import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, HAIKU_MODEL } from '../anthropic';
import { parseJson } from './parse-json';
import { AI_DETECTION_VERSION, type AiDetectionOutput } from './types';

export const aiDetectionSchema = z.object({
  axis_scores: z.object({
    opener:      z.number().int().min(0).max(100),
    structure:   z.number().int().min(0).max(100),
    hedging:     z.number().int().min(0).max(100),
    cta:         z.number().int().min(0).max(100),
    vocabulary:  z.number().int().min(0).max(100),
    punctuation: z.number().int().min(0).max(100),
    rhythm:      z.number().int().min(0).max(100),
  }),
  red_flags: z.array(
    z.object({
      axis: z.string(),
      evidence: z.string(),
      severity: z.enum(['high', 'med', 'low']),
    }),
  ).max(3),
});

export function computeOverall(scores: z.infer<typeof aiDetectionSchema>['axis_scores']): number {
  const values = Object.values(scores);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Load rubric once at module init — same content for every call, supports prompt caching.
const RUBRIC = readFileSync(resolve(process.cwd(), 'prompts/judges/ai-detection.md'), 'utf-8');

export interface Email {
  subject: string;
  body: string;
}

export async function aiDetection(email: Email): Promise<AiDetectionOutput> {
  const userMessage = `Subject: ${email.subject}\n\nBody:\n${email.body}`;

  const res = await anthropic().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 800,
    system: [
      {
        type: 'text',
        text: RUBRIC,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = res.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('');

  const parsed = parseJson(raw, aiDetectionSchema);

  return {
    axisScores: parsed.axis_scores,
    overall: computeOverall(parsed.axis_scores),
    redFlags: parsed.red_flags,
  };
}

export { AI_DETECTION_VERSION };
