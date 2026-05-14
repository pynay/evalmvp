import { config as loadEnv } from 'dotenv';
// override: true — shell env may have empty strings (e.g. ANTHROPIC_API_KEY="" from
// 1Password CLI integration) that dotenv's default "don't override" leaves in place,
// silently breaking API auth. .env.local is the source of truth for local dev.
loadEnv({ path: '.env.local', override: true });
loadEnv({ path: '.env', override: true });

import { existsSync } from 'node:fs';
import { generateAi } from './generate-ai';
import { loadCsvFile } from './load-csv';
import { embedEmails } from './embed';
import { upsertEmails } from './upsert';
import { CORPUS_TARGETS, SMOKE_TARGETS } from './config';
import type { RawEmail } from './types';

const isSmoke = process.argv.includes('--smoke');
const TARGETS = isSmoke ? SMOKE_TARGETS : CORPUS_TARGETS;

const HUMAN_CSV = 'data/seed-human-emails.csv';
const TEMPLATE_CSV = 'data/seed-template-emails.csv';

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

async function main() {
  log(`Building corpus (${isSmoke ? 'SMOKE' : 'FULL'}): targets=${JSON.stringify(TARGETS)}`);

  const all: RawEmail[] = [];

  // 1. AI
  log(`\n── AI corpus ──`);
  const ai = await generateAi({ target: TARGETS.ai, log });
  log(`  generated ${ai.length} AI emails`);
  all.push(...ai);

  // 2. Human (CSV)
  log(`\n── Human corpus ──`);
  if (!existsSync(HUMAN_CSV)) {
    log(`  ${HUMAN_CSV} not found — using example file as fallback.`);
    log(`  Copy data/seed-human-emails.example.csv → ${HUMAN_CSV} and curate.`);
    const human = loadCsvFile('data/seed-human-emails.example.csv', 'human').slice(0, TARGETS.human);
    log(`  loaded ${human.length} human emails (from example file)`);
    all.push(...human);
  } else {
    const human = loadCsvFile(HUMAN_CSV, 'human').slice(0, TARGETS.human);
    log(`  loaded ${human.length} human emails`);
    all.push(...human);
  }

  // 3. Template (CSV)
  log(`\n── Template corpus ──`);
  if (!existsSync(TEMPLATE_CSV)) {
    log(`  ${TEMPLATE_CSV} not found — using example file as fallback.`);
    const template = loadCsvFile('data/seed-template-emails.example.csv', 'template').slice(0, TARGETS.template);
    log(`  loaded ${template.length} template emails (from example file)`);
    all.push(...template);
  } else {
    const template = loadCsvFile(TEMPLATE_CSV, 'template').slice(0, TARGETS.template);
    log(`  loaded ${template.length} template emails`);
    all.push(...template);
  }

  // 4. Segment + embed
  log(`\n── Embedding ──`);
  const embedded = await embedEmails(all, log);

  // 5. Upsert
  log(`\n── Upsert ──`);
  const { inserted } = await upsertEmails(embedded, log);

  log(`\n✓ Done. Inserted ${inserted} rows. Run 'pnpm corpus:validate' to gate.`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  log(`FAILED: ${msg}`);
  if (e instanceof Error && e.stack) log(e.stack);
  process.exit(1);
});
