# Step 1 — Convex Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Next.js 15 app on Convex (cloud-hosted) with Convex Auth (Google OAuth + magic link), all 8 collections + 1 lock table declared in schema with indexes and vector indexes, the `withWorkspace` tenant-isolation helper, a lint rule forbidding raw `ctx.db` calls, a workspace auto-create hook, and a passing cross-tenant integration test that proves `prospects.list` returns empty rows when called as a different user.

**Architecture:** Convex is the single backend (database + auth + workflow). Next.js client calls Convex functions via the typed SDK. Tenant isolation is app-level via `withWorkspace`; the lint rule + cross-tenant test enforce it. No Docker, no SQL migrations, no Drizzle, no Inngest.

**Tech Stack:** Next.js 15 (App Router) · TypeScript 5 strict · Convex (cloud dev) · Convex Auth · Vitest + `convex-test` · pnpm · Vercel target.

---

## File map

**Create:**
```
package.json
tsconfig.json
next.config.ts
postcss.config.mjs
tailwind.config.ts
.eslintrc.cjs                     (cjs, not json, so we can use require for the no-restricted-syntax config)
.prettierrc
.gitignore
.env.local.example
README.md
vitest.config.ts

src/app/globals.css
src/app/layout.tsx
src/app/page.tsx
src/app/auth/sign-in/page.tsx
src/app/(authed)/layout.tsx
src/app/(authed)/dashboard/page.tsx

src/components/ConvexClientProvider.tsx

convex/schema.ts
convex/auth.ts
convex/auth.config.ts
convex/http.ts
convex/lib/auth.ts                (withWorkspace helper)
convex/workspaces.ts              (auto-create on first sign-in)
convex/prospects.ts               (one demo query exercising withWorkspace)

scripts/smoke.ts

tests/integration/tenant-isolation.test.ts
tests/unit/.gitkeep
```

---

## Task 1 — Repo & toolchain bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc`, `.gitignore`, `.env.local.example`

- [ ] **Step 1: Verify pnpm and Node ≥20**

Run: `node --version && pnpm --version`
Expected: `v20.x.x` or higher, pnpm `9.x` or higher. If pnpm missing: `npm i -g pnpm`.

- [ ] **Step 2: Initialize `package.json`**

```json
{
  "name": "evalmvp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "dev:convex": "convex dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "smoke": "tsx scripts/smoke.ts"
  },
  "dependencies": {
    "@auth/core": "^0.37.2",
    "@convex-dev/auth": "^0.0.79",
    "convex": "^1.17.4",
    "next": "15.5.18",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@edge-runtime/vm": "^4.0.4",
    "autoprefixer": "^10.4.20",
    "convex-test": "^0.0.34",
    "eslint": "^9.14.0",
    "eslint-config-next": "15.5.18",
    "postcss": "^8.4.49",
    "prettier": "^3.3.3",
    "prettier-plugin-tailwindcss": "^0.6.8",
    "tailwindcss": "^3.4.14",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

If `@convex-dev/auth` or `convex-test` versions resolve newer/older during install, use whatever pnpm resolves and note it in the report.

- [ ] **Step 3: Create `tsconfig.json`**

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
    "paths": { "@/*": ["./src/*"], "@convex/*": ["./convex/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "convex/**/*.ts"],
  "exclude": ["node_modules", "convex/_generated"]
}
```

Note: `convex/_generated` is excluded from strict typecheck because Convex generates files that pass their own checks but may emit warnings we don't want failing our build. We still typecheck the rest.

- [ ] **Step 4: Create the rest of the config files**

`.eslintrc.cjs` — the lint rule that forbids raw `ctx.db` outside `convex/lib/`:
```js
module.exports = {
  extends: ['next/core-web-vitals'],
  overrides: [
    {
      files: ['convex/**/*.ts'],
      excludedFiles: ['convex/lib/**', 'convex/_generated/**', 'convex/schema.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "MemberExpression[object.object.name='ctx'][object.property.name='db']",
            message: "Use the withWorkspace helper from convex/lib/auth.ts; raw ctx.db calls outside convex/lib/ are forbidden to prevent cross-tenant data leaks.",
          },
        ],
      },
    },
  ],
};
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
.idea
.vscode
coverage/
convex/_generated/
```

