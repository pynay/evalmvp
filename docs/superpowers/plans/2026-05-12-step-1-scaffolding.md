# Step 1 — Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Next.js 15 app on Supabase with Drizzle, Inngest wired in, all 8 tables migrated, RLS policies enforced and provably correct via a passing cross-workspace-read test.

**Architecture:** Supabase SQL migrations own DDL/RLS/triggers (source of truth). Drizzle schema is hand-mirrored for runtime types. Supabase Auth (Google OAuth) provides JWTs; server actions wrap Drizzle queries in transactions that `SET LOCAL request.jwt.claims` so RLS fires automatically. A separate service-role Drizzle client is used in Inngest contexts, where app code checks `workspace_id` explicitly.

**Tech Stack:** Next.js 15 (App Router) · TypeScript 5 strict · Supabase (Postgres 15 + pgvector + Auth) · Drizzle ORM + `postgres` driver · Inngest · Vitest · pnpm · Vercel target.

---

## File map

**Create:**
```
package.json
tsconfig.json
next.config.ts
postcss.config.mjs
tailwind.config.ts
.eslintrc.json
.prettierrc
.gitignore
.env.local.example
README.md
drizzle.config.ts
vitest.config.ts

src/app/globals.css
src/app/layout.tsx
src/app/page.tsx
src/app/auth/sign-in/page.tsx
src/app/auth/callback/route.ts
src/app/(authed)/layout.tsx
src/app/(authed)/dashboard/page.tsx
src/app/api/inngest/route.ts

src/middleware.ts
src/lib/supabase/server.ts
src/lib/supabase/client.ts
src/lib/supabase/middleware.ts

src/lib/db/schema.ts
src/lib/db/client.ts
src/lib/db/with-rls.ts

src/lib/inngest/client.ts
src/lib/inngest/functions/hello.ts

supabase/config.toml
supabase/migrations/0001_init.sql
supabase/migrations/0002_workspace_autocreate.sql
supabase/seed.sql

scripts/security/rls-test.ts
scripts/smoke.ts

tests/integration/rls.test.ts
tests/unit/.gitkeep
```

---

## Task 1 — Repo & toolchain bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc`, `.gitignore`, `.env.local.example`

- [ ] **Step 1: Verify pnpm and Node ≥20**

Run: `node --version && pnpm --version`
Expected: `v20.x.x` (or higher) and pnpm `9.x` (or higher). If pnpm missing: `npm i -g pnpm`.

- [ ] **Step 2: Initialize `package.json`**

Create `package.json`:

```json
{
  "name": "evalmvp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:push": "supabase db push",
    "db:reset": "supabase db reset",
    "db:start": "supabase start",
    "db:stop": "supabase stop",
    "rls:test": "tsx scripts/security/rls-test.ts",
    "smoke": "tsx scripts/smoke.ts",
    "inngest:dev": "npx inngest-cli@latest dev -u http://localhost:3000/api/inngest"
  },
  "dependencies": {
    "@supabase/ssr": "^0.5.2",
    "@supabase/supabase-js": "^2.45.4",
    "drizzle-orm": "^0.36.4",
    "inngest": "^3.27.5",
    "next": "15.0.3",
    "postgres": "^3.4.5",
    "react": "19.0.0-rc-66855b96-20241106",
    "react-dom": "19.0.0-rc-66855b96-20241106",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "drizzle-kit": "^0.28.1",
    "eslint": "^9.14.0",
    "eslint-config-next": "15.0.3",
    "postcss": "^8.4.49",
    "prettier": "^3.3.3",
    "prettier-plugin-tailwindcss": "^0.6.8",
    "supabase": "^1.219.2",
    "tailwindcss": "^3.4.14",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json` with strict mode**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `.eslintrc.json`, `.prettierrc`, `.gitignore`, `.env.local.example`**

`.eslintrc.json`:
```json
{ "extends": "next/core-web-vitals" }
```

`.prettierrc`:
```json
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100, "plugins": ["prettier-plugin-tailwindcss"] }
```

`.gitignore`:
```
node_modules/
.next/
.env.local
.env*.local
.vercel
*.log
.DS_Store
supabase/.branches
supabase/.temp
.idea
.vscode
coverage/
```

