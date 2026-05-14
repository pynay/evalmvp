# Step 6 — Generation + Regen Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Build the eval-gated generation loop. Given a (prospect, sender, ICP) triple, the loop generates a draft via Sonnet 4.6, scores it in parallel with the 3 judges from Steps 3-5, blends the scores (0.4 × AI-Detection + 0.3 × Genericness + 0.3 × Personalization), and either queues the draft for approval (overall ≥ threshold) or regenerates with structured feedback (up to 3 retries; then flag).

This step is **the first point the product can produce an end-to-end email.** Everything before this was scaffolding and components.

**Architecture:** A pure orchestrator function `generateForProspect({ prospect, sender, icp, threshold }) → GenerationResult`. No Inngest in this step — we run synchronously for the bare-MVP CLI. Later (Step 9 when UI lands, or post-bare-MVP) we'll wire to Inngest's event-driven model so the eval loop runs in the background. The pure orchestrator function is the same; only the trigger changes.

**Inputs in the bare MVP come from JSON fixture files** (`tests/fixtures/generation/sender.json`, `tests/fixtures/generation/prospect.json`). Step 7's setup page (later) will write these into the `senders` and `prospects` tables. Step 8's prospect input (later) will replace the prospect fixture. Until then, hand-curate the fixtures to test with your own voice samples + a real prospect.

**No DB persistence in Step 6's CLI path.** The loop runs in memory and prints results to stdout. Later when the UI lands, generations get persisted to the `generations` table and scores to `scores`. The orchestrator function signature is designed so adding persistence is a trivial wrapper.

---

## File map

**Create:**
```
prompts/generation/v1.md                        # versioned system prompt template

src/lib/generation/types.ts                      # GenerationResult, ScoreBundle, FeedbackContext
src/lib/generation/blend.ts                      # blendOverall (0.4/0.3/0.3)
src/lib/generation/feedback.ts                   # buildFeedback (structured + critique)
src/lib/generation/prompt.ts                     # buildSystemPrompt, buildUserPrompt
src/lib/generation/generate.ts                   # generateDraft (Sonnet call)
src/lib/generation/score-all.ts                  # parallel fan-out to 3 judges
src/lib/generation/loop.ts                       # the orchestrator

scripts/generation/generate-single.ts            # CLI: run loop on fixture prospect

tests/unit/blend.test.ts                         # blendOverall tests (TDD)
tests/unit/feedback.test.ts                      # buildFeedback tests (TDD)
tests/unit/prompt.test.ts                        # prompt builder tests (TDD)

tests/fixtures/generation/sender.example.json    # template (committed)
tests/fixtures/generation/prospect.example.json  # template (committed)
```

**Modify:**
- `package.json` — add `gen:single` script
- `.gitignore` — add `tests/fixtures/generation/sender.json` and `prospect.json` (real-data versions)
- `README.md` — Step 6 doc section

---

## Task 1 — Generation prompt template + types

**Files:**
- Create: `prompts/generation/v1.md`, `src/lib/generation/types.ts`

- [ ] **Step 1: Create directories**

`mkdir -p prompts/generation src/lib/generation tests/fixtures/generation scripts/generation`

- [ ] **Step 2: Create `prompts/generation/v1.md`** with this content:

````markdown
# Generation Prompt — v1

