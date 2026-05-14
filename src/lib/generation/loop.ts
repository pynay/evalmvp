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
  threshold?: number;
  maxRetries?: number;
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

    feedback = buildFeedback(draft, scores, overall);
  }

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
