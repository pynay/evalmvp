/**
 * Creates two synthetic auth users, verifies that workspace auto-creation
 * worked, then asserts that user A cannot read user B's workspace under
 * an authed connection. Cleans up afterward.
 *
 * Run: pnpm rls:test
 * Exits 0 on success, 1 on failure (with details).
 *
 * Note: uses `set_config('request.jwt.claims', <json>, true)` — the format
 * Supabase Postgres 15's auth.uid() reads. The legacy dotted-key format
 * (request.jwt.claim.sub) is NOT read by current Supabase auth helpers.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });  // fallback for CI environments
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const SERVICE_URL = process.env.DATABASE_URL_SERVICE!;
const AUTH_URL = process.env.DATABASE_URL!;

function claims(userId: string) {
  return JSON.stringify({ sub: userId, role: 'authenticated' });
}

async function main() {
  const svc = postgres(SERVICE_URL, { prepare: false });
  const aId = randomUUID();
  const bId = randomUUID();
  const aEmail = `rls-a-${aId.slice(0,8)}@test.local`;
  const bEmail = `rls-b-${bId.slice(0,8)}@test.local`;

  try {
    // Service role creates two auth users; trigger creates their workspaces.
    await svc`insert into auth.users (id, email, raw_user_meta_data, aud, role)
              values (${aId}, ${aEmail}, ${'{"name":"A"}'}::jsonb, 'authenticated', 'authenticated'),
                     (${bId}, ${bEmail}, ${'{"name":"B"}'}::jsonb, 'authenticated', 'authenticated')`;

    const [aWs] = await svc`select id from public.workspaces where owner_id = ${aId}`;
    const [bWs] = await svc`select id from public.workspaces where owner_id = ${bId}`;
    if (!aWs || !bWs) throw new Error('workspace auto-create trigger did not fire');

    // Authed connection acting as A
    const authed = postgres(AUTH_URL, { prepare: false });
    const visibleToA = await authed.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${claims(aId)}, true)`;
      await tx`set local role authenticated`;
      return tx`select id from public.workspaces`;
    });

    const ids = (visibleToA as unknown as { id: string }[]).map((r) => r.id);
    if (!ids.includes(aWs.id)) throw new Error(`A cannot read own workspace ${aWs.id}`);
    if (ids.includes(bWs.id))  throw new Error(`RLS BREACH: A can read B's workspace ${bWs.id}`);

    // Cross-workspace insert attempt should be blocked
    let insertBlocked = false;
    try {
      await authed.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${claims(aId)}, true)`;
        await tx`set local role authenticated`;
        await tx`insert into public.senders (workspace_id, name, email, provider)
                 values (${bWs.id}, 'pwn', 'pwn@x.com', 'gmail')`;
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      insertBlocked = /new row violates row-level security/i.test(msg);
    }
    if (!insertBlocked) throw new Error('RLS BREACH: A inserted into B workspace');

    await authed.end();
    console.log('RLS test passed: cross-workspace reads and writes blocked, own-workspace allowed.');
  } finally {
    await svc`delete from auth.users where id in (${aId}, ${bId})`;
    await svc.end();
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('RLS test FAILED:', msg);
  if (e instanceof Error && e.stack) console.error('STACK:', e.stack);
  console.error('RAW:', e);
  process.exit(1);
});
