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
