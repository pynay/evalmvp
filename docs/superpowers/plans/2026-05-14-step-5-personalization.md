# Step 5 — Personalization Depth Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Build the Personalization Depth judge — Haiku 4.5 extracts grounded references and generic-token hits from the email body given the prospect's enrichment JSON. A deterministic scoring formula then converts those structured outputs into a 0–100 score where higher = more personalized.

**Architecture:** Two-layer design. The LLM does extraction (find references, classify specificity, identify generic tokens). Our code does scoring (deterministic formula from spec §8.3). This separation makes the scoring auditable, testable without API calls, and tunable without re-prompting.

**Why no corpus-based calibration:** the corpus rows have no enrichment attached — they're standalone cold emails. Calibration via a hand-crafted fixture file of `(email, enrichment, expected_score_range)` triples is more honest and lets us add edge cases over time.

---

## File map

**Create:**
```
prompts/judges/personalization.md           # versioned rubric
src/lib/judges/personalization.ts           # judge function + score computation
scripts/judges/calibrate-personalization.ts # fixture-based calibration runner
tests/unit/personalization-score.test.ts    # score formula tests (TDD)
tests/fixtures/personalization-cases.json   # hand-crafted (email, enrichment) test cases
```

**Modify:**
- `src/lib/judges/types.ts` — add `PersonalizationOutput`, `Reference`, `Specificity`
- `package.json` — add `judge:calibrate-personalization`
- `README.md` — Step 5 doc section

---

## Task 1 — Rubric + types

**Files:**
- Create: `prompts/judges/personalization.md`
- Modify: `src/lib/judges/types.ts`

- [ ] **Step 1: Create `prompts/judges/personalization.md`**:

```markdown
# Personalization Depth Judge — Rubric v1

You are an evaluator measuring how much a cold email is personalized to the specific prospect, given their enrichment data.

## Input

You receive:
- An email (subject + body)
- Enrichment data: a JSON object with the prospect's LinkedIn data (recent posts, headline, about section, current role, tenure, etc.) and any custom CSV fields the user uploaded

## Your job

Extract references from the email body and classify each by specificity. Plus flag any generic personalization tokens.

## What counts as a reference

A reference is a phrase in the email body that refers to the prospect specifically. Classify each on a 4-point scale:

- **high**: specific, verifiable, traceable to a concrete enrichment field
  - Examples: "your post about Tempo on Nov 7", "Jen, your new VP Eng who came from Linear", "the $5M Series A you closed last quarter"
- **med**: specific to the prospect/company but not exactly traceable to a field
  - Examples: "your engineering team", "scaling past Series B"
- **low**: industry/role generic (mentions the role/industry but anyone in that role would receive the same line)
  - Examples: "fintech leaders like you", "as a CTO"
- **generic**: template placeholder or obvious AI-tell that didn't actually personalize
  - Examples: "your role at {company}", "I noticed {company} has been growing", "we help companies like yours"

## What counts as a generic token

Exact phrases that signal templated personalization regardless of context:

- Unsubstituted placeholders: `{company}`, `{first_name}`, `{linkedin_url}`, `<company>`, `[company]`, etc.
- Template scaffolds that didn't get filled: "your role at <company>", "your role at the company"
- AI-tells: "companies like yours", "leaders like you", "based on your profile", "given your background"

## Output format

Return JSON only. No commentary, no code fences:

```json
{
  "references": [
    { "snippet": "verbatim quote from email", "grounded_in": "enrichment.recent_posts[2]", "specificity": "high" }
  ],
  "generic_token_hits": ["exact phrase 1"],
  "grounded_ref_count": 0
}
```

- `snippet`: verbatim substring of the email body
- `grounded_in`: if you can identify the specific enrichment field the reference traces to, provide a JSONPath-like string (e.g., `enrichment.recent_posts[2]`, `enrichment.headline`). Otherwise `null`.
- `specificity`: one of `high`, `med`, `low`, `generic`
- `generic_token_hits`: array of exact phrases from the email that match the generic-token patterns above
- `grounded_ref_count`: count of references where `specificity` is `high` OR `med` AND `grounded_in` is not null

Do NOT compute a score. The caller applies the scoring formula.
```

