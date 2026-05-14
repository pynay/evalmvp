'use client';

import { useState, useTransition } from 'react';
import { uploadProspects, type UploadResult } from './actions';

const PLACEHOLDER = `# One prospect per line:
# email, first_name, company[, linkedin_url]
pete@acme.com, Pete, Acme Observability, https://linkedin.com/in/pete-sloan
sarah@cardera.com, Sarah, Cardera`;

export function ProspectsForm() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      const r = await uploadProspects(text);
      setResult(r);
      if (r.ok && r.inserted > 0) {
        setText('');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Paste prospects (max 10 per submission)</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={10}
          className="mt-1 block w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm"
        />
        <span className="mt-1 block text-xs text-neutral-500">
          Format: <code>email, first_name, company[, linkedin_url]</code>. Lines starting with # are skipped. If APIFY_API_KEY is set, linkedin_url enriches the prospect; otherwise we fall back to CSV-only.
        </span>
      </label>

      <button
        type="submit"
        disabled={isPending || !text.trim()}
        className="rounded bg-black px-6 py-2 text-white disabled:opacity-50"
      >
        {isPending ? 'Uploading + enriching…' : 'Upload + enrich'}
      </button>

      {result && (
        <div className="rounded border border-neutral-200 p-3 text-sm">
          {result.fatal ? (
            <p className="text-red-700">{result.fatal}</p>
          ) : (
            <ul className="space-y-1">
              <li>✓ Inserted: {result.inserted}</li>
              {result.duplicates > 0 && <li>{result.duplicates} duplicate(s) skipped (already in workspace)</li>}
              {result.enriched > 0 && <li>✓ Enriched via Apify: {result.enriched}</li>}
              {result.enrichmentFailures > 0 && <li>! Apify failures: {result.enrichmentFailures}</li>}
              {result.parseErrors.length > 0 && (
                <li>
                  Parse errors on {result.parseErrors.length} line(s):
                  <ul className="ml-4 mt-1 list-disc text-red-700">
                    {result.parseErrors.map((e, i) => (
                      <li key={i}>line {e.line}: {e.message}</li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
