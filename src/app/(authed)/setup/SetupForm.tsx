'use client';

import { useState, useTransition } from 'react';
import { saveSetup, type SetupInput, type SetupSnapshot } from './actions';

interface VoiceSample {
  subject: string;
  body: string;
}

const EMPTY_SAMPLE: VoiceSample = { subject: '', body: '' };

export function SetupForm({ initial }: { initial: SetupSnapshot | null }) {
  const [industry, setIndustry] = useState(initial?.icp?.industry?.join(', ') ?? '');
  const [roleKeywords, setRoleKeywords] = useState(initial?.icp?.roleKeywords?.join(', ') ?? '');
  const [valueProp, setValueProp] = useState(initial?.icp?.valueProp ?? '');
  const [threshold, setThreshold] = useState(initial?.icp?.thresholdDefault ?? 70);

  const [senderName, setSenderName] = useState(initial?.sender?.name ?? '');
  const [senderEmail, setSenderEmail] = useState(initial?.sender?.email ?? '');

  const initialSamples = initial?.sender?.voiceSamples ?? [];
  const [samples, setSamples] = useState<VoiceSample[]>(
    initialSamples.length >= 3 ? initialSamples : [EMPTY_SAMPLE, EMPTY_SAMPLE, EMPTY_SAMPLE],
  );

  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function updateSample(i: number, field: keyof VoiceSample, value: string) {
    setSamples((s) => s.map((v, idx) => (idx === i ? { ...v, [field]: value } : v)));
  }

  function addSample() {
    if (samples.length >= 10) return;
    setSamples((s) => [...s, { subject: '', body: '' }]);
  }

  function removeSample(i: number) {
    if (samples.length <= 3) return;
    setSamples((s) => s.filter((_, idx) => idx !== i));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload: SetupInput = {
      icp: {
        industry: industry.split(',').map((s) => s.trim()).filter(Boolean),
        roleKeywords: roleKeywords.split(',').map((s) => s.trim()).filter(Boolean),
        valueProp: valueProp.trim(),
        thresholdDefault: threshold,
      },
      sender: {
        name: senderName.trim(),
        email: senderEmail.trim(),
        voiceSamples: samples.map((s) => ({ subject: s.subject.trim(), body: s.body.trim() })),
      },
    };

    startTransition(async () => {
      const result = await saveSetup(payload);
      if (result && 'ok' in result && !result.ok) {
        setError(result.error);
      }
      // success: server action redirects to /dashboard; no client-side handling needed
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-10">
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">ICP &mdash; who you&apos;re pitching</h2>
        <p className="text-sm text-neutral-600">
          The generator uses these fields in the system prompt to bias toward your target buyer.
        </p>

        <label className="block">
          <span className="text-sm font-medium">Industries (comma-separated)</span>
          <input
            type="text"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="B2B SaaS, DevTools"
            className="mt-1 block w-full rounded border border-neutral-300 px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Target role keywords (comma-separated)</span>
          <input
            type="text"
            value={roleKeywords}
            onChange={(e) => setRoleKeywords(e.target.value)}
            placeholder="Head of Sales, VP Sales, RevOps"
            className="mt-1 block w-full rounded border border-neutral-300 px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Value proposition</span>
          <textarea
            value={valueProp}
            onChange={(e) => setValueProp(e.target.value)}
            placeholder="cut sales-cycle time in half using eval-gated AI outbound"
            rows={3}
            className="mt-1 block w-full rounded border border-neutral-300 px-3 py-2"
          />
        </label>

        <label className="block max-w-xs">
          <span className="text-sm font-medium">Eval gate threshold (0–100)</span>
          <input
            type="number"
            value={threshold}
            min={0}
            max={100}
            onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
            className="mt-1 block w-full rounded border border-neutral-300 px-3 py-2"
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Default 70. Higher = stricter. Currently 85 in the generation code.
          </span>
        </label>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Sender identity</h2>
        <p className="text-sm text-neutral-600">
          The &quot;From:&quot; line that appears on generated emails. No OAuth in the bare MVP &mdash; emails are copy-pasted manually.
        </p>

        <label className="block">
          <span className="text-sm font-medium">Your name</span>
          <input
            type="text"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value)}
            placeholder="Pranay"
            className="mt-1 block w-full rounded border border-neutral-300 px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">From email</span>
          <input
            type="email"
            value={senderEmail}
            onChange={(e) => setSenderEmail(e.target.value)}
            placeholder="pranay@evalmvp.com"
            className="mt-1 block w-full rounded border border-neutral-300 px-3 py-2"
          />
        </label>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Voice samples</h2>
            <p className="text-sm text-neutral-600">
              Real cold emails you&apos;ve sent (or seen). 3&ndash;10 pairs. The generator&apos;s system prompt caches these as few-shot examples.
            </p>
          </div>
          <button
            type="button"
            onClick={addSample}
            disabled={samples.length >= 10}
            className="rounded bg-neutral-200 px-3 py-1 text-sm disabled:opacity-50"
          >
            Add sample ({samples.length}/10)
          </button>
        </div>

        {samples.map((s, i) => (
          <div key={i} className="rounded border border-neutral-200 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Sample {i + 1}</span>
              <button
                type="button"
                onClick={() => removeSample(i)}
                disabled={samples.length <= 3}
                className="text-xs text-red-600 disabled:opacity-30"
              >
                Remove
              </button>
            </div>
            <input
              type="text"
              value={s.subject}
              onChange={(e) => updateSample(i, 'subject', e.target.value)}
              placeholder="Subject"
              className="block w-full rounded border border-neutral-300 px-3 py-2"
            />
            <textarea
              value={s.body}
              onChange={(e) => updateSample(i, 'body', e.target.value)}
              placeholder="Body (≥20 chars)"
              rows={4}
              className="block w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm"
            />
          </div>
        ))}
      </section>

      {error && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-black px-6 py-2 text-white disabled:opacity-50"
      >
        {isPending ? 'Saving…' : 'Save and continue'}
      </button>
    </form>
  );
}
