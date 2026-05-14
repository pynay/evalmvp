import { describe, it, expect } from 'vitest';
import { aiDetectionSchema, computeOverall } from '../../src/lib/judges/ai-detection';

describe('aiDetectionSchema', () => {
  it('validates a well-formed output', () => {
    const valid = {
      axis_scores: {
        opener: 30, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: [
        { axis: 'opener', evidence: 'I came across your role', severity: 'high' },
      ],
    };
    expect(() => aiDetectionSchema.parse(valid)).not.toThrow();
  });

  it('rejects scores outside 0-100', () => {
    const invalid = {
      axis_scores: {
        opener: 150, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: [],
    };
    expect(() => aiDetectionSchema.parse(invalid)).toThrow();
  });

  it('rejects unknown severity values', () => {
    const invalid = {
      axis_scores: {
        opener: 30, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: [{ axis: 'opener', evidence: 'x', severity: 'critical' }],
    };
    expect(() => aiDetectionSchema.parse(invalid)).toThrow();
  });

  it('rejects more than 3 red flags', () => {
    const invalid = {
      axis_scores: {
        opener: 30, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: Array(4).fill({ axis: 'opener', evidence: 'x', severity: 'low' }),
    };
    expect(() => aiDetectionSchema.parse(invalid)).toThrow();
  });
});

describe('computeOverall', () => {
  it('is the mean of all axis scores', () => {
    const scores = { opener: 0, structure: 0, hedging: 0, cta: 100, vocabulary: 100, punctuation: 100, rhythm: 100 };
    expect(computeOverall(scores)).toBeCloseTo(400 / 7);
  });

  it('returns 50 for a uniform 50', () => {
    const scores = { opener: 50, structure: 50, hedging: 50, cta: 50, vocabulary: 50, punctuation: 50, rhythm: 50 };
    expect(computeOverall(scores)).toBe(50);
  });
});
