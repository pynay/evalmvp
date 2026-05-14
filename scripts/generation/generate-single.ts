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
