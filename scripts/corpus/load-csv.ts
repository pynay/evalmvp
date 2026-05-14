import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import type { Origin, RawEmail } from './types';

interface CsvRow {
  source?: string;
  vendor?: string;
  subject: string;
  body: string;
}

export function parseCsv(csv: string, origin: Origin): RawEmail[] {
  if (origin !== 'human' && origin !== 'template') {
    throw new Error(`parseCsv expects origin 'human' or 'template', got '${origin}'`);
  }

  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  return records
    .filter((r) => r.subject && r.body)
    .map((r) => ({
      origin,
      source: r.source,
      vendor: r.vendor,
      subject: r.subject,
      body: r.body,
    }));
}

export function loadCsvFile(path: string, origin: Origin): RawEmail[] {
  const csv = readFileSync(path, 'utf-8');
  return parseCsv(csv, origin);
}
