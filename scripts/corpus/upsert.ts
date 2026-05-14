import postgres from 'postgres';
import type { EmbeddedEmail } from './types';

const SERVICE_URL = process.env.DATABASE_URL_SERVICE;

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export async function upsertEmails(
  emails: EmbeddedEmail[],
  log: (msg: string) => void = () => {},
): Promise<{ inserted: number }> {
  if (!SERVICE_URL) throw new Error('DATABASE_URL_SERVICE not set');
  const sql = postgres(SERVICE_URL, { prepare: false });

  try {
    log(`Upserting ${emails.length} rows into email_corpus…`);
    const BATCH = 50;

    let inserted = 0;
    for (let i = 0; i < emails.length; i += BATCH) {
      const batch = emails.slice(i, i + BATCH);
      const values = batch.map((e) => ({
        source: e.source ?? null,
        origin: e.origin,
        model: e.model ?? null,
        vendor: e.vendor ?? null,
        subject: e.subject,
        body: e.body,
        embedding_opener: vectorLiteral(e.embedding.opener),
        embedding_body:   vectorLiteral(e.embedding.body),
        embedding_cta:    vectorLiteral(e.embedding.cta),
        metadata_jsonb:   e.metadata ?? {},
      }));

      await sql`
        insert into email_corpus
          (source, origin, model, vendor, subject, body,
           embedding_opener, embedding_body, embedding_cta, metadata_jsonb)
        select
          v.source, v.origin, v.model, v.vendor, v.subject, v.body,
          v.embedding_opener::vector, v.embedding_body::vector, v.embedding_cta::vector,
          v.metadata_jsonb::jsonb
        from json_to_recordset(${JSON.stringify(values)}::json) as v(
          source text, origin text, model text, vendor text, subject text, body text,
          embedding_opener text, embedding_body text, embedding_cta text, metadata_jsonb json
        )
      `;
      inserted += batch.length;
      log(`  ${inserted}/${emails.length}`);
    }

    return { inserted };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
