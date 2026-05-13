import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, SONNET_MODEL } from '../../src/lib/anthropic';
import { openai as openaiClient, GPT4O_MODEL } from '../../src/lib/openai';
import { ICP_VARIANTS, PROMPT_STYLES, GENERATORS } from './config';
import type { RawEmail } from './types';

interface GenerateOptions {
  target: number;
  log?: (msg: string) => void;
}

const SYSTEM_PROMPT = `You are an AI cold-email writing assistant used by SDR tools.
Generate a single cold email exactly as if you were producing output for a customer of an AI SDR platform.
Do NOT explain. Do NOT add commentary. Output JSON only: { "subject": "...", "body": "..." }.`;

function userPrompt(icp: typeof ICP_VARIANTS[number], style: typeof PROMPT_STYLES[number]) {
  return `${style.instruction}

Target prospect:
- Industry: ${icp.industry}
- Role: ${icp.role}
- Company size: ${icp.size}

Value prop to convey: ${icp.valueProp}

Produce one cold email. Output JSON only.`;
}

async function generateOne(
  generator: typeof GENERATORS[number],
  icp: typeof ICP_VARIANTS[number],
  style: typeof PROMPT_STYLES[number],
): Promise<RawEmail | null> {
  try {
    let raw: string;

    if (generator.provider === 'anthropic') {
      const res = await anthropic().messages.create({
        model: SONNET_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(icp, style) }],
      });
      raw = res.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');
    } else {
      const res = await openaiClient().chat.completions.create({
        model: GPT4O_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(icp, style) },
        ],
        response_format: { type: 'json_object' },
      });
      raw = res.choices[0]?.message?.content ?? '';
    }

    // Extract JSON (some models wrap in code fences despite instructions)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string };
    if (!parsed.subject || !parsed.body) return null;

    return {
      origin: 'ai',
      source: `generator:${generator.provider}:${generator.model}`,
      model: generator.model,
      subject: parsed.subject,
      body: parsed.body,
      metadata: { icp: icp.industry, style: style.name },
    };
  } catch {
    // Soft-fail individual calls — we generate many; one missing is fine
    return null;
  }
}

export async function generateAi({ target, log = () => {} }: GenerateOptions): Promise<RawEmail[]> {
  const out: RawEmail[] = [];
  const combinations = GENERATORS.flatMap((g) =>
    ICP_VARIANTS.flatMap((icp) =>
      PROMPT_STYLES.map((style) => ({ generator: g, icp, style })),
    ),
  );

  // perCombo: aim to get target/combinations rounded up
  const perCombo = Math.max(1, Math.ceil(target / combinations.length));

  log(`Generating AI corpus: target=${target}, combinations=${combinations.length}, perCombo=${perCombo}`);

  for (const combo of combinations) {
    if (out.length >= target) break;
    for (let i = 0; i < perCombo && out.length < target; i++) {
      const email = await generateOne(combo.generator, combo.icp, combo.style);
      if (email) {
        out.push(email);
        log(`[${out.length}/${target}] ${combo.generator.model} × ${combo.icp.industry} × ${combo.style.name}`);
      }
    }
  }

  return out;
}
