import { describe, it, expect } from 'vitest';
import { parseCsv } from '../../scripts/corpus/load-csv';

describe('parseCsv', () => {
  it('parses human corpus rows', () => {
    const csv = `source,subject,body
"r/sales","Test subject","Body content here"
"Twitter","Another subject","Another body"`;
    const rows = parseCsv(csv, 'human');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      origin: 'human',
      source: 'r/sales',
      subject: 'Test subject',
      body: 'Body content here',
    });
  });

  it('parses template corpus rows with vendor', () => {
    const csv = `vendor,source,subject,body
"Apollo","apollo.io/templates","Test","Body"`;
    const rows = parseCsv(csv, 'template');
    expect(rows[0]).toEqual({
      origin: 'template',
      vendor: 'Apollo',
      source: 'apollo.io/templates',
      subject: 'Test',
      body: 'Body',
    });
  });

  it('rejects rows with empty subject or body', () => {
    const csv = `source,subject,body
"x","","missing subject"
"y","has subject","valid"`;
    const rows = parseCsv(csv, 'human');
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('has subject');
  });

  it('throws on unknown origin', () => {
    expect(() => parseCsv('source,subject,body\na,b,c', 'ai' as never)).toThrow(/origin/i);
  });
});
