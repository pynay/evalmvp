'use client';

import { useState, useTransition } from 'react';
import { generateUnscored, type GenerateBatchResult } from '../approval/actions';

export function GenerateButton() {
  const [result, setResult] = useState<GenerateBatchResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setResult(null);
    startTransition(async () => {
      const r = await generateUnscored();
      setResult(r);
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={isPending}
        className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {isPending ? 'Generating (up to ~90s)…' : 'Generate (up to 3 unscored prospects)'}
      </button>
      {result && (
        <div className="rounded border border-neutral-200 p-3 text-sm">
          {result.ok ? (
            <ul className="space-y-1">
              <li>✓ Queued for review: {result.generated}</li>
              {result.flagged > 0 && <li>! Flagged (below threshold): {result.flagged}</li>}
              {result.errors > 0 && <li>✗ Errors: {result.errors}</li>}
              {result.reason && <li className="text-neutral-500">{result.reason}</li>}
            </ul>
          ) : (
            <p className="text-red-700">{result.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}