`.env.local.example`:
```
# Supabase (local dev defaults from `supabase start`)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Postgres direct connections (printed by `supabase start`)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_URL_SERVICE=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# OAuth token encryption (any 32+ char random string; rotate quarterly)
OAUTH_TOKEN_KEY=

# Inngest (local dev)
INNGEST_EVENT_KEY=local
INNGEST_SIGNING_KEY=local
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, no errors. `node_modules/` exists.

- [ ] **Step 6: Verify typecheck baseline (will fail until Task 2 adds files)**

Run: `pnpm typecheck`
Expected: error about no input files. This is OK — proceed.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json .eslintrc.json .prettierrc .gitignore .env.local.example
git commit -m "chore: bootstrap toolchain (next, ts, drizzle, supabase, inngest, vitest)"
```

---

## Task 2 — Next.js skeleton + Tailwind

**Files:**
- Create: `next.config.ts`, `postcss.config.mjs`, `tailwind.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`

- [ ] **Step 1: Create Next.js config**

`next.config.ts`:
```ts
import type { NextConfig } from 'next';
const config: NextConfig = { reactStrictMode: true, experimental: { typedRoutes: true } };
export default config;
```

`postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

- [ ] **Step 2: Create root layout, landing page, global styles**

`src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`src/app/layout.tsx`:
```tsx
import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'EvalMVP', description: 'Eval-gated email generation' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:
```tsx
import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold">EvalMVP</h1>
      <p className="mt-4 text-neutral-600">Eval-gated cold email generation.</p>
      <Link href="/auth/sign-in" className="mt-8 inline-block rounded bg-black px-4 py-2 text-white">
        Sign in
      </Link>
    </main>
  );
}
```

- [ ] **Step 3: Verify build passes**

Run: `pnpm build`
Expected: build completes; output shows `/` route compiled. No type errors.

- [ ] **Step 4: Commit**

```bash
git add next.config.ts postcss.config.mjs tailwind.config.ts src/app/
git commit -m "feat: next.js skeleton + tailwind + landing page"
```

---

## Task 3 — Supabase local + project config

**Files:**
- Create: `supabase/config.toml`, `supabase/seed.sql`

- [ ] **Step 1: Initialize Supabase locally**

Run: `pnpm supabase init`
Expected: creates `supabase/config.toml` and `supabase/seed.sql`. If `supabase/` already exists, skip.

- [ ] **Step 2: Edit `supabase/config.toml` to enable Google OAuth provider**

Find the `[auth.external.google]` block (or add it) and set:

```toml
[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_GOOGLE_SECRET)"
redirect_uri = ""
url = ""
```

For local dev, Google OAuth is optional — Supabase Studio also lets you sign in via magic link. The plan continues with magic link for tests; Google OAuth gets a real client_id when deploying to Vercel.

In `[auth]` block, ensure:
```toml
site_url = "http://localhost:3000"
additional_redirect_urls = ["http://localhost:3000/auth/callback"]
enable_signup = true
```

- [ ] **Step 3: Start Supabase locally**

Run: `pnpm db:start`
Expected: prints `API URL`, `DB URL`, `Studio URL`, `anon key`, `service_role key`. Copy these.

- [ ] **Step 4: Populate `.env.local` from output**

```bash
cp .env.local.example .env.local
# Edit .env.local: paste NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
# Generate OAUTH_TOKEN_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste output as OAUTH_TOKEN_KEY
```

- [ ] **Step 5: Verify Supabase is reachable**

Run: `curl -s http://127.0.0.1:54321/rest/v1/ -H "apikey: $(grep ANON_KEY .env.local | cut -d= -f2)" | head`
Expected: `{}` or OpenAPI JSON. Non-empty 200 response.

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml supabase/seed.sql
git commit -m "chore: supabase local config with google oauth + auth redirects"
```

---

## Task 4 — Supabase auth client + sign-in flow

**Files:**
- Create: `src/lib/supabase/server.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/middleware.ts`, `src/middleware.ts`, `src/app/auth/sign-in/page.tsx`, `src/app/auth/callback/route.ts`, `src/app/(authed)/layout.tsx`, `src/app/(authed)/dashboard/page.tsx`

- [ ] **Step 1: Create Supabase server client**

`src/lib/supabase/server.ts`:
```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a RSC; ignore — middleware handles refresh.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 2: Create Supabase browser client**

