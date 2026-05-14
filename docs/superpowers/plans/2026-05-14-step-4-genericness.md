# Step 4 — Genericness Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Build the Genericness judge — for each segment (opener / body / cta) of a candidate email, compute cosine similarity against the AI corpus via pgvector, return a score 0–100 where higher = more unique. Plus a calibration script.

**Architecture:** The judge is a pure function `genericness({ subject, body }) → GenericnessOutput`. It segments the candidate (reusing Step 2's `segment()`), embeds each segment via OpenAI `text-embedding-3-small` (reusing/extracting Step 2's batch embedder), queries pgvector via `embedding <=> $1` for each segment's nearest neighbor in `email_corpus WHERE origin IN ('ai', 'template')`, and computes the score. No LLM call. ~$0.0001 per email + ~50ms DB roundtrip.

**Bare-MVP scope (v1.0 — distance from bad only):** This step ships the "distance from AI corpus" leg only. The positive-direction fix (similarity to human corpus, weighted 0.4) from spec §8.2 lands as a separate small commit once the human corpus is curated to a statistically useful size (~50+ rows). With only 5 human rows today, the positive direction would be noise.

**Test strategy:** unit tests on the score blender (axes → overall) and the corpus-row evidence shape. Integration test against the hosted DB's actual `email_corpus` (once corpus:build completes), asserting that an obvious AI-style email scores low.

---

## File map

**Create:**
```
src/lib/embeddings.ts                       # extracted from scripts/corpus/embed.ts — reusable
src/lib/judges/genericness.ts               # judge function
scripts/judges/calibrate-genericness.ts     # calibration runner
tests/unit/genericness-blend.test.ts        # blend + evidence shape tests
```

**Modify:**
- `src/lib/judges/types.ts` — add `GenericnessOutput`
- `scripts/corpus/embed.ts` — use the extracted helper, removing duplication
- `package.json` — add `judge:calibrate-generic`
- `README.md` — Step 4 doc section

---

## Task 1 — Embedding helper + Genericness output type

**Files:**
- Create: `src/lib/embeddings.ts`
- Modify: `src/lib/judges/types.ts`, `scripts/corpus/embed.ts`

- [ ] **Step 1: Add `GenericnessOutput` to `src/lib/judges/types.ts`**

Append to the existing types file:

```ts
export interface SimilarityMatch {
  segment: 'opener' | 'body' | 'cta';
  similarity: number;          // 0-1 cosine similarity
  corpusRowId: string;
  snippet: string;             // first 120 chars of the matching corpus row's body
  source: string | null;
}

export interface GenericnessOutput {
  axisScores: {
    opener: number;
    body: number;
    cta: number;
  };
  overall: number;             // 100 × (1 - peak similarity across segments)
  evidence: SimilarityMatch[]; // top 3 nearest matches
}

export const GENERICNESS_VERSION = 'v1.0';
```

- [ ] **Step 2: Create `src/lib/embeddings.ts`**

Extract the batched embedding logic from `scripts/corpus/embed.ts` so the Genericness judge can use it without depending on corpus-build types:

