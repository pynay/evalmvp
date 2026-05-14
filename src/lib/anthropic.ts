import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

export function anthropic() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

export const SONNET_MODEL = 'claude-sonnet-4-6';
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
