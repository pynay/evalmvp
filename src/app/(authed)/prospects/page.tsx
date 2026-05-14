import { eq, desc } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import { withRls } from '@/lib/db/with-rls';
import { workspaces, prospects } from '@/lib/db/schema';
import { ProspectsForm } from './ProspectsForm';

interface ProspectSummary {
  id: string;
  email: string;
  firstName: string | null;
  company: string | null;
  linkedinUrl: string | null;
  enrichmentStatus: string | null;
  createdAt: Date;
}

async function loadProspects(): Promise<ProspectSummary[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  return withRls(user.id, async (db) => {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
    if (!ws) return [];

    const rows = await db
      .select({
        id: prospects.id,
        email: prospects.email,
        firstName: prospects.firstName,
        company: prospects.company,
        linkedinUrl: prospects.linkedinUrl,
        enrichmentStatus: prospects.enrichmentStatus,
        createdAt: prospects.createdAt,
      })
      .from(prospects)
      .where(eq(prospects.workspaceId, ws.id))
      .orderBy(desc(prospects.createdAt))
      .limit(50);
    return rows;
  });
}

export default async function ProspectsPage() {
  const list = await loadProspects();

  return (
    <main className="mx-auto max-w-4xl px-6 py-8 space-y-8">
      <header>
        <h1 className="text-3xl font-semibold">Prospects</h1>
        <p className="mt-2 text-neutral-600">
          Paste a small batch of prospects to enrich and queue for generation.
        </p>
      </header>

      <section>
        <ProspectsForm />
      </section>

      <section>
        <h2 className="text-xl font-semibold">Recent prospects ({list.length})</h2>
        {list.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">None yet. Paste some above.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead className="border-b border-neutral-200">
              <tr className="text-left">
                <th className="py-2 font-medium">Email</th>
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Company</th>
                <th className="py-2 font-medium">Enrichment</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="border-b border-neutral-100">
                  <td className="py-2 font-mono text-xs">{p.email}</td>
                  <td className="py-2">{p.firstName ?? '—'}</td>
                  <td className="py-2">{p.company ?? '—'}</td>
                  <td className="py-2">
                    <EnrichmentBadge status={p.enrichmentStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function EnrichmentBadge({ status }: { status: string | null }) {
  const colors: Record<string, string> = {
    pending: 'bg-neutral-100 text-neutral-700',
    ok: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    fallback_csv_only: 'bg-yellow-100 text-yellow-700',
  };
  const cls = colors[status ?? ''] ?? 'bg-neutral-100 text-neutral-700';
  return <span className={`rounded px-2 py-0.5 text-xs ${cls}`}>{status ?? 'unknown'}</span>;
}