`src/lib/supabase/client.ts`:
```ts
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

- [ ] **Step 3: Create auth middleware**

`src/lib/supabase/middleware.ts`:
```ts
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  const isAuthRoute = request.nextUrl.pathname.startsWith('/auth');
  const isAuthed = request.nextUrl.pathname.startsWith('/(authed)') ||
                   request.nextUrl.pathname.startsWith('/dashboard');

  if (!user && isAuthed) {
    return NextResponse.redirect(new URL('/auth/sign-in', request.url));
  }
  if (user && isAuthRoute && request.nextUrl.pathname !== '/auth/callback') {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  return response;
}
```

`src/middleware.ts`:
```ts
import { updateSession } from '@/lib/supabase/middleware';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
```

- [ ] **Step 4: Create sign-in page (magic link for local dev)**

`src/app/auth/sign-in/page.tsx`:
```tsx
'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const supabase = createClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (!error) setSent(true);
  }

  if (sent) return <main className="p-8">Check your email for the magic link (or Inbucket at http://127.0.0.1:54324 for local dev).</main>;

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="w-full rounded bg-black px-4 py-2 text-white">
          Send magic link
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Create callback route**

`src/app/auth/callback/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(`${origin}/dashboard`);
}
```

- [ ] **Step 6: Create authed layout + dashboard**

`src/app/(authed)/layout.tsx`:
```tsx
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { ReactNode } from 'react';

export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in');
  return <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>;
}
```

`src/app/(authed)/dashboard/page.tsx`:
```tsx
import { createClient } from '@/lib/supabase/server';

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <main>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-neutral-600">Signed in as {user!.email}</p>
      <p className="mt-4 text-sm text-neutral-500">Workspace data will appear here once Task 7 lands.</p>
    </main>
  );
}
```

- [ ] **Step 7: Verify typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: no errors. `/dashboard` and `/auth/sign-in` appear in route list.

- [ ] **Step 8: Manual smoke (one-time, optional but recommended)**

Run: `pnpm dev` (in one terminal), open `http://localhost:3000`, click Sign in, enter `test@example.com`, click Send magic link. Open `http://127.0.0.1:54324` (Inbucket), click the magic link in the latest email. You land on `/dashboard` showing your email. Stop dev server.

- [ ] **Step 9: Commit**

```bash
git add src/lib/supabase src/middleware.ts src/app/auth src/app/\(authed\)
git commit -m "feat: supabase auth (magic link) + protected dashboard route"
```

---

## Task 5 — Migration: tables + extensions

**Files:**
- Create: `supabase/migrations/0001_init.sql`

- [ ] **Step 1: Create the migration file**

`supabase/migrations/0001_init.sql`:
```sql
-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists "vector";
create extension if not exists "citext";
create extension if not exists "btree_gist";

-- workspaces
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text,
  plan text not null default 'free' check (plan in ('free','solo','team')),
  monthly_send_quota int not null default 0,
  monthly_sends_used int not null default 0,
  quota_reset_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on workspaces(owner_id);

-- senders
create table senders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  email citext not null,
  provider text not null check (provider in ('gmail','outlook')),
  domain text,
  oauth_access_token_encrypted bytea,
  oauth_refresh_token_encrypted bytea,
  oauth_expires_at timestamptz,
  voice_samples_jsonb jsonb not null default '[]'::jsonb,
  voice_samples_indexed_at timestamptz,
  daily_send_cap int not null default 200,
  sends_today int not null default 0,
  sends_today_reset_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, email)
);
create index on senders(workspace_id);

-- icps
create table icps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  industry text[] not null default '{}',
  role_keywords text[] not null default '{}',
  size_range int4range,
  geo text[] not null default '{}',
  exclusions text[] not null default '{}',
  value_prop text,
  threshold_default int not null default 70 check (threshold_default between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on icps(workspace_id);

-- prospects
create table prospects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  sender_id uuid references senders(id) on delete set null,
  icp_id uuid references icps(id) on delete set null,
  email citext not null,
  first_name text,
  last_name text,
  company text,
  role text,
  linkedin_url text,
  custom_fields_jsonb jsonb not null default '{}'::jsonb,
  enrichment_jsonb jsonb,
  enrichment_fetched_at timestamptz,
  enrichment_status text check (enrichment_status in ('pending','ok','failed','fallback_csv_only')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, email)
);
create index on prospects(workspace_id);

-- generations
create table generations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  prospect_id uuid not null references prospects(id) on delete cascade,
  sender_id uuid not null references senders(id) on delete cascade,
  icp_id uuid references icps(id) on delete set null,
  parent_generation_id uuid references generations(id) on delete set null,
  subject text,
  body text,
  model text,
  prompt_version text,
  retry_count int not null default 0,
  status text not null default 'pending' check (status in (
    'pending','enriching','generating','scoring','needs_review',
    'approved','rejected','flagged','sending','sent','failed'
  )),
  overall_score numeric(5,2),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on generations(workspace_id);
create index on generations(prospect_id);
create index on generations(status);

-- scores
create table scores (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  generation_id uuid not null references generations(id) on delete cascade,
  judge_name text not null check (judge_name in ('ai_detection','genericness','personalization')),
  score numeric(5,2) not null,
  sub_scores_jsonb jsonb not null default '{}'::jsonb,
  evidence_jsonb jsonb not null default '{}'::jsonb,
  judge_version text not null,
  scored_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index on scores(workspace_id);
create index on scores(generation_id);
create unique index on scores(generation_id, judge_name);

-- sends
create table sends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  generation_id uuid not null references generations(id) on delete cascade,
  sender_id uuid not null references senders(id) on delete cascade,
  sent_at timestamptz,
  send_method text check (send_method in ('gmail','outlook')),
  external_message_id text,
  error text,
  status text not null default 'queued' check (status in ('queued','sent','failed','bounced')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on sends(workspace_id);

-- email_corpus (global, no workspace_id)
create table email_corpus (
  id uuid primary key default gen_random_uuid(),
  source text,
  origin text not null check (origin in ('ai','human','template')),
  model text,
  vendor text,
  subject text,
  body text not null,
  embedding_opener vector(1536),
  embedding_body vector(1536),
  embedding_cta vector(1536),
  metadata_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index email_corpus_body_hnsw on email_corpus using hnsw (embedding_body vector_cosine_ops);
create index email_corpus_opener_hnsw on email_corpus using hnsw (embedding_opener vector_cosine_ops);
create index email_corpus_cta_hnsw on email_corpus using hnsw (embedding_cta vector_cosine_ops);

-- updated_at trigger helper
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$ declare t text;
begin
  for t in select unnest(array['workspaces','senders','icps','prospects','generations','sends'])
  loop
    execute format('create trigger trg_%I_updated_at before update on %I
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
```

- [ ] **Step 2: Apply migrations**

Run: `pnpm db:reset`
Expected: prints `Resetting local database…` then `Finished supabase db reset`. No errors. (`db:reset` re-applies all migrations.)

- [ ] **Step 3: Verify tables exist**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "\dt public.*"
```
Expected: 8 tables listed (`workspaces`, `senders`, `icps`, `prospects`, `generations`, `scores`, `sends`, `email_corpus`).

- [ ] **Step 4: Verify pgvector works**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select '[1,2,3]'::vector;"
```
Expected: returns `[1,2,3]`. No error.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "feat(db): initial schema — 8 tables, pgvector, pgcrypto, citext"
```

---

## Task 6 — Migration: RLS policies

**Files:**
- Modify: `supabase/migrations/0001_init.sql` (append RLS block)

- [ ] **Step 1: Append RLS policies to migration**

Append to `supabase/migrations/0001_init.sql`:

```sql
-- ============================================================
-- Row-Level Security
-- ============================================================

alter table workspaces  enable row level security;
alter table senders     enable row level security;
alter table icps        enable row level security;
alter table prospects   enable row level security;
alter table generations enable row level security;
alter table scores      enable row level security;
alter table sends       enable row level security;
alter table email_corpus enable row level security;

-- Helper: returns workspace_ids the current auth.uid() owns
create or replace function auth_workspace_ids() returns setof uuid language sql stable as $$
  select id from workspaces where owner_id = auth.uid()
$$;

-- workspaces: owners can CRUD their own
create policy ws_select on workspaces for select using (owner_id = auth.uid());
create policy ws_insert on workspaces for insert with check (owner_id = auth.uid());
create policy ws_update on workspaces for update using (owner_id = auth.uid());
create policy ws_delete on workspaces for delete using (owner_id = auth.uid());

-- Tenant tables: workspace_id must be in auth_workspace_ids()
do $$ declare t text;
begin
  for t in select unnest(array['senders','icps','prospects','generations','scores','sends'])
  loop
    execute format($f$
      create policy %I_select on %I for select
        using (workspace_id in (select auth_workspace_ids()));
      create policy %I_insert on %I for insert
        with check (workspace_id in (select auth_workspace_ids()));
      create policy %I_update on %I for update
        using (workspace_id in (select auth_workspace_ids()));
      create policy %I_delete on %I for delete
        using (workspace_id in (select auth_workspace_ids()));
    $f$, t||'_sel', t, t||'_ins', t, t||'_upd', t, t||'_del', t);
  end loop;
end $$;

-- email_corpus: authenticated read-only, no anon, no writes from authenticated
create policy corpus_read on email_corpus for select to authenticated using (true);
```

- [ ] **Step 2: Re-apply migration**

Run: `pnpm db:reset`
Expected: completes without error.

- [ ] **Step 3: Verify RLS is enabled on every tenant table**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select tablename, rowsecurity from pg_tables
where schemaname='public' and tablename in
  ('workspaces','senders','icps','prospects','generations','scores','sends','email_corpus')
order by tablename;"
```
Expected: every row shows `rowsecurity = t`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "feat(db): RLS policies — workspace-scoped on tenant tables, corpus read-only"
```

---

## Task 7 — Migration: workspace auto-create trigger

**Files:**
- Create: `supabase/migrations/0002_workspace_autocreate.sql`

- [ ] **Step 1: Create the trigger migration**

`supabase/migrations/0002_workspace_autocreate.sql`:
```sql
-- Auto-create a workspace for every new auth.users row.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspaces (name, owner_id)
  values (coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)) || ' workspace',
          new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

