import { describe, it, expect } from 'vitest';
import { blendOverall } from '../../src/lib/generation/blend';
import type { ScoreBundle } from '../../src/lib/generation/types';

function bundle(ai: number, gen: number, pers: number): ScoreBundle {
  return {
    aiDetection:    { axisScores: { opener: 0, structure: 0, hedging: 0, cta: 0, vocabulary: 0, punctuation: 0, rhythm: 0 }, overall: ai, redFlags: [] },
    genericness:    { axisScores: { opener: 0, body: 0, cta: 0 }, overall: gen, evidence: [] },
    personalization:{ references: [], genericTokenHits: [], groundedRefCount: 0, score: pers },
  };
}

describe('blendOverall', () => {
  it('matches spec weights 0.4/0.3/0.3', () => {
    expect(blendOverall(bundle(100, 0, 0))).toBe(40);
    expect(blendOverall(bundle(0, 100, 0))).toBe(30);
    expect(blendOverall(bundle(0, 0, 100))).toBe(30);
  });

  it('all 100 → 100', () => {
    expect(blendOverall(bundle(100, 100, 100))).toBe(100);
  });

  it('all 70 → 70', () => {
    expect(blendOverall(bundle(70, 70, 70))).toBe(70);
  });

  it('mixed: 80 / 60 / 50 → 0.4×80 + 0.3×60 + 0.3×50 = 32 + 18 + 15 = 65', () => {
    expect(blendOverall(bundle(80, 60, 50))).toBe(65);
  });

  it('rounds to nearest integer', () => {
    expect(blendOverall(bundle(75, 75, 75))).toBe(75);
    expect(blendOverall(bundle(73, 67, 71))).toBe(71);
  });
});
