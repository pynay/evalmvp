'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import { withRls } from '@/lib/db/with-rls';
import { workspaces, icps, senders, prospects, generations } from '@/lib/db/schema';
import { generateForProspect } from '@/lib/generation/loop';
import { persistGenerationResult } from '@/lib/generation/persist';
import type { Sender, Icp, Prospect } from '@/lib/generation/types';

const GENERATE_BUTTON_MAX = 3;

export interface GenerateBatchResult {
  ok: boolean;
  generated: number;
  flagged: number;
  errors: number;
  reason?: string;
}

/**
 * Triggered from the dashboard "Generate" button. Reads up to GENERATE_BUTTON_MAX
 * prospects without a generation, runs the eval loop on each, persists results.
 * Synchronous + blocking; the page reloads to /approval after.
 *
 * Cap is intentional: each prospect costs ~$0.05-0.20 and takes ~30s with retries.
 * 3 prospects × 30s = ~90s — at the edge of server-action UX patience.
 */
export async function generateUnscored(): Promise<GenerateBatchResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, generated: 0, flagged: 0, errors: 0, reason: 'Not authenticated' };

  try {
    const setup = await withRls(user.id, async (db) => {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
      if (!ws) throw new Error('No workspace');
      const [icp] = await db.select().from(icps).where(eq(icps.workspaceId, ws.id)).limit(1);
      const [sender] = await db.select().from(senders).where(eq(senders.workspaceId, ws.id)).limit(1);
      if (!icp || !sender) throw new Error('Visit /setup first to configure ICP and sender');
      return { ws, icp, sender };
    });

    const rows = await withRls(user.id, async (db) => {
      return db
        .select({
          id: prospects.id,
          email: prospects.email,
          firstName: prospects.firstName,
          lastName: prospects.lastName,
          company: prospects.company,
          role: prospects.role,
          enrichmentJsonb: prospects.enrichmentJsonb,
        })
        .from(prospects)
        .leftJoin(generations, eq(generations.prospectId, prospects.id))
        .where(and(eq(prospects.workspaceId, setup.ws.id), isNull(generations.id)))
        .orderBy(desc(prospects.createdAt))
        .limit(GENERATE_BUTTON_MAX);
    });

    if (rows.length === 0) {
      return { ok: true, generated: 0, flagged: 0, errors: 0, reason: 'No prospects without generations' };
    }

    const sender: Sender = {
      name: setup.sender.name,
      email: setup.sender.email,
      voiceSamples: setup.sender.voiceSamplesJsonb as Array<{ subject: string; body: string }>,
    };
    const icp: Icp = {
      industry: setup.icp.industry as string[],
      roleKeywords: setup.icp.roleKeywords as string[],
      valueProp: setup.icp.valueProp ?? '',
    };

    let generated = 0;
    let flagged = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const prospect: Prospect = {
          email: row.email,
          firstName: row.firstName ?? undefined,
          lastName: row.lastName ?? undefined,
          company: row.company ?? undefined,
          role: row.role ?? undefined,
          enrichment: (row.enrichmentJsonb as Record<string, unknown>) ?? {},
        };

        const result = await generateForProspect({ prospect, sender, icp });

        await withRls(user.id, async (db) => {
          await persistGenerationResult(db, {
            workspaceId: setup.ws.id,
            prospectId: row.id,
            senderId: setup.sender.id,
            icpId: setup.icp.id,
            result,
          });
        });

        if (result.status === 'needs_review') generated++;
        else flagged++;
      } catch {
        errors++;
      }
    }

    revalidatePath('/approval');
    revalidatePath('/dashboard');

    return { ok: true, generated, flagged, errors };
  } catch (e) {
    return {
      ok: false,
      generated: 0,
      flagged: 0,
      errors: 0,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function approveGeneration(generationId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  try {
    await withRls(user.id, async (db) => {
      await db
        .update(generations)
        .set({ status: 'approved', approvedAt: new Date(), approvedBy: user.id })
        .where(eq(generations.id, generationId));
    });
    revalidatePath('/approval');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rejectGeneration(generationId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  try {
    await withRls(user.id, async (db) => {
      await db
        .update(generations)
        .set({ status: 'rejected' })
        .where(eq(generations.id, generationId));
    });
    revalidatePath('/approval');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