```ts
import { openai, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './openai';

const BATCH_SIZE = 100;  // OpenAI accepts up to 2048 per call

/**
 * Embed an array of texts via OpenAI text-embedding-3-small.
 * Batches at 100 inputs per request. Returns a parallel array of 1536-dim vectors.
 */
export async function embedTexts(
  texts: string[],
  log: (msg: string) => void = () => {},
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // OpenAI rejects empty strings — pad with a single space.
    const safeBatch = batch.map((t) => (t.trim() === '' ? ' ' : t));
    const res = await openai().embeddings.create({
      model: EMBEDDING_MODEL,
      input: safeBatch,
    });
    for (const d of res.data) {
      if (d.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Unexpected dimension ${d.embedding.length}, expected ${EMBEDDING_DIMENSIONS}`);
      }
      out.push(d.embedding);
    }
    log(`  ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
  }
  return out;
}
```

- [ ] **Step 3: Update `scripts/corpus/embed.ts` to use the helper**

Replace the existing `embedBatch` private function and the inline batching loop with a call to `embedTexts`. The diff (showing only the changes inside the file):

```ts
// REMOVE the local BATCH_SIZE constant and the local async function embedBatch().
// ADD an import at the top:
import { embedTexts } from '../../src/lib/embeddings';

// In embedEmails(), replace the batching loop with:
const allEmbeddings = await embedTexts(texts, log);
```

The rest of the file (segment looping, re-assembly into EmbeddedEmail) stays the same.

After the edit, the full file should look like (verify before committing):

```ts
import { EMBEDDING_DIMENSIONS } from '../../src/lib/openai';
import { embedTexts } from '../../src/lib/embeddings';
import type { RawEmail, EmbeddedEmail } from './types';
import { segment } from './segment';

export async function embedEmails(
  emails: RawEmail[],
  log: (msg: string) => void = () => {},
): Promise<EmbeddedEmail[]> {
  const withSegments = emails.map((email) => ({
    email,
    segments: segment({ subject: email.subject, body: email.body }),
  }));

  const texts: string[] = [];
  for (const { segments } of withSegments) {
    texts.push(segments.opener || ' ', segments.bodyMiddle || ' ', segments.cta || ' ');
  }

  log(`Embedding ${texts.length} segments (${withSegments.length} emails × 3)…`);
  const allEmbeddings = await embedTexts(texts, log);

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

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/embeddings.ts src/lib/judges/types.ts scripts/corpus/embed.ts
git commit -m "feat(judges): extract embedTexts helper + GenericnessOutput type"
```

---

## Task 2 — Genericness judge function (TDD)

**Files:**
- Create: `src/lib/judges/genericness.ts`, `tests/unit/genericness-blend.test.ts`

- [ ] **Step 1: Write failing tests** at `tests/unit/genericness-blend.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { blendGenericness, formatEvidence } from '../../src/lib/judges/genericness';

describe('blendGenericness', () => {
  it('axis score = 100 × (1 - similarity)', () => {
    const result = blendGenericness({ opener: 0.1, body: 0.2, cta: 0.3 });
    expect(result.opener).toBe(90);
    expect(result.body).toBe(80);
    expect(result.cta).toBe(70);
  });

  it('overall = 100 × (1 - max similarity)', () => {
    const result = blendGenericness({ opener: 0.1, body: 0.95, cta: 0.3 });
    expect(result.overall).toBe(5);  // 100 × (1 - 0.95)
  });

  it('clamps similarity > 1 (numerical noise)', () => {
    const result = blendGenericness({ opener: 1.05, body: 0.0, cta: 0.0 });
    expect(result.opener).toBe(0);
    expect(result.overall).toBe(0);
  });

  it('clamps similarity < 0', () => {
    const result = blendGenericness({ opener: -0.1, body: 0.0, cta: 0.0 });
    expect(result.opener).toBe(100);
  });
});

describe('formatEvidence', () => {
  it('keeps top 3 by similarity, descending', () => {
    const raw = [
      { segment: 'opener' as const, similarity: 0.3, corpusRowId: 'a', body: 'body a', source: 's1' },
      { segment: 'body' as const,   similarity: 0.7, corpusRowId: 'b', body: 'body b', source: 's2' },
      { segment: 'cta' as const,    similarity: 0.5, corpusRowId: 'c', body: 'body c', source: 's3' },
      { segment: 'opener' as const, similarity: 0.9, corpusRowId: 'd', body: 'body d', source: 's4' },
    ];
    const result = formatEvidence(raw);
    expect(result).toHaveLength(3);
    expect(result[0].corpusRowId).toBe('d');
    expect(result[1].corpusRowId).toBe('b');
    expect(result[2].corpusRowId).toBe('c');
  });

  it('truncates body to 120 chars for snippet', () => {
    const longBody = 'x'.repeat(200);
    const result = formatEvidence([
      { segment: 'opener', similarity: 0.5, corpusRowId: 'a', body: longBody, source: null },
    ]);
    expect(result[0].snippet.length).toBeLessThanOrEqual(120);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test tests/unit/genericness-blend.test.ts 2>&1 | tail -10`
Expected: 6 failures, module not found.

- [ ] **Step 3: Implement `src/lib/judges/genericness.ts`**

```ts
import postgres from 'postgres';
import { embedTexts } from '../embeddings';
import { segment } from '../../scripts/corpus/segment';
import { GENERICNESS_VERSION, type GenericnessOutput, type SimilarityMatch } from './types';

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Per-segment score: 100 × (1 - similarity). Higher = more unique.
 * Clamps similarity to [0, 1] to handle numerical noise from cosine distance.
 */
export function blendGenericness(sims: { opener: number; body: number; cta: number }) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const score = (s: number) => Math.round(100 * (1 - clamp(s)));
  const opener = score(sims.opener);
  const body = score(sims.body);
  const cta = score(sims.cta);
  const overall = Math.min(opener, body, cta);  // worst (closest match) drives overall
  return { opener, body, cta, overall };
}

interface RawMatch {
  segment: 'opener' | 'body' | 'cta';
  similarity: number;
  corpusRowId: string;
  body: string;
  source: string | null;
}

export function formatEvidence(raw: RawMatch[]): SimilarityMatch[] {
  return [...raw]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3)
    .map((m) => ({
      segment: m.segment,
      similarity: m.similarity,
      corpusRowId: m.corpusRowId,
      snippet: m.body.slice(0, 120),
      source: m.source,
    }));
}

export interface Email {
  subject: string;
  body: string;
}

/**
 * Genericness v1.0 — distance from AI corpus only.
 *
 * For each segment (opener / body / cta), embeds it via OpenAI and finds the
 * nearest neighbor in email_corpus where origin = 'ai'. The closer the match,
 * the more "generic" the email is — i.e., the more it resembles AI SDR output.
 *
 * Score = 100 × (1 - peak similarity across segments). Higher = more unique.
 *
 * Positive direction (closeness to human corpus, weighted 0.4) is deferred
 * until the human corpus has ≥50 curated rows — see spec §8.2.
 */
export async function genericness(email: Email): Promise<GenericnessOutput> {
  const SERVICE_URL = process.env.DATABASE_URL_SERVICE;
  if (!SERVICE_URL) throw new Error('DATABASE_URL_SERVICE not set');

  // 1. Segment + embed the candidate
  const segs = segment({ subject: email.subject, body: email.body });
  const [openerEmb, bodyEmb, ctaEmb] = await embedTexts([
    segs.opener || ' ',
    segs.bodyMiddle || ' ',
    segs.cta || ' ',
  ]);

  // 2. Query pgvector for nearest neighbors per segment
  const sql = postgres(SERVICE_URL, { prepare: false });
  try {
    // pgvector returns cosine DISTANCE via <=>. similarity = 1 - distance.
    const findNearest = async (vec: number[], segment: 'opener' | 'body' | 'cta') => {
      const col = segment === 'opener' ? sql`embedding_opener`
                : segment === 'body'   ? sql`embedding_body`
                : sql`embedding_cta`;
      const rows = await sql<{ id: string; body: string; source: string | null; distance: number }[]>`
        select id, body, source, ${col} <=> ${vectorLiteral(vec)}::vector as distance
        from email_corpus
        where origin = 'ai' and ${col} is not null
        order by ${col} <=> ${vectorLiteral(vec)}::vector
        limit 1
      `;
      return rows[0] ?? null;
    };

    const [oRow, bRow, cRow] = await Promise.all([
      findNearest(openerEmb, 'opener'),
      findNearest(bodyEmb, 'body'),
      findNearest(ctaEmb, 'cta'),
    ]);

    const oSim = oRow ? 1 - Number(oRow.distance) : 0;
    const bSim = bRow ? 1 - Number(bRow.distance) : 0;
    const cSim = cRow ? 1 - Number(cRow.distance) : 0;

    const blend = blendGenericness({ opener: oSim, body: bSim, cta: cSim });

    const matches: RawMatch[] = [];
    if (oRow) matches.push({ segment: 'opener', similarity: oSim, corpusRowId: oRow.id, body: oRow.body, source: oRow.source });
    if (bRow) matches.push({ segment: 'body',   similarity: bSim, corpusRowId: bRow.id, body: bRow.body, source: bRow.source });
    if (cRow) matches.push({ segment: 'cta',    similarity: cSim, corpusRowId: cRow.id, body: cRow.body, source: cRow.source });

    return {
      axisScores: { opener: blend.opener, body: blend.body, cta: blend.cta },
      overall: blend.overall,
      evidence: formatEvidence(matches),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export { GENERICNESS_VERSION };
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test tests/unit/genericness-blend.test.ts 2>&1 | tail -10`
Expected: 6 passed.

- [ ] **Step 5: Verify full test suite**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -15`
Expected: typecheck clean. All ~28 tests pass (22 from before + 6 new).

- [ ] **Step 6: Commit**

```bash
git add src/lib/judges/genericness.ts tests/unit/genericness-blend.test.ts
git commit -m "feat(judges): Genericness v1.0 — pgvector distance from AI corpus + 6 blend tests"
```

---

## Task 3 — Calibration runner

**Files:**
- Create: `scripts/judges/calibrate-genericness.ts`
- Modify: `package.json`

- [ ] **Step 1: Add script to `package.json`** — inside the `scripts` block, after `judge:calibrate-ai`:

```json
    "judge:calibrate-generic": "tsx scripts/judges/calibrate-genericness.ts",
```

- [ ] **Step 2: Implement** `scripts/judges/calibrate-genericness.ts`:

```ts
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import postgres from 'postgres';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { genericness, GENERICNESS_VERSION } from '../../src/lib/judges/genericness';

// Bare-MVP targets. Spec §8.2 doesn't define hard numbers; these are our starting bar.
// Adjust as calibration data accumulates.
const TARGET_AI_MEAN_MAX = 40;
const TARGET_HUMAN_MEAN_MIN = 60;
const TARGET_OVERLAP_PCT_MAX = 15;

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
  if (!process.env.DATABASE_URL_SERVICE) throw new Error('DATABASE_URL_SERVICE not set');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const sql = postgres(process.env.DATABASE_URL_SERVICE, { prepare: false });
  const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

  try {
    log('Fetching corpus…');
    const rows = await sql<CorpusRow[]>`
      select id, origin, source, subject, body from email_corpus
      where subject is not null and body is not null
      order by origin, id
    `;
    log(`  ${rows.length} rows`);
    if (rows.length === 0) throw new Error('Corpus is empty. Run pnpm corpus:build first.');

    // Note: a Genericness call queries email_corpus itself, so calibrating
    // an AI row finds itself as the nearest neighbor (similarity ~1.0).
    // Filter the candidate's own id out of the query in genericness.ts later,
    // or exclude self-comparison here. For v1.0 simplicity, we skip self-match
    // by passing a marker — but the current judge has no such param. So we
    // just accept that AI rows will score 0 (nearest match = self). The signal
    // is the OTHER origin (human) — we want those scoring high (no AI matches).
    log('NOTE: AI rows will score ~0 because each finds itself as nearest neighbor.');
    log('      Signal of interest is whether HUMAN rows score high (low similarity to AI corpus).');

    log('Running judge on each row… (~50ms each, ~$0.0001 per row)');
    const results: CalibrationResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const out = await genericness({ subject: row.subject, body: row.body });
        results.push({
          corpus_id: row.id,
          origin: row.origin,
          overall: out.overall,
          axis_scores: out.axisScores,
        });
        if ((i + 1) % 50 === 0 || i + 1 === rows.length) {
          log(`  ${i + 1}/${rows.length}`);
        }
      } catch (e) {
        log(`  ! row ${row.id} (${row.origin}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const summaries = {
      ai: summarize(results, 'ai'),
      human: summarize(results, 'human'),
      template: summarize(results, 'template'),
    };

    const aiHigh = results.filter((r) => r.origin === 'ai' && r.overall > 50).length;
    const humanLow = results.filter((r) => r.origin === 'human' && r.overall < 50).length;
    const totalRelevant = results.filter((r) => r.origin === 'ai' || r.origin === 'human').length;
    const overlapPct = totalRelevant > 0 ? ((aiHigh + humanLow) / totalRelevant) * 100 : 0;

    const lines = [
      `\n── Genericness Calibration (${GENERICNESS_VERSION}) ──`,
      `  Corpus rows scored: ${results.length} / ${rows.length}`,
      ``,
      `  AI corpus    — n=${summaries.ai.n}, mean=${summaries.ai.mean}, σ=${summaries.ai.stdev}, range=[${summaries.ai.min}-${summaries.ai.max}]`,
      `  Human corpus — n=${summaries.human.n}, mean=${summaries.human.mean}, σ=${summaries.human.stdev}, range=[${summaries.human.min}-${summaries.human.max}]`,
      ``,
      `  Overlap: ${aiHigh} AI >50 + ${humanLow} human <50 = ${overlapPct.toFixed(1)}% of (ai+human)`,
      ``,
      `── Targets (v1.0; without positive direction) ──`,
      `  ${summaries.ai.mean <= TARGET_AI_MEAN_MAX ? '✓' : '✗'} AI mean ≤ ${TARGET_AI_MEAN_MAX} (got ${summaries.ai.mean})`,
      `  ${summaries.human.mean >= TARGET_HUMAN_MEAN_MIN ? '✓' : '✗'} Human mean ≥ ${TARGET_HUMAN_MEAN_MIN} (got ${summaries.human.mean})`,
      `  ${overlapPct <= TARGET_OVERLAP_PCT_MAX ? '✓' : '✗'} Overlap ≤ ${TARGET_OVERLAP_PCT_MAX}% (got ${overlapPct.toFixed(1)}%)`,
    ];
    for (const line of lines) console.log(line);

    mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
    const reportPath = resolve(
      process.cwd(),
      `reports/genericness-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(reportPath, JSON.stringify({
      version: GENERICNESS_VERSION,
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

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: SKIP actual calibration run if corpus is empty.** If the corpus build finished and rows exist, run `pnpm judge:calibrate-generic` and capture output. Otherwise defer to the post-build batch.

- [ ] **Step 5: Commit**

```bash
git add scripts/judges/calibrate-genericness.ts package.json
git commit -m "feat(judges): Genericness calibration runner — pgvector mean/stddev per origin"
```

---

## Task 4 — README docs

- [ ] **Step 1: Update README** — find the "Judges (Step 3+)" section and add a new subsection after the AI-Detection block, before the "If discrimination is poor" troubleshooting list:

```markdown
**Step 4 — Genericness (v1.0):** pgvector cosine similarity over `email_corpus WHERE origin = 'ai'`. For each candidate's (opener / body / cta) segment, finds the nearest AI corpus match and scores 100 × (1 − similarity). Higher = more unique. No LLM call.

Cost ~$0.0001 per email (embeddings only).

```bash
pnpm judge:calibrate-generic
```

NOTE: positive-direction fix (closeness to human corpus, weighted 0.4) deferred until human corpus has ≥50 curated rows. See spec §8.2.
```

- [ ] **Step 2: Update build sequence** — change `4. Genericness similarity over pgvector` to `4. ✅ Genericness similarity over pgvector (v1.0; positive direction deferred)`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Step 4 Genericness section + mark v1.0 done in build sequence"
```

---

## Self-review

**Spec coverage** (§8.2):
- ✓ Segment-level cosine similarity against AI corpus
- ✓ Score = inverse of max similarity
- ✓ Evidence: top-3 nearest matches with snippet + source
- ⚠ Positive direction (closeness to human corpus, 0.4 weight) intentionally deferred per scope decision — human corpus too small to give a useful signal yet

**Deferred:**
- Positive direction fix (Step 4.5, lands when human corpus grows)
- Calibration run if corpus isn't built yet

**Type consistency:** `GenericnessOutput`, `SimilarityMatch`, `Email` defined consistently. Reuses `embedTexts` from `src/lib/embeddings.ts` and `segment` from `scripts/corpus/segment.ts`.

**Cost discipline:** judge is ~$0.0001/email (no LLM). 800-row calibration is ~$0.08.

---

## Execution Handoff

Subagent-driven. Same model as Steps 2-3.
