'use client';

import { useState, useTransition } from 'react';
import { approveGeneration, rejectGeneration } from './actions';

export interface GenerationItem {
  id: string;
  prospectEmail: string;
  prospectFirstName: string | null;
  prospectCompany: string | null;
  subject: string | null;
  body: string | null;
  status: string;
  overallScore: number;
  retryCount: number;
  scores: {
    aiDetection: number;
    genericness: number;
    personalization: number;
    groundedRefCount: number | null;
    genericTokenHits: string[];
  };
}

export function GenerationRow({ item }: { item: GenerationItem }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<null | 'approved' | 'rejected'>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const scoreClass = (s: number) =>
    s >= 80 ? 'text-green-700' : s >= 70 ? 'text-yellow-700' : 'text-red-700';

  function copy() {
    if (!item.body) return;
    navigator.clipboard.writeText(`Subject: ${item.subject ?? ''}\n\n${item.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function approve() {
    setError(null);
    startTransition(async () => {
      const r = await approveGeneration(item.id);
      if (!r.ok) setError(r.error ?? 'Failed');
      else setDone('approved');
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const r = await rejectGeneration(item.id);
      if (!r.ok) setError(r.error ?? 'Failed');
      else setDone('rejected');
    });
  }

  if (done) {
    return (
      <li className="rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">
        {item.prospectEmail} &mdash; {done}
      </li>
    );
  }

  return (
    <li className="rounded border border-neutral-200">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <span className={`font-mono text-sm font-semibold ${scoreClass(item.overallScore)}`}>
              {item.overallScore}
            </span>
            <span className="font-medium">{item.prospectFirstName ?? item.prospectEmail}</span>
            <span className="text-sm text-neutral-500">{item.prospectCompany ?? ''}</span>
            {item.status === 'flagged' && (
              <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">flagged</span>
            )}
          </div>
          <div className="mt-1 text-sm text-neutral-600">{item.subject ?? '(no subject)'}</div>
        </div>
        <span className="text-xs text-neutral-400">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-neutral-200 px-4 py-4 space-y-4">
          <div className="rounded bg-neutral-50 p-3">
            <div className="font-semibold">Subject: {item.subject}</div>
            <div className="mt-2 whitespace-pre-wrap font-serif text-sm leading-relaxed">{item.body}</div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="rounded border border-neutral-200 p-2">
              <div className="text-xs text-neutral-500">AI-Detection</div>
              <div className={`text-lg font-semibold ${scoreClass(item.scores.aiDetection)}`}>
                {item.scores.aiDetection}
              </div>
            </div>
            <div className="rounded border border-neutral-200 p-2">
              <div className="text-xs text-neutral-500">Genericness</div>
              <div className={`text-lg font-semibold ${scoreClass(item.scores.genericness)}`}>
                {item.scores.genericness}
              </div>
            </div>
            <div className="rounded border border-neutral-200 p-2">
              <div className="text-xs text-neutral-500">Personalization</div>
              <div className={`text-lg font-semibold ${scoreClass(item.scores.personalization)}`}>
                {item.scores.personalization}
              </div>
              <div className="mt-1 text-xs text-neutral-500">
                refs: {item.scores.groundedRefCount ?? 0}, generic: {item.scores.genericTokenHits.length}
              </div>
            </div>
          </div>

          <div className="text-xs text-neutral-500">
            retries: {item.retryCount} &nbsp;|&nbsp; to: {item.prospectEmail}
          </div>

          {error && <p className="text-sm text-red-700">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={copy}
              className="rounded bg-neutral-200 px-4 py-2 text-sm"
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={approve}
              disabled={isPending}
              className="rounded bg-green-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {isPending ? '…' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={reject}
              disabled={isPending}
              className="rounded bg-neutral-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {isPending ? '…' : 'Reject'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
