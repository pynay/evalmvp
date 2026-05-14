import { generations, scores } from '../db/schema';
import { GENERATION_VERSION, type GenerationResult } from './types';
import { SONNET_MODEL } from '../anthropic';
import { AI_DETECTION_VERSION } from '../judges/types';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../db/schema';

// Mirrors the version constants exported by the judge modules — copied here
// to avoid a circular-import pull from genericness.ts / personalization.ts.
const GENERICNESS_VERSION = 'v1.0';
const PERSONALIZATION_VERSION = 'v1';

type Db = PostgresJsDatabase<typeof schema>;

export interface PersistArgs {
  workspaceId: string;
  prospectId: string;
  senderId: string;
  icpId: string | null;
  result: GenerationResult;
}

/**
 * Insert a generation row + its 3 score rows. Caller provides a DB handle
 * (either authed-via-withRls or service-role). Returns the generation id.
 *
 * Schema reminder:
 *   generations.overall_score is numeric(5,2) — Drizzle accepts string for numeric.
 *   scores.score is numeric(5,2) — same.
 */
export async function persistGenerationResult(db: Db, args: PersistArgs): Promise<string> {
  const [gen] = await db
    .insert(generations)
    .values({
      workspaceId: args.workspaceId,
      prospectId: args.prospectId,
      senderId: args.senderId,
      icpId: args.icpId,
      subject: args.result.finalDraft.subject,
      body: args.result.finalDraft.body,
      model: SONNET_MODEL,
      promptVersion: GENERATION_VERSION,
      retryCount: args.result.retryCount,
      status: args.result.status,
      overallScore: args.result.overall.toString(),
    })
    .returning({ id: generations.id });

  const generationId = gen.id;

  await db.insert(scores).values([
    {
      workspaceId: args.workspaceId,
      generationId,
      judgeName: 'ai_detection',
      score: Math.round(args.result.finalScores.aiDetection.overall).toString(),
      subScoresJsonb: args.result.finalScores.aiDetection.axisScores,
      evidenceJsonb: { redFlags: args.result.finalScores.aiDetection.redFlags },
      judgeVersion: AI_DETECTION_VERSION,
    },
    {
      workspaceId: args.workspaceId,
      generationId,
      judgeName: 'genericness',
      score: Math.round(args.result.finalScores.genericness.overall).toString(),
      subScoresJsonb: args.result.finalScores.genericness.axisScores,
      evidenceJsonb: { matches: args.result.finalScores.genericness.evidence },
      judgeVersion: GENERICNESS_VERSION,
    },
    {
      workspaceId: args.workspaceId,
      generationId,
      judgeName: 'personalization',
      score: args.result.finalScores.personalization.score.toString(),
      subScoresJsonb: {
        groundedRefCount: args.result.finalScores.personalization.groundedRefCount,
        genericTokenHits: args.result.finalScores.personalization.genericTokenHits,
      },
      evidenceJsonb: { references: args.result.finalScores.personalization.references },
      judgeVersion: PERSONALIZATION_VERSION,
    },
  ]);

  return generationId;
}
