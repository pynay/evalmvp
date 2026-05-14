/**
 * Generate emails for all workspace prospects that don't yet have a generation.
 * Service-role connection (bypasses RLS); reads the first workspace's data.
 *
 * Caps at MAX_PER_RUN to avoid runaway spend.
 * Run: pnpm gen:all
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
loadEnv({ path: '.env', override: true });

import { eq, and, isNull, desc } from 'drizzle-orm';
import { serviceDb, closePools } from '../../src/lib/db/client';
import { workspaces, icps, senders, prospects, generations } from '../../src/lib/db/schema';
import { generateForProspect } from '../../src/lib/generation/loop';
import { persistGenerationResult } from '../../src/lib/generation/persist';
import type { Sender, Icp, Prospect } from '../../src/lib/generation/types';

const MAX_PER_RUN = 5;

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

async function main() {
  const db = serviceDb();

  const [ws] = await db.select().from(workspaces).limit(1);
  if (!ws) throw new Error('No workspace exists. Sign in first.');

  const [icpRow] = await db.select().from(icps).where(eq(icps.workspaceId, ws.id)).limit(1);
  const [senderRow] = await db.select().from(senders).where(eq(senders.workspaceId, ws.id)).limit(1);
  if (!icpRow) throw new Error('No ICP for this workspace. Visit /setup first.');
  if (!senderRow) throw new Error('No sender for this workspace. Visit /setup first.');

  // Prospects that don't yet have a generation row.
  const rows = await db
    .select({
      id: prospects.id,
      email: prospects.email,
      firstName: prospects.firstName,
      lastName: prospects.lastName,
      company: prospects.company,
      role: prospects.role,
      enrichmentJsonb: prospects.enrichmentJsonb,
    })
    .from(prospects)
    .leftJoin(generations, eq(generations.prospectId, prospects.id))
    .where(and(eq(prospects.workspaceId, ws.id), isNull(generations.id)))
    .orderBy(desc(prospects.createdAt))
    .limit(MAX_PER_RUN);

  if (rows.length === 0) {
    log('No prospects without an existing generation.');
    await closePools();
    return;
  }

  log(`Generating for ${rows.length} prospect(s) (capped at ${MAX_PER_RUN})…`);

  const sender: Sender = {
    name: senderRow.name,
    email: senderRow.email,
    voiceSamples: senderRow.voiceSamplesJsonb as Array<{ subject: string; body: string }>,
  };

  const icp: Icp = {
    industry: icpRow.industry as string[],
    roleKeywords: icpRow.roleKeywords as string[],
    valueProp: icpRow.valueProp ?? '',
  };

  let okCount = 0;
  let flaggedCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    log(`\n— ${row.email} —`);
    try {
      const prospect: Prospect = {
        email: row.email,
        firstName: row.firstName ?? undefined,
        lastName: row.lastName ?? undefined,
        company: row.company ?? undefined,
        role: row.role ?? undefined,
        enrichment: (row.enrichmentJsonb as Record<string, unknown>) ?? {},
      };

      const result = await generateForProspect({
        prospect,
        sender,
        icp,
        log: (m) => process.stderr.write(`    ${m}\n`),
      });

      await persistGenerationResult(db, {
        workspaceId: ws.id,
        prospectId: row.id,
        senderId: senderRow.id,
        icpId: icpRow.id,
        result,
      });

      log(`  → ${result.status} (overall=${result.overall}, retries=${result.retryCount})`);
      if (result.status === 'needs_review') okCount++;
      else flaggedCount++;
    } catch (e) {
      errorCount++;
      log(`  ✗ ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(`\nDone. ${okCount} queued for review, ${flaggedCount} flagged, ${errorCount} errored.`);
  await closePools();
}

main().catch(async (e) => {
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) log(e.stack);
  await closePools();
  process.exit(1);
});