`.env.local.example`:
```
# Convex (filled in by `npx convex dev` on first run)
NEXT_PUBLIC_CONVEX_URL=
CONVEX_DEPLOYMENT=

# Convex Auth (filled in by setup; SITE_URL must match your dev/prod origin)
SITE_URL=http://localhost:3000
JWT_PRIVATE_KEY=
JWKS=

# Google OAuth (optional for local dev; required for production)
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# Resend (for magic-link email delivery; optional in dev — see README for local fallback)
AUTH_RESEND_KEY=

# Token encryption (AES-256-GCM key, 64 hex chars)
OAUTH_TOKEN_KEY=
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, no unresolvable peer-dep errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json .eslintrc.cjs .prettierrc .gitignore .env.local.example
git commit -m "chore: bootstrap toolchain (next, convex, convex-auth, vitest, lint guardrail)"
```

---

## Task 2 — Next.js skeleton + Tailwind

**Files:**
- Create: `next.config.ts`, `postcss.config.mjs`, `tailwind.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`

- [ ] **Step 1: Configs**

`next.config.ts`:
```ts
import type { NextConfig } from 'next';
const config: NextConfig = { reactStrictMode: true, typedRoutes: true };
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

- [ ] **Step 2: Root layout + landing**

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
import { ConvexClientProvider } from '@/components/ConvexClientProvider';

export const metadata = { title: 'EvalMVP', description: 'Eval-gated email generation' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900 antialiased">
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
```

