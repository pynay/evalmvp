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
