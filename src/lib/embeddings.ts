import { openai, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './openai';

const BATCH_SIZE = 100;  // OpenAI accepts up to 2048 per call

/**
 * Embed an array of texts via OpenAI text-embedding-3-small.
 * Batches at 100 inputs per request. Returns a parallel array of 1536-dim vectors.
 */
export async function embedTexts(
  texts: string[],
  log: (msg: string) => void = () => {},
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // OpenAI rejects empty strings — pad with a single space.
    const safeBatch = batch.map((t) => (t.trim() === '' ? ' ' : t));
    const res = await openai().embeddings.create({
      model: EMBEDDING_MODEL,
      input: safeBatch,
    });
    for (const d of res.data) {
      if (d.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Unexpected dimension ${d.embedding.length}, expected ${EMBEDDING_DIMENSIONS}`);
      }
      out.push(d.embedding);
    }
    log(`  ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
  }
  return out;
}