You write cold emails in the voice of the sender. Your job is to produce one email for a specific prospect that scores above 70/100 on three independent quality judges: AI-Detection (looks human), Genericness (doesn't match templated patterns), and Personalization (references real prospect data).

## Hard rules — DO NOT BREAK

- **No em-dashes (—).** Use a comma, period, or two short sentences instead.
- **No template placeholders.** Never write `{company}`, `{first_name}`, `<company>`, `[company]`, etc. — these are unsubstituted variables that signal templated output. Always substitute real prospect data.
- **No banned openers:** "I came across", "I noticed your", "hope this finds you", "saw your recent", "I wanted to reach out about", "given your background", "based on your profile"
- **No banned vocabulary:** "leverage", "synergize", "streamline", "robust", "innovative", "scalable", "value prop", "best-in-class", "thought leader", "companies like yours", "leaders like you"
- **No dual-option CTAs:** ("worth a quick chat, or open to ideas?"). Pick one.
- **No hedging stack:** at most one of "might", "could potentially", "I think this could" per email.

## Required

- **Subject line:** ≤60 chars, references something specific to this prospect (not their role or industry)
- **Body:** 60–150 words. Conversational, not corporate.
- **At least 2 grounded references** to the prospect's actual data from the enrichment JSON. A grounded reference is a specific verifiable fact (a post they wrote, a person they hired, a number from a news mention, a quote from their about section). Generic mentions of their role or industry don't count.
- **Single concrete CTA:** either a specific time ("Tuesday at 2pm?") or a referenced shared context ("happy to share what we showed Acme")
- **Match the sender's voice.** Study the voice samples for sentence length variance, opener style, punctuation density, vocabulary. Your output should be plausible coming from the same writer.

## Voice samples (the sender's actual cold emails — match this style)

{{VOICE_SAMPLES}}

## ICP definition

{{ICP}}

## Output format

Return JSON only. No commentary, no code fences:

```json
{ "subject": "...", "body": "..." }
```

The body must be plain text. Use `\n\n` for paragraph breaks if needed.
````

- [ ] **Step 3: Create `src/lib/generation/types.ts`** with:

```ts
import type { AiDetectionOutput, GenericnessOutput, PersonalizationOutput } from '../judges/types';

export interface Draft {
  subject: string;
  body: string;
}

export interface Sender {
  name: string;
  email: string;
  voiceSamples: Array<{ subject: string; body: string }>;
}

export interface Icp {
  industry: string[];
  roleKeywords: string[];
  valueProp: string;
  sizeRange?: string;       // human-readable like "Series A-B (20-100 employees)"
}

export interface Prospect {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  role?: string;
  enrichment: Record<string, unknown>;  // LinkedIn + custom fields, free-form
}

export interface ScoreBundle {
  aiDetection: AiDetectionOutput;
  genericness: GenericnessOutput;
  personalization: PersonalizationOutput;
}

export type LoopStatus = 'needs_review' | 'flagged';

export interface GenerationResult {
  status: LoopStatus;
  finalDraft: Draft;
  finalScores: ScoreBundle;
  overall: number;
  retryCount: number;            // 0 = passed on first attempt
  attempts: Array<{
    draft: Draft;
    scores: ScoreBundle;
    overall: number;
  }>;
}

export const GENERATION_VERSION = 'v1';

// Spec §7.4 blend weights
export const BLEND_WEIGHTS = {
  aiDetection: 0.4,
  genericness: 0.3,
  personalization: 0.3,
} as const;

export const DEFAULT_THRESHOLD = 70;
export const MAX_RETRIES = 3;
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add prompts/generation/v1.md src/lib/generation/types.ts
git commit -m "feat(gen): generation prompt v1 + shared types (blend weights, threshold, retries)"
```

---

## Task 2 — Pure helpers: blend + feedback (TDD)

**Files:**
- Create: `src/lib/generation/blend.ts`, `src/lib/generation/feedback.ts`, `tests/unit/blend.test.ts`, `tests/unit/feedback.test.ts`

- [ ] **Step 1: Write failing tests** at `tests/unit/blend.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { blendOverall } from '../../src/lib/generation/blend';
import type { ScoreBundle } from '../../src/lib/generation/types';

function bundle(ai: number, gen: number, pers: number): ScoreBundle {
  return {
    aiDetection:    { axisScores: { opener: 0, structure: 0, hedging: 0, cta: 0, vocabulary: 0, punctuation: 0, rhythm: 0 }, overall: ai, redFlags: [] },
    genericness:    { axisScores: { opener: 0, body: 0, cta: 0 }, overall: gen, evidence: [] },
    personalization:{ references: [], genericTokenHits: [], groundedRefCount: 0, score: pers },
  };
}

describe('blendOverall', () => {
  it('matches spec weights 0.4/0.3/0.3', () => {
    expect(blendOverall(bundle(100, 0, 0))).toBe(40);
    expect(blendOverall(bundle(0, 100, 0))).toBe(30);
    expect(blendOverall(bundle(0, 0, 100))).toBe(30);
  });

  it('all 100 → 100', () => {
    expect(blendOverall(bundle(100, 100, 100))).toBe(100);
  });

  it('all 70 → 70', () => {
    expect(blendOverall(bundle(70, 70, 70))).toBe(70);
  });

  it('mixed: 80 / 60 / 50 → 0.4×80 + 0.3×60 + 0.3×50 = 32 + 18 + 15 = 65', () => {
    expect(blendOverall(bundle(80, 60, 50))).toBe(65);
  });

  it('rounds to nearest integer', () => {
    // 0.4 × 75 + 0.3 × 75 + 0.3 × 75 = 75 exact, no rounding
    expect(blendOverall(bundle(75, 75, 75))).toBe(75);
    // 0.4 × 73 + 0.3 × 67 + 0.3 × 71 = 29.2 + 20.1 + 21.3 = 70.6 → 71
    expect(blendOverall(bundle(73, 67, 71))).toBe(71);
  });
});
```

- [ ] **Step 2: Run tests, confirm 5 failures**

Run: `pnpm test tests/unit/blend.test.ts 2>&1 | tail -10`

- [ ] **Step 3: Implement** `src/lib/generation/blend.ts`:

```ts
import { BLEND_WEIGHTS, type ScoreBundle } from './types';

/**
 * Blend the three judge scores into a single 0-100 overall.
 * Weights from spec §7.4: 0.4 × AI-Detection + 0.3 × Genericness + 0.3 × Personalization.
 * Result is rounded to the nearest integer.
 */
export function blendOverall(scores: ScoreBundle): number {
  const blended =
    BLEND_WEIGHTS.aiDetection    * scores.aiDetection.overall +
    BLEND_WEIGHTS.genericness    * scores.genericness.overall +
    BLEND_WEIGHTS.personalization * scores.personalization.score;
  return Math.round(blended);
}
```

- [ ] **Step 4: Run tests, confirm 5 pass**

Run: `pnpm test tests/unit/blend.test.ts 2>&1 | tail -10`

- [ ] **Step 5: Write failing tests** at `tests/unit/feedback.test.ts`:

```ts
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
        redFlags: [
          { axis: 'opener', evidence: 'I noticed your', severity: 'high' },
        ],
      },
      genericness:    { axisScores: { opener: 90, body: 90, cta: 90 }, overall: 90, evidence: [] },
      personalization:{ references: [], genericTokenHits: [], groundedRefCount: 2, score: 50 },
    };
    const fb = buildFeedback(draft, bundle1, 58);
    expect(fb).toContain('opener');
    expect(fb).toContain('I noticed your');
  });
});
```

- [ ] **Step 6: Run tests, confirm 6 failures**

Run: `pnpm test tests/unit/feedback.test.ts 2>&1 | tail -10`

- [ ] **Step 7: Implement** `src/lib/generation/feedback.ts`:

```ts
import type { Draft, ScoreBundle } from './types';

/**
 * Build the structured + natural-language feedback included in the user message
 * on retry attempts. Spec §7.3 says the regen prompt gets both structured
 * sub-score deltas AND a natural-language critique. v1 critique is rule-based
 * (deterministic, free) — we can A/B against an LLM-generated critique later.
 *
 * The feedback should make the generator focus on the LOWEST-scoring axis first
 * while preserving what worked elsewhere.
 */
export function buildFeedback(
  prevDraft: Draft,
  prevScores: ScoreBundle,
  prevOverall: number,
): string {
  const lines: string[] = [];

  lines.push(`PREVIOUS_DRAFT:`);
  lines.push(`Subject: ${prevDraft.subject}`);
  lines.push(prevDraft.body);
  lines.push(``);

  const ai = Math.round(prevScores.aiDetection.overall);
  const gen = Math.round(prevScores.genericness.overall);
  const pers = prevScores.personalization.score;

  lines.push(`SCORES (previous draft scored ${prevOverall}/100; need 70):`);
  lines.push(`  ai_detection: ${ai} (target ≥70; higher = more human)`);
  lines.push(`  genericness: ${gen} (target ≥70; higher = more unique)`);
  lines.push(`  personalization: ${pers} (target ≥70; grounded_refs=${prevScores.personalization.groundedRefCount}, generic_tokens=${prevScores.personalization.genericTokenHits.length})`);
  lines.push(``);

  // Identify the lowest-scoring judge
  const judgeScores: Array<[string, number]> = [
    ['ai_detection', ai],
    ['genericness', gen],
    ['personalization', pers],
  ];
  judgeScores.sort((a, b) => a[1] - b[1]);
  const [lowestName] = judgeScores[0];

  lines.push(`CRITIQUE:`);
  lines.push(`The lowest-scoring dimension is ${lowestName}. Focus the rewrite on lifting that one first.`);

  // Specific guidance per axis
  if (lowestName === 'ai_detection') {
    // Surface low axes and red flags
    const axes = prevScores.aiDetection.axisScores;
    const lowAxes = Object.entries(axes)
      .filter(([_, s]) => s < 50)
      .map(([name, s]) => `${name}=${s}`);
    if (lowAxes.length > 0) {
      lines.push(`  Low axes: ${lowAxes.join(', ')}`);
    }
    const flags = prevScores.aiDetection.redFlags;
    if (flags.length > 0) {
      lines.push(`  Red flags from previous draft:`);
      for (const f of flags) {
        lines.push(`    - ${f.axis} (${f.severity}): "${f.evidence}"`);
      }
    }
  } else if (lowestName === 'personalization') {
    if (prevScores.personalization.genericTokenHits.length > 0) {
      lines.push(`  Replace these generic tokens with real prospect data from the enrichment JSON:`);
      for (const hit of prevScores.personalization.genericTokenHits) {
        lines.push(`    - "${hit}"`);
      }
    }
    if (prevScores.personalization.groundedRefCount === 0) {
      lines.push(`  Zero grounded references — add at least 2 specific facts from the enrichment that anchor to verifiable prospect data (a post they wrote, a person they hired, a number from a news mention).`);
    }
  } else {
    // genericness lowest
    lines.push(`  The draft reads close to known AI SDR templates. Try a less common opener, vary sentence rhythm, drop any 3-paragraph structure.`);
  }

  lines.push(``);
  lines.push(`INSTRUCTIONS: Rewrite the email below. Preserve what worked in the highest-scoring dimension. Do NOT just paraphrase the previous draft.`);

  return lines.join('\n');
}
```

- [ ] **Step 8: Run tests, confirm 6 pass**

Run: `pnpm test tests/unit/feedback.test.ts 2>&1 | tail -10`

- [ ] **Step 9: Full test suite**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -10`
Expected: all 50 tests pass (39 + 5 + 6).

- [ ] **Step 10: Commit**

```bash
git add src/lib/generation/blend.ts src/lib/generation/feedback.ts tests/unit/blend.test.ts tests/unit/feedback.test.ts
git commit -m "feat(gen): blendOverall + buildFeedback + 11 unit tests"
```

---

## Task 3 — Prompt builders (TDD)

**Files:**
- Create: `src/lib/generation/prompt.ts`, `tests/unit/prompt.test.ts`

- [ ] **Step 1: Write failing tests** at `tests/unit/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt } from '../../src/lib/generation/prompt';
import type { Sender, Icp, Prospect } from '../../src/lib/generation/types';

