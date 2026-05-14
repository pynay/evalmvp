// Bare-MVP v1.2: AI + human only, template skipped. The AI generator already
// covers template-style patterns via its prompt variants. The human target
// matches the example CSV until founders curate more (corpus is INSERT-only,
// so growing it later is free — just edit data/seed-human-emails.csv and re-run).
export const CORPUS_TARGETS = {
  ai: 500,
  human: 5,
  template: 0,
} as const;

// Smoke run: tiny sample to verify the pipeline end-to-end without burning API quota
export const SMOKE_TARGETS = {
  ai: 4,
  human: 2,
  template: 2,
} as const;

// ICP variants the AI generator targets. Diverse enough that the generated
// corpus doesn't all read like emails to the same buyer.
export const ICP_VARIANTS = [
  { industry: 'B2B SaaS', role: 'Head of Sales', size: 'Series A-B (20-100 employees)', valueProp: 'cut deal cycle in half' },
  { industry: 'E-commerce DTC', role: 'CMO', size: '$10-50M ARR', valueProp: 'increase repeat purchase rate' },
  { industry: 'Healthcare IT', role: 'VP Engineering', size: '500-2000 employees', valueProp: 'HIPAA-compliant audit logs' },
  { industry: 'Financial Services', role: 'Head of Compliance', size: 'mid-market bank', valueProp: 'automate KYC review' },
  { industry: 'Construction', role: 'Operations Director', size: '$5-30M revenue', valueProp: 'reduce subcontractor invoice delays' },
  { industry: 'Manufacturing', role: 'Plant Manager', size: '100-500 employees', valueProp: 'predictive maintenance' },
  { industry: 'Education (K-12 SaaS)', role: 'Head of Product', size: 'late seed - Series A', valueProp: 'teacher onboarding flow' },
  { industry: 'Logistics / 3PL', role: 'VP Operations', size: '$20-200M revenue', valueProp: 'last-mile route optimization' },
  { industry: 'Real Estate (PropTech)', role: 'CTO', size: 'Series B+', valueProp: 'tenant communication automation' },
  { industry: 'Legal Tech', role: 'Head of Customer Success', size: 'post-Series A', valueProp: 'reduce onboarding time' },
] as const;

// Prompt styles intentionally cover the spectrum AI SDR tools produce.
// Names match what AI-Detection's `opener`/`structure`/`rhythm` axes look for.
export const PROMPT_STYLES = [
  { name: 'rigid-three-paragraph', instruction: 'Write a cold email with a 3-paragraph structure: opener referencing their company, middle paragraph with value prop and a stat, closing with a soft CTA.' },
  { name: 'hedge-heavy', instruction: 'Write a cold email that is polite, professional, and uses some hedging language ("might be", "could potentially", "I think").' },
  { name: 'casual-friendly', instruction: 'Write a casual, friendly cold email. Short paragraphs, conversational tone. Avoid corporate jargon.' },
  { name: 'data-driven', instruction: 'Write a cold email that leads with a specific stat about their industry, then asks if they\'re seeing the same trend.' },
  { name: 'question-led-cta', instruction: 'Write a cold email that ends with a dual-option CTA ("worth a quick chat, or open to ideas?").' },
] as const;

export const GENERATORS = [
  { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' },
  { provider: 'openai' as const, model: 'gpt-4o' },
];
