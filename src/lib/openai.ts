import OpenAI from 'openai';

let _client: OpenAI | null = null;

export function openai() {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  _client = new OpenAI({ apiKey });
  return _client;
}

export const GPT4O_MODEL = 'gpt-4o';
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
