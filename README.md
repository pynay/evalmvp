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
- **Authed Drizzle queries:** wrap with `withRls(userId, fn)` which sets `request.jwt.claims` (JSON blob — the format Supabase Postgres 15's `auth.uid()` reads) and switches to the `authenticated` role inside a transaction.
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
