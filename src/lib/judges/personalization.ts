import type { Reference } from './types';

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
