'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import { withRls } from '@/lib/db/with-rls';
import { workspaces, icps, senders } from '@/lib/db/schema';

const setupSchema = z.object({
  icp: z.object({
    industry: z.array(z.string().min(1)).min(1, 'At least one industry required'),
    roleKeywords: z.array(z.string().min(1)).min(1, 'At least one role keyword required'),
    valueProp: z.string().min(10, 'Value prop must be at least 10 chars'),
    thresholdDefault: z.number().int().min(0).max(100).default(70),
  }),
  sender: z.object({
    name: z.string().min(1, 'Sender name required'),
    email: z.string().email('Valid email required'),
    voiceSamples: z
      .array(
        z.object({
          subject: z.string().min(1, 'Subject required'),
          body: z.string().min(20, 'Body must be at least 20 chars'),
        }),
      )
      .min(3, 'At least 3 voice samples required')
      .max(10, 'At most 10 voice samples'),
  }),
});

export type SetupInput = z.infer<typeof setupSchema>;
export type SetupSnapshot = {
  icp: {
    industry: string[];
    roleKeywords: string[];
    valueProp: string;
    thresholdDefault: number;
  } | null;
  sender: {
    name: string;
    email: string;
    voiceSamples: Array<{ subject: string; body: string }>;
  } | null;
};

export async function getSetup(): Promise<SetupSnapshot | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  return withRls(user.id, async (db) => {
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, user.id))
      .limit(1);
    if (!ws) return { icp: null, sender: null };

    const [icp] = await db
      .select()
      .from(icps)
      .where(and(eq(icps.workspaceId, ws.id), eq(icps.name, 'Default ICP')))
      .limit(1);
    const [sender] = await db
      .select()
      .from(senders)
      .where(eq(senders.workspaceId, ws.id))
      .limit(1);

    return {
      icp: icp
        ? {
            industry: icp.industry as string[],
            roleKeywords: icp.roleKeywords as string[],
            valueProp: icp.valueProp ?? '',
            thresholdDefault: icp.thresholdDefault,
          }
        : null,
      sender: sender
        ? {
            name: sender.name,
            email: sender.email,
            voiceSamples: (sender.voiceSamplesJsonb as Array<{ subject: string; body: string }>) ?? [],
          }
        : null,
    };
  });
}

export async function saveSetup(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const parsed = setupSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const data = parsed.data;

  try {
    await withRls(user.id, async (db) => {
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.ownerId, user.id))
        .limit(1);
      if (!ws) throw new Error('No workspace for this user');

      const icpFields = {
        industry: data.icp.industry,
        roleKeywords: data.icp.roleKeywords,
        valueProp: data.icp.valueProp,
        thresholdDefault: data.icp.thresholdDefault,
      };

      const [existingIcp] = await db
        .select()
        .from(icps)
        .where(and(eq(icps.workspaceId, ws.id), eq(icps.name, 'Default ICP')))
        .limit(1);

      if (existingIcp) {
        await db.update(icps).set(icpFields).where(eq(icps.id, existingIcp.id));
      } else {
        await db.insert(icps).values({ workspaceId: ws.id, name: 'Default ICP', ...icpFields });
      }

      const senderFields = {
        name: data.sender.name,
        voiceSamplesJsonb: data.sender.voiceSamples,
      };

      const [existingSender] = await db
        .select()
        .from(senders)
        .where(and(eq(senders.workspaceId, ws.id), eq(senders.email, data.sender.email)))
        .limit(1);

      if (existingSender) {
        await db.update(senders).set(senderFields).where(eq(senders.id, existingSender.id));
      } else {
        await db.insert(senders).values({
          workspaceId: ws.id,
          email: data.sender.email,
          provider: 'gmail',
          ...senderFields,
        });
      }
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  redirect('/dashboard');
}