const sender: Sender = {
  name: 'Pranay',
  email: 'pranay@evalmvp.com',
  voiceSamples: [
    { subject: 'About your latest hire', body: 'Saw you brought Jen on as VP Eng. Worked with her at Linear in 2022.' },
    { subject: 'Bonsai post', body: 'Hey Marc — saw your post about the juniper. Tried wiring last winter.' },
  ],
};

const icp: Icp = {
  industry: ['B2B SaaS'],
  roleKeywords: ['Head of Sales', 'VP Sales'],
  valueProp: 'cut deal cycle in half',
  sizeRange: 'Series A-B',
};

const prospect: Prospect = {
  email: 'pete@acme.com',
  firstName: 'Pete',
  company: 'Acme',
  role: 'CTO',
  enrichment: {
    headline: 'CTO at Acme',
    recent_posts: [{ title: 'Ditching Datadog for Tempo' }],
  },
};

describe('buildSystemPrompt', () => {
  it('includes voice samples verbatim', () => {
    const sys = buildSystemPrompt(sender, icp);
    expect(sys).toContain('Saw you brought Jen on as VP Eng');
    expect(sys).toContain('Bonsai post');
  });

  it('includes ICP fields', () => {
    const sys = buildSystemPrompt(sender, icp);
    expect(sys).toContain('B2B SaaS');
    expect(sys).toContain('cut deal cycle in half');
  });

  it('contains the banned-vocabulary list (hard rules)', () => {
    const sys = buildSystemPrompt(sender, icp);
    expect(sys.toLowerCase()).toContain('leverage');
    expect(sys.toLowerCase()).toContain('em-dash');
  });
});

