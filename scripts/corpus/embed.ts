import { EMBEDDING_DIMENSIONS } from '../../src/lib/openai';
import { embedTexts } from '../../src/lib/embeddings';
import type { RawEmail, EmbeddedEmail } from './types';
import { segment } from './segment';

export async function embedEmails(
  emails: RawEmail[],
  log: (msg: string) => void = () => {},
): Promise<EmbeddedEmail[]> {
  const withSegments = emails.map((email) => ({
    email,
    segments: segment({ subject: email.subject, body: email.body }),
  }));

  const texts: string[] = [];
  for (const { segments } of withSegments) {
    texts.push(segments.opener || ' ', segments.bodyMiddle || ' ', segments.cta || ' ');
  }

  log(`Embedding ${texts.length} segments (${withSegments.length} emails × 3)…`);
  const allEmbeddings = await embedTexts(texts, log);

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