- [ ] **Step 2: Re-apply migration**

Run: `pnpm db:reset`
Expected: completes without error.

- [ ] **Step 3: Verify trigger fires**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
insert into auth.users (id, email, raw_user_meta_data)
values (gen_random_uuid(), 'trigger-test@example.com', '{\"name\":\"Trigger Test\"}')
returning id;"
```

Then:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select w.name, w.owner_id from workspaces w
join auth.users u on u.id = w.owner_id
where u.email = 'trigger-test@example.com';"
```
Expected: one row, name = `Trigger Test workspace`.

Cleanup:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "delete from auth.users where email = 'trigger-test@example.com';"
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_workspace_autocreate.sql
git commit -m "feat(db): auto-create workspace on new auth.users insert"
```

---

## Task 8 — Drizzle schema + clients

**Files:**
- Create: `drizzle.config.ts`, `src/lib/db/schema.ts`, `src/lib/db/client.ts`, `src/lib/db/with-rls.ts`

- [ ] **Step 1: Create Drizzle config**

`drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL_SERVICE! },
  verbose: true,
  strict: true,
});
```

- [ ] **Step 2: Create Drizzle schema mirroring SQL**

`src/lib/db/schema.ts`:
```ts
import {
  pgTable, uuid, text, timestamp, integer, jsonb, boolean, numeric, customType,
  index, uniqueIndex, check, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Custom types Drizzle doesn't ship natively
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dim})`,
    toDriver: (v) => `[${v.join(',')}]`,
    fromDriver: (v) => JSON.parse(v),
  })('embedding');

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  plan: text('plan').notNull().default('free'),
  monthlySendQuota: integer('monthly_send_quota').notNull().default(0),
  monthlySendsUsed: integer('monthly_sends_used').notNull().default(0),
  quotaResetAt: timestamp('quota_reset_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const senders = pgTable('senders', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: citext('email').notNull(),
  provider: text('provider').notNull(),
  domain: text('domain'),
  oauthAccessTokenEncrypted: bytea('oauth_access_token_encrypted'),
  oauthRefreshTokenEncrypted: bytea('oauth_refresh_token_encrypted'),
  oauthExpiresAt: timestamp('oauth_expires_at', { withTimezone: true }),
  voiceSamplesJsonb: jsonb('voice_samples_jsonb').notNull().default(sql`'[]'::jsonb`),
  voiceSamplesIndexedAt: timestamp('voice_samples_indexed_at', { withTimezone: true }),
  dailySendCap: integer('daily_send_cap').notNull().default(200),
  sendsToday: integer('sends_today').notNull().default(0),
  sendsTodayResetAt: timestamp('sends_today_reset_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqWsEmail: uniqueIndex('senders_ws_email').on(t.workspaceId, t.email),
}));

export const icps = pgTable('icps', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  industry: text('industry').array().notNull().default(sql`'{}'`),
  roleKeywords: text('role_keywords').array().notNull().default(sql`'{}'`),
  geo: text('geo').array().notNull().default(sql`'{}'`),
  exclusions: text('exclusions').array().notNull().default(sql`'{}'`),
  valueProp: text('value_prop'),
  thresholdDefault: integer('threshold_default').notNull().default(70),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const prospects = pgTable('prospects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').references(() => senders.id, { onDelete: 'set null' }),
  icpId: uuid('icp_id').references(() => icps.id, { onDelete: 'set null' }),
  email: citext('email').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  company: text('company'),
  role: text('role'),
  linkedinUrl: text('linkedin_url'),
  customFieldsJsonb: jsonb('custom_fields_jsonb').notNull().default(sql`'{}'::jsonb`),
  enrichmentJsonb: jsonb('enrichment_jsonb'),
  enrichmentFetchedAt: timestamp('enrichment_fetched_at', { withTimezone: true }),
  enrichmentStatus: text('enrichment_status'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqWsEmail: uniqueIndex('prospects_ws_email').on(t.workspaceId, t.email),
}));

export const generations = pgTable('generations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').notNull().references(() => prospects.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => senders.id, { onDelete: 'cascade' }),
  icpId: uuid('icp_id').references(() => icps.id, { onDelete: 'set null' }),
  parentGenerationId: uuid('parent_generation_id'),
  subject: text('subject'),
  body: text('body'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  retryCount: integer('retry_count').notNull().default(0),
  status: text('status').notNull().default('pending'),
  overallScore: numeric('overall_score', { precision: 5, scale: 2 }),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scores = pgTable('scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  generationId: uuid('generation_id').notNull().references(() => generations.id, { onDelete: 'cascade' }),
  judgeName: text('judge_name').notNull(),
  score: numeric('score', { precision: 5, scale: 2 }).notNull(),
  subScoresJsonb: jsonb('sub_scores_jsonb').notNull().default(sql`'{}'::jsonb`),
  evidenceJsonb: jsonb('evidence_jsonb').notNull().default(sql`'{}'::jsonb`),
  judgeVersion: text('judge_version').notNull(),
  scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqGenJudge: uniqueIndex('scores_gen_judge').on(t.generationId, t.judgeName),
}));

export const sends = pgTable('sends', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  generationId: uuid('generation_id').notNull().references(() => generations.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => senders.id, { onDelete: 'cascade' }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  sendMethod: text('send_method'),
  externalMessageId: text('external_message_id'),
  error: text('error'),
  status: text('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailCorpus = pgTable('email_corpus', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source'),
  origin: text('origin').notNull(),
  model: text('model'),
  vendor: text('vendor'),
  subject: text('subject'),
  body: text('body').notNull(),
  // vector columns are managed via raw SQL; Drizzle types them as unknown
  metadataJsonb: jsonb('metadata_jsonb').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Create Drizzle client factories**

`src/lib/db/client.ts`:
```ts
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
```

- [ ] **Step 4: Create the RLS-wrapping helper**

`src/lib/db/with-rls.ts`:
```ts
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
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add drizzle.config.ts src/lib/db
git commit -m "feat(db): drizzle schema mirror + authed/service clients + RLS wrapper"
```

---

## Task 9 — Inngest scaffolding

**Files:**
- Create: `src/lib/inngest/client.ts`, `src/lib/inngest/functions/hello.ts`, `src/app/api/inngest/route.ts`

- [ ] **Step 1: Create Inngest client**

`src/lib/inngest/client.ts`:
```ts
import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'evalmvp',
  eventKey: process.env.INNGEST_EVENT_KEY,
});
```

- [ ] **Step 2: Create hello function**

`src/lib/inngest/functions/hello.ts`:
```ts
import { inngest } from '../client';