(`ConvexClientProvider` is created in Task 4; for now this import will fail typecheck. That's OK — fix it when Task 4 lands. If you want a clean intermediate build, comment out the import + wrapper and uncomment in Task 4.)

`src/app/page.tsx`:
```tsx
import Link from 'next/link';
import type { Route } from 'next';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold">EvalMVP</h1>
      <p className="mt-4 text-neutral-600">Eval-gated cold email generation.</p>
      <Link href={'/auth/sign-in' as Route} className="mt-8 inline-block rounded bg-black px-4 py-2 text-white">
        Sign in
      </Link>
    </main>
  );
}
```

- [ ] **Step 3: Skip the `ConvexClientProvider` import for now**

To keep `pnpm build` passing during Task 2 alone, comment out the provider import + JSX in `layout.tsx`. Task 4 will uncomment them when the component exists.

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: builds clean, route `/` listed.

- [ ] **Step 5: Commit**

```bash
git add next.config.ts postcss.config.mjs tailwind.config.ts src/app/
git commit -m "feat: next.js skeleton + tailwind + landing page"
```

---

## Task 3 — Convex init + schema

**Files:**
- Create: `convex/schema.ts`. Convex generates `convex/_generated/*` on first `convex dev`.

- [ ] **Step 1: Initialize Convex**

Run: `npx convex dev` (do NOT use `pnpm convex dev` — Convex's CLI is npm-published and pnpm scripts are wrapped). On first run it will:
1. Open a browser to sign you into Convex Cloud
2. Prompt to create a new project (call it `evalmvp`)
3. Generate `.env.local` with `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL`
4. Create `convex/_generated/` directory
5. Stay running and watch `convex/` for changes

Leave it running in this terminal. Open a new terminal for subsequent commands.

If `convex dev` errors because you have no Convex account, sign up at convex.dev (free tier is plenty for dev).

- [ ] **Step 2: Create `convex/schema.ts` with all 9 tables**

```ts
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { authTables } from '@convex-dev/auth/server';

export default defineSchema({
  ...authTables,

  workspaces: defineTable({
    name: v.string(),
    ownerId: v.id('users'),
    stripeCustomerId: v.optional(v.string()),
    plan: v.union(v.literal('free'), v.literal('solo'), v.literal('team')),
    monthlySendQuota: v.number(),
    monthlySendsUsed: v.number(),
    quotaResetAt: v.optional(v.number()),
  }).index('by_owner', ['ownerId']),

  senders: defineTable({
    workspaceId: v.id('workspaces'),
    name: v.string(),
    email: v.string(),
    provider: v.union(v.literal('gmail'), v.literal('outlook')),
    domain: v.optional(v.string()),
    oauthAccessTokenEncrypted: v.bytes(),
    oauthRefreshTokenEncrypted: v.bytes(),
    oauthExpiresAt: v.optional(v.number()),
    voiceSamples: v.array(v.object({ subject: v.string(), body: v.string() })),
    voiceSamplesIndexedAt: v.optional(v.number()),
    dailySendCap: v.number(),
    sendsToday: v.number(),
    sendsTodayResetAt: v.optional(v.number()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_email', ['workspaceId', 'email']),

  icps: defineTable({
    workspaceId: v.id('workspaces'),
    name: v.string(),
    industry: v.array(v.string()),
    roleKeywords: v.array(v.string()),
    sizeRangeMin: v.optional(v.number()),
    sizeRangeMax: v.optional(v.number()),
    geo: v.array(v.string()),
    exclusions: v.array(v.string()),
    valueProp: v.optional(v.string()),
    thresholdDefault: v.number(),
  }).index('by_workspace', ['workspaceId']),

  prospects: defineTable({
    workspaceId: v.id('workspaces'),
    senderId: v.optional(v.id('senders')),
    icpId: v.optional(v.id('icps')),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    company: v.optional(v.string()),
    role: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    customFields: v.any(),
    enrichment: v.optional(v.any()),
    enrichmentFetchedAt: v.optional(v.number()),
    enrichmentStatus: v.optional(
      v.union(
        v.literal('pending'),
        v.literal('ok'),
        v.literal('failed'),
        v.literal('fallback_csv_only'),
      ),
    ),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_email', ['workspaceId', 'email']),

  generations: defineTable({
    workspaceId: v.id('workspaces'),
    prospectId: v.id('prospects'),
    senderId: v.id('senders'),
    icpId: v.optional(v.id('icps')),
    parentGenerationId: v.optional(v.id('generations')),
    subject: v.optional(v.string()),
    body: v.optional(v.string()),
    model: v.optional(v.string()),
    promptVersion: v.optional(v.string()),
    retryCount: v.number(),
    status: v.union(
      v.literal('pending'), v.literal('enriching'), v.literal('generating'),
      v.literal('scoring'), v.literal('needs_review'), v.literal('approved'),
      v.literal('rejected'), v.literal('flagged'), v.literal('sending'),
      v.literal('sent'), v.literal('failed'),
    ),
    overallScore: v.optional(v.number()),
    approvedBy: v.optional(v.id('users')),
    approvedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_prospect', ['prospectId'])
    .index('by_workspace_status', ['workspaceId', 'status']),

  scores: defineTable({
    workspaceId: v.id('workspaces'),
    generationId: v.id('generations'),
    judgeName: v.union(
      v.literal('ai_detection'), v.literal('genericness'), v.literal('personalization'),
    ),
    score: v.number(),
    subScores: v.any(),
    evidence: v.any(),
    judgeVersion: v.string(),
    scoredAt: v.number(),
  })
    .index('by_generation', ['generationId'])
    .index('by_generation_judge', ['generationId', 'judgeName']),

  sends: defineTable({
    workspaceId: v.id('workspaces'),
    generationId: v.id('generations'),
    senderId: v.id('senders'),
    sentAt: v.optional(v.number()),
    sendMethod: v.optional(v.union(v.literal('gmail'), v.literal('outlook'))),
    externalMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
    status: v.union(
      v.literal('queued'), v.literal('sent'), v.literal('failed'), v.literal('bounced'),
    ),
  }).index('by_workspace', ['workspaceId']),

  emailCorpus: defineTable({
    source: v.optional(v.string()),
    origin: v.union(v.literal('ai'), v.literal('human'), v.literal('template')),
    model: v.optional(v.string()),
    vendor: v.optional(v.string()),
    subject: v.optional(v.string()),
    body: v.string(),
    embeddingOpener: v.array(v.float64()),
    embeddingBody: v.array(v.float64()),
    embeddingCta: v.array(v.float64()),
    metadata: v.any(),
  })
    .index('by_origin', ['origin'])
    .vectorIndex('vec_opener', { vectorField: 'embeddingOpener', dimensions: 1536, filterFields: ['origin'] })
    .vectorIndex('vec_body',   { vectorField: 'embeddingBody',   dimensions: 1536, filterFields: ['origin'] })
    .vectorIndex('vec_cta',    { vectorField: 'embeddingCta',    dimensions: 1536, filterFields: ['origin'] }),

  senderLocks: defineTable({
    senderId: v.id('senders'),
    acquiredAt: v.number(),
    expiresAt: v.number(),
  }).index('by_sender', ['senderId']),
});
```

- [ ] **Step 3: Wait for Convex to apply the schema**

The `convex dev` terminal should print "Schema validation passed" or similar within ~10 seconds of saving `schema.ts`. If it reports errors, fix them and save. Errors at this point typically mean a typo in the validator definitions.

- [ ] **Step 4: Verify schema reached the dev deployment**

Run: `npx convex run --schema` (or check the Convex dashboard at the URL printed by `convex dev`). All 9 tables (plus the auth tables) should be visible.

Alternatively, verify via the dashboard: open the URL `convex dev` printed, look at "Data" — you should see `workspaces`, `senders`, `icps`, `prospects`, `generations`, `scores`, `sends`, `emailCorpus`, `senderLocks` as empty tables.

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts .env.local
# WAIT — .env.local should be gitignored. Verify before committing.
git status   # confirm .env.local is NOT in the staged changes
git add convex/schema.ts
git commit -m "feat(convex): schema with 8 tenant collections + emailCorpus + senderLocks + vector indexes"
```

---

## Task 4 — Convex Auth + provider component

**Files:**
- Create: `convex/auth.ts`, `convex/auth.config.ts`, `convex/http.ts`, `src/components/ConvexClientProvider.tsx`

- [ ] **Step 1: Set up Convex Auth**

Run: `npx @convex-dev/auth`
This installer will:
- Add auth tables to the schema (already imported via `...authTables` in Task 3)
- Create `convex/auth.ts`, `convex/auth.config.ts`, `convex/http.ts`
- Generate JWT keys and write them to `.env.local` and the Convex dashboard env
- Configure `SITE_URL`

Follow the prompts. Choose:
- Provider: **Google** + **Resend** (magic link via Resend) — for dev, you can skip Resend by using a `LocalLog` provider that prints magic links to the `convex dev` terminal.

If the installer offers a "skip Google" / "use only magic link" path for dev, take it; we can add Google in production.

- [ ] **Step 2: Edit `convex/auth.ts` to expose the auth API**

If the installer didn't already, ensure `convex/auth.ts` looks like:
```ts
import { convexAuth } from '@convex-dev/auth/server';
import Google from '@auth/core/providers/google';
import Resend from '@auth/core/providers/resend';

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [Google, Resend],
});
```

For local dev without Resend keys, swap `Resend` for the `LocalLog` provider as documented at https://labs.convex.dev/auth. The installer's choice is preserved.

- [ ] **Step 3: Create the React provider**

`src/components/ConvexClientProvider.tsx`:
```tsx
'use client';
import { ConvexAuthNextjsProvider } from '@convex-dev/auth/nextjs';
import { ConvexReactClient } from 'convex/react';
import type { ReactNode } from 'react';

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexAuthNextjsProvider client={convex}>{children}</ConvexAuthNextjsProvider>;
}
```

- [ ] **Step 4: Uncomment the provider import in `src/app/layout.tsx`**

Restore the `import { ConvexClientProvider } from '@/components/ConvexClientProvider';` line and the `<ConvexClientProvider>` wrapper around `{children}`.

- [ ] **Step 5: Verify typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: no errors. If `@convex-dev/auth/nextjs` exports a different name in the version you installed, check the installed package's exports and adjust.

- [ ] **Step 6: Commit**

```bash
git add convex/auth.ts convex/auth.config.ts convex/http.ts src/components/ConvexClientProvider.tsx src/app/layout.tsx
git commit -m "feat(auth): convex auth with provider component wired into next.js"
```

---

## Task 5 — Sign-in page + auth callback + dashboard

**Files:**
- Create: `src/app/auth/sign-in/page.tsx`, `src/app/(authed)/layout.tsx`, `src/app/(authed)/dashboard/page.tsx`

- [ ] **Step 1: Sign-in page**

`src/app/auth/sign-in/page.tsx`:
```tsx
'use client';
import { useAuthActions } from '@convex-dev/auth/react';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function SignInInner() {
  const { signIn } = useAuthActions();
  const params = useSearchParams();
  const initialError = params.get('error') === 'auth_failed'
    ? 'Sign-in failed. Try again.'
    : null;
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    try {
      await signIn('resend', { email });
      setSent(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send magic link');
    }
  }

  if (sent) return <main className="p-8">Check your email for the magic link (or the convex dev terminal for local dev).</main>;

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
        {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
      </form>
      <button
        onClick={() => signIn('google').catch(() => setErrorMsg('Google sign-in unavailable in dev'))}
        className="mt-3 w-full rounded border px-4 py-2"
      >
        Continue with Google
      </button>
    </main>
  );
}

