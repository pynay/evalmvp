import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Sender, Icp, Prospect } from './types';

const TEMPLATE = readFileSync(resolve(process.cwd(), 'prompts/generation/v2.md'), 'utf-8');

function renderVoiceSamples(samples: Array<{ subject: string; body: string }>): string {
  return samples
    .map((s, i) => `### Sample ${i + 1}\nSubject: ${s.subject}\n\n${s.body}`)
    .join('\n\n---\n\n');
}

function renderIcp(icp: Icp): string {
  const lines = [
    `- Industry: ${icp.industry.join(', ')}`,
    `- Target role(s): ${icp.roleKeywords.join(', ')}`,
    `- Value prop: ${icp.valueProp}`,
  ];
  if (icp.sizeRange) lines.push(`- Company size: ${icp.sizeRange}`);
  return lines.join('\n');
}

export function buildSystemPrompt(sender: Sender, icp: Icp): string {
  return TEMPLATE
    .replace('{{VOICE_SAMPLES}}', renderVoiceSamples(sender.voiceSamples))
    .replace('{{ICP}}', renderIcp(icp));
}

export function buildUserPrompt(args: { prospect: Prospect; feedback: string | null }): string {
  const { prospect, feedback } = args;
  const lines = [
    `Write a cold email to this prospect.`,
    ``,
    `Prospect:`,
    `- Name: ${prospect.firstName ?? '(unknown)'}${prospect.lastName ? ' ' + prospect.lastName : ''}`,
    `- Email: ${prospect.email}`,
    `- Company: ${prospect.company ?? '(unknown)'}`,
    `- Role: ${prospect.role ?? '(unknown)'}`,
    ``,
    `Enrichment JSON:`,
    JSON.stringify(prospect.enrichment, null, 2),
    ``,
  ];

  if (feedback) {
    lines.push(`---`);
    lines.push(feedback);
    lines.push(`---`);
    lines.push(``);
  }

  lines.push(`Output JSON only: { "subject": "...", "body": "..." }`);
  return lines.join('\n');
}
