# Step 3 — AI-Detection Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Build the AI-Detection judge — a Haiku 4.5 call that scores a cold email across 7 axes (opener / structure / hedging / cta / vocabulary / punctuation / rhythm), returns axis sub-scores 0–100 (higher = more human), and identifies the top 3 red flags with evidence quotes. Plus a calibration script that runs the judge against the corpus and reports discrimination metrics.

**Architecture:** The judge is a pure function `aiDetection({ subject, body }) → JudgeOutput`. The rubric lives in `prompts/judges/ai-detection.md` (versioned, plain text — `readFileSync`'d at module load). Output JSON is parsed and validated before returning. The calibration script reads `email_corpus`, runs the judge against every row, computes mean/stddev per origin + overlap count, writes a JSON report to `reports/calibration/ai-detection-<timestamp>.json` and prints a summary. Calibration target from spec §8.1: mean AI ≤30, mean human ≥70, overlap <10%.

**Tech stack:** Anthropic SDK (Haiku 4.5), Zod for output validation, the `postgres` driver for corpus reads. No DB writes in this step — the eval loop (Step 6) handles persistence to the `scores` table.

**Scope discipline:** This step ONLY builds the judge + calibration. It does NOT wire the judge into a generation loop (Step 6) or persist results to the `scores` table at runtime (also Step 6). Calibration is run-once, output-to-file.

---

## File map

**Create:**
```
prompts/judges/ai-detection.md           # versioned rubric, readFileSync'd
src/lib/judges/types.ts                  # shared judge types
src/lib/judges/ai-detection.ts           # judge function
src/lib/judges/parse-json.ts             # extract + validate JSON from LLM output
scripts/judges/calibrate-ai-detection.ts # calibration runner
tests/unit/parse-json.test.ts            # parser TDD
tests/unit/ai-detection-parser.test.ts   # AI-Detection-specific output shape tests
reports/.gitkeep                         # ensure reports/ dir exists (outputs gitignored)
```

**Modify:**
- `package.json` — add deps (zod — already there from Step 1) + scripts (`judge:calibrate-ai`)
- `.gitignore` — add `reports/*.json` (calibration runs are not committed)
- `README.md` — Step 3 doc section

---

## Task 1 — Prompt file + shared types

**Files:**
- Create: `prompts/judges/ai-detection.md`, `src/lib/judges/types.ts`

- [ ] **Step 1: Create `prompts/judges/ai-detection.md`** with EXACTLY this content:

```markdown
# AI-Detection Judge — Rubric v1

You are an evaluator distinguishing AI-generated cold emails from human-written ones.

Given a cold email (subject + body), score it on 7 axes. For each axis: 0 = obvious AI tell, 100 = clearly human. Then identify the top 3 red flags with verbatim evidence from the email.

## Axes

### 1. opener (0–100)
**AI tells (lower score):** "I came across", "I noticed your", "hope this finds", "saw your recent", "I wanted to reach out about"
**Human (higher score):** specific reference to something only a human reader would mention — a sentence the prospect wrote in a podcast, a person they hired, a non-obvious fact about their company history

### 2. structure (0–100)
**AI tells:** rigid 3-paragraph shape, each paragraph similar length, "Hi {name},\n\n[hook]\n\n[value prop]\n\n[CTA]" template
**Human:** variable paragraph lengths, occasional fragments, sometimes a single-line PS or "Btw —" aside

### 3. hedging (0–100)
**AI tells:** "might be", "could potentially", "I think this could", "would love to", "I believe this might", "perhaps"
**Human:** direct claims with specifics ("This will save you 12 hours a week"), bets, definite statements

### 4. cta (0–100)
**AI tells:** dual-option asks ("worth a quick chat, or open to ideas?"), "Would you be open to a brief conversation?", "open to a 15-minute call?"
**Human:** specific, single ask with concrete time ("Tuesday at 2pm work?"), or referring to a shared context ("happy to share what we showed Acme")

### 5. vocabulary (0–100)
**AI tells:** "leverage", "synergize", "streamline", "robust", "innovative", "scalable", "value prop", "best-in-class", "thought leader"
**Human:** domain-specific terms, vendor names ("HubSpot", "Snowflake"), technical proper nouns, slang ("kicked off", "spinning up")

### 6. punctuation (0–100)
**AI tells:** em-dash density (more than once per paragraph), semicolons in marketing copy, formal commas in lists ("foo, bar, and baz")
**Human:** minimal em-dashes, rare semicolons, occasional run-on ("did X and Y and then Z")

### 7. rhythm (0–100)
**AI tells:** sentence-length variance near zero (every sentence the same length), no fragments
**Human:** mix of fragments and long sentences ("Worth it. Especially if you're still doing X manually."), variable cadence

## Output format

Return JSON only. No commentary, no code fences:

```json
{
  "axis_scores": {
    "opener": 0,
    "structure": 0,
    "hedging": 0,
    "cta": 0,
    "vocabulary": 0,
    "punctuation": 0,
    "rhythm": 0
  },
  "red_flags": [
    { "axis": "opener", "evidence": "verbatim quote from email", "severity": "high" }
  ]
}
```

- `axis_scores`: integer 0–100 per axis
- `red_flags`: 0–3 entries, ordered by severity. `evidence` MUST be a verbatim substring of the input. `severity` is one of `high`, `med`, `low`.
- Do NOT compute an "overall" score; the caller averages the axes.
```

This is the load-bearing prompt. Edits to it should bump the version in the title (v1 → v2) and be committed in their own commit so calibration runs can be tied to a prompt version.

- [ ] **Step 2: Create `src/lib/judges/types.ts`** with:

```ts
export type JudgeName = 'ai_detection' | 'genericness' | 'personalization';

export type Severity = 'high' | 'med' | 'low';

export interface RedFlag {
  axis: string;
  evidence: string;
  severity: Severity;
}

export interface AiDetectionOutput {
  axisScores: {
    opener: number;
    structure: number;
    hedging: number;
    cta: number;
    vocabulary: number;
    punctuation: number;
    rhythm: number;
  };
  overall: number;        // computed by us (mean of axes), not the model
  redFlags: RedFlag[];
}

export const AI_DETECTION_VERSION = 'v1';
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add prompts/judges/ai-detection.md src/lib/judges/types.ts
git commit -m "feat(judges): AI-Detection rubric v1 + shared judge types"
```

---

## Task 2 — JSON output parser (TDD)

**Files:**
- Create: `src/lib/judges/parse-json.ts`, `tests/unit/parse-json.test.ts`

LLM outputs sometimes wrap JSON in code fences or include leading prose. This parser extracts and validates.

- [ ] **Step 1: Write failing tests** at `tests/unit/parse-json.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests, confirm failure**

Run: `pnpm test tests/unit/parse-json.test.ts 2>&1 | tail -15`
Expected: 6 failures — module not found.

- [ ] **Step 3: Implement** `src/lib/judges/parse-json.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm test tests/unit/parse-json.test.ts 2>&1 | tail -10`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/judges/parse-json.ts tests/unit/parse-json.test.ts
git commit -m "feat(judges): JSON output parser + 6 unit tests (handles code fences + prose)"
```

---

## Task 3 — AI-Detection judge function

**Files:**
- Create: `src/lib/judges/ai-detection.ts`, `tests/unit/ai-detection-parser.test.ts`

- [ ] **Step 1: Write failing tests** at `tests/unit/ai-detection-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aiDetectionSchema, computeOverall } from '../../src/lib/judges/ai-detection';

describe('aiDetectionSchema', () => {
  it('validates a well-formed output', () => {
    const valid = {
      axis_scores: {
        opener: 30, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: [
        { axis: 'opener', evidence: 'I came across your role', severity: 'high' },
      ],
    };
    expect(() => aiDetectionSchema.parse(valid)).not.toThrow();
  });

  it('rejects scores outside 0-100', () => {
    const invalid = {
      axis_scores: {
        opener: 150, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: [],
    };
    expect(() => aiDetectionSchema.parse(invalid)).toThrow();
  });

  it('rejects unknown severity values', () => {
    const invalid = {
      axis_scores: {
        opener: 30, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: [{ axis: 'opener', evidence: 'x', severity: 'critical' }],
    };
    expect(() => aiDetectionSchema.parse(invalid)).toThrow();
  });

  it('rejects more than 3 red flags', () => {
    const invalid = {
      axis_scores: {
        opener: 30, structure: 40, hedging: 50, cta: 60,
        vocabulary: 70, punctuation: 80, rhythm: 90,
      },
      red_flags: Array(4).fill({ axis: 'opener', evidence: 'x', severity: 'low' }),
    };
    expect(() => aiDetectionSchema.parse(invalid)).toThrow();
  });
});

describe('computeOverall', () => {
  it('is the mean of all axis scores', () => {
    const scores = { opener: 0, structure: 0, hedging: 0, cta: 100, vocabulary: 100, punctuation: 100, rhythm: 100 };
    expect(computeOverall(scores)).toBeCloseTo(400 / 7);
  });

  it('returns 50 for a uniform 50', () => {
    const scores = { opener: 50, structure: 50, hedging: 50, cta: 50, vocabulary: 50, punctuation: 50, rhythm: 50 };
    expect(computeOverall(scores)).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

Run: `pnpm test tests/unit/ai-detection-parser.test.ts 2>&1 | tail -10`
Expected: 6 failures — module not found.

- [ ] **Step 3: Implement** `src/lib/judges/ai-detection.ts`:

```ts
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { anthropic, HAIKU_MODEL } from '../anthropic';
import { parseJson } from './parse-json';
import { AI_DETECTION_VERSION, type AiDetectionOutput } from './types';
import type Anthropic from '@anthropic-ai/sdk';

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
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm test tests/unit/ai-detection-parser.test.ts 2>&1 | tail -10`
Expected: 6 passed.

- [ ] **Step 5: Verify typecheck and full test suite**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -10`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/judges/ai-detection.ts tests/unit/ai-detection-parser.test.ts
git commit -m "feat(judges): AI-Detection judge — Haiku call + Zod validation + 6 parser tests"
```

---

## Task 4 — Calibration script

**Files:**
- Create: `scripts/judges/calibrate-ai-detection.ts`, `reports/.gitkeep`
- Modify: `package.json`, `.gitignore`

The calibration script reads every row from `email_corpus`, runs the judge against each, and reports discrimination metrics. The actual run is deferred until the user provides their Anthropic API key and the corpus has been bootstrapped. The code lands now.

- [ ] **Step 1: Create `reports/.gitkeep`** (empty file).

- [ ] **Step 2: Update `.gitignore`** — append:
```
# Calibration runs (timestamped JSON reports — not committed)
reports/*.json
```

- [ ] **Step 3: Add script to `package.json`** — inside the `scripts` block, after `corpus:smoke`:
```json
    "judge:calibrate-ai": "tsx scripts/judges/calibrate-ai-detection.ts",
```

- [ ] **Step 4: Implement** `scripts/judges/calibrate-ai-detection.ts`:

```ts
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import postgres from 'postgres';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { aiDetection, AI_DETECTION_VERSION } from '../../src/lib/judges/ai-detection';

const SERVICE_URL = process.env.DATABASE_URL_SERVICE;

// Calibration thresholds from spec §8.1
const TARGET_AI_MEAN_MAX = 30;
const TARGET_HUMAN_MEAN_MIN = 70;
const TARGET_OVERLAP_PCT_MAX = 10;

interface CorpusRow {
  id: string;
  origin: 'ai' | 'human' | 'template';
  source: string | null;
  subject: string;
  body: string;
}

interface CalibrationResult {
  corpus_id: string;
  origin: 'ai' | 'human' | 'template';
  overall: number;
  axis_scores: Record<string, number>;
}

function summarize(results: CalibrationResult[], origin: string) {
  const scores = results.filter((r) => r.origin === origin).map((r) => r.overall);
  if (scores.length === 0) return { n: 0, mean: 0, stdev: 0, min: 0, max: 0 };
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    mean: Math.round(mean * 10) / 10,
    stdev: Math.round(Math.sqrt(variance) * 10) / 10,
    min: Math.min(...scores),
    max: Math.max(...scores),
  };
}

async function main() {
  if (!SERVICE_URL) throw new Error('DATABASE_URL_SERVICE not set');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const sql = postgres(SERVICE_URL, { prepare: false });
  const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

  try {
    log('Fetching corpus…');
    const rows = await sql<CorpusRow[]>`
      select id, origin, source, subject, body from email_corpus
      where subject is not null and body is not null
      order by origin, id
    `;
    log(`  ${rows.length} rows`);

    if (rows.length === 0) {
      throw new Error('Corpus is empty. Run pnpm corpus:build first.');
    }

    log('Running judge on each row… (this takes a few minutes; cost ~$0.001 per row)');
    const results: CalibrationResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const out = await aiDetection({ subject: row.subject, body: row.body });
        results.push({
          corpus_id: row.id,
          origin: row.origin,
          overall: out.overall,
          axis_scores: out.axisScores,
        });
        if ((i + 1) % 25 === 0 || i + 1 === rows.length) {
          log(`  ${i + 1}/${rows.length}`);
        }
      } catch (e) {
        log(`  ! row ${row.id} (${row.origin}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Summaries
    const summaries = {
      ai: summarize(results, 'ai'),
      human: summarize(results, 'human'),
      template: summarize(results, 'template'),
    };

    // Overlap: AI rows scoring >50 + human rows scoring <50
    const aiHigh = results.filter((r) => r.origin === 'ai' && r.overall > 50).length;
    const humanLow = results.filter((r) => r.origin === 'human' && r.overall < 50).length;
    const totalRelevant = results.filter((r) => r.origin === 'ai' || r.origin === 'human').length;
    const overlapPct = totalRelevant > 0 ? ((aiHigh + humanLow) / totalRelevant) * 100 : 0;

    // Print summary
    const lines = [
      `\n── AI-Detection Calibration (${AI_DETECTION_VERSION}) ──`,
      `  Corpus rows scored: ${results.length} / ${rows.length}`,
      ``,
      `  AI corpus       — n=${summaries.ai.n}, mean=${summaries.ai.mean}, σ=${summaries.ai.stdev}, range=[${summaries.ai.min}-${summaries.ai.max}]`,
      `  Human corpus    — n=${summaries.human.n}, mean=${summaries.human.mean}, σ=${summaries.human.stdev}, range=[${summaries.human.min}-${summaries.human.max}]`,
      `  Template corpus — n=${summaries.template.n}, mean=${summaries.template.mean}, σ=${summaries.template.stdev}, range=[${summaries.template.min}-${summaries.template.max}]`,
      ``,
      `  Overlap: ${aiHigh} AI rows >50 + ${humanLow} human rows <50 = ${overlapPct.toFixed(1)}% of (ai+human)`,
      ``,
      `── Targets ──`,
      `  ${summaries.ai.mean <= TARGET_AI_MEAN_MAX ? '✓' : '✗'} AI mean ≤ ${TARGET_AI_MEAN_MAX} (got ${summaries.ai.mean})`,
      `  ${summaries.human.mean >= TARGET_HUMAN_MEAN_MIN ? '✓' : '✗'} Human mean ≥ ${TARGET_HUMAN_MEAN_MIN} (got ${summaries.human.mean})`,
      `  ${overlapPct <= TARGET_OVERLAP_PCT_MAX ? '✓' : '✗'} Overlap ≤ ${TARGET_OVERLAP_PCT_MAX}% (got ${overlapPct.toFixed(1)}%)`,
    ];
    for (const line of lines) console.log(line);

    // Write report
    mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
    const reportPath = resolve(
      process.cwd(),
      `reports/ai-detection-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(reportPath, JSON.stringify({
      version: AI_DETECTION_VERSION,
      timestamp: new Date().toISOString(),
      summaries,
      overlap: { aiHigh, humanLow, overlapPct },
      results,
    }, null, 2));
    console.log(`\n  Report written to ${reportPath}`);

    const passed =
      summaries.ai.mean <= TARGET_AI_MEAN_MAX &&
      summaries.human.mean >= TARGET_HUMAN_MEAN_MIN &&
      overlapPct <= TARGET_OVERLAP_PCT_MAX;
    process.exit(passed ? 0 : 1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e: unknown) => {
  console.error('Calibration error:', e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: SKIP the actual calibration run.** No API key + empty corpus. The next deferred batch (after Step 6 if user provides keys + curates corpus) is when this runs.

- [ ] **Step 7: Commit**

```bash
git add scripts/judges/calibrate-ai-detection.ts reports/.gitkeep package.json .gitignore
git commit -m "feat(judges): AI-Detection calibration runner — corpus discrimination metrics + JSON report"
```

---

## Task 5 — README update

**File:**
- Modify: `README.md`

- [ ] **Step 1:** In `README.md`, find the line `## Corpus bootstrap (Step 2)` and insert this section IMMEDIATELY AFTER the entire Step 2 section ends (before `## Schema source of truth`):

```markdown
## Judges (Step 3+)

Three independent judges score every generated email before it gets queued for approval. Each judge is a pure function `(email) → { axisScores, overall, redFlags }`. The eval loop in Step 6 fans out the 3 judges in parallel and blends their `overall` scores at 0.4 / 0.3 / 0.3.

**Step 3 — AI-Detection:** Haiku 4.5 scores 7 axes (opener, structure, hedging, CTA, vocabulary, punctuation, rhythm). Higher = more human. Rubric at `prompts/judges/ai-detection.md`.

To calibrate against the corpus (after Step 2's corpus build):
```bash
pnpm judge:calibrate-ai
```
Cost ~$0.001 per corpus row × ~800 rows = ~$0.80 per full calibration. Writes a timestamped JSON report to `reports/ai-detection-<ts>.json` and exits 0 if discrimination meets the spec's targets (AI mean ≤30, human mean ≥70, overlap ≤10%).

If discrimination is poor, the fixes (in order of effort):
1. Edit `prompts/judges/ai-detection.md` (bump version), recalibrate.
2. Expand corpus (raise `CORPUS_TARGETS` in `scripts/corpus/config.ts`, re-run `pnpm corpus:build`).
3. Add more diverse ICP variants / prompt styles to `scripts/corpus/config.ts`.
```

- [ ] **Step 2: Update build sequence** — change `3. AI-Detection judge + calibration` to `3. ✅ AI-Detection judge + calibration`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: judges section + Step 3 marked done in build sequence"
```

---

## Self-review

**Spec coverage** (§8.1 AI-Detection):
- 7 axes with rubric — ✓ (Task 1)
- Output schema with axis_scores + red_flags — ✓ (Task 3, schema)
- Calibration targets — ✓ (Task 4, exits 1 if any target missed)
- Versioning — ✓ (`AI_DETECTION_VERSION = 'v1'`; rubric file version in markdown header)

**Deferred (correctly):**
- Running calibration against real corpus — needs API key + corpus build
- Persisting scores to DB at runtime — Step 6's eval loop
- Genericness + Personalization judges — Steps 4-5
- Generation loop integration — Step 6

**Placeholder scan:** every code step has complete code, every command has expected output.

**Type consistency:** `JudgeName`, `Severity`, `RedFlag`, `AiDetectionOutput` defined once in `types.ts`. Zod schema's `axis_scores` (snake) gets remapped to TS `axisScores` (camel) in the judge function — intentional, the wire format matches the prompt's JSON, internal types use camel.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-13-step-3-ai-detection.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review.
**2. Inline Execution** — work in this session.

Which?