export default function SignIn() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
```

If the auth provider name differs (e.g., `LocalLog` instead of `resend` for dev), substitute accordingly.

- [ ] **Step 2: Authed layout**

`src/app/(authed)/layout.tsx`:
```tsx
import { redirect } from 'next/navigation';
import { convexAuthNextjsToken } from '@convex-dev/auth/nextjs/server';
import type { ReactNode } from 'react';

export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const token = await convexAuthNextjsToken();
  if (!token) redirect('/auth/sign-in');
  return <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>;
}
```

If `convexAuthNextjsToken` is not the right helper for the version you installed, check `@convex-dev/auth/nextjs/server` exports and use the documented "is the user authenticated server-side" check.

- [ ] **Step 3: Dashboard**

`src/app/(authed)/dashboard/page.tsx`:
```tsx
'use client';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

export default function Dashboard() {
  const workspace = useQuery(api.workspaces.current);
  if (workspace === undefined) return <main>Loading…</main>;
  if (workspace === null) return <main>No workspace found. Try signing out and back in.</main>;
  return (
    <main>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-neutral-600">Workspace: {workspace.name}</p>
      <p className="mt-4 text-sm text-neutral-500">Onboarding wizard ships in Step 7.</p>
    </main>
  );
}
```

(`api.workspaces.current` is created in Task 7.)

- [ ] **Step 4: Verify build (will fail because workspaces.current doesn't exist yet)**

Skip the build for this task — Task 7 makes it pass. Commit and move on.

- [ ] **Step 5: Commit**

```bash
git add src/app/auth src/app/\(authed\)
git commit -m "feat(auth): sign-in page + protected dashboard layout"
```

---

## Task 6 — withWorkspace helper + lint test

**Files:**
- Create: `convex/lib/auth.ts`

- [ ] **Step 1: Create the helper**

`convex/lib/auth.ts`:
```ts
import type { Id } from '../_generated/dataModel';
import type { QueryCtx, MutationCtx, ActionCtx } from '../_generated/server';

