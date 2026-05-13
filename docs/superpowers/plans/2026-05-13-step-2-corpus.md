# Step 2 — Corpus Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build the pipeline that produces the reference email corpus (`email_corpus` table) that Steps 3-5 calibrate against and Step 4's Genericness judge queries at runtime. Lands the code; running the pipeline against real data is a one-time bootstrap event after merge.

**Architecture:** Three parallel data sources — synthetic AI emails generated via LLMs, human emails loaded from a manually-curated CSV, template emails loaded from a manually-curated CSV. All three flow through one pipeline: segment into `(opener, body_middle, cta)` → embed each segment with OpenAI `text-embedding-3-small` → upsert into `email_corpus`. A `validate.ts` script checks the corpus passes a quality gate before judges can rely on it.

**Tech stack:** `@anthropic-ai/sdk` (Sonnet 4.6 generation), `openai` (GPT-4o generation + text-embedding-3-small), `csv-parse` for CSV loading. All scripts run via `tsx` from `scripts/corpus/`.

**Bootstrap-size targets** (down from spec's 3500 — easier iteration; expand later):
- AI: 500 synthetic emails (10 ICP variants × 5 prompt styles × 2 LLMs × 5 samples each)
- Human: 200 curated (founders gather; ~$50-100 of attention)
- Template: 100 curated (Apollo / Outreach / Lemlist / Lavender public template galleries)

Total ~800 rows. Calibration in Step 3 will reveal if this is enough to discriminate.

---

## File map

**Create:**
```
src/lib/anthropic.ts
src/lib/openai.ts

scripts/corpus/config.ts
scripts/corpus/generate-ai.ts
scripts/corpus/load-csv.ts
scripts/corpus/segment.ts
scripts/corpus/embed.ts
scripts/corpus/upsert.ts
scripts/corpus/build.ts
scripts/corpus/validate.ts
scripts/corpus/types.ts

tests/unit/segment.test.ts
tests/unit/load-csv.test.ts

data/seed-human-emails.csv     (gitignored; founders curate)
data/seed-template-emails.csv  (gitignored; founders curate)
data/seed-human-emails.example.csv     (5 example rows, committed)
data/seed-template-emails.example.csv  (5 example rows, committed)
```

**Modify:**
- `package.json` — add deps (anthropic, openai, csv-parse) + scripts (corpus:build, corpus:validate, corpus:smoke)
- `.env.local.example` — add ANTHROPIC_API_KEY, OPENAI_API_KEY
- `.gitignore` — add `data/seed-*.csv` (real seed data not committed)
- `README.md` — add Step 2 doc section

---

## Task 1 — Add deps and env vars

**Files:**
- Modify: `package.json`, `.env.local.example`, `.gitignore`

- [ ] **Step 1: Add deps**

Run:
```bash
pnpm add @anthropic-ai/sdk openai csv-parse
pnpm add -D @types/node-fetch
```

Expected: `pnpm-lock.yaml` updated, no peer-dep errors.

- [ ] **Step 2: Add scripts to `package.json`**

Inside the `scripts` object, after `"smoke": ...`, add:
```json
    "corpus:generate-ai": "tsx scripts/corpus/generate-ai.ts",
    "corpus:load-csv": "tsx scripts/corpus/load-csv.ts",
    "corpus:build": "tsx scripts/corpus/build.ts",
    "corpus:validate": "tsx scripts/corpus/validate.ts",
    "corpus:smoke": "tsx scripts/corpus/build.ts --smoke",
```

- [ ] **Step 3: Update `.env.local.example`**

Append at the end of the file:
```
# LLM providers (Step 2: corpus generation; Step 3-6: judges + generation)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

- [ ] **Step 4: Update `.gitignore`**

Append:
```
# Curated corpus seed data (not committed — founders paste real emails here)
data/seed-human-emails.csv
data/seed-template-emails.csv
```

- [ ] **Step 5: Populate your local `.env.local`**

Add your Anthropic + OpenAI keys to `.env.local`. If you don't have them yet, generate at https://console.anthropic.com and https://platform.openai.com.

- [ ] **Step 6: Verify**

Run: `pnpm typecheck`
Expected: clean (the new deps exist but aren't imported yet).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml .env.local.example .gitignore
git commit -m "chore: add anthropic + openai + csv-parse for corpus generation"
```

---

## Task 2 — Anthropic + OpenAI client factories

**Files:**
- Create: `src/lib/anthropic.ts`, `src/lib/openai.ts`

- [ ] **Step 1: Create `src/lib/anthropic.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

export function anthropic() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

export const SONNET_MODEL = 'claude-sonnet-4-6';
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
```

- [ ] **Step 2: Create `src/lib/openai.ts`**

```ts
import OpenAI from 'openai';

let _client: OpenAI | null = null;

export function openai() {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  _client = new OpenAI({ apiKey });
  return _client;
}

export const GPT4O_MODEL = 'gpt-4o';
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/anthropic.ts src/lib/openai.ts
git commit -m "feat: anthropic + openai client factories with env validation"
```

---

## Task 3 — Corpus config and shared types

**Files:**
- Create: `scripts/corpus/config.ts`, `scripts/corpus/types.ts`

- [ ] **Step 1: Create `scripts/corpus/types.ts`**

```ts
export type Origin = 'ai' | 'human' | 'template';

export interface RawEmail {
  origin: Origin;
  source?: string;       // url, dataset name, or generator id
  model?: string;        // for ai
  vendor?: string;       // for template
  subject: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface Segments {
  opener: string;
  bodyMiddle: string;
  cta: string;
}

export interface EmbeddedEmail extends RawEmail {
  segments: Segments;
  embedding: {
    opener: number[];
    body: number[];
    cta: number[];
  };
}
```

- [ ] **Step 2: Create `scripts/corpus/config.ts`**

```ts
export const CORPUS_TARGETS = {
  ai: 500,
  human: 200,
  template: 100,
} as const;

// Smoke run: tiny sample to verify the pipeline end-to-end without burning API quota
export const SMOKE_TARGETS = {
  ai: 4,
  human: 2,
  template: 2,
} as const;

// ICP variants the AI generator targets. Diverse enough that the generated
// corpus doesn't all read like emails to the same buyer.
export const ICP_VARIANTS = [
  { industry: 'B2B SaaS', role: 'Head of Sales', size: 'Series A-B (20-100 employees)', valueProp: 'cut deal cycle in half' },
  { industry: 'E-commerce DTC', role: 'CMO', size: '$10-50M ARR', valueProp: 'increase repeat purchase rate' },
  { industry: 'Healthcare IT', role: 'VP Engineering', size: '500-2000 employees', valueProp: 'HIPAA-compliant audit logs' },
  { industry: 'Financial Services', role: 'Head of Compliance', size: 'mid-market bank', valueProp: 'automate KYC review' },
  { industry: 'Construction', role: 'Operations Director', size: '$5-30M revenue', valueProp: 'reduce subcontractor invoice delays' },
  { industry: 'Manufacturing', role: 'Plant Manager', size: '100-500 employees', valueProp: 'predictive maintenance' },
  { industry: 'Education (K-12 SaaS)', role: 'Head of Product', size: 'late seed - Series A', valueProp: 'teacher onboarding flow' },
  { industry: 'Logistics / 3PL', role: 'VP Operations', size: '$20-200M revenue', valueProp: 'last-mile route optimization' },
  { industry: 'Real Estate (PropTech)', role: 'CTO', size: 'Series B+', valueProp: 'tenant communication automation' },
  { industry: 'Legal Tech', role: 'Head of Customer Success', size: 'post-Series A', valueProp: 'reduce onboarding time' },
] as const;

// Prompt styles intentionally cover the spectrum AI SDR tools produce.
// Names match what AI-Detection's `opener`/`structure`/`rhythm` axes look for.
export const PROMPT_STYLES = [
  { name: 'rigid-three-paragraph', instruction: 'Write a cold email with a 3-paragraph structure: opener referencing their company, middle paragraph with value prop and a stat, closing with a soft CTA.' },
  { name: 'hedge-heavy', instruction: 'Write a cold email that is polite, professional, and uses some hedging language ("might be", "could potentially", "I think").' },
  { name: 'casual-friendly', instruction: 'Write a casual, friendly cold email. Short paragraphs, conversational tone. Avoid corporate jargon.' },
  { name: 'data-driven', instruction: 'Write a cold email that leads with a specific stat about their industry, then asks if they\'re seeing the same trend.' },
  { name: 'question-led-cta', instruction: 'Write a cold email that ends with a dual-option CTA ("worth a quick chat, or open to ideas?").' },
] as const;

export const GENERATORS = [
  { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' },
  { provider: 'openai' as const, model: 'gpt-4o' },
];
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/corpus/config.ts scripts/corpus/types.ts
git commit -m "feat(corpus): config (ICP variants, prompt styles, generators) + shared types"
```

---

## Task 4 — Segment extractor (with unit tests)

**Files:**
- Create: `scripts/corpus/segment.ts`, `tests/unit/segment.test.ts`

TDD shape: write tests first, run to confirm they fail, implement, run to confirm they pass.

- [ ] **Step 1: Write the failing tests**

`tests/unit/segment.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test tests/unit/segment.test.ts`
Expected: 5 failures, all "Cannot find module '../../scripts/corpus/segment'".

- [ ] **Step 3: Implement `scripts/corpus/segment.ts`**

```ts
import type { Segments } from './types';

/**
 * Splits a cold email into (opener, body_middle, cta) for separate embedding.
 *
 * - opener: first sentence
 * - cta: last sentence ending in ? or !, else last paragraph
 * - body_middle: everything between opener and cta
 *
 * The split is intentionally heuristic. Cold-email shape is regular enough
 * that simple regex outperforms an LLM-based segmenter on cost and latency
 * (called ~3500 times during corpus build, ~1 time per generation at runtime).
 */
export function segment({ body }: { subject: string; body: string }): Segments {
  const normalized = body.trim().replace(/\r\n/g, '\n');

  // Find opener: first sentence (ends with . ? !)
  const openerMatch = normalized.match(/^(.+?[.!?])\s/);
  const opener = openerMatch ? openerMatch[1].trim() : normalized;

  // Find CTA: last sentence ending in ? or !
  const ctaMatch = normalized.match(/([^.!?]+[?!])\s*$/);
  let cta = ctaMatch ? ctaMatch[1].trim() : '';

  // Fallback CTA: last paragraph
  if (!cta) {
    const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    cta = paragraphs[paragraphs.length - 1] ?? '';
  }

  // body_middle: between opener and cta
  let bodyMiddle = normalized;
  if (opener && bodyMiddle.startsWith(opener)) {
    bodyMiddle = bodyMiddle.slice(opener.length).trim();
  }
  if (cta && bodyMiddle.endsWith(cta)) {
    bodyMiddle = bodyMiddle.slice(0, bodyMiddle.length - cta.length).trim();
  }
  // Strip trailing/leading punctuation/whitespace
  bodyMiddle = bodyMiddle.replace(/^[.\s]+|[\s]+$/g, '');

  // Edge case: single-sentence body — opener and cta point to the same thing
  if (opener === cta) {
    bodyMiddle = '';
  }

  return { opener, bodyMiddle, cta };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test tests/unit/segment.test.ts`
Expected: 5 passed.

If a test fails: the regex pattern is wrong for that edge case. Fix the regex (not the test) and re-run.

- [ ] **Step 5: Commit**

```bash
git add scripts/corpus/segment.ts tests/unit/segment.test.ts
git commit -m "feat(corpus): segment extractor (opener/body_middle/cta) + 5 unit tests"
```

---

## Task 5 — CSV loader (human + template corpora)

**Files:**
- Create: `scripts/corpus/load-csv.ts`, `tests/unit/load-csv.test.ts`, `data/seed-human-emails.example.csv`, `data/seed-template-emails.example.csv`

- [ ] **Step 1: Create example CSV files (committed) and gitignored placeholders**

`data/seed-human-emails.example.csv`:
```csv
source,subject,body
"r/sales 2025-Q4","Quick thought on your bonsai post","Hey Marc — saw your post about the juniper. Tried wiring last winter and snapped a primary branch. What time of year do you find safest? Curious how you got that taper."
"Twitter @founder_name","About your latest hire","Saw you brought Jen on as VP Eng. Worked with her at Linear in 2022 — she has a way of turning a vague platform vision into something six people can execute on tomorrow. Lucky to land her."
"Pavilion forum","Re: outbound channel test","Sent 40 emails to RevOps leaders this week using the angle we discussed. 6 replies, 3 calls booked. The thing that worked: dropping the 'I noticed' opener entirely. Just stating the specific problem we'd discussed at the dinner."
"Lavender blog","Sample 1","Pete — your team raised in April, doubled headcount, and the comp-plan post on LinkedIn mentioned you're rewriting variable comp from scratch. We built a comp tool for exactly this stage. Worth 20 minutes?"
"Manually curated","Cold email sample","Hey Dana, your podcast episode with Tomas was the first explanation of dunning that didn't feel like a sales pitch. We do collections automation for B2B SaaS. If your stack is Stripe + HubSpot we can show you a 12% recovery lift in 4 weeks. Open to a Tuesday?"
```

`data/seed-template-emails.example.csv`:
```csv
vendor,source,subject,body
"Apollo","apollo.io/templates/sales","I noticed {company} expanded","Hi {first_name}, I noticed {company} expanded into {market} recently. We help companies like yours streamline {value_prop}. Worth a quick chat next week?"
"Outreach","outreach.io/blog/cold-email-templates","Quick question about {company}","Hey {first_name}, hope this finds you well. I came across {company}'s recent {trigger_event} and wanted to reach out. We work with {role_keyword} leaders to {value_prop}. Open to a 15-minute conversation?"
"Lemlist","lemlist.com/templates","Saw your post on {topic}","Hi {first_name}, I saw your recent post on {topic} and it resonated. We're working with similar {industry} companies to address {pain_point}. Would love to share what we've learned. Worth a quick chat or open to ideas?"
"Reply","reply.io/cold-email-templates","Idea for {company}","{first_name}, I noticed your role at {company} and had an idea I think could be valuable. We help {industry} leaders {value_prop}. Could potentially save you {benefit}. Worth exploring?"
"HubSpot","hubspot.com/sales/cold-email-templates","Helping {company} with {pain_point}","Hi {first_name}, I might be reaching out at a bad time, but I think we could help {company} with {pain_point}. We've worked with similar {industry} companies. Would you be open to a brief conversation?"
```

Note these example rows are designed to illustrate the shape; founders will replace them with real curated content via `cp data/seed-human-emails.example.csv data/seed-human-emails.csv` and editing.

- [ ] **Step 2: Write the failing tests**

`tests/unit/load-csv.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseCsv } from '../../scripts/corpus/load-csv';

describe('parseCsv', () => {
  it('parses human corpus rows', () => {
    const csv = `source,subject,body
"r/sales","Test subject","Body content here"
"Twitter","Another subject","Another body"`;
    const rows = parseCsv(csv, 'human');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      origin: 'human',
      source: 'r/sales',
      subject: 'Test subject',
      body: 'Body content here',
    });
  });

  it('parses template corpus rows with vendor', () => {
    const csv = `vendor,source,subject,body
"Apollo","apollo.io/templates","Test","Body"`;
    const rows = parseCsv(csv, 'template');
    expect(rows[0]).toEqual({
      origin: 'template',
      vendor: 'Apollo',
      source: 'apollo.io/templates',
      subject: 'Test',
      body: 'Body',
    });
  });

  it('rejects rows with empty subject or body', () => {
    const csv = `source,subject,body
"x","","missing subject"
"y","has subject","valid"`;
    const rows = parseCsv(csv, 'human');
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('has subject');
  });

  it('throws on unknown origin', () => {
    expect(() => parseCsv('source,subject,body\na,b,c', 'ai' as never)).toThrow(/origin/i);
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

Run: `pnpm test tests/unit/load-csv.test.ts`
Expected: 4 failures, "Cannot find module '../../scripts/corpus/load-csv'".

- [ ] **Step 4: Implement `scripts/corpus/load-csv.ts`**

```ts
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import type { Origin, RawEmail } from './types';

interface CsvRow {
  source?: string;
  vendor?: string;
  subject: string;
  body: string;
}

export function parseCsv(csv: string, origin: Origin): RawEmail[] {
  if (origin !== 'human' && origin !== 'template') {
    throw new Error(`parseCsv expects origin 'human' or 'template', got '${origin}'`);
  }

  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  return records
    .filter((r) => r.subject && r.body)
    .map((r) => ({
      origin,
      source: r.source,
      vendor: r.vendor,
      subject: r.subject,
      body: r.body,
    }));
}

export function loadCsvFile(path: string, origin: Origin): RawEmail[] {
  const csv = readFileSync(path, 'utf-8');
  return parseCsv(csv, origin);
}
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `pnpm test tests/unit/load-csv.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/corpus/load-csv.ts tests/unit/load-csv.test.ts data/seed-human-emails.example.csv data/seed-template-emails.example.csv
git commit -m "feat(corpus): CSV loader for human + template corpora + 4 unit tests + example seeds"
```

---

## Task 6 — AI generator

**Files:**
- Create: `scripts/corpus/generate-ai.ts`

This task makes real API calls when run. The implementer should run it once at the end to verify it works (small smoke), but the full 500-row generation is a separate one-time event after merge.

- [ ] **Step 1: Implement `scripts/corpus/generate-ai.ts`**

```ts
import { anthropic, SONNET_MODEL } from '../../src/lib/anthropic';
import { openai as openaiClient, GPT4O_MODEL } from '../../src/lib/openai';
import { ICP_VARIANTS, PROMPT_STYLES, GENERATORS } from './config';
import type { RawEmail } from './types';

interface GenerateOptions {
  target: number;
  perVariantSamples?: number;  // how many samples per (ICP × style × model) combo
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
  } catch (e) {
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

// Type import for Anthropic.TextBlock used above
import type Anthropic from '@anthropic-ai/sdk';
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean. If `Anthropic.TextBlock` errors, hoist the type import to the top of the file (above the relative imports).

- [ ] **Step 3: Smoke-run with 2 samples**

Run:
```bash
ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' .env.local | cut -d= -f2-) \
OPENAI_API_KEY=$(grep '^OPENAI_API_KEY=' .env.local | cut -d= -f2-) \
node --experimental-strip-types -e "
import('./scripts/corpus/generate-ai.ts').then(async ({ generateAi }) => {
  const emails = await generateAi({ target: 2, log: (m) => console.error(m) });
  console.log(JSON.stringify(emails, null, 2));
});" 2>&1 | tail -30
```

Expected: prints 2 generated emails as JSON, each with `subject`, `body`, `model`, and metadata. If both providers error, check API keys.

- [ ] **Step 4: Commit**

```bash
git add scripts/corpus/generate-ai.ts
git commit -m "feat(corpus): AI generator (Anthropic Sonnet + OpenAI GPT-4o, 10 ICPs × 5 styles)"
```

---

## Task 7 — Embedder

**Files:**
- Create: `scripts/corpus/embed.ts`

- [ ] **Step 1: Implement `scripts/corpus/embed.ts`**

```ts
import { openai, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../../src/lib/openai';
import type { RawEmail, EmbeddedEmail, Segments } from './types';
import { segment } from './segment';

const BATCH_SIZE = 100;  // OpenAI accepts up to 2048 inputs per call; 100 keeps payloads small.

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

export async function embedEmails(
  emails: RawEmail[],
  log: (msg: string) => void = () => {},
): Promise<EmbeddedEmail[]> {
  // Segment all first
  const withSegments = emails.map((email) => ({
    email,
    segments: segment({ subject: email.subject, body: email.body }),
  }));

  // Build flat list of texts to embed (3 per email: opener, body, cta)
  const texts: string[] = [];
  for (const { segments } of withSegments) {
    texts.push(segments.opener || ' ', segments.bodyMiddle || ' ', segments.cta || ' ');
  }

  log(`Embedding ${texts.length} segments (${withSegments.length} emails × 3) in batches of ${BATCH_SIZE}…`);

  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await embedBatch(batch);
    allEmbeddings.push(...batchEmbeddings);
    log(`  ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
  }

  // Re-assemble: each email gets 3 consecutive embeddings
  const out: EmbeddedEmail[] = [];
  for (let i = 0; i < withSegments.length; i++) {
    const base = i * 3;
    const opener = allEmbeddings[base];
    const body = allEmbeddings[base + 1];
    const cta = allEmbeddings[base + 2];

    if (!opener || !body || !cta) throw new Error(`Missing embedding for email ${i}`);
    if (opener.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Unexpected dimension ${opener.length}, expected ${EMBEDDING_DIMENSIONS}`);
    }

    out.push({
      ...withSegments[i].email,
      segments: withSegments[i].segments,
      embedding: { opener, body, cta },
    });
  }

  return out;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add scripts/corpus/embed.ts
git commit -m "feat(corpus): embedder — segment + batch embed via text-embedding-3-small"
```

---

## Task 8 — Upsert into Postgres

**Files:**
- Create: `scripts/corpus/upsert.ts`

This script connects to the hosted DB and inserts/updates `email_corpus` rows. Uses the service-role connection (full privileges; corpus is global).

- [ ] **Step 1: Implement `scripts/corpus/upsert.ts`**

```ts
import postgres from 'postgres';
import type { EmbeddedEmail } from './types';

const SERVICE_URL = process.env.DATABASE_URL_SERVICE;

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export async function upsertEmails(
  emails: EmbeddedEmail[],
  log: (msg: string) => void = () => {},
): Promise<{ inserted: number }> {
  if (!SERVICE_URL) throw new Error('DATABASE_URL_SERVICE not set');
  const sql = postgres(SERVICE_URL, { prepare: false });

  try {
    log(`Upserting ${emails.length} rows into email_corpus…`);
    const BATCH = 50;

    let inserted = 0;
    for (let i = 0; i < emails.length; i += BATCH) {
      const batch = emails.slice(i, i + BATCH);
      const values = batch.map((e) => ({
        source: e.source ?? null,
        origin: e.origin,
        model: e.model ?? null,
        vendor: e.vendor ?? null,
        subject: e.subject,
        body: e.body,
        embedding_opener: vectorLiteral(e.embedding.opener),
        embedding_body:   vectorLiteral(e.embedding.body),
        embedding_cta:    vectorLiteral(e.embedding.cta),
        metadata_jsonb:   e.metadata ?? {},
      }));

      await sql`
        insert into email_corpus
          (source, origin, model, vendor, subject, body,
           embedding_opener, embedding_body, embedding_cta, metadata_jsonb)
        select
          v.source, v.origin, v.model, v.vendor, v.subject, v.body,
          v.embedding_opener::vector, v.embedding_body::vector, v.embedding_cta::vector,
          v.metadata_jsonb::jsonb
        from json_to_recordset(${JSON.stringify(values)}::json) as v(
          source text, origin text, model text, vendor text, subject text, body text,
          embedding_opener text, embedding_body text, embedding_cta text, metadata_jsonb json
        )
      `;
      inserted += batch.length;
      log(`  ${inserted}/${emails.length}`);
    }

    return { inserted };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add scripts/corpus/upsert.ts
git commit -m "feat(corpus): upsert into email_corpus with json_to_recordset batching"
```

---

## Task 9 — Orchestrator (build.ts)

**Files:**
- Create: `scripts/corpus/build.ts`

- [ ] **Step 1: Implement `scripts/corpus/build.ts`**

```ts
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { existsSync } from 'node:fs';
import { generateAi } from './generate-ai';
import { loadCsvFile } from './load-csv';
import { embedEmails } from './embed';
import { upsertEmails } from './upsert';
import { CORPUS_TARGETS, SMOKE_TARGETS } from './config';
import type { RawEmail } from './types';

const isSmoke = process.argv.includes('--smoke');
const TARGETS = isSmoke ? SMOKE_TARGETS : CORPUS_TARGETS;

const HUMAN_CSV = 'data/seed-human-emails.csv';
const TEMPLATE_CSV = 'data/seed-template-emails.csv';

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

async function main() {
  log(`Building corpus (${isSmoke ? 'SMOKE' : 'FULL'}): targets=${JSON.stringify(TARGETS)}`);

  const all: RawEmail[] = [];

  // 1. AI
  log(`\n── AI corpus ──`);
  const ai = await generateAi({ target: TARGETS.ai, log });
  log(`  generated ${ai.length} AI emails`);
  all.push(...ai);

  // 2. Human (CSV)
  log(`\n── Human corpus ──`);
  if (!existsSync(HUMAN_CSV)) {
    log(`  ${HUMAN_CSV} not found — using example file as fallback.`);
    log(`  Copy data/seed-human-emails.example.csv → ${HUMAN_CSV} and curate.`);
    const human = loadCsvFile('data/seed-human-emails.example.csv', 'human').slice(0, TARGETS.human);
    log(`  loaded ${human.length} human emails (from example file)`);
    all.push(...human);
  } else {
    const human = loadCsvFile(HUMAN_CSV, 'human').slice(0, TARGETS.human);
    log(`  loaded ${human.length} human emails`);
    all.push(...human);
  }

  // 3. Template (CSV)
  log(`\n── Template corpus ──`);
  if (!existsSync(TEMPLATE_CSV)) {
    log(`  ${TEMPLATE_CSV} not found — using example file as fallback.`);
    const template = loadCsvFile('data/seed-template-emails.example.csv', 'template').slice(0, TARGETS.template);
    log(`  loaded ${template.length} template emails (from example file)`);
    all.push(...template);
  } else {
    const template = loadCsvFile(TEMPLATE_CSV, 'template').slice(0, TARGETS.template);
    log(`  loaded ${template.length} template emails`);
    all.push(...template);
  }

  // 4. Segment + embed
  log(`\n── Embedding ──`);
  const embedded = await embedEmails(all, log);

  // 5. Upsert
  log(`\n── Upsert ──`);
  const { inserted } = await upsertEmails(embedded, log);

  log(`\n✓ Done. Inserted ${inserted} rows. Run 'pnpm corpus:validate' to gate.`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  log(`FAILED: ${msg}`);
  if (e instanceof Error && e.stack) log(e.stack);
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Smoke run (8 total emails, ~$0.05 in API spend)**

Run: `pnpm corpus:smoke 2>&1 | tail -30`
Expected: prints "Done. Inserted 8 rows." or similar. If a step fails, the error message identifies which stage (AI gen / embedding / upsert).

After successful run, verify in the DB:
```bash
psql "$DATABASE_URL" -c "select origin, count(*) from email_corpus group by origin order by origin;"
```
Expected: 3 rows showing ai=4, human=2, template=2.

- [ ] **Step 4: Clean up smoke data so it doesn't pollute the real corpus**

```bash
psql "$DATABASE_URL" -c "delete from email_corpus where metadata_jsonb->>'style' is not null and source like 'generator:%';"
psql "$DATABASE_URL" -c "delete from email_corpus where source in ('r/sales 2025-Q4','Twitter @founder_name','Pavilion forum','Lavender blog','Manually curated','apollo.io/templates/sales','outreach.io/blog/cold-email-templates','lemlist.com/templates','reply.io/cold-email-templates','hubspot.com/sales/cold-email-templates');"
```

(Yes this is hacky for smoke cleanup — the example data is identifiable by source string. For the real corpus run, no cleanup is needed.)

- [ ] **Step 5: Commit**

```bash
git add scripts/corpus/build.ts
git commit -m "feat(corpus): orchestrator with --smoke flag (AI gen → CSV load → embed → upsert)"
```

---

## Task 10 — Validator (quality gate)

**Files:**
- Create: `scripts/corpus/validate.ts`

- [ ] **Step 1: Implement `scripts/corpus/validate.ts`**

```ts
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import postgres from 'postgres';
import { CORPUS_TARGETS } from './config';

// Quality gate thresholds. Defined as a fraction of the per-origin target so
// we tolerate ~10% AI generation drop-offs without failing the gate.
const MIN_FRACTION = 0.9;

async function main() {
  const url = process.env.DATABASE_URL_SERVICE;
  if (!url) throw new Error('DATABASE_URL_SERVICE not set');
  const sql = postgres(url, { prepare: false });
  const failures: string[] = [];

  try {
    // 1. Row counts per origin
    const counts = await sql<{ origin: string; count: number }[]>`
      select origin, count(*)::int as count from email_corpus group by origin
    `;
    const byOrigin = Object.fromEntries(counts.map((r) => [r.origin, r.count]));

    for (const [origin, target] of Object.entries(CORPUS_TARGETS)) {
      const actual = byOrigin[origin] ?? 0;
      const minimum = Math.floor(target * MIN_FRACTION);
      const status = actual >= minimum ? '✓' : '✗';
      console.log(`${status} ${origin}: ${actual} rows (target ${target}, min ${minimum})`);
      if (actual < minimum) failures.push(`${origin}: only ${actual} rows, need ${minimum}`);
    }

    // 2. No null embeddings on rows we care about
    const nullEmbeddings = await sql<{ count: number }[]>`
      select count(*)::int as count from email_corpus
      where embedding_body is null or embedding_opener is null or embedding_cta is null
    `;
    const nullCount = nullEmbeddings[0]?.count ?? 0;
    const embStatus = nullCount === 0 ? '✓' : '✗';
    console.log(`${embStatus} embeddings: ${nullCount} rows have null embedding columns (need 0)`);
    if (nullCount > 0) failures.push(`${nullCount} rows have null embeddings`);

    // 3. Spot-check sample for manual review
    console.log(`\n── 5 random sample rows for spot-check ──`);
    const samples = await sql<{ origin: string; source: string; subject: string; body: string }[]>`
      select origin, source, subject, substring(body, 1, 120) as body
      from email_corpus order by random() limit 5
    `;
    for (const s of samples) {
      console.log(`  [${s.origin}] ${s.source ?? '?'}`);
      console.log(`    SUBJECT: ${s.subject}`);
      console.log(`    BODY:    ${s.body}…\n`);
    }

    if (failures.length > 0) {
      console.error(`\n✗ Validation FAILED:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\n✓ Corpus validation passed.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e: unknown) => {
  console.error('Validation error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Test against an empty corpus**

Run: `pnpm corpus:validate 2>&1 | tail -15`
Expected (against an empty `email_corpus` table): prints ✗ for each origin (0 rows), prints 0 null embeddings, exits with code 1 and "Validation FAILED" message.

- [ ] **Step 4: Commit**

```bash
git add scripts/corpus/validate.ts
git commit -m "feat(corpus): validator — row counts + embedding completeness + spot-check sample"
```

---

## Task 11 — Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Corpus bootstrap" section to README**

In `README.md`, after the "Dev loop" section and before "Schema source of truth", insert:

```markdown
## Corpus bootstrap (Step 2)

The Genericness judge (Step 4) compares each generated email against a reference corpus stored in `email_corpus`. Three origins:

- **`ai`** — generated by Anthropic Sonnet 4.6 + OpenAI GPT-4o across 10 ICP variants × 5 prompt styles. Cost ~$10 for 500 emails.
- **`human`** — curated by founders. Paste real cold emails you've sent (or seen) into `data/seed-human-emails.csv` using the example file as a template. Aim for 200.
- **`template`** — public templates from Apollo / Outreach / Lemlist / etc. Paste into `data/seed-template-emails.csv`. Aim for 100.

**To bootstrap:**

```bash
# Smoke test the pipeline (~8 emails, ~$0.05 in API spend)
pnpm corpus:smoke

# 1. Curate human + template CSVs
cp data/seed-human-emails.example.csv data/seed-human-emails.csv
cp data/seed-template-emails.example.csv data/seed-template-emails.csv
# Edit both. Aim for 200 + 100 rows.

# 2. Full build (~$10, ~30 min)
pnpm corpus:build

# 3. Validate
pnpm corpus:validate
```

The build is idempotent in the sense that re-running will INSERT new rows (no dedup yet). For now: if you want to rebuild from scratch, truncate `email_corpus` first.

To resize: edit `CORPUS_TARGETS` in `scripts/corpus/config.ts`.
```

- [ ] **Step 2: Update the build sequence checklist in README**

Find the line `2. Corpus generator + embedder` and replace with:
```
2. ✅ Corpus generator + embedder
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: corpus bootstrap section + mark Step 2 done in build sequence"
```

---

## Self-review

**Spec coverage** (spec section → task):
- §6 Corpus bootstrap pipeline — Tasks 4, 5, 6, 7, 8, 9
- §6 Quality gate — Task 10
- §4 Stack (Anthropic, OpenAI text-embedding-3-small) — Tasks 1, 2

**Deferred (correctly, not in Step 2):**
- Apify enrichment — Step 8 (when prospects land)
- AI-Detection judge calibration against this corpus — Step 3
- Genericness similarity query — Step 4

**Bootstrap-size note:** spec §6 originally targets 3,500 rows (2000 AI + 1000 human + 500 template). This plan ships with `CORPUS_TARGETS = { ai: 500, human: 200, template: 100 }` for faster iteration. Step 3's calibration test will reveal whether 800 rows is enough to discriminate. If not: bump `CORPUS_TARGETS` and re-run `pnpm corpus:build`.

**Placeholder scan:** every code step has complete code, every command has expected output, no TBDs.

**Type consistency:** `RawEmail`, `EmbeddedEmail`, `Segments`, `Origin` defined in `types.ts` and used consistently. The orchestrator's `RawEmail` flows through embed → upsert preserving the type.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-13-step-2-corpus.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review.

**2. Inline Execution** — work the plan in this session.

Which?