- [ ] **Step 2: Add types to `src/lib/judges/types.ts`** (append at the end):

```ts

export type Specificity = 'high' | 'med' | 'low' | 'generic';

export interface Reference {
  snippet: string;
  groundedIn: string | null;
  specificity: Specificity;
}

export interface PersonalizationOutput {
  references: Reference[];
  genericTokenHits: string[];
  groundedRefCount: number;
  score: number;  // 0-100, computed by us from the structured output
}

export const PERSONALIZATION_VERSION = 'v1';
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add prompts/judges/personalization.md src/lib/judges/types.ts
git commit -m "feat(judges): Personalization rubric v1 + shared types"
```

---

## Task 2 — Score computation (TDD)

**Files:**
- Create: `src/lib/judges/personalization.ts` (partial — just the score function for now), `tests/unit/personalization-score.test.ts`

We TDD the scoring formula first because it's the deterministic, testable layer. The Haiku call wrapping comes in Task 3.

- [ ] **Step 1: Write failing tests** at `tests/unit/personalization-score.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computePersonalizationScore } from '../../src/lib/judges/personalization';
import type { Reference } from '../../src/lib/judges/types';

const high = (i: number): Reference => ({
  snippet: `high ref ${i}`, groundedIn: `enrichment.field${i}`, specificity: 'high',
});
const med = (i: number): Reference => ({
  snippet: `med ref ${i}`, groundedIn: `enrichment.field${i}`, specificity: 'med',
});
const ungrounded = (i: number): Reference => ({
  snippet: `floating ref ${i}`, groundedIn: null, specificity: 'high',
});

describe('computePersonalizationScore', () => {
  it('1 high grounded ref → 20', () => {
    expect(computePersonalizationScore([high(1)], [], 1)).toBe(20);
  });

  it('3 high grounded refs → 60 (cap)', () => {
    expect(computePersonalizationScore([high(1), high(2), high(3)], [], 3)).toBe(60);
  });

  it('5 high grounded refs still capped at 60', () => {
    expect(computePersonalizationScore(
      [high(1), high(2), high(3), high(4), high(5)], [], 5,
    )).toBe(60);
  });

  it('2 med grounded refs → 20', () => {
    expect(computePersonalizationScore([med(1), med(2)], [], 2)).toBe(20);
  });

  it('3 med grounded refs → 20 (cap)', () => {
    expect(computePersonalizationScore([med(1), med(2), med(3)], [], 3)).toBe(20);
  });

  it('high + med stack: 3 high + 2 med → 60 + 20 = 80', () => {
    expect(computePersonalizationScore(
      [high(1), high(2), high(3), med(1), med(2)], [], 5,
    )).toBe(80);
  });

  it('1 generic token → minus 30 → floored at 0 when no positives', () => {
    expect(computePersonalizationScore([], ['{company}'], 0)).toBe(0);
  });

  it('grounded_ref_count=0 → minus 40 → 0', () => {
    expect(computePersonalizationScore([], [], 0)).toBe(0);
  });

  it('mixed: 2 high refs + 1 generic token = 40 − 30 = 10', () => {
    expect(computePersonalizationScore([high(1), high(2)], ['{company}'], 2)).toBe(10);
  });

  it('ungrounded high ref does NOT add — has groundedIn null', () => {
    expect(computePersonalizationScore([ungrounded(1)], [], 0)).toBe(0);
  });

  it('cap above 100', () => {
    // 3 high (60) + 2 med (20) with no negatives stays at 80; can't exceed because of caps
    expect(computePersonalizationScore(
      [high(1), high(2), high(3), high(4), med(1), med(2), med(3)], [], 7,
    )).toBe(80);
  });
});
```

- [ ] **Step 2: Run tests, confirm 11 failures**

Run: `pnpm test tests/unit/personalization-score.test.ts 2>&1 | tail -15`
Expected: 11 failures (module not found).

- [ ] **Step 3: Implement** `src/lib/judges/personalization.ts` (just the score function for now — the judge wrapper comes in Task 3):