/**
 * Resolves the current authenticated user's workspace and passes its id to the callback.
 * Throws if the request is unauthenticated or the user has no workspace.
 *
 * Every query/mutation/action that reads or writes tenant data MUST go through this helper.
 * The ESLint rule in .eslintrc.cjs forbids raw `ctx.db.*` outside this file (and convex/schema.ts).
 */
export async function withWorkspace<T>(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  fn: (workspaceId: Id<'workspaces'>) => Promise<T>,
): Promise<T> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Not authenticated');

  // identity.subject is the Convex Auth user id
  const userId = identity.subject as Id<'users'>;

  // Actions can't call ctx.db directly — they have to use ctx.runQuery
  // Queries and mutations have ctx.db available.
  let workspaceId: Id<'workspaces'> | null = null;
  if ('db' in ctx) {
    const ws = await ctx.db
      .query('workspaces')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .first();
    workspaceId = ws?._id ?? null;
  } else {
    // Action context: run a query to fetch the workspace
    const ws = await ctx.runQuery(
      // @ts-expect-error api shape known after _generated lands
      (await import('../_generated/api')).api.workspaces._lookupByOwner,
      { ownerId: userId },
    );
    workspaceId = ws?._id ?? null;
  }

  if (!workspaceId) throw new Error('No workspace for user');
  return fn(workspaceId);
}
```

Note: the action branch above references a `_lookupByOwner` query that will be created in Task 7. The `@ts-expect-error` directive lets typecheck pass until Task 7 lands.

- [ ] **Step 2: Verify the ESLint rule is active**

Create a temporary file `convex/_lint_test.ts` to confirm the rule fires:
```ts
import { query } from './_generated/server';

export const bad = query({
  args: {},
  handler: async (ctx) => {
    // This should trip the no-restricted-syntax rule
    return ctx.db.query('workspaces').collect();
  },
});
```

Run: `pnpm lint`
Expected: error on the `ctx.db` line with our custom message. **The lint rule is what makes the helper enforceable** — verify it triggers before deleting the test file.

After confirming the error: `rm convex/_lint_test.ts`.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: passes (the `@ts-expect-error` directive suppresses the missing-api error).

- [ ] **Step 4: Commit**

```bash
git add convex/lib/auth.ts
git commit -m "feat(security): withWorkspace tenant-isolation helper; verified ESLint guardrail"
```

---

## Task 7 — Workspace auto-create + demo query

**Files:**
- Create: `convex/workspaces.ts`, `convex/prospects.ts`

- [ ] **Step 1: Workspace functions**

`convex/workspaces.ts`:
```ts
import { v } from 'convex/values';
import { query, mutation, internalMutation, internalQuery } from './_generated/server';
import { withWorkspace } from './lib/auth';
import type { Id } from './_generated/dataModel';

