import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

/**
 * Service-role connection. Bypasses RLS — use ONLY in trusted server contexts
 * (Inngest functions, migrations, smoke scripts) where the caller is enforcing
 * `workspace_id` checks in application code.
 *
 * Never use this in a server action or route handler that takes user input.
 */
let _serviceClient: Sql | null = null;
let _service: ReturnType<typeof drizzle<typeof schema>> | null = null;
export function serviceDb() {
  if (_service) return _service;
  _serviceClient = postgres(process.env.DATABASE_URL_SERVICE!, { prepare: false });
  _service = drizzle(_serviceClient, { schema });
  return _service;
}

/**
 * Raw pool used to back `withRls`. Do NOT call from app code — it bypasses RLS
 * by default. The `withRls(userId, fn)` wrapper in `./with-rls.ts` opens a
 * transaction that sets `request.jwt.claims` and switches to the `authenticated`
 * role so RLS policies fire. Anything outside that wrapper sees rows as the
 * postgres role.
 *
 * Named `unsafeRawAuthedPool` (instead of the old `authedDb`) so the danger is
 * visible at the call site.
 */
let _authedClient: Sql | null = null;
let _authedPool: ReturnType<typeof drizzle<typeof schema>> | null = null;
export function unsafeRawAuthedPool() {
  if (_authedPool) return _authedPool;
  _authedClient = postgres(process.env.DATABASE_URL!, { prepare: false });
  _authedPool = drizzle(_authedClient, { schema });
  return _authedPool;
}

/**
 * Closes any open connection pools. Call from scripts/tests at end-of-run so
 * the Node event loop drains and the process exits. App code (Next.js / Inngest
 * handlers) does NOT need this — those processes are long-lived.
 */
export async function closePools(): Promise<void> {
  await Promise.all([
    _serviceClient ? _serviceClient.end({ timeout: 5 }) : Promise.resolve(),
    _authedClient ? _authedClient.end({ timeout: 5 }) : Promise.resolve(),
  ]);
  _service = null;
  _serviceClient = null;
  _authedPool = null;
  _authedClient = null;
}