export const hello = inngest.createFunction(
  { id: 'hello' },
  { event: 'test/hello' },
  async ({ event, step }) => {
    await step.run('greet', () => ({ greeted: event.data?.name ?? 'world' }));
    return { ok: true };
  },
);
```

- [ ] **Step 3: Create Inngest route handler**

`src/app/api/inngest/route.ts`:
```ts
import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { hello } from '@/lib/inngest/functions/hello';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [hello],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: `/api/inngest` route appears in the route list, no errors.

- [ ] **Step 5: Verify Inngest endpoint serves**

In one terminal: `pnpm dev`
In another:
```bash
curl -s http://localhost:3000/api/inngest | head -c 200
```
Expected: JSON with `framework: "nextjs"` and a `functions` list including `hello`. Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inngest src/app/api/inngest
git commit -m "feat: inngest scaffolding with hello function and /api/inngest route"
```

---

## Task 10 — RLS verification test

**Files:**
- Create: `vitest.config.ts`, `scripts/security/rls-test.ts`, `tests/integration/rls.test.ts`, `tests/unit/.gitkeep`

This task is TDD-shaped: write a test that *should* fail without RLS, then run it to verify it *passes* (because RLS is in place from Task 6).

- [ ] **Step 1: Create Vitest config**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: [],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
```