// Used by withWorkspace from action contexts; not callable from clients.
export const _lookupByOwner = internalQuery({
  args: { ownerId: v.id('users') },
  handler: async (ctx, { ownerId }) => {
    return ctx.db
      .query('workspaces')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .first();
  },
});

// Auto-create on first sign-in (called from convex/auth.ts callback below).
export const ensureForUser = internalMutation({
  args: { userId: v.id('users'), name: v.string() },
  handler: async (ctx, { userId, name }) => {
    const existing = await ctx.db
      .query('workspaces')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .first();
    if (existing) return existing._id;
    return ctx.db.insert('workspaces', {
      name: `${name}'s workspace`,
      ownerId: userId,
      plan: 'free',
      monthlySendQuota: 0,
      monthlySendsUsed: 0,
    });
  },
});

// Public query returning the current user's workspace (or null).
export const current = query({
  args: {},
  handler: async (ctx) => {
    // Note: this uses withWorkspace, which throws if unauthenticated — for client UX,
    // return null instead so the dashboard can show "not signed in" state.
    try {
      return await withWorkspace(ctx, async (workspaceId) => {
        return ctx.db.get(workspaceId);
      });
    } catch {
      return null;
    }
  },
});
```

`convex/prospects.ts`:
```ts
import { query } from './_generated/server';
import { withWorkspace } from './lib/auth';

// Demo query that exercises the tenant helper. Used by the cross-tenant test in Task 8.
export const list = query({
  args: {},
  handler: (ctx) =>
    withWorkspace(ctx, async (workspaceId) => {
      return ctx.db
        .query('prospects')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
        .collect();
    }),
});
```

- [ ] **Step 2: Wire workspace auto-create into the auth callback**

Edit `convex/auth.ts` to call `workspaces.ensureForUser` after a user is created. The exact hook name depends on the `@convex-dev/auth` version; the current API is `createOrUpdateUser`. Add to the `convexAuth({...})` config:

```ts
import { internal } from './_generated/api';

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [Google, Resend],
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      const userId = args.existingUserId ?? (await ctx.db.insert('users', {
        email: args.profile.email,
        name: args.profile.name,
      }));
      await ctx.runMutation(internal.workspaces.ensureForUser, {
        userId,
        name: args.profile.name ?? args.profile.email?.split('@')[0] ?? 'unnamed',
      });
      return userId;
    },
  },
});
```

If the callback signature differs in your installed version, check the docs at https://labs.convex.dev/auth and adjust — the principle is "after auth resolves a user, ensure a workspace exists for them."

- [ ] **Step 3: Wait for Convex to deploy the new functions**

`convex dev` should auto-deploy. Look for "Convex functions ready!" in the terminal.

- [ ] **Step 4: Verify typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: passes. The Task 5 dashboard's `api.workspaces.current` reference now resolves.

- [ ] **Step 5: Commit**

```bash
git add convex/workspaces.ts convex/prospects.ts convex/auth.ts
git commit -m "feat: workspace auto-create on first sign-in + demo prospects.list query"
```

---

## Task 8 — Cross-tenant integration test (load-bearing)

**Files:**
- Create: `vitest.config.ts`, `tests/integration/tenant-isolation.test.ts`, `tests/unit/.gitkeep`

This task is the analog of the Supabase RLS test from v1. It's the load-bearing artifact that proves tenant isolation actually holds.

- [ ] **Step 1: Vitest config**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'edge-runtime',                    // required by convex-test
    include: ['tests/**/*.test.ts'],
    server: { deps: { inline: ['convex-test'] } },
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@convex': path.resolve(__dirname, 'convex'),
    },
  },
});
```

- [ ] **Step 2: Write the failing test first (TDD)**