```ts
import type { Reference } from './types';

/**
 * Deterministic scoring from the structured output the Personalization judge extracts.
 *
 * Rules from spec §8.3:
 *   - Start at 0
 *   - +20 per grounded high-specificity reference (cap 60)
 *   - +10 per grounded med-specificity (cap 20)
 *   - −30 per generic token hit
 *   - −40 if grounded_ref_count == 0
 *   - Floor 0, ceiling 100
 *
 * "Grounded" = the reference has a non-null `groundedIn` field.
 */
export function computePersonalizationScore(
  references: Reference[],
  genericTokenHits: string[],
  groundedRefCount: number,
): number {
  let score = 0;

  const groundedHighCount = references.filter(
    (r) => r.specificity === 'high' && r.groundedIn !== null,
  ).length;
  score += Math.min(groundedHighCount * 20, 60);

  const groundedMedCount = references.filter(
    (r) => r.specificity === 'med' && r.groundedIn !== null,
  ).length;
  score += Math.min(groundedMedCount * 10, 20);

  score -= genericTokenHits.length * 30;
  if (groundedRefCount === 0) score -= 40;

  return Math.max(0, Math.min(100, score));
}
```

- [ ] **Step 4: Run tests, confirm 11 pass**

Run: `pnpm test tests/unit/personalization-score.test.ts 2>&1 | tail -10`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/judges/personalization.ts tests/unit/personalization-score.test.ts
git commit -m "feat(judges): Personalization score formula + 11 unit tests (TDD)"
```

---

## Task 3 — Judge function (LLM wrapper)

**Files:**
- Modify: `src/lib/judges/personalization.ts` (add the judge function on top of the score helper)

- [ ] **Step 1: Append to `src/lib/judges/personalization.ts`**:

```ts
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, HAIKU_MODEL } from '../anthropic';
import { parseJson } from './parse-json';
import { PERSONALIZATION_VERSION, type PersonalizationOutput } from './types';

export const personalizationSchema = z.object({
  references: z.array(z.object({
    snippet: z.string(),
    grounded_in: z.string().nullable(),
    specificity: z.enum(['high', 'med', 'low', 'generic']),
  })),
  generic_token_hits: z.array(z.string()),
  grounded_ref_count: z.number().int().min(0),
});

const RUBRIC = readFileSync(resolve(process.cwd(), 'prompts/judges/personalization.md'), 'utf-8');

export interface PersonalizationInput {
  subject: string;
  body: string;
  enrichment: Record<string, unknown>;
}

