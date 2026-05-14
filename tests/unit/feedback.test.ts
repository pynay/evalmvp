import { describe, it, expect } from 'vitest';
import { buildFeedback } from '../../src/lib/generation/feedback';
import type { Draft, ScoreBundle } from '../../src/lib/generation/types';

const draft: Draft = { subject: 'Test', body: 'Hello world.' };

function bundle(ai: number, gen: number, persScore: number, generic: string[] = [], groundedCount = 0): ScoreBundle {
  return {
    aiDetection:    { axisScores: { opener: 30, structure: 50, hedging: 60, cta: 40, vocabulary: 70, punctuation: 80, rhythm: 90 }, overall: ai, redFlags: [] },
    genericness:    { axisScores: { opener: gen, body: gen, cta: gen }, overall: gen, evidence: [] },
    personalization:{ references: [], genericTokenHits: generic, groundedRefCount: groundedCount, score: persScore },
  };
}

describe('buildFeedback', () => {
  it('includes the previous draft body verbatim', () => {
    const fb = buildFeedback(draft, bundle(50, 50, 50), 50);
    expect(fb).toContain('Hello world.');
  });

  it('includes all three judge overall scores', () => {
    const fb = buildFeedback(draft, bundle(45, 55, 65), 55);
    expect(fb).toContain('ai_detection: 45');
    expect(fb).toContain('genericness: 55');
    expect(fb).toContain('personalization: 65');
  });

  it('identifies the lowest-scoring judge in the critique', () => {
    const fb = buildFeedback(draft, bundle(20, 80, 80), 60);
    expect(fb.toLowerCase()).toContain('ai_detection');
  });

  it('lists generic tokens explicitly when present', () => {
    const fb = buildFeedback(draft, bundle(80, 80, 0, ['{company}', 'leaders like you'], 0), 53);
    expect(fb).toContain('{company}');
    expect(fb).toContain('leaders like you');
  });

  it('flags zero grounded refs as a separate issue', () => {
    const fb = buildFeedback(draft, bundle(80, 80, 0, [], 0), 53);
    expect(fb.toLowerCase()).toContain('grounded');
  });

  it('surfaces AI-Detection low axes when AI-Detection is the problem', () => {
    const bundle1: ScoreBundle = {
      aiDetection: {
        axisScores: { opener: 10, structure: 15, hedging: 80, cta: 80, vocabulary: 80, punctuation: 80, rhythm: 80 },
        overall: 46,
        redFlags: [{ axis: 'opener', evidence: 'I noticed your', severity: 'high' }],
      },
      genericness:    { axisScores: { opener: 90, body: 90, cta: 90 }, overall: 90, evidence: [] },
      personalization:{ references: [], genericTokenHits: [], groundedRefCount: 2, score: 50 },
    };
    const fb = buildFeedback(draft, bundle1, 58);
    expect(fb).toContain('opener');
    expect(fb).toContain('I noticed your');
  });
});
