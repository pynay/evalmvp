# EvalMVP

Eval-gated cold email generation. Spec: `docs/superpowers/specs/2026-05-12-eval-gated-email-mvp-design.md`.

## Prerequisites
- Node ≥20, pnpm ≥9
- A free Supabase project at https://supabase.com/dashboard (no Docker, no local CLI auth needed)
- `psql` available on PATH (`brew install libpq` on macOS if missing)

## First-time setup

1. **Create a Supabase dev project**: https://supabase.com/dashboard/new
   - Name it `evalmvp-dev`
   - Pick a region close to you
   - Generate and save a database password

2. **Populate `.env.local`** from the dashboard. Copy `.env.local.example` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Settings → API)
   - `SUPABASE_SERVICE_ROLE_KEY` (Settings → API; secret — never commit)
   - `DATABASE_URL` and `DATABASE_URL_SERVICE` — use the **Transaction-mode pooler** string (Connect → Connection string → Transaction). Username format is `postgres.<project-ref>`, port 6543. The direct connection on port 5432 is IPv6-only and won't work on most dev networks.
   - Generate `OAUTH_TOKEN_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

3. **Apply the migrations**:
   ```bash
   pnpm install
   pnpm db:apply          # runs every supabase/migrations/*.sql against the hosted DB
   pnpm smoke             # typecheck + build + RLS test
   ```

## Dev loop

Two terminals:
```bash
pnpm dev               # Next.js on :3000
pnpm inngest:dev       # Inngest dev server, watching /api/inngest
```

The database lives in the cloud — no local container to start. Sign in at http://localhost:3000/auth/sign-in. For magic-link delivery in dev, either:
- Use email/password auth (simplest), or
- Configure Supabase's Auth → SMTP in the dashboard with Resend's free tier, or
- Manually copy the auth code from the dashboard's Authentication → Users page

## Schema source of truth

- **DDL, RLS, triggers, extensions** live in `supabase/migrations/*.sql` (source of truth).
- **Drizzle schema** (`src/lib/db/schema.ts`) is hand-mirrored for runtime types. When you change SQL, update the Drizzle schema in the same commit.
- **Why not Drizzle Kit migrations?** It cannot express RLS policies or auth triggers cleanly. Mixing the two systems is more error-prone than maintaining the mirror.

To apply new migrations after editing SQL: `pnpm db:apply` (idempotent — uses `create … if not exists` patterns where it matters).

## RLS model

- Tenant tables (`workspaces`, `senders`, `icps`, `prospects`, `generations`, `scores`, `sends`) are RLS-locked to `workspace_id ∈ auth_workspace_ids()` for `select/insert/update/delete`.
- `email_corpus` is global, readable by any authenticated user, no writes from authenticated.
- **App code path:** server actions / RSC use the Supabase server client (RLS fires automatically via JWT cookie). Background jobs use the service-role Drizzle client (`serviceDb()`) and MUST verify `workspace_id` manually.
- **Authed Drizzle queries:** wrap with `withRls(userId, fn)` which sets `request.jwt.claims` (JSON blob — the format Supabase's `auth.uid()` reads) and switches to the `authenticated` role inside a transaction.
- **RLS verification:** `pnpm rls:test` creates two synthetic users and asserts cross-workspace reads/writes are blocked. CI must run this.

## Project structure

```
src/app/                     Next.js routes
src/lib/supabase/            Supabase clients (server, browser, middleware)
src/lib/db/                  Drizzle schema + clients + RLS wrapper
src/lib/inngest/             Inngest client + functions
supabase/migrations/         SQL migrations (source of truth)
supabase/config.toml         Supabase CLI config (for `db:apply` and future CLI use)
scripts/security/rls-test.ts RLS proof
scripts/smoke.ts             Pre-deploy smoke
tests/integration/           Vitest integration tests
docs/superpowers/specs/      Design docs
docs/superpowers/plans/      Implementation plans (one per build step)
```

## Build sequence

1. ✅ Scaffolding + RLS
2. Corpus generator + embedder
3. AI-Detection judge + calibration
4. Genericness judge (with positive direction via human corpus — see spec §8.2)
5. Personalization Depth judge
6. Generation prompt + regen loop
7. Setup page (stripped — single form, no OAuth)
8. Prospect input (textarea paste) + Apify enrichment
9. Approval list UI (stripped — copy-to-clipboard, no send automation)

**Cut from bare MVP** (see spec §14, §13): Stripe billing + Gmail/Outlook send automation. Re-added when eval quality is validated and there's reason.