export async function personalization(input: PersonalizationInput): Promise<PersonalizationOutput> {
  const userMessage = `Email:
Subject: ${input.subject}

${input.body}

Enrichment data:
${JSON.stringify(input.enrichment, null, 2)}`;

  const res = await anthropic().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1200,
    system: [
      { type: 'text', text: RUBRIC, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = res.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('');

  const parsed = parseJson(raw, personalizationSchema);

  // Convert snake_case from rubric to camelCase internal type
  const references = parsed.references.map((r) => ({
    snippet: r.snippet,
    groundedIn: r.grounded_in,
    specificity: r.specificity,
  }));

  const score = computePersonalizationScore(
    references,
    parsed.generic_token_hits,
    parsed.grounded_ref_count,
  );

  return {
    references,
    genericTokenHits: parsed.generic_token_hits,
    groundedRefCount: parsed.grounded_ref_count,
    score,
  };
}

export { PERSONALIZATION_VERSION };
```

NOTE: this APPENDS to the file from Task 2. The `computePersonalizationScore` function stays at the top; the new imports and the `personalization()` function go below it.

- [ ] **Step 2: Verify typecheck + full test suite**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -10`
Expected: typecheck clean, all ~39 tests pass (28 from before + 11 new).

- [ ] **Step 3: Commit**

```bash
git add src/lib/judges/personalization.ts
git commit -m "feat(judges): Personalization judge — Haiku call + Zod validation + score wiring"
```

---

## Task 4 — Fixture-based calibration

**Files:**
- Create: `tests/fixtures/personalization-cases.json`, `scripts/judges/calibrate-personalization.ts`
- Modify: `package.json`

- [ ] **Step 1: Create** `tests/fixtures/personalization-cases.json` with hand-crafted test pairs:

```json
[
  {
    "name": "well-personalized email — 3 high grounded refs",
    "expected_min": 50,
    "expected_max": 80,
    "subject": "your Tempo migration writeup",
    "body": "Pete — your post about ditching Datadog for self-hosted Tempo was the first writeup I've read that didn't pretend the migration was painless. The 'two weeks of dashboards no one looked at' line is going to stick with me. We do schema-validation tooling that catches the kind of cardinality blow-up you ran into at week three. Worth a Tuesday at 2pm chat?",
    "enrichment": {
      "first_name": "Pete",
      "headline": "Engineering at Acme",
      "recent_posts": [
        { "title": "Ditching Datadog for self-hosted Tempo", "snippet": "Two weeks of dashboards no one looked at..." }
      ],
      "tenure_months": 18
    }
  },
  {
    "name": "templated email — 2 generic tokens, 0 grounded refs",
    "expected_min": 0,
    "expected_max": 10,
    "subject": "Quick question about {company}",
    "body": "Hi {first_name}, I noticed your role at {company} and wanted to reach out. We help companies like yours streamline operations. Worth a quick chat?",
    "enrichment": {
      "first_name": "Sarah",
      "company": "Acme",
      "headline": "VP Sales at Acme"
    }
  },
  {
    "name": "mediocre — uses real prospect data but generically",
    "expected_min": 10,
    "expected_max": 35,
    "subject": "Sales acceleration",
    "body": "Hi Sarah, as a VP Sales at a growing SaaS company, you're probably looking for ways to accelerate your team's outbound. We work with leaders like you to shorten deal cycles. Open to a 15-minute chat?",
    "enrichment": {
      "first_name": "Sarah",
      "company": "Acme",
      "headline": "VP Sales at Acme",
      "industry": "SaaS"
    }
  },
  {
    "name": "moderately personalized — 1 high + 1 med grounded refs",
    "expected_min": 25,
    "expected_max": 50,
    "subject": "your team's GraphQL migration",
    "body": "Hey Jen — saw the post about your team migrating from REST to GraphQL last quarter. We've shipped to engineering teams making the same move at companies your size. Worth 20 minutes?",
    "enrichment": {
      "first_name": "Jen",
      "headline": "Engineering Manager at Acme",
      "company_size": "200-500",
      "recent_posts": [
        { "title": "Lessons from our REST-to-GraphQL migration", "date": "2026-04-15" }
      ]
    }
  },
  {
    "name": "well-personalized but with a generic token slip",
    "expected_min": 15,
    "expected_max": 45,
    "subject": "the Series B + the comp post",
    "body": "Hey {first_name} — your LinkedIn post last week about rewriting variable comp from scratch resonated. We built a comp tool for exactly this stage. Worth a chat?",
    "enrichment": {
      "first_name": "Marcus",
      "headline": "Head of People at Acme",
      "recent_posts": [
        { "title": "Why we're rewriting variable comp from scratch", "date": "2026-05-08" }
      ]
    }
  }
]
```

Note: the `expected_min`/`expected_max` ranges are deliberately wide because the LLM-side reference classification has variance.

- [ ] **Step 2: Add script to `package.json`** — inside the `scripts` block, after `judge:calibrate-generic`:

```json
    "judge:calibrate-personalization": "tsx scripts/judges/calibrate-personalization.ts",
```

- [ ] **Step 3: Implement** `scripts/judges/calibrate-personalization.ts`:

```ts
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
loadEnv({ path: '.env', override: true });

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { personalization, PERSONALIZATION_VERSION } from '../../src/lib/judges/personalization';

interface TestCase {
  name: string;
  expected_min: number;
  expected_max: number;
  subject: string;
  body: string;
  enrichment: Record<string, unknown>;
}

interface CaseResult {
  name: string;
  score: number;
  expected_min: number;
  expected_max: number;
  in_range: boolean;
  grounded_ref_count: number;
  generic_hits: string[];
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const fixturesPath = resolve(process.cwd(), 'tests/fixtures/personalization-cases.json');
  const cases: TestCase[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

  console.log(`Running ${cases.length} personalization test cases against Haiku 4.5…\n`);

  const results: CaseResult[] = [];
  for (const tc of cases) {
    try {
      const out = await personalization({
        subject: tc.subject,
        body: tc.body,
        enrichment: tc.enrichment,
      });
      const inRange = out.score >= tc.expected_min && out.score <= tc.expected_max;
      results.push({
        name: tc.name,
        score: out.score,
        expected_min: tc.expected_min,
        expected_max: tc.expected_max,
        in_range: inRange,
        grounded_ref_count: out.groundedRefCount,
        generic_hits: out.genericTokenHits,
      });
      const status = inRange ? '✓' : '✗';
      console.log(`${status} ${tc.name}`);
      console.log(`    score=${out.score} (expected ${tc.expected_min}-${tc.expected_max}), grounded=${out.groundedRefCount}, generic_hits=${JSON.stringify(out.genericTokenHits)}`);
    } catch (e) {
      console.error(`  ! ${tc.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const passed = results.filter((r) => r.in_range).length;
  console.log(`\n── ${passed}/${results.length} cases in expected range ──`);

  mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
  const reportPath = resolve(
    process.cwd(),
    `reports/personalization-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(reportPath, JSON.stringify({
    version: PERSONALIZATION_VERSION,
    timestamp: new Date().toISOString(),
    results,
    passed,
    total: results.length,
  }, null, 2));
  console.log(`  Report: ${reportPath}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('Calibration error:', e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Run calibration**

Run: `pnpm judge:calibrate-personalization 2>&1 | tail -25`
Expected: prints per-case results. Cost ~$0.01 (5 cases × ~$0.002 Haiku call). The pass rate depends on how the LLM classifies references — anywhere from 3/5 to 5/5 is reasonable for v1.

Include the actual pass rate in the commit message.

- [ ] **Step 6: Commit**

```bash
git add scripts/judges/calibrate-personalization.ts tests/fixtures/personalization-cases.json package.json
git commit -m "feat(judges): Personalization calibration via 5 hand-crafted fixtures"
```

---

## Task 5 — README docs

- [ ] **Step 1: Update "Judges (Step 3+)" section** — after the Step 4 Genericness block, insert:

```markdown

**Step 5 — Personalization Depth (v1):** Haiku 4.5 extracts references from the email body, classifies each as high/med/low/generic specificity (high+med are "grounded" if traced to a specific enrichment field), and flags template-style tokens. A deterministic formula (spec §8.3) converts that structured output to 0–100: +20 per grounded high (cap 60), +10 per grounded med (cap 20), −30 per generic token, −40 if no grounded refs at all.

```bash
pnpm judge:calibrate-personalization
```

Calibrated against `tests/fixtures/personalization-cases.json` — 5 hand-crafted (email, enrichment) pairs with expected score ranges. Cost ~$0.01 per run.
```

- [ ] **Step 2: Update build sequence**

Change `5. Personalization Depth judge` to `5. ✅ Personalization Depth judge`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Step 5 Personalization section + mark done in build sequence"
```

---

## Self-review

**Spec coverage (§8.3):**
- ✓ Haiku judge over body + enrichment context
- ✓ Output schema with references + generic_token_hits + grounded_ref_count
- ✓ Scoring rules match spec exactly (+20 high cap 60, +10 med cap 20, -30 generic, -40 if no grounded, floor 0 ceiling 100)
- ✓ Score interpretation: higher = more personalized

**Deferred:**
- Larger fixture set (add as we see edge cases)
- Corpus-based calibration (corpus has no enrichment; not applicable to this judge)

**Type consistency:** `PersonalizationOutput`, `Reference`, `Specificity` defined in `types.ts`. Zod schema uses snake_case to match the LLM's output; we remap to camelCase for the runtime type. Same pattern as AI-Detection.

---

## Execution Handoff

Subagent-driven. Same flow as Steps 3 and 4.
