import { BLEND_WEIGHTS, type ScoreBundle } from './types';

/**
 * Blend the three judge scores into a single 0-100 overall.
 * Weights from spec §7.4: 0.4 × AI-Detection + 0.3 × Genericness + 0.3 × Personalization.
 * Result is rounded to the nearest integer.
 */
export function blendOverall(scores: ScoreBundle): number {
  const blended =
    BLEND_WEIGHTS.aiDetection    * scores.aiDetection.overall +
    BLEND_WEIGHTS.genericness    * scores.genericness.overall +
    BLEND_WEIGHTS.personalization * scores.personalization.score;
  return Math.round(blended);
}
