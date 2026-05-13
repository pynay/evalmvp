export type Origin = 'ai' | 'human' | 'template';

export interface RawEmail {
  origin: Origin;
  source?: string;       // url, dataset name, or generator id
  model?: string;        // for ai
  vendor?: string;       // for template
  subject: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface Segments {
  opener: string;
  bodyMiddle: string;
  cta: string;
}

export interface EmbeddedEmail extends RawEmail {
  segments: Segments;
  embedding: {
    opener: number[];
    body: number[];
    cta: number[];
  };
}
