import type { z } from 'zod';

/**
 * Extracts and validates JSON from raw LLM output. Handles common wrapping:
 * - ```json ... ``` code fences
 * - ``` ... ``` (no language tag)
 * - leading prose before the JSON object
 *
 * Throws if no JSON object is found or if the parsed JSON doesn't match the schema.
 */
export function parseJson<T>(raw: string, schema: z.ZodSchema<T>): T {
  // Try direct parse first
  let candidate = raw.trim();

  // Strip code fences if present
  const fenceMatch = candidate.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) candidate = fenceMatch[1].trim();

  // Find the first { and matching last } — handles leading prose
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`No JSON object found in LLM output: ${candidate.slice(0, 80)}`);
  }
  candidate = candidate.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON: ${msg}. Raw: ${candidate.slice(0, 80)}`);
  }

  return schema.parse(parsed);
}
