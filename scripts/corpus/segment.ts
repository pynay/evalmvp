import type { Segments } from './types';

/**
 * Splits a cold email into (opener, body_middle, cta) for separate embedding.
 *
 * - opener: first sentence
 * - cta: last sentence ending in ? or !, else last paragraph
 * - body_middle: everything between opener and cta
 *
 * The split is intentionally heuristic. Cold-email shape is regular enough
 * that simple regex outperforms an LLM-based segmenter on cost and latency
 * (called ~3500 times during corpus build, ~1 time per generation at runtime).
 */
export function segment({ body }: { subject: string; body: string }): Segments {
  const normalized = body.trim().replace(/\r\n/g, '\n');

  // Find opener: first sentence (ends with . ? !)
  const openerMatch = normalized.match(/^(.+?[.!?])\s/);
  const opener = openerMatch ? openerMatch[1].trim() : normalized;

  // Find CTA: last sentence ending in ? or !
  const ctaMatch = normalized.match(/([^.!?]+[?!])\s*$/);
  let cta = ctaMatch ? ctaMatch[1].trim() : '';

  // Fallback CTA: last paragraph
  if (!cta) {
    const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    cta = paragraphs[paragraphs.length - 1] ?? '';
  }

  // body_middle: between opener and cta
  let bodyMiddle = normalized;
  if (opener && bodyMiddle.startsWith(opener)) {
    bodyMiddle = bodyMiddle.slice(opener.length).trim();
  }
  if (cta && bodyMiddle.endsWith(cta)) {
    bodyMiddle = bodyMiddle.slice(0, bodyMiddle.length - cta.length).trim();
  }
  // Strip trailing/leading punctuation/whitespace
  bodyMiddle = bodyMiddle.replace(/^[.\s]+|[\s]+$/g, '');

  // Edge case: single-sentence body — opener and cta point to the same thing
  if (opener === cta) {
    bodyMiddle = '';
  }

  return { opener, bodyMiddle, cta };
}
