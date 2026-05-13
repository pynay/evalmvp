import { openai, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../../src/lib/openai';
import type { RawEmail, EmbeddedEmail } from './types';
import { segment } from './segment';

const BATCH_SIZE = 100;  // OpenAI accepts up to 2048 inputs per call; 100 keeps payloads small.

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

export async function embedEmails(
  emails: RawEmail[],
  log: (msg: string) => void = () => {},
): Promise<EmbeddedEmail[]> {
  // Segment all first
  const withSegments = emails.map((email) => ({
    email,
    segments: segment({ subject: email.subject, body: email.body }),
  }));

  // Build flat list of texts to embed (3 per email: opener, body, cta)
  const texts: string[] = [];
  for (const { segments } of withSegments) {
    texts.push(segments.opener || ' ', segments.bodyMiddle || ' ', segments.cta || ' ');
  }

  log(`Embedding ${texts.length} segments (${withSegments.length} emails × 3) in batches of ${BATCH_SIZE}…`);

  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await embedBatch(batch);
    allEmbeddings.push(...batchEmbeddings);
    log(`  ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
  }

  // Re-assemble: each email gets 3 consecutive embeddings
  const out: EmbeddedEmail[] = [];
  for (let i = 0; i < withSegments.length; i++) {
    const base = i * 3;
    const opener = allEmbeddings[base];
    const body = allEmbeddings[base + 1];
    const cta = allEmbeddings[base + 2];

    if (!opener || !body || !cta) throw new Error(`Missing embedding for email ${i}`);
    if (opener.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Unexpected dimension ${opener.length}, expected ${EMBEDDING_DIMENSIONS}`);
    }

    out.push({
      ...withSegments[i].email,
      segments: withSegments[i].segments,
      embedding: { opener, body, cta },
    });
  }

  return out;
}
