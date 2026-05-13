import { sql } from 'drizzle-orm';
import { unsafeRawAuthedPool } from './client';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from './schema';

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Runs the callback inside a transaction with auth.uid() set so RLS policies fire.
 * Pass the user's id from `supabase.auth.getUser()`.
 *
 * Sets `request.jwt.claims` to a JSON blob — this is the format PostgREST 12+ /
 * Supabase Postgres 15+'s `auth.uid()` reads. The legacy `request.jwt.claim.<key>`
 * (singular, dotted) keys are NOT read by Supabase's auth helpers.
 */
export async function withRls<T>(
  userId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  const db = unsafeRawAuthedPool();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx as unknown as Db);
  });
}
