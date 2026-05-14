import Link from 'next/link';
import type { Route } from 'next';
import { createClient } from '@/lib/supabase/server';
import { getSetup } from '../setup/actions';

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const setup = await getSetup();

  const hasIcp = setup?.icp != null;
  const hasSender = setup?.sender != null;
  const ready = hasIcp && hasSender;

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-sm text-neutral-600">Signed in as {user?.email}</p>
      </div>

      <section className="rounded border border-neutral-200 p-4">
        <h2 className="font-semibold">Setup status</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li>{hasIcp ? '✓' : '✗'} ICP defined</li>
          <li>{hasSender ? '✓' : '✗'} Sender + voice samples</li>
        </ul>
        <Link
          href={'/setup' as Route}
          className="mt-4 inline-block rounded bg-black px-4 py-2 text-sm text-white"
        >
          {ready ? 'Edit setup' : 'Complete setup'}
        </Link>
      </section>

      {ready && (
        <section className="rounded border border-neutral-200 p-4">
          <h2 className="font-semibold">Prospects</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Upload prospects in batches of up to 10. Apify enrichment fires inline.
          </p>
          <Link
            href={'/prospects' as Route}
            className="mt-4 inline-block rounded bg-black px-4 py-2 text-sm text-white"
          >
            Manage prospects
          </Link>
        </section>
      )}
    </main>
  );
}
