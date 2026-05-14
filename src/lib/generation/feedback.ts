import type { Draft, ScoreBundle } from './types';

/**
 * Build the structured + natural-language feedback included in the user message
 * on retry attempts. Spec §7.3 says the regen prompt gets both structured
 * sub-score deltas AND a natural-language critique. v1 critique is rule-based
 * (deterministic, free) — we can A/B against an LLM-generated critique later.
 */
export function buildFeedback(
  prevDraft: Draft,
  prevScores: ScoreBundle,
  prevOverall: number,
): string {
  const lines: string[] = [];

  lines.push(`PREVIOUS_DRAFT:`);
  lines.push(`Subject: ${prevDraft.subject}`);
  lines.push(prevDraft.body);
  lines.push(``);

  const ai = Math.round(prevScores.aiDetection.overall);
  const gen = Math.round(prevScores.genericness.overall);
  const pers = prevScores.personalization.score;

  lines.push(`SCORES (previous draft scored ${prevOverall}/100; need 70):`);
  lines.push(`  ai_detection: ${ai} (target ≥70; higher = more human)`);
  lines.push(`  genericness: ${gen} (target ≥70; higher = more unique)`);
  lines.push(`  personalization: ${pers} (target ≥70; grounded_refs=${prevScores.personalization.groundedRefCount}, generic_tokens=${prevScores.personalization.genericTokenHits.length})`);
  lines.push(``);

  const judgeScores: Array<[string, number]> = [
    ['ai_detection', ai],
    ['genericness', gen],
    ['personalization', pers],
  ];
  judgeScores.sort((a, b) => a[1] - b[1]);
  const [lowestName] = judgeScores[0];

  lines.push(`CRITIQUE:`);
  lines.push(`The lowest-scoring dimension is ${lowestName}. Focus the rewrite on lifting that one first.`);

  if (lowestName === 'ai_detection') {
    const axes = prevScores.aiDetection.axisScores;
    const lowAxes = Object.entries(axes)
      .filter(([_, s]) => s < 50)
      .map(([name, s]) => `${name}=${s}`);
    if (lowAxes.length > 0) {
      lines.push(`  Low axes: ${lowAxes.join(', ')}`);
    }
    const flags = prevScores.aiDetection.redFlags;
    if (flags.length > 0) {
      lines.push(`  Red flags from previous draft:`);
      for (const f of flags) {
        lines.push(`    - ${f.axis} (${f.severity}): "${f.evidence}"`);
      }
    }
  } else if (lowestName === 'personalization') {
    if (prevScores.personalization.genericTokenHits.length > 0) {
      lines.push(`  Replace these generic tokens with real prospect data from the enrichment JSON:`);
      for (const hit of prevScores.personalization.genericTokenHits) {
        lines.push(`    - "${hit}"`);
      }
    }
    if (prevScores.personalization.groundedRefCount === 0) {
      lines.push(`  Zero grounded references — add at least 2 specific facts from the enrichment that anchor to verifiable prospect data (a post they wrote, a person they hired, a number from a news mention).`);
    }
  } else {
    lines.push(`  The draft reads close to known AI SDR templates. Try a less common opener, vary sentence rhythm, drop any 3-paragraph structure.`);
  }

  lines.push(``);
  lines.push(`INSTRUCTIONS: Rewrite the email below. Preserve what worked in the highest-scoring dimension. Do NOT just paraphrase the previous draft.`);

  return lines.join('\n');
}
