import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
loadEnv({ path: '.env', override: true });

import postgres from 'postgres';
import { CORPUS_TARGETS } from './config';

// Quality gate thresholds. Defined as a fraction of the per-origin target so
// we tolerate ~10% AI generation drop-offs without failing the gate.
const MIN_FRACTION = 0.9;

async function main() {
  const url = process.env.DATABASE_URL_SERVICE;
  if (!url) throw new Error('DATABASE_URL_SERVICE not set');
  const sql = postgres(url, { prepare: false });
  const failures: string[] = [];

  try {
    // 1. Row counts per origin
    const counts = await sql<{ origin: string; count: number }[]>`
      select origin, count(*)::int as count from email_corpus group by origin
    `;
    const byOrigin = Object.fromEntries(counts.map((r) => [r.origin, r.count]));

    for (const [origin, target] of Object.entries(CORPUS_TARGETS)) {
      const actual = byOrigin[origin] ?? 0;
      const minimum = Math.floor(target * MIN_FRACTION);
      const status = actual >= minimum ? '✓' : '✗';
      console.log(`${status} ${origin}: ${actual} rows (target ${target}, min ${minimum})`);
      if (actual < minimum) failures.push(`${origin}: only ${actual} rows, need ${minimum}`);
    }

    // 2. No null embeddings on rows we care about
    const nullEmbeddings = await sql<{ count: number }[]>`
      select count(*)::int as count from email_corpus
      where embedding_body is null or embedding_opener is null or embedding_cta is null
    `;
    const nullCount = nullEmbeddings[0]?.count ?? 0;
    const embStatus = nullCount === 0 ? '✓' : '✗';
    console.log(`${embStatus} embeddings: ${nullCount} rows have null embedding columns (need 0)`);
    if (nullCount > 0) failures.push(`${nullCount} rows have null embeddings`);

    // 3. Spot-check sample for manual review
    console.log(`\n── 5 random sample rows for spot-check ──`);
    const samples = await sql<{ origin: string; source: string; subject: string; body: string }[]>`
      select origin, source, subject, substring(body, 1, 120) as body
      from email_corpus order by random() limit 5
    `;
    for (const s of samples) {
      console.log(`  [${s.origin}] ${s.source ?? '?'}`);
      console.log(`    SUBJECT: ${s.subject}`);
      console.log(`    BODY:    ${s.body}…\n`);
    }

    if (failures.length > 0) {
      console.error(`\n✗ Validation FAILED:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\n✓ Corpus validation passed.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e: unknown) => {
  console.error('Validation error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