describe('buildUserPrompt', () => {
  it('includes prospect fields', () => {
    const user = buildUserPrompt({ prospect, feedback: null });
    expect(user).toContain('Pete');
    expect(user).toContain('Acme');
    expect(user).toContain('CTO');
  });

  it('serializes enrichment as JSON', () => {
    const user = buildUserPrompt({ prospect, feedback: null });
    expect(user).toContain('Ditching Datadog for Tempo');
  });

  it('includes feedback block on retry', () => {
    const fb = 'PREVIOUS_DRAFT:\nSubject: x\nbody\n\nSCORES:\n  ai_detection: 30';
    const user = buildUserPrompt({ prospect, feedback: fb });
    expect(user).toContain('PREVIOUS_DRAFT');
    expect(user).toContain('ai_detection: 30');
  });

  it('omits feedback block on first attempt', () => {
    const user = buildUserPrompt({ prospect, feedback: null });
    expect(user).not.toContain('PREVIOUS_DRAFT');
  });
});
```

- [ ] **Step 2: Run tests, confirm 7 failures**

Run: `pnpm test tests/unit/prompt.test.ts 2>&1 | tail -10`

- [ ] **Step 3: Implement** `src/lib/generation/prompt.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Sender, Icp, Prospect } from './types';

const TEMPLATE = readFileSync(resolve(process.cwd(), 'prompts/generation/v1.md'), 'utf-8');

