/**
 * Creates two synthetic auth users via the service-role connection, then uses
 * `withRls` (the actual production RLS-wrapping helper) to verify that user A
 * cannot read or write user B's tenant data. Cleans up afterward.
 *
 * Run: pnpm rls:test
 * Exits 0 on success, 1 on failure (with details).
 *
 * The assertions go through `withRls` deliberately — if a future change quietly
 * breaks the JWT-claims format or the role switch, this test catches it.
 * Service-role setup/teardown uses raw postgres-js because we need to bypass
 * RLS to create the synthetic auth.users rows.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });  // fallback for CI environments

import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { withRls } from '../../src/lib/db/with-rls';
import { closePools } from '../../src/lib/db/client';
import { workspaces, senders } from '../../src/lib/db/schema';

const SERVICE_URL = process.env.DATABASE_URL_SERVICE!;

async function main() {
  const svc = postgres(SERVICE_URL, { prepare: false });
  const aId = randomUUID();
  const bId = randomUUID();
  const aEmail = `rls-a-${aId.slice(0, 8)}@test.local`;
  const bEmail = `rls-b-${bId.slice(0, 8)}@test.local`;

  try {
    // Service-role: create two auth users; the workspace_autocreate trigger fires.
    await svc`insert into auth.users (id, email, raw_user_meta_data, aud, role)
              values (${aId}, ${aEmail}, ${'{"name":"A"}'}::jsonb, 'authenticated', 'authenticated'),
                     (${bId}, ${bEmail}, ${'{"name":"B"}'}::jsonb, 'authenticated', 'authenticated')`;

    const [aWs] = await svc`select id from public.workspaces where owner_id = ${aId}`;
    const [bWs] = await svc`select id from public.workspaces where owner_id = ${bId}`;
    if (!aWs || !bWs) throw new Error('workspace auto-create trigger did not fire');
    const aWsId = aWs.id as string;
    const bWsId = bWs.id as string;

    // Read assertion: as A, select all workspaces — should see only A's.
    // Goes through the production withRls helper.
    const visibleToA = await withRls(aId, async (db) => {
      return db.select({ id: workspaces.id }).from(workspaces);
    });
    const ids = visibleToA.map((r) => r.id);
    if (!ids.includes(aWsId)) throw new Error(`A cannot read own workspace ${aWsId}`);
    if (ids.includes(bWsId))  throw new Error(`RLS BREACH: A can read B's workspace ${bWsId}`);

    // Write assertion: as A, try to insert a sender into B's workspace — must throw.
    let insertBlocked = false;
    try {
      await withRls(aId, async (db) => {
        await db.insert(senders).values({
          workspaceId: bWsId as never,  // Drizzle Id<"workspaces"> shape
          name: 'pwn',
          email: 'pwn@x.com',
          provider: 'gmail',
        });
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      insertBlocked = /row-level security|new row violates/i.test(msg);
      if (!insertBlocked) throw new Error(`Unexpected insert error: ${msg}`);
    }
    if (!insertBlocked) throw new Error('RLS BREACH: A inserted into B workspace');

    console.log('RLS test passed: cross-workspace reads and writes blocked, own-workspace allowed.');
  } finally {
    await svc`delete from auth.users where id in (${aId}, ${bId})`;
    await svc.end({ timeout: 5 });
    await closePools();
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('RLS test FAILED:', msg);
  if (e instanceof Error && e.stack) console.error('STACK:', e.stack);
  process.exit(1);
});
