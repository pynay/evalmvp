import { eq, and, inArray, desc } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import { withRls } from '@/lib/db/with-rls';
import { workspaces, prospects, generations, scores } from '@/lib/db/schema';
import { GenerationRow, type GenerationItem } from './GenerationRow';

async function loadGenerations(): Promise<GenerationItem[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  return withRls(user.id, async (db) => {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
    if (!ws) return [];

    const genRows = await db
      .select({
        id: generations.id,
        subject: generations.subject,
        body: generations.body,
        status: generations.status,
        overallScore: generations.overallScore,
        retryCount: generations.retryCount,
        prospectId: generations.prospectId,
      })
      .from(generations)
      .where(
        and(
          eq(generations.workspaceId, ws.id),
          inArray(generations.status, ['needs_review', 'flagged']),
        ),
      )
      .orderBy(desc(generations.createdAt))
      .limit(50);

    if (genRows.length === 0) return [];

    const prospectIds = genRows.map((g) => g.prospectId);
    const prospectRows = await db
      .select({
        id: prospects.id,
        email: prospects.email,
        firstName: prospects.firstName,
        company: prospects.company,
      })
      .from(prospects)
      .where(inArray(prospects.id, prospectIds));
    const prospectMap = new Map(prospectRows.map((p) => [p.id, p]));

    const generationIds = genRows.map((g) => g.id);
    const scoreRows = await db
      .select({
        generationId: scores.generationId,
        judgeName: scores.judgeName,
        score: scores.score,
        subScoresJsonb: scores.subScoresJsonb,
      })
      .from(scores)
      .where(inArray(scores.generationId, generationIds));

    const scoreMap = new Map<string, typeof scoreRows>();
    for (const s of scoreRows) {
      const arr = scoreMap.get(s.generationId) ?? [];
      arr.push(s);
      scoreMap.set(s.generationId, arr);
    }

    return genRows.map((g): GenerationItem => {
      const p = prospectMap.get(g.prospectId);
      const judgeRows = scoreMap.get(g.id) ?? [];
      const aiRow = judgeRows.find((j) => j.judgeName === 'ai_detection');
      const genRow = judgeRows.find((j) => j.judgeName === 'genericness');
      const persRow = judgeRows.find((j) => j.judgeName === 'personalization');
      const persSub = persRow?.subScoresJsonb as
        | { groundedRefCount?: number; genericTokenHits?: string[] }
        | null;
      return {
        id: g.id,
        prospectEmail: p?.email ?? '(unknown)',
        prospectFirstName: p?.firstName ?? null,
        prospectCompany: p?.company ?? null,
        subject: g.subject,
        body: g.body,
        status: g.status,
        overallScore: Math.round(parseFloat(g.overallScore ?? '0')),
        retryCount: g.retryCount,
        scores: {
          aiDetection: Math.round(parseFloat(aiRow?.score ?? '0')),
          genericness: Math.round(parseFloat(genRow?.score ?? '0')),
          personalization: Math.round(parseFloat(persRow?.score ?? '0')),
          groundedRefCount: persSub?.groundedRefCount ?? null,
          genericTokenHits: persSub?.genericTokenHits ?? [],
        },
      };
    });
  });
}

export default async function ApprovalPage() {
  const items = await loadGenerations();

  return (
    <main className="mx-auto max-w-4xl px-6 py-8 space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Approval</h1>
        <p className="mt-2 text-neutral-600">
          Generations awaiting review. Click a row to expand, see scores, copy the email, and approve or reject.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="rounded bg-neutral-50 p-4 text-sm text-neutral-600">
          No generations awaiting review. Run <code className="rounded bg-neutral-200 px-1">pnpm gen:all</code> or click Generate on the dashboard.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <GenerationRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </main>
  );
}
