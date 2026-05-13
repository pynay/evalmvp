import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Service-role connection: bypasses RLS. Use ONLY in trusted server contexts
// (Inngest functions, migrations, smoke scripts). App code must check workspace_id.
let _service: ReturnType<typeof drizzle<typeof schema>> | null = null;
export function serviceDb() {
  if (_service) return _service;
  const client = postgres(process.env.DATABASE_URL_SERVICE!, { prepare: false });
  _service = drizzle(client, { schema });
  return _service;
}

// Authenticated connection: RLS fires when wrapped via `withRls`.
let _authed: ReturnType<typeof drizzle<typeof schema>> | null = null;
export function authedDb() {
  if (_authed) return _authed;
  const client = postgres(process.env.DATABASE_URL!, { prepare: false });
  _authed = drizzle(client, { schema });
  return _authed;
}
