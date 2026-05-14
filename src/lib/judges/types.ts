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