function renderVoiceSamples(samples: Array<{ subject: string; body: string }>): string {
  return samples
    .map((s, i) => `### Sample ${i + 1}\nSubject: ${s.subject}\n\n${s.body}`)
    .join('\n\n---\n\n');
}

function renderIcp(icp: Icp): string {
  const lines = [
    `- Industry: ${icp.industry.join(', ')}`,
    `- Target role(s): ${icp.roleKeywords.join(', ')}`,
    `- Value prop: ${icp.valueProp}`,
  ];
  if (icp.sizeRange) lines.push(`- Company size: ${icp.sizeRange}`);
  return lines.join('\n');
}

export function buildSystemPrompt(sender: Sender, icp: Icp): string {
  return TEMPLATE
    .replace('{{VOICE_SAMPLES}}', renderVoiceSamples(sender.voiceSamples))
    .replace('{{ICP}}', renderIcp(icp));
}

export function buildUserPrompt(args: { prospect: Prospect; feedback: string | null }): string {
  const { prospect, feedback } = args;
  const lines = [
    `Write a cold email to this prospect.`,
    ``,
    `Prospect:`,
    `- Name: ${prospect.firstName ?? '(unknown)'}${prospect.lastName ? ' ' + prospect.lastName : ''}`,
    `- Email: ${prospect.email}`,
    `- Company: ${prospect.company ?? '(unknown)'}`,
    `- Role: ${prospect.role ?? '(unknown)'}`,
    ``,
    `Enrichment JSON:`,
    JSON.stringify(prospect.enrichment, null, 2),
    ``,
  ];

  if (feedback) {
    lines.push(`---`);
    lines.push(feedback);
    lines.push(`---`);
    lines.push(``);
  }

  lines.push(`Output JSON only: { "subject": "...", "body": "..." }`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests, confirm 7 pass**

Run: `pnpm test tests/unit/prompt.test.ts 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation/prompt.ts tests/unit/prompt.test.ts
git commit -m "feat(gen): system + user prompt builders + 7 unit tests"
```

---

## Task 4 — generateDraft (Sonnet call) + scoreAll (parallel fan-out)

**Files:**
- Create: `src/lib/generation/generate.ts`, `src/lib/generation/score-all.ts`

- [ ] **Step 1: Implement** `src/lib/generation/generate.ts`:

```ts
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
  feedback: string | null;     // null on first attempt, regen-feedback string on retries
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
```

- [ ] **Step 2: Implement** `src/lib/generation/score-all.ts`:

```ts
import { aiDetection } from '../judges/ai-detection';
import { genericness } from '../judges/genericness';
import { personalization } from '../judges/personalization';
import type { Draft, ScoreBundle, Prospect } from './types';

/**
 * Fan out to all three judges in parallel. Total wall time ≈ max(judge latencies).
 * AI-Detection (~1.5s) and Personalization (~1.5s) are Haiku calls; Genericness
 * is ~50ms pgvector + ~100ms embedding ≈ 200ms total. So bottleneck is ~1.5s.
 */
export async function scoreAll(draft: Draft, prospect: Prospect): Promise<ScoreBundle> {
  const [aiResult, genericResult, persResult] = await Promise.all([
    aiDetection({ subject: draft.subject, body: draft.body }),
    genericness({ subject: draft.subject, body: draft.body }),
    personalization({
      subject: draft.subject,
      body: draft.body,
      enrichment: prospect.enrichment,
    }),
  ]);
  return { aiDetection: aiResult, genericness: genericResult, personalization: persResult };
}
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -10`
Expected: typecheck clean. 57 tests still pass (50 + nothing new — these files are integration code, tested via the loop in Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/lib/generation/generate.ts src/lib/generation/score-all.ts
git commit -m "feat(gen): generateDraft (Sonnet 4.6) + scoreAll (parallel 3-judge fan-out)"
```

---

## Task 5 — Loop orchestrator

**Files:**
- Create: `src/lib/generation/loop.ts`

- [ ] **Step 1: Implement** `src/lib/generation/loop.ts`:

```ts
import { generateDraft } from './generate';
import { scoreAll } from './score-all';
import { blendOverall } from './blend';
import { buildFeedback } from './feedback';
import {
  DEFAULT_THRESHOLD, MAX_RETRIES,
  type Draft, type Sender, type Icp, type Prospect, type GenerationResult, type ScoreBundle,
} from './types';

export interface GenerateForProspectArgs {
  prospect: Prospect;
  sender: Sender;
  icp: Icp;
  threshold?: number;        // defaults to 70
  maxRetries?: number;       // defaults to 3
  log?: (msg: string) => void;
}

/**
 * The eval-gated generation loop. Returns when:
 * - Above-threshold draft produced (status: 'needs_review'), OR
 * - Max retries exhausted (status: 'flagged'), returning the best attempt.
 *
 * "Best attempt" when flagged = the one with the highest overall score across
 * all attempts (in case attempt 3 was worse than attempt 1).
 */
export async function generateForProspect(args: GenerateForProspectArgs): Promise<GenerationResult> {
  const threshold = args.threshold ?? DEFAULT_THRESHOLD;
  const maxRetries = args.maxRetries ?? MAX_RETRIES;
  const log = args.log ?? (() => {});

  const attempts: Array<{ draft: Draft; scores: ScoreBundle; overall: number }> = [];
  let feedback: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    log(`  attempt ${attempt + 1}/${maxRetries + 1}: generating…`);
    const draft = await generateDraft({
      prospect: args.prospect,
      sender: args.sender,
      icp: args.icp,
      feedback,
    });

    log(`  attempt ${attempt + 1}: scoring (3 judges in parallel)…`);
    const scores = await scoreAll(draft, args.prospect);
    const overall = blendOverall(scores);
    attempts.push({ draft, scores, overall });

    log(`  attempt ${attempt + 1}: overall=${overall} (need ${threshold})  ai=${Math.round(scores.aiDetection.overall)} gen=${Math.round(scores.genericness.overall)} pers=${scores.personalization.score}`);

    if (overall >= threshold) {
      return {
        status: 'needs_review',
        finalDraft: draft,
        finalScores: scores,
        overall,
        retryCount: attempt,
        attempts,
      };
    }

    // Build feedback for next attempt
    feedback = buildFeedback(draft, scores, overall);
  }

  // Exhausted retries — return the best attempt by overall score
  const best = attempts.reduce((a, b) => (a.overall >= b.overall ? a : b));
  log(`  flagged: best overall ${best.overall} across ${attempts.length} attempts`);
  return {
    status: 'flagged',
    finalDraft: best.draft,
    finalScores: best.scores,
    overall: best.overall,
    retryCount: maxRetries,
    attempts,
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/generation/loop.ts
git commit -m "feat(gen): generateForProspect — full eval-gated loop with feedback regen"
```

---

## Task 6 — CLI script + first real run

**Files:**
- Create: `tests/fixtures/generation/sender.example.json`, `tests/fixtures/generation/prospect.example.json`, `scripts/generation/generate-single.ts`
- Modify: `package.json`, `.gitignore`

This task includes ACTUALLY RUNNING the loop end-to-end. Cost ~$0.05-0.15 per run (depends on retries: 1 generation + 3 judges per attempt = ~$0.02 per attempt × up to 4 attempts).

- [ ] **Step 1: Create example fixture files (committed)**

`tests/fixtures/generation/sender.example.json`:
```json
{
  "name": "Pranay (example)",
  "email": "pranay@example.com",
  "voiceSamples": [
    {
      "subject": "About your latest hire",
      "body": "Saw you brought Jen on as VP Eng. Worked with her at Linear in 2022 — she has a way of turning a vague platform vision into something six people can execute on tomorrow. Lucky to land her."
    },
    {
      "subject": "Quick thought on your bonsai post",
      "body": "Hey Marc — saw your post about the juniper. Tried wiring last winter and snapped a primary branch. What time of year do you find safest? Curious how you got that taper."
    },
    {
      "subject": "Re: outbound channel test",
      "body": "Sent 40 emails to RevOps leaders this week using the angle we discussed. 6 replies, 3 calls booked. The thing that worked: dropping the 'I noticed' opener entirely. Just stating the specific problem we'd discussed at the dinner."
    },
    {
      "subject": "your dunning podcast episode",
      "body": "Hey Dana, your episode with Tomas was the first explanation of dunning that didn't feel like a sales pitch. We do collections automation for B2B SaaS. If your stack is Stripe + HubSpot we can show you a 12% recovery lift in 4 weeks. Open to a Tuesday?"
    },
    {
      "subject": "Sample 5 — comp post",
      "body": "Pete — your team raised in April, doubled headcount, and the comp-plan post on LinkedIn mentioned you're rewriting variable comp from scratch. We built a comp tool for exactly this stage. Worth 20 minutes?"
    }
  ],
  "icp": {
    "industry": ["B2B SaaS"],
    "roleKeywords": ["Head of Sales", "VP Sales", "RevOps"],
    "valueProp": "cut sales-cycle time in half using eval-gated AI outbound",
    "sizeRange": "Series A-B (20-100 employees)"
  }
}
```

`tests/fixtures/generation/prospect.example.json`:
```json
{
  "email": "pete@acme.com",
  "firstName": "Pete",
  "lastName": "Sloan",
  "company": "Acme Observability",
  "role": "CTO",
  "enrichment": {
    "headline": "CTO at Acme Observability · ex-Datadog, ex-Honeycomb",
    "about": "I run engineering at Acme. Previously led the storage team at Honeycomb. Spend most of my time on observability infrastructure problems that other people don't think are problems yet.",
    "recent_posts": [
      {
        "title": "Ditching Datadog for self-hosted Tempo: what we learned in 6 weeks",
        "date": "2026-04-22",
        "snippet": "Two weeks of dashboards no one looked at. Then the cardinality blow-up at week three. We rebuilt the schema, capped 14 high-churn labels, and started over."
      },
      {
        "title": "Engineering hiring in late 2026",
        "date": "2026-03-10",
        "snippet": "Brought on Jen as VP Eng. We're 14 engineers and growing 3 a quarter."
      }
    ],
    "tenure_months": 22,
    "company_size": "30-50 employees, Series A",
    "company_industry": "Observability / DevOps tooling"
  }
}
```

- [ ] **Step 2: Update `.gitignore`** — add at the end:

```
# Real-data fixtures (founders fill these in with their own voice samples and prospects)
tests/fixtures/generation/sender.json
tests/fixtures/generation/prospect.json
```

- [ ] **Step 3: Add script to `package.json`** — inside `scripts`, after `judge:calibrate-personalization`:

```json
    "gen:single": "tsx scripts/generation/generate-single.ts",
```

- [ ] **Step 4: Implement** `scripts/generation/generate-single.ts`:

```ts
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
loadEnv({ path: '.env', override: true });

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateForProspect } from '../../src/lib/generation/loop';
import type { Sender, Icp, Prospect } from '../../src/lib/generation/types';

const SENDER_PATH = 'tests/fixtures/generation/sender.json';
const SENDER_EXAMPLE_PATH = 'tests/fixtures/generation/sender.example.json';
const PROSPECT_PATH = 'tests/fixtures/generation/prospect.json';
const PROSPECT_EXAMPLE_PATH = 'tests/fixtures/generation/prospect.example.json';

function loadFixture<T>(path: string, fallback: string): T {
  if (existsSync(path)) {
    console.log(`Loading ${path}`);
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  console.log(`${path} not found — using ${fallback} as fallback.`);
  return JSON.parse(readFileSync(fallback, 'utf-8'));
}

async function main() {
  const senderConfig = loadFixture<{ name: string; email: string; voiceSamples: Sender['voiceSamples']; icp: Icp }>(SENDER_PATH, SENDER_EXAMPLE_PATH);
  const prospect = loadFixture<Prospect>(PROSPECT_PATH, PROSPECT_EXAMPLE_PATH);

  const sender: Sender = {
    name: senderConfig.name,
    email: senderConfig.email,
    voiceSamples: senderConfig.voiceSamples,
  };

  const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
  log(`Running generateForProspect for ${prospect.email} (${prospect.firstName} at ${prospect.company})…`);
  log(``);

  const result = await generateForProspect({
    prospect,
    sender,
    icp: senderConfig.icp,
    log,
  });

  log(``);
  log(`── Result ──`);
  log(`  status: ${result.status}`);
  log(`  overall: ${result.overall}`);
  log(`  retries: ${result.retryCount}`);
  log(``);

  console.log(`\n=== Final draft ===`);
  console.log(`Subject: ${result.finalDraft.subject}`);
  console.log(``);
  console.log(result.finalDraft.body);
  console.log(``);
  console.log(`=== Scores ===`);
  console.log(`  overall:         ${result.overall}/100  (threshold 70)`);
  console.log(`  ai_detection:    ${Math.round(result.finalScores.aiDetection.overall)}/100`);
  console.log(`  genericness:     ${Math.round(result.finalScores.genericness.overall)}/100`);
  console.log(`  personalization: ${result.finalScores.personalization.score}/100  (grounded_refs=${result.finalScores.personalization.groundedRefCount}, generic_hits=${result.finalScores.personalization.genericTokenHits.length})`);

  // Write full result to reports/ for later review
  mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
  const reportPath = resolve(
    process.cwd(),
    `reports/gen-single-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(`\nFull result: ${reportPath}`);

  process.exit(result.status === 'needs_review' ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: RUN THE LOOP**

Run: `pnpm gen:single 2>&1 | tail -50`

Cost ~$0.05-0.15 (1 generation + 3 judges per attempt, up to 4 attempts). Time ~30-90 seconds.

CAPTURE THE OUTPUT verbatim. This is the most important moment in the project — first end-to-end generation. Include:
- The final subject + body
- The score breakdown
- The retry count
- Whether it passed (`needs_review`) or got flagged

Possible outcomes:
- **Passes on first attempt:** great. Note the score.
- **Passes after 1-3 retries:** great, the regen loop worked. Note where the score climbed.
- **Flagged (3 retries below threshold):** show the best attempt + scores. This is signal that the rubric or threshold needs tuning.

**Include the full subject + body in your report so the user can read it and judge "would I send this?"**

- [ ] **Step 7: Commit**

```bash
git add scripts/generation/generate-single.ts tests/fixtures/generation/sender.example.json tests/fixtures/generation/prospect.example.json package.json .gitignore
git commit -m "feat(gen): single-prospect CLI + example fixtures (first run: <status>, overall <N>)"
```

(Fill in `<status>` and `<N>` with the real values from the run.)

---

## Task 7 — README

- [ ] **Step 1: Update README**

After the existing "Judges (Step 3+)" section and before "Schema source of truth", insert:

```markdown
## Generation loop (Step 6)

The eval-gated generation loop ties Steps 3-5 together. Given a prospect + sender + ICP, it generates a draft via Sonnet 4.6, scores it in parallel with the 3 judges, blends per spec §7.4 (`0.4 × AI-Detection + 0.3 × Genericness + 0.3 × Personalization`), and either queues the draft (overall ≥ 70) or regenerates with structured feedback (up to 3 retries; then flagged).

**To run end-to-end on a fixture:**

```bash
# (Optional) curate your own voice samples + prospect; otherwise the example fixtures work
cp tests/fixtures/generation/sender.example.json tests/fixtures/generation/sender.json
cp tests/fixtures/generation/prospect.example.json tests/fixtures/generation/prospect.json

# Run the loop
pnpm gen:single
```

Cost ~$0.05–0.15 per run depending on retries. Writes the full result (all attempts + scores) to `reports/gen-single-<ts>.json`.

**The generation prompt** lives at `prompts/generation/v1.md`. Edits to it should bump the version. Voice samples and ICP are injected at runtime.

**The regen feedback** combines structured score deltas with a rule-based natural-language critique. The critique targets the lowest-scoring axis. Specific guidance for the personalization judge calls out generic tokens by phrase so the generator can fix them.
```

- [ ] **Step 2: Update build sequence**

Change `6. Generation prompt + regen loop` to `6. ✅ Generation prompt + regen loop`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Step 6 generation loop section + mark done in build sequence"
```

---

## Self-review

**Spec coverage (§7):**
- ✓ §7.1 function chain (enrich → generate → score-fanout → evaluate-blend → re-enqueue or queue) — implemented as a synchronous loop. Inngest wiring is deferred to when UI lands; the pure orchestrator is the same.
- ✓ §7.2 prompt structure (voice samples in cached system, ICP, hard rules, retry feedback in user message)
- ✓ §7.3 regen feedback (structured deltas + rule-based critique; LLM critique deferred to A/B test)
- ✓ §7.4 score blend (0.4/0.3/0.3, threshold 70, max retries 3)

**Deferred (correctly):**
- Inngest wiring — bare-MVP CLI is sync
- DB persistence (generations, scores tables) — bare-MVP doesn't need it for testing
- Prospect/sender from DB — fixture files for now
- Real Apify enrichment — fixture's enrichment field is hand-curated for now
- LLM-generated critique (vs rule-based) — A/B post-launch

**Open questions the first run will answer:**
- Does Sonnet 4.6 + voice samples produce above-threshold drafts on the first try? (cost / latency win)
- What's the typical retry count? (informs cost-per-send)
- Which judge most often fails first? (informs prompt iteration priority)
- Does the regen loop actually lift scores, or does it produce similarly-failing variants?

---

## Execution Handoff

Subagent-driven. Final task includes a real API run. Total cost across all task verifications + final run: ~$0.30.
