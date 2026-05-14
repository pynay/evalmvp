import { describe, it, expect } from 'vitest';
import { segment } from '../../scripts/corpus/segment';

describe('segment', () => {
  it('extracts the opener as the first sentence', () => {
    const result = segment({
      subject: 'Quick question about Acme',
      body: 'Hi Sarah, I noticed Acme expanded into Europe last quarter. We help SaaS companies like yours streamline cross-border invoicing. Worth a 15-min chat?',
    });
    expect(result.opener).toBe('Hi Sarah, I noticed Acme expanded into Europe last quarter.');
  });

  it('extracts the CTA as the last sentence ending in ? or !', () => {
    const result = segment({
      subject: 'Test',
      body: 'Hello. This is the middle. Worth a chat?',
    });
    expect(result.cta).toBe('Worth a chat?');
  });

  it('falls back to last paragraph as CTA when no ? or !', () => {
    const result = segment({
      subject: 'Test',
      body: 'Hello.\n\nThis is the middle paragraph.\n\nThis is the final paragraph that should be the CTA.',
    });
    expect(result.cta).toBe('This is the final paragraph that should be the CTA.');
  });

  it('body_middle excludes opener and cta', () => {
    const result = segment({
      subject: 'Test',
      body: 'First sentence. Middle sentence one. Middle sentence two. Worth a chat?',
    });
    expect(result.bodyMiddle).toBe('Middle sentence one. Middle sentence two.');
  });

  it('handles single-sentence body (opener=cta=body)', () => {
    const result = segment({
      subject: 'Test',
      body: 'Worth a quick chat?',
    });
    expect(result.opener).toBe('Worth a quick chat?');
    expect(result.cta).toBe('Worth a quick chat?');
    expect(result.bodyMiddle).toBe('');
  });
});
