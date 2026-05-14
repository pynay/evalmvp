import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, SONNET_MODEL } from '../anthropic';
import { parseJson } from '../judges/parse-json';
import { buildSystemPrompt, buildUserPrompt } from './prompt';
import type { Draft, Sender, Icp, Prospect } from './types';

const draftSchema = z.object({
  subject: z.string().min(1).max(120),
  body: z.string().min(20),
});

export interface GenerateDraftArgs {
  prospect: Prospect;
  sender: Sender;
  icp: Icp;
  feedback: string | null;
}

export async function generateDraft(args: GenerateDraftArgs): Promise<Draft> {
  const system = buildSystemPrompt(args.sender, args.icp);
  const user = buildUserPrompt({ prospect: args.prospect, feedback: args.feedback });

  const res = await anthropic().messages.create({
    model: SONNET_MODEL,
    max_tokens: 1500,
    system: [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: user }],
  });

  const raw = res.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('');

  return parseJson(raw, draftSchema);
}
