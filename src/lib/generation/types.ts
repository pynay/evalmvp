import type { AiDetectionOutput, GenericnessOutput, PersonalizationOutput } from '../judges/types';

export interface Draft {
  subject: string;
  body: string;
}

export interface Sender {
  name: string;
  email: string;
  voiceSamples: Array<{ subject: string; body: string }>;
}

export interface Icp {
  industry: string[];
  roleKeywords: string[];
  valueProp: string;
  sizeRange?: string;
}

export interface Prospect {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  role?: string;
  enrichment: Record<string, unknown>;
}

export interface ScoreBundle {
  aiDetection: AiDetectionOutput;
  genericness: GenericnessOutput;
  personalization: PersonalizationOutput;
}

export type LoopStatus = 'needs_review' | 'flagged';

export interface GenerationResult {
  status: LoopStatus;
  finalDraft: Draft;
  finalScores: ScoreBundle;
  overall: number;
  retryCount: number;
  attempts: Array<{
    draft: Draft;
    scores: ScoreBundle;
    overall: number;
  }>;
}

export const GENERATION_VERSION = 'v1';

export const BLEND_WEIGHTS = {
  aiDetection: 0.4,
  genericness: 0.3,
  personalization: 0.3,
} as const;

export const DEFAULT_THRESHOLD = 70;
export const MAX_RETRIES = 3;
