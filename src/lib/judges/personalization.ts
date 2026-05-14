import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, HAIKU_MODEL } from '../anthropic';
import { parseJson } from './parse-json';
import type { Reference } from './types';
import { PERSONALIZATION_VERSION, type PersonalizationOutput } from './types';

export const personalizationSchema = z.object({
  references: z.array(z.object({
    snippet: z.string(),
    grounded_in: z.string().nullable(),
    specificity: z.enum(['high', 'med', 'low', 'generic']),
  })),
  generic_token_hits: z.array(z.string()),
  grounded_ref_count: z.number().int().min(0),
});

const RUBRIC = readFileSync(resolve(process.cwd(), 'prompts/judges/personalization.md'), 'utf-8');

/**
 * Deterministic scoring from the structured output the Personalization judge extracts.
 *
 * Rules from spec §8.3:
 *   - Start at 0
 *   - +20 per grounded high-specificity reference (cap 60)
 *   - +10 per grounded med-specificity (cap 20)
 *   - −30 per generic token hit
 *   - −40 if grounded_ref_count == 0
 *   - Floor 0, ceiling 100
 *
 * "Grounded" = the reference has a non-null `groundedIn` field.
 */
export function computePersonalizationScore(
  references: Reference[],
  genericTokenHits: string[],
  groundedRefCount: number,
): number {
  let score = 0;

  const groundedHighCount = references.filter(
    (r) => r.specificity === 'high' && r.groundedIn !== null,
  ).length;
  score += Math.min(groundedHighCount * 20, 60);

  const groundedMedCount = references.filter(
    (r) => r.specificity === 'med' && r.groundedIn !== null,
  ).length;
  score += Math.min(groundedMedCount * 10, 20);

  score -= genericTokenHits.length * 30;
  if (groundedRefCount === 0) score -= 40;

  return Math.max(0, Math.min(100, score));
}

export interface PersonalizationInput {
  subject: string;
  body: string;
  enrichment: Record<string, unknown>;
}

export async function personalization(input: PersonalizationInput): Promise<PersonalizationOutput> {
  const userMessage = `Email:
Subject: ${input.subject}

${input.body}

Enrichment data:
${JSON.stringify(input.enrichment, null, 2)}`;

  const res = await anthropic().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1200,
    system: [
      { type: 'text', text: RUBRIC, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = res.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('');

  const parsed = parseJson(raw, personalizationSchema);

  const references = parsed.references.map((r) => ({
    snippet: r.snippet,
    groundedIn: r.grounded_in,
    specificity: r.specificity,
  }));

  const score = computePersonalizationScore(
    references,
    parsed.generic_token_hits,
    parsed.grounded_ref_count,
  );

  return {
    references,
    genericTokenHits: parsed.generic_token_hits,
    groundedRefCount: parsed.grounded_ref_count,
    score,
  };
}

export { PERSONALIZATION_VERSION };
