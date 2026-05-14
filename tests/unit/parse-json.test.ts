import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJson } from '../../src/lib/judges/parse-json';

const Schema = z.object({ foo: z.string(), bar: z.number() });

describe('parseJson', () => {
  it('parses plain JSON', () => {
    const out = parseJson('{"foo":"hello","bar":42}', Schema);
    expect(out).toEqual({ foo: 'hello', bar: 42 });
  });

  it('strips ```json code fences', () => {
    const raw = '```json\n{"foo":"hello","bar":42}\n```';
    expect(parseJson(raw, Schema)).toEqual({ foo: 'hello', bar: 42 });
  });

  it('strips ``` (no language tag) code fences', () => {
    const raw = '```\n{"foo":"hello","bar":42}\n```';
    expect(parseJson(raw, Schema)).toEqual({ foo: 'hello', bar: 42 });
  });

  it('handles leading prose before JSON', () => {
    const raw = 'Sure, here is the JSON:\n\n{"foo":"hello","bar":42}';
    expect(parseJson(raw, Schema)).toEqual({ foo: 'hello', bar: 42 });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJson('not json at all', Schema)).toThrow(/json/i);
  });

  it('throws on schema mismatch', () => {
    expect(() => parseJson('{"foo":42,"bar":"oops"}', Schema)).toThrow();
  });
});
