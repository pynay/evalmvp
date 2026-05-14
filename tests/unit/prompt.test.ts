import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt } from '../../src/lib/generation/prompt';
import type { Sender, Icp, Prospect } from '../../src/lib/generation/types';

const sender: Sender = {
  name: 'Pranay',
  email: 'pranay@evalmvp.com',
  voiceSamples: [
    { subject: 'About your latest hire', body: 'Saw you brought Jen on as VP Eng. Worked with her at Linear in 2022.' },
    { subject: 'Bonsai post', body: 'Hey Marc — saw your post about the juniper. Tried wiring last winter.' },
  ],
};

const icp: Icp = {
  industry: ['B2B SaaS'],
  roleKeywords: ['Head of Sales', 'VP Sales'],
  valueProp: 'cut deal cycle in half',
  sizeRange: 'Series A-B',
};

const prospect: Prospect = {
  email: 'pete@acme.com',
  firstName: 'Pete',
  company: 'Acme',
  role: 'CTO',
  enrichment: {
    headline: 'CTO at Acme',
    recent_posts: [{ title: 'Ditching Datadog for Tempo' }],
  },
};

describe('buildSystemPrompt', () => {
  it('includes voice samples verbatim', () => {
    const sys = buildSystemPrompt(sender, icp);
    expect(sys).toContain('Saw you brought Jen on as VP Eng');
    expect(sys).toContain('Bonsai post');
  });

  it('includes ICP fields', () => {
    const sys = buildSystemPrompt(sender, icp);
    expect(sys).toContain('B2B SaaS');
    expect(sys).toContain('cut deal cycle in half');
  });

  it('contains the banned-vocabulary list (hard rules)', () => {
    const sys = buildSystemPrompt(sender, icp);
    expect(sys.toLowerCase()).toContain('leverage');
    expect(sys.toLowerCase()).toContain('em-dash');
  });
});

describe('buildUserPrompt', () => {
  it('includes prospect fields', () => {
    const user = buildUserPrompt({ prospect, feedback: null });
    expect(user).toContain('Pete');
    expect(user).toContain('Acme');
    expect(user).toContain('CTO');
  });

  it('serializes enrichment as JSON', () => {
    const user = buildUserPrompt({ prospect, feedback: null });
    expect(user).toContain('Ditching Datadog for Tempo');
  });

  it('includes feedback block on retry', () => {
    const fb = 'PREVIOUS_DRAFT:\nSubject: x\nbody\n\nSCORES:\n  ai_detection: 30';
    const user = buildUserPrompt({ prospect, feedback: fb });
    expect(user).toContain('PREVIOUS_DRAFT');
    expect(user).toContain('ai_detection: 30');
  });

  it('omits feedback block on first attempt', () => {
    const user = buildUserPrompt({ prospect, feedback: null });
    expect(user).not.toContain('PREVIOUS_DRAFT');
  });
});
