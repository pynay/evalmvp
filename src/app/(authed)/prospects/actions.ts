'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { eq, and, inArray } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import { withRls } from '@/lib/db/with-rls';
import { workspaces, prospects } from '@/lib/db/schema';
import { scrapeLinkedinProfile } from '@/lib/apify';

const MAX_PROSPECTS_PER_SUBMISSION = 10;

const prospectRowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  company: z.string().min(1),
  linkedinUrl: z.string().url().optional(),
});

type ProspectRow = z.infer<typeof prospectRowSchema>;

interface ParseResult {
  parsed: ProspectRow[];
  errors: Array<{ line: number; raw: string; message: string }>;
}

/**
 * Parse the textarea contents into prospect rows.
 * Format per line: `email, first_name, company[, linkedin_url]`
 * Blank lines and lines starting with # are skipped.
 */
function parseProspectsText(text: string): ParseResult {
  const lines = text.split('\n');
  const parsed: ProspectRow[] = [];
  const errors: ParseResult['errors'] = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const parts = trimmed.split(',').map((p) => p.trim());
    if (parts.length < 3 || parts.length > 4) {
      errors.push({
        line: idx + 1,
        raw: trimmed,
        message: `Expected "email, first_name, company[, linkedin_url]" — got ${parts.length} fields`,
      });
      return;
    }

    const [email, firstName, company, linkedinUrl] = parts;
    const candidate = {
      email,
      firstName,
      company,
      linkedinUrl: linkedinUrl || undefined,
    };
    const result = prospectRowSchema.safeParse(candidate);
    if (!result.success) {
      errors.push({
        line: idx + 1,
        raw: trimmed,
        message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return;
    }
    parsed.push(result.data);
  });

  return { parsed, errors };
}

export interface UploadResult {
  ok: boolean;
  inserted: number;
  duplicates: number;
  enriched: number;
  enrichmentFailures: number;
  parseErrors: ParseResult['errors'];
  fatal?: string;
}

export async function uploadProspects(rawText: string): Promise<UploadResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return emptyResult({ fatal: 'Not authenticated' });

  const { parsed, errors } = parseProspectsText(rawText);

  if (parsed.length === 0) {
    return emptyResult({ parseErrors: errors, fatal: errors.length ? undefined : 'No prospects to upload' });
  }

  if (parsed.length > MAX_PROSPECTS_PER_SUBMISSION) {
    return emptyResult({
      parseErrors: errors,
      fatal: `Max ${MAX_PROSPECTS_PER_SUBMISSION} prospects per submission. Got ${parsed.length}. Split into smaller batches.`,
    });
  }

  // Dedup within submission (last write wins)
  const dedup = new Map<string, ProspectRow>();
  for (const p of parsed) dedup.set(p.email.toLowerCase(), p);
  const unique = [...dedup.values()];

  // Find workspace + filter against existing prospects
  const workspaceId = await withRls(user.id, async (db) => {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
    if (!ws) throw new Error('No workspace');
    return ws.id;
  });

  const existingEmails = await withRls(user.id, async (db) => {
    const rows = await db
      .select({ email: prospects.email })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.email, unique.map((p) => p.email))));
    return new Set(rows.map((r) => r.email.toLowerCase()));
  });

  const fresh = unique.filter((p) => !existingEmails.has(p.email.toLowerCase()));
  const duplicates = unique.length - fresh.length;

  if (fresh.length === 0) {
    return {
      ok: true,
      inserted: 0,
      duplicates,
      enriched: 0,
      enrichmentFailures: 0,
      parseErrors: errors,
    };
  }

  // Insert with enrichment_status = 'pending'
  const inserted = await withRls(user.id, async (db) => {
    const out = await db
      .insert(prospects)
      .values(
        fresh.map((p) => ({
          workspaceId,
          email: p.email,
          firstName: p.firstName,
          company: p.company,
          linkedinUrl: p.linkedinUrl,
          enrichmentStatus: 'pending' as const,
        })),
      )
      .returning({ id: prospects.id, email: prospects.email, linkedinUrl: prospects.linkedinUrl });
    return out;
  });

  // Enrich in parallel via Apify (capped — caller limited submission to 10)
  const apifyAvailable = !!process.env.APIFY_API_KEY;
  let enriched = 0;
  let enrichmentFailures = 0;

  const enrichmentResults = await Promise.all(
    inserted.map(async (row) => {
      if (!row.linkedinUrl || !apifyAvailable) {
        return { id: row.id, status: 'fallback_csv_only' as const, data: null as unknown };
      }
      try {
        const profile = await scrapeLinkedinProfile(row.linkedinUrl);
        if (!profile) {
          return { id: row.id, status: 'fallback_csv_only' as const, data: null };
        }
        return { id: row.id, status: 'ok' as const, data: profile };
      } catch {
        return { id: row.id, status: 'failed' as const, data: null };
      }
    }),
  );

  // Update rows with enrichment results
  await withRls(user.id, async (db) => {
    for (const r of enrichmentResults) {
      await db
        .update(prospects)
        .set({
          enrichmentStatus: r.status,
          enrichmentJsonb: r.data ?? null,
          enrichmentFetchedAt: new Date(),
        })
        .where(eq(prospects.id, r.id));
      if (r.status === 'ok') enriched++;
      else if (r.status === 'failed') enrichmentFailures++;
    }
  });

  revalidatePath('/prospects');
  revalidatePath('/dashboard');

  return {
    ok: true,
    inserted: fresh.length,
    duplicates,
    enriched,
    enrichmentFailures,
    parseErrors: errors,
  };
}

function emptyResult(partial: Partial<UploadResult> = {}): UploadResult {
  return {
    ok: !partial.fatal,
    inserted: 0,
    duplicates: 0,
    enriched: 0,
    enrichmentFailures: 0,
    parseErrors: partial.parseErrors ?? [],
    fatal: partial.fatal,
  };
}
