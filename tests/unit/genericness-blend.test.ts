import { describe, it, expect } from 'vitest';
import { blendGenericness, formatEvidence } from '../../src/lib/judges/genericness';

describe('blendGenericness', () => {
  it('axis score = 100 × (1 - similarity)', () => {
    const result = blendGenericness({ opener: 0.1, body: 0.2, cta: 0.3 });
    expect(result.opener).toBe(90);
    expect(result.body).toBe(80);
    expect(result.cta).toBe(70);
  });

  it('overall = 100 × (1 - max similarity)', () => {
    const result = blendGenericness({ opener: 0.1, body: 0.95, cta: 0.3 });
    expect(result.overall).toBe(5);  // 100 × (1 - 0.95)
  });

  it('clamps similarity > 1 (numerical noise)', () => {
    const result = blendGenericness({ opener: 1.05, body: 0.0, cta: 0.0 });
    expect(result.opener).toBe(0);
    expect(result.overall).toBe(0);
  });

  it('clamps similarity < 0', () => {
    const result = blendGenericness({ opener: -0.1, body: 0.0, cta: 0.0 });
    expect(result.opener).toBe(100);
  });
});

describe('formatEvidence', () => {
  it('keeps top 3 by similarity, descending', () => {
    const raw = [
      { segment: 'opener' as const, similarity: 0.3, corpusRowId: 'a', body: 'body a', source: 's1' },
      { segment: 'body' as const,   similarity: 0.7, corpusRowId: 'b', body: 'body b', source: 's2' },
      { segment: 'cta' as const,    similarity: 0.5, corpusRowId: 'c', body: 'body c', source: 's3' },
      { segment: 'opener' as const, similarity: 0.9, corpusRowId: 'd', body: 'body d', source: 's4' },
    ];
    const result = formatEvidence(raw);
    expect(result).toHaveLength(3);
    expect(result[0].corpusRowId).toBe('d');
    expect(result[1].corpusRowId).toBe('b');
    expect(result[2].corpusRowId).toBe('c');
  });

  it('truncates body to 120 chars for snippet', () => {
    const longBody = 'x'.repeat(200);
    const result = formatEvidence([
      { segment: 'opener', similarity: 0.5, corpusRowId: 'a', body: longBody, source: null },
    ]);
    expect(result[0].snippet.length).toBeLessThanOrEqual(120);
  });
});
