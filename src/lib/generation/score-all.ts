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
