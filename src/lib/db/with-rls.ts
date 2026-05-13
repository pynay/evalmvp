import { sql } from 'drizzle-orm';
import { authedDb } from './client';

/**
 * Runs the callback inside a transaction with auth.uid() set so RLS policies fire.
 * Pass the user's id from `supabase.auth.getUser()`.
 */
export async function withRls<T>(userId: string, fn: (tx: ReturnType<typeof authedDb>) => Promise<T>): Promise<T> {
  const db = authedDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    await tx.execute(sql`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx as unknown as ReturnType<typeof authedDb>);
  });
}
