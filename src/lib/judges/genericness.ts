import postgres from 'postgres';
import { embedTexts } from '../embeddings';
import { segment } from '../../../scripts/corpus/segment';
import { GENERICNESS_VERSION, type GenericnessOutput, type SimilarityMatch } from './types';

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Per-segment score: 100 × (1 - similarity). Higher = more unique.
 * Clamps similarity to [0, 1] to handle numerical noise from cosine distance.
 */
export function blendGenericness(sims: { opener: number; body: number; cta: number }) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const score = (s: number) => Math.round(100 * (1 - clamp(s)));
  const opener = score(sims.opener);
  const body = score(sims.body);
  const cta = score(sims.cta);
  const overall = Math.min(opener, body, cta);  // worst (closest match) drives overall
  return { opener, body, cta, overall };
}

interface RawMatch {
  segment: 'opener' | 'body' | 'cta';
  similarity: number;
  corpusRowId: string;
  body: string;
  source: string | null;
}

export function formatEvidence(raw: RawMatch[]): SimilarityMatch[] {
  return [...raw]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3)
    .map((m) => ({
      segment: m.segment,
      similarity: m.similarity,
      corpusRowId: m.corpusRowId,
      snippet: m.body.slice(0, 120),
      source: m.source,
    }));
}

export interface Email {
  subject: string;
  body: string;
}

/**
 * Genericness v1.0 — distance from AI corpus only.
 *
 * For each segment (opener / body / cta), embeds it via OpenAI and finds the
 * nearest neighbor in email_corpus where origin = 'ai'. The closer the match,
 * the more "generic" the email is — i.e., the more it resembles AI SDR output.
 *
 * Score = 100 × (1 - peak similarity across segments). Higher = more unique.
 *
 * Positive direction (closeness to human corpus, weighted 0.4) is deferred
 * until the human corpus has ≥50 curated rows — see spec §8.2.
 */
export async function genericness(email: Email): Promise<GenericnessOutput> {
  const SERVICE_URL = process.env.DATABASE_URL_SERVICE;
  if (!SERVICE_URL) throw new Error('DATABASE_URL_SERVICE not set');

  // 1. Segment + embed the candidate
  const segs = segment({ subject: email.subject, body: email.body });
  const [openerEmb, bodyEmb, ctaEmb] = await embedTexts([
    segs.opener || ' ',
    segs.bodyMiddle || ' ',
    segs.cta || ' ',
  ]);

  // 2. Query pgvector for nearest neighbors per segment
  const sql = postgres(SERVICE_URL, { prepare: false });
  try {
    // pgvector returns cosine DISTANCE via <=>. similarity = 1 - distance.
    const findNearest = async (vec: number[], segmentName: 'opener' | 'body' | 'cta') => {
      const col = segmentName === 'opener' ? sql`embedding_opener`
                : segmentName === 'body'   ? sql`embedding_body`
                : sql`embedding_cta`;
      const rows = await sql<{ id: string; body: string; source: string | null; distance: number }[]>`
        select id, body, source, ${col} <=> ${vectorLiteral(vec)}::vector as distance
        from email_corpus
        where origin = 'ai' and ${col} is not null
        order by ${col} <=> ${vectorLiteral(vec)}::vector
        limit 1
      `;
      return rows[0] ?? null;
    };

    const [oRow, bRow, cRow] = await Promise.all([
      findNearest(openerEmb, 'opener'),
      findNearest(bodyEmb, 'body'),
      findNearest(ctaEmb, 'cta'),
    ]);

    const oSim = oRow ? 1 - Number(oRow.distance) : 0;
    const bSim = bRow ? 1 - Number(bRow.distance) : 0;
    const cSim = cRow ? 1 - Number(cRow.distance) : 0;

    const blend = blendGenericness({ opener: oSim, body: bSim, cta: cSim });

    const matches: RawMatch[] = [];
    if (oRow) matches.push({ segment: 'opener', similarity: oSim, corpusRowId: oRow.id, body: oRow.body, source: oRow.source });
    if (bRow) matches.push({ segment: 'body',   similarity: bSim, corpusRowId: bRow.id, body: bRow.body, source: bRow.source });
    if (cRow) matches.push({ segment: 'cta',    similarity: cSim, corpusRowId: cRow.id, body: cRow.body, source: cRow.source });

    return {
      axisScores: { opener: blend.opener, body: blend.body, cta: blend.cta },
      overall: blend.overall,
      evidence: formatEvidence(matches),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export { GENERICNESS_VERSION };