`tests/integration/tenant-isolation.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

describe('tenant isolation', () => {
  it('prospects.list returns only the calling user\'s workspace prospects', async () => {
    const t = convexTest(schema);

    // Create two users + their workspaces
    const userA = await t.run(async (ctx) => {
      return ctx.db.insert('users', { email: 'a@test.local', name: 'Alice' });
    });
    const userB = await t.run(async (ctx) => {
      return ctx.db.insert('users', { email: 'b@test.local', name: 'Bob' });
    });

    const wsA = await t.mutation(internal.workspaces.ensureForUser, { userId: userA, name: 'Alice' });
    const wsB = await t.mutation(internal.workspaces.ensureForUser, { userId: userB, name: 'Bob' });

    // Seed one prospect in each workspace (direct DB write — bypasses withWorkspace,
    // simulating what an Inngest-equivalent action would do legitimately)
    await t.run(async (ctx) => {
      await ctx.db.insert('prospects', { workspaceId: wsA, email: 'pa@example.com', customFields: {} });
      await ctx.db.insert('prospects', { workspaceId: wsB, email: 'pb@example.com', customFields: {} });
    });

    // Identity: act as user A
    const asA = t.withIdentity({ subject: userA });
    const aProspects = await asA.query(api.prospects.list, {});
    expect(aProspects).toHaveLength(1);
    expect(aProspects[0].email).toBe('pa@example.com');

    // Identity: act as user B
    const asB = t.withIdentity({ subject: userB });
    const bProspects = await asB.query(api.prospects.list, {});
    expect(bProspects).toHaveLength(1);
    expect(bProspects[0].email).toBe('pb@example.com');

    // The critical assertion: A cannot see B's prospects, B cannot see A's
    expect(aProspects.map((p) => p.email)).not.toContain('pb@example.com');
    expect(bProspects.map((p) => p.email)).not.toContain('pa@example.com');
  });

  it('prospects.list throws for unauthenticated callers', async () => {
    const t = convexTest(schema);
    await expect(t.query(api.prospects.list, {})).rejects.toThrow('Not authenticated');
  });
});
```

Create `tests/unit/.gitkeep` (empty).

- [ ] **Step 3: Run the test**

Run: `pnpm test`
Expected: both cases pass.

If the test fails because the `withIdentity` subject doesn't get picked up by `withWorkspace`: this is the canary bug — verify in `convex/lib/auth.ts` that `identity.subject` is read correctly. The convex-test docs at https://docs.convex.dev/testing show the exact identity-shape expected.

If the test fails because of any cross-tenant leak: that's the failure case we're guarding against. Fix `withWorkspace` (likely the `withIndex` query is missing the `ownerId` filter).

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts tests/integration/tenant-isolation.test.ts tests/unit/.gitkeep
git commit -m "test: cross-tenant isolation — prospects.list scoped to caller's workspace"
```

---

## Task 9 — README + smoke

**Files:**
- Create: `README.md`, `scripts/smoke.ts`

- [ ] **Step 1: Smoke script**

`scripts/smoke.ts`:
```ts
/**
 * End-to-end smoke: typecheck, build, lint, integration tests.
 * Used in CI and pre-deploy.
 */
import { execSync } from 'node:child_process';

const steps = [
  ['typecheck', 'pnpm typecheck'],
  ['lint',      'pnpm lint'],
  ['build',     'pnpm build'],
  ['test',      'pnpm test'],
];

for (const [name, cmd] of steps) {
  process.stdout.write(`▶ ${name}… `);
  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log('ok');
  } catch (e: unknown) {
    console.log('FAILED');
    if (e && typeof e === 'object' && 'stdout' in e) console.error(String((e as { stdout: unknown }).stdout ?? ''));
    if (e && typeof e === 'object' && 'stderr' in e) console.error(String((e as { stderr: unknown }).stderr ?? ''));
    process.exit(1);
  }
}
console.log('All smoke checks passed.');
```

- [ ] **Step 2: README**

`README.md`:
````markdown
# EvalMVP

Eval-gated cold email generation. Spec: `docs/superpowers/specs/2026-05-12-eval-gated-email-mvp-design.md`.

## Prerequisites
- Node ≥20, pnpm ≥9
- A Convex Cloud account (free tier; sign up at convex.dev)
- No Docker required

## First-time setup

```bash
pnpm install
npx convex dev            # opens browser to create your Convex deployment;
                          # writes .env.local with CONVEX_DEPLOYMENT + NEXT_PUBLIC_CONVEX_URL
                          # KEEP THIS RUNNING in its own terminal
