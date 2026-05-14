import { describe, it, expect } from 'vitest';
import { computePersonalizationScore } from '../../src/lib/judges/personalization';
import type { Reference } from '../../src/lib/judges/types';

const high = (i: number): Reference => ({
  snippet: `high ref ${i}`, groundedIn: `enrichment.field${i}`, specificity: 'high',
});
const med = (i: number): Reference => ({
  snippet: `med ref ${i}`, groundedIn: `enrichment.field${i}`, specificity: 'med',
});
const ungrounded = (i: number): Reference => ({
  snippet: `floating ref ${i}`, groundedIn: null, specificity: 'high',
});

describe('computePersonalizationScore', () => {
  it('1 high grounded ref → 20', () => {
    expect(computePersonalizationScore([high(1)], [], 1)).toBe(20);
  });

  it('3 high grounded refs → 60 (cap)', () => {
    expect(computePersonalizationScore([high(1), high(2), high(3)], [], 3)).toBe(60);
  });

  it('5 high grounded refs still capped at 60', () => {
    expect(computePersonalizationScore(
      [high(1), high(2), high(3), high(4), high(5)], [], 5,
    )).toBe(60);
  });

  it('2 med grounded refs → 20', () => {
    expect(computePersonalizationScore([med(1), med(2)], [], 2)).toBe(20);
  });

  it('3 med grounded refs → 20 (cap)', () => {
    expect(computePersonalizationScore([med(1), med(2), med(3)], [], 3)).toBe(20);
  });

  it('high + med stack: 3 high + 2 med → 60 + 20 = 80', () => {
    expect(computePersonalizationScore(
      [high(1), high(2), high(3), med(1), med(2)], [], 5,
    )).toBe(80);
  });

  it('1 generic token → minus 30 → floored at 0 when no positives', () => {
    expect(computePersonalizationScore([], ['{company}'], 0)).toBe(0);
  });

  it('grounded_ref_count=0 → minus 40 → 0', () => {
    expect(computePersonalizationScore([], [], 0)).toBe(0);
  });

  it('mixed: 2 high refs + 1 generic token = 40 − 30 = 10', () => {
    expect(computePersonalizationScore([high(1), high(2)], ['{company}'], 2)).toBe(10);
  });

  it('ungrounded high ref does NOT add — has groundedIn null', () => {
    expect(computePersonalizationScore([ungrounded(1)], [], 0)).toBe(0);
  });

  it('cap above 100', () => {
    expect(computePersonalizationScore(
      [high(1), high(2), high(3), high(4), med(1), med(2), med(3)], [], 7,
    )).toBe(80);
  });
});
