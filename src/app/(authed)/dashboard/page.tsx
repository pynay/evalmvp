import Link from 'next/link';
import type { Route } from 'next';
import { eq, and, inArray } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import { withRls } from '@/lib/db/with-rls';
import { workspaces, prospects, generations } from '@/lib/db/schema';
import { getSetup } from '../setup/actions';
import { GenerateButton } from './GenerateButton';

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const setup = await getSetup();

  const hasIcp = setup?.icp != null;
  const hasSender = setup?.sender != null;
  const ready = hasIcp && hasSender;

  // Counts for the dashboard summary
  const counts = ready && user
    ? await withRls(user.id, async (db) => {
        const [ws] = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
        if (!ws) return { prospects: 0, awaiting: 0 };
        const [prospectsCount] = await db
          .select({ id: prospects.id })
          .from(prospects)
          .where(eq(prospects.workspaceId, ws.id))
          .limit(500);
        const allProspects = await db
          .select({ id: prospects.id })
          .from(prospects)
          .where(eq(prospects.workspaceId, ws.id));
        const awaitingRows = await db
          .select({ id: generations.id })
          .from(generations)
          .where(
            and(
              eq(generations.workspaceId, ws.id),
              inArray(generations.status, ['needs_review', 'flagged']),
            ),
          );
        return { prospects: allProspects.length, awaiting: awaitingRows.length };
      })
    : { prospects: 0, awaiting: 0 };

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
        <>
          <section className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Prospects ({counts.prospects})</h2>
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

          <section className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Generate</h2>
            <p className="mt-2 text-sm text-neutral-600">
              Run the eval-gated loop on prospects without an existing generation. Cost ~$0.05&ndash;0.20 each.
            </p>
            <div className="mt-4">
              <GenerateButton />
            </div>
          </section>

          <section className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Approval ({counts.awaiting} awaiting)</h2>
            <p className="mt-2 text-sm text-neutral-600">
              Review generated drafts, see per-judge scores, copy + approve, or reject.
            </p>
            <Link
              href={'/approval' as Route}
              className="mt-4 inline-block rounded bg-black px-4 py-2 text-sm text-white"
            >
              Open approval queue
            </Link>
          </section>
        </>
      )}
    </main>
  );
}