- [ ] **Step 2: Create the RLS verification script (callable from CI and tests)**

`scripts/security/rls-test.ts`:
```ts
/**
 * Creates two synthetic auth users, verifies that workspace auto-creation
 * worked, then asserts that user A cannot read user B's workspace under
 * an authed connection. Cleans up afterward.
 *
 * Run: pnpm rls:test
 * Exits 0 on success, 1 on failure (with details).
 */
import 'dotenv/config';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const SERVICE_URL = process.env.DATABASE_URL_SERVICE!;
const AUTH_URL = process.env.DATABASE_URL!;

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
      await tx`select set_config('request.jwt.claim.sub', ${aId}, true)`;
      await tx`select set_config('request.jwt.claim.role', 'authenticated', true)`;
      await tx`set local role authenticated`;
      return tx`select id from public.workspaces`;
    });

    const ids = visibleToA.map((r: any) => r.id);
    if (!ids.includes(aWs.id)) throw new Error(`A cannot read own workspace ${aWs.id}`);
    if (ids.includes(bWs.id))  throw new Error(`RLS BREACH: A can read B's workspace ${bWs.id}`);

    // Cross-workspace insert attempt should be blocked
    let insertBlocked = false;
    try {
      await authed.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${aId}, true)`;
        await tx`select set_config('request.jwt.claim.role', 'authenticated', true)`;
        await tx`set local role authenticated`;
        await tx`insert into public.senders (workspace_id, name, email, provider)
                 values (${bWs.id}, 'pwn', 'pwn@x.com', 'gmail')`;
      });
    } catch (e: any) {
      insertBlocked = /new row violates row-level security/i.test(e.message);
    }
    if (!insertBlocked) throw new Error('RLS BREACH: A inserted into B workspace');

    await authed.end();
    console.log('RLS test passed: cross-workspace reads and writes blocked, own-workspace allowed.');
  } finally {
    await svc`delete from auth.users where id in (${aId}, ${bId})`;
    await svc.end();
  }
}

main().catch((e) => {
  console.error('RLS test FAILED:', e.message);
  process.exit(1);
});
```

