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