npx @convex-dev/auth      # configures Convex Auth + Google/Resend providers; writes JWT keys
pnpm smoke                # typecheck + lint + build + tests
```

## Dev loop

Two terminals:
```bash
npx convex dev            # backend
pnpm dev                  # next.js on :3000
```

Sign in at http://localhost:3000/auth/sign-in. For local dev with the LocalLog provider, magic links print to the `convex dev` terminal.

## Architecture quick reference

- **Convex** is the database + auth + workflow. No SQL. No Drizzle. No Docker.
- **Tenant isolation** is enforced at the app layer via `withWorkspace(ctx, cb)` in `convex/lib/auth.ts`.
  - Every query/mutation/action that touches tenant data MUST go through this helper.
  - The ESLint rule in `.eslintrc.cjs` forbids raw `ctx.db.*` calls outside `convex/lib/` and `convex/schema.ts`.
  - The integration test in `tests/integration/tenant-isolation.test.ts` proves cross-workspace queries return empty.
  - **Honest caveat:** unlike Postgres RLS, this is app-level. A missed filter in a single function = silent data leak. Discipline + lint + test holds us; if it ever breaks, RLS is the migration path.
- **Workflow:** Convex `actions` for external I/O (LLMs, Apify, Gmail), `mutations` for atomic writes, `scheduledFunctions` for delayed/cron work. No Inngest.
- **Vector search:** Convex's `vectorSearch` on `emailCorpus` indexes; over-fetch then filter in app code (see Step 4 / Genericness judge).

## Project structure

```
src/app/                     Next.js routes
src/components/              Convex client provider
convex/                      Convex backend
  schema.ts                  source of truth for all collections + indexes
  auth.ts auth.config.ts     Convex Auth wiring
  http.ts                    httpAction endpoints (Stripe webhook lands here later)
  lib/auth.ts                withWorkspace helper
  workspaces.ts              workspace queries + auto-create mutation
  prospects.ts               demo query exercising withWorkspace
scripts/smoke.ts             pre-deploy gate
tests/integration/           Vitest + convex-test
docs/superpowers/specs/      Design docs
docs/superpowers/plans/      Implementation plans (one per build step)
```

## Build sequence (this repo)

1. ✅ Convex scaffolding + tenant isolation (this plan)
2. Corpus generator + embedder
3. AI-Detection judge + calibration
4. Genericness similarity (bidirectional)
5. Personalization Depth judge
6. Generation prompt + regen loop
7. Onboarding wizard
8. CSV upload + Apify enrichment
9. Approval UI (reactive)
10. Send flow with sender locks
11. Stripe checkout + httpAction webhook
````

- [ ] **Step 3: Run the smoke script end-to-end**

Run: `pnpm smoke`
Expected: prints `▶ typecheck… ok`, `▶ lint… ok`, `▶ build… ok`, `▶ test… ok`, then `All smoke checks passed.`

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/smoke.ts
git commit -m "docs: README with Convex setup + tenant isolation model; add smoke script"
```

---

## Self-review

**Spec coverage** (spec section → task):
- §3 Architecture: Tasks 3, 4, 7 (Convex + Auth + functions)
- §4 Stack: Tasks 1, 2, 3, 4 cover Next/Convex/Auth/Tailwind
- §5 Data model: Task 3 (all 9 tables)
- §6 Tenant isolation: Tasks 1 (lint rule), 6 (helper), 8 (test)
- §18 Security — tenant isolation: Tasks 6, 8
- §18 Security — token encryption: env var declared in Task 1; crypto helpers deferred to Step 7 (OAuth) since no tokens exist yet
- §19 Testing — cross-tenant test: Task 8
- §19 Testing — smoke script: Task 9
- §16 API surface — httpAction: Task 4 creates `convex/http.ts`; Stripe webhook deferred to Step 11

**Deferred (correctly, to later plans):**
- Sentry & PostHog wiring (no events to emit yet)
- Stripe (Step 11 plan)
- Real Google OAuth client_id setup for production (Step 7 plan, when senders connect mailboxes)
- Anthropic/OpenAI/Apify clients (their respective build steps)
- Sender OAuth crypto helpers (Step 7)
- The `emailCorpus` vectorIndexes are declared but unused (Step 2 populates the corpus)
- Onboarding wizard, CSV upload, approval UI, send flow, billing — Steps 7-11

**Placeholder scan:** Every code step has complete code. Every command has expected output. The one `@ts-expect-error` directive in Task 6 is necessary because Task 6 is implemented before Task 7 generates the api reference; it's removed implicitly when Task 7 lands.

**Type consistency:** `workspaceId` consistent across all tables and the helper. `withWorkspace` signature stable across queries, mutations, and actions. `internal.workspaces.ensureForUser` referenced in `convex/auth.ts` matches the export name in `convex/workspaces.ts`.

**Failure modes documented:** Task 6 step 2 explicitly verifies the lint rule fires before proceeding — the rule is half of the tenant-isolation guarantee. Task 8 is the other half.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-step-1-convex-scaffolding.md`. Execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Same approach as before.

**2. Inline Execution** — I work the plan in this session with checkpoints.

Which approach?