- [ ] **Step 3: Run the script and verify it passes**

Run: `pnpm rls:test`
Expected: prints `RLS test passed: ...`. Exits 0.

If it fails: re-run `pnpm db:reset` to ensure all migrations applied, then re-run. If still failing, check that `set local role authenticated` is being honored (Postgres ≥14 required) and that policies from Task 6 are present (`\dp public.workspaces` should show four policies).

- [ ] **Step 4: Wrap the script in a Vitest test**

`tests/integration/rls.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('RLS', () => {
  it('blocks cross-workspace reads and writes', () => {
    expect(() => execSync('pnpm rls:test', { stdio: 'pipe' })).not.toThrow();
  });
});
```

Create `tests/unit/.gitkeep` (empty).

- [ ] **Step 5: Run the test suite**

Run: `pnpm test`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts scripts/security/rls-test.ts tests/integration/rls.test.ts tests/unit/.gitkeep
git commit -m "test: RLS verification — cross-workspace reads/writes blocked"
```

---

## Task 11 — README + smoke script

**Files:**
- Create: `README.md`, `scripts/smoke.ts`

- [ ] **Step 1: Create smoke script**

`scripts/smoke.ts`:
```ts
/**
 * End-to-end smoke: typecheck, build, RLS test, Inngest endpoint reachable.
 * Assumes `pnpm db:start` is running. Used in CI and pre-deploy.
 */
import { execSync } from 'node:child_process';

const steps = [
  ['typecheck', 'pnpm typecheck'],
  ['build',     'pnpm build'],
  ['rls',       'pnpm rls:test'],
];

