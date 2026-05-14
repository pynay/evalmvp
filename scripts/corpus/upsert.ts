import postgres from 'postgres';
import type { EmbeddedEmail } from './types';

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export async function upsertEmails(
  emails: EmbeddedEmail[],
  log: (msg: string) => void = () => {},
): Promise<{ inserted: number }> {
  // Read env at call time. ESM hoists imports, so a top-level
  // `process.env.DATABASE_URL_SERVICE` read here would happen BEFORE dotenv runs in build.ts.
  const SERVICE_URL = process.env.DATABASE_URL_SERVICE;
  if (!SERVICE_URL) throw new Error('DATABASE_URL_SERVICE not set');
  const sql = postgres(SERVICE_URL, { prepare: false });

  try {
    log(`Upserting ${emails.length} rows into email_corpus…`);
    let inserted = 0;

    // Per-row INSERT wrapped in a transaction. A single connection from the pooler
    // services all the inserts. For 800 rows on the hosted DB this is ~40s — fine.
    // (Earlier attempt at json_to_recordset batching hit a parameter-binding edge
    // case with postgres-js; the simpler form is correct and fast enough.)
    await sql.begin(async (tx) => {
      for (const e of emails) {
        await tx`
          insert into email_corpus
            (source, origin, model, vendor, subject, body,
             embedding_opener, embedding_body, embedding_cta, metadata_jsonb)
          values (
            ${e.source ?? null},
            ${e.origin},
            ${e.model ?? null},
            ${e.vendor ?? null},
            ${e.subject},
            ${e.body},
            ${vectorLiteral(e.embedding.opener)}::vector,
            ${vectorLiteral(e.embedding.body)}::vector,
            ${vectorLiteral(e.embedding.cta)}::vector,
            ${JSON.stringify(e.metadata ?? {})}::jsonb
          )
        `;
        inserted++;
        if (inserted % 25 === 0 || inserted === emails.length) {
          log(`  ${inserted}/${emails.length}`);
        }
      }
    });

    return { inserted };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