for (const [name, cmd] of steps) {
  process.stdout.write(`▶ ${name}… `);
  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log('ok');
  } catch (e: any) {
    console.log('FAILED');
    console.error(e.stdout?.toString() ?? '');
    console.error(e.stderr?.toString() ?? '');
    process.exit(1);
  }
}
console.log('All smoke checks passed.');
```

- [ ] **Step 2: Create README**

`README.md`:
````markdown
# EvalMVP

Eval-gated cold email generation. Spec: `docs/superpowers/specs/2026-05-12-eval-gated-email-mvp-design.md`.

## Prerequisites
- Node ≥20, pnpm ≥9
- Docker Desktop (for local Supabase)
- Supabase CLI (`brew install supabase/tap/supabase`)

## First-time setup

```bash
pnpm install
pnpm db:start                    # starts local Supabase (Postgres + Auth + Studio)
cp .env.local.example .env.local # then fill in keys printed by `db:start`
pnpm db:reset                    # applies migrations
pnpm smoke                       # typecheck + build + RLS test
```

## Dev loop

Three terminals:
```bash
pnpm db:start          # one-time per laptop session
pnpm dev               # Next.js on :3000
pnpm inngest:dev       # Inngest dev server, watching /api/inngest
```

Sign in at http://localhost:3000/auth/sign-in. Magic-link emails land in Inbucket at http://127.0.0.1:54324.

## Schema source of truth

- **DDL, RLS, triggers, extensions** live in `supabase/migrations/*.sql` (source of truth).
- **Drizzle schema** (`src/lib/db/schema.ts`) is hand-mirrored for runtime types. When you change SQL, update the Drizzle schema in the same commit.
- **Why not Drizzle Kit migrations?** It cannot express RLS policies or auth triggers cleanly. Mixing the two systems is more error-prone than maintaining the mirror.

## RLS model

- Tenant tables (`workspaces`, `senders`, `icps`, `prospects`, `generations`, `scores`, `sends`) are RLS-locked to `workspace_id ∈ auth_workspace_ids()` for `select/insert/update/delete`.
- `email_corpus` is global, readable by any authenticated user, no writes from authenticated.
- **App code path:** server actions / RSC use the Supabase server client (RLS fires automatically via JWT cookie). Background jobs use the service-role Drizzle client (`serviceDb()`) and MUST verify `workspace_id` manually.
- **Authed Drizzle queries:** wrap with `withRls(userId, fn)` which sets `request.jwt.claim.*` and switches to the `authenticated` role inside a transaction.
- **RLS verification:** `pnpm rls:test` creates two synthetic users and asserts cross-workspace reads/writes are blocked. CI must run this.

## Project structure

```
src/app/                     Next.js routes
src/lib/supabase/            Supabase clients (server, browser, middleware)
src/lib/db/                  Drizzle schema + clients + RLS wrapper
src/lib/inngest/             Inngest client + functions
supabase/migrations/         SQL migrations (source of truth)
scripts/security/rls-test.ts RLS proof
scripts/smoke.ts             Pre-deploy smoke
tests/integration/           Vitest integration tests
docs/superpowers/specs/      Design docs
docs/superpowers/plans/      Implementation plans (one per build step)
```

## Build sequence (this repo)

1. ✅ Scaffolding + RLS (this plan)
2. Corpus generator + embedder
3. AI-Detection judge + calibration
4. Genericness similarity
5. Personalization Depth judge
6. Generation prompt + regen loop
7. Onboarding wizard
8. CSV upload + Apify enrichment
9. Approval UI
10. Send flow
11. Stripe checkout + quota
````

- [ ] **Step 3: Run the smoke script end-to-end**

Run: `pnpm smoke`
Expected: prints `▶ typecheck… ok`, `▶ build… ok`, `▶ rls… ok`, then `All smoke checks passed.`

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/smoke.ts
git commit -m "docs: README with setup + RLS model + project structure; add smoke script"
```

---

## Self-review

**Spec coverage** (spec section → task):
- §4 Stack: Tasks 1, 2, 3, 4, 8, 9 cover Next.js / Supabase / Drizzle / Inngest / Tailwind
- §5.1–5.8 Data model: Tasks 5, 8 (all 8 tables in SQL + Drizzle mirror)
- §17 Security — RLS: Task 6
- §17 Security — token encryption: pgcrypto extension installed in Task 5; encryption helpers deferred to Step 7 (OAuth) since no tokens exist yet
- §17 Security — service-role isolation: Task 8 (separate `serviceDb` vs `authedDb`)
- §18 Testing — RLS test script: Task 10
- §18 Testing — smoke script: Task 11
- §15 API surface — Inngest route: Task 9; OAuth callbacks deferred (Step 7); Stripe webhook deferred (Step 11)
- Workspace auto-create (needed for any UI to show data): Task 7

**Deferred (correctly, to later plans):**
- Sentry & PostHog wiring (no events to emit yet)
- Stripe (Step 11 plan)
- Google OAuth real client_id (Step 7 plan, when senders are added)
- Anthropic/OpenAI/Apify clients (their respective build steps)
- `email_corpus` HNSW index tuning (Step 2 plan, when corpus is loaded)

**Placeholder scan:** Every code step has complete code. Every command has expected output. No TODOs / TBDs.

**Type consistency:** `workspaces.ownerId` (Drizzle) ↔ `owner_id` (SQL); `voiceSamplesJsonb` ↔ `voice_samples_jsonb`; status enum values match across SQL check constraint and Drizzle. `serviceDb()` and `authedDb()` names consistent in client.ts and used by `withRls`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-step-1-scaffolding.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
