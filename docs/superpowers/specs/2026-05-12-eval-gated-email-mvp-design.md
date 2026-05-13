# Eval-Gated Email Generation MVP — System Spec

**Status:** Design v2 (Convex edition)
**Source:** `handoff.md` + v1 spec (commit `6dbb60f`, Supabase edition — preserved in git history for reference)
**Date:** 2026-05-12

> **What changed from v1:** Stack pivoted from Supabase + Drizzle + Inngest to Convex (database + auth + workflow). Drops Docker for local dev. Tenant isolation moves from Postgres RLS to app-level discipline via a `withWorkspace` helper. Genericness judge gains a positive direction (similarity to human corpus) on top of the existing distance-from-bad measure.

---

## 1. Product

A web app that generates cold emails one prospect at a time, scores every draft with three independent judges, regenerates with feedback until a quality threshold is met, then queues drafts for human approval and sends through the user's own Gmail/Outlook.

**Differentiator.** Every send is provably above a quality bar. Competitors (Artisan, 11x, Regie, Cardinal) generate but do not score before sending. The eval engine — corpus + judges + calibration — is the moat.

**Success metric.** 5 paying customers actively running campaigns and renewing into month two.

**Scope guardrails.** Generation is the core product, not optional. Ship when output quality is something the founders would send themselves.

---

## 2. End-to-end flow

1. User signs up via Google OAuth or magic link → workspace auto-created
2. Connects Gmail or Outlook send-OAuth → becomes a `sender`
3. Defines ICP (industry, role keywords, company size, geo, exclusions, value prop, threshold)
4. Pastes 5–10 replied-to emails as voice samples
5. Uploads prospect CSV
6. For each prospect: enrich → generate → score (3 judges in parallel) → blend → regenerate if below threshold (max 3) → queue for approval (or flag for manual review if still below)
7. User reviews approval table with per-email score breakdown and evidence highlights (reactive — new scores appear without page refresh)
8. Approved emails send through the user's mailbox with drip + jitter rate limiting

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Next.js (App Router) on Vercel                          │
│  - RSC + server actions                                  │
│  - useQuery() for reactive approval UI                   │
└─────────────────────────────┬────────────────────────────┘
                              │ Convex client SDK (typed)
                              ▼
┌──────────────────────────────────────────────────────────┐
│  Convex (cloud-hosted; no Docker)                        │
│                                                          │
│  Data layer:                                             │
│   - 8 collections, indexed by workspaceId                │
│   - vector indexes on emailCorpus.embedding_{opener,     │
│     body, cta} for the Genericness judge                 │
│                                                          │
│  Auth: Convex Auth (Google OAuth + magic link)           │
│                                                          │
│  Functions:                                              │
│   - queries (reads, reactive to clients)                 │
│   - mutations (writes, atomic)                           │
│   - actions (external I/O: LLMs, Apify, Gmail, Stripe)   │
│   - scheduledFunctions (cron + delayed invocations)      │
│                                                          │
│  Eval pipeline (action chains):                          │
│   prospect.uploaded                                      │
│     → enrichProspect (action, Apify)                     │
│     → generateDraft (action, Anthropic)                  │
│     → scoreAll (action, runs 3 judges via Promise.all)   │
│     → evaluateBlend (mutation)                           │
│        ├─ below threshold + retry < 3 → re-enqueue       │
│        ├─ below threshold + retry == 3 → flag            │
│        └─ above → status='needs_review'                  │
│                                                          │
│  Send pipeline:                                          │
│   onApproval(generationId)                               │
│     → scheduledFunction (drip with jitter)               │
│     → sendEmail (action: Gmail/Graph + record send row)  │
└──────────────────────────────────────────────────────────┘

External:
  - Anthropic (Sonnet 4.6 generation, Haiku 4.5 judges)
  - OpenAI (text-embedding-3-small)
  - Apify (LinkedIn enrichment)
  - Stripe (Checkout + webhook via Convex httpAction)
  - Sentry, PostHog
```

**Why Convex over the v1 stack.**
- One vendor for DB + auth + workflow + functions; no Docker for local dev (`npx convex dev`).
- Reactive queries make the approval table update automatically when scores land — no Realtime subscription plumbing.
- End-to-end typed RPC between Next.js client and Convex functions.

**What we give up vs v1.**
- **Tenant isolation is now app-level**, not database-enforced. Single missed filter in a query = silent cross-workspace data leak. Mitigation: every query/mutation/action goes through the `withWorkspace` helper; lint rule + code review.
- **No durable workflow steps.** If an action dies mid-loop, it retries from the start. Mitigation: idempotency keys on side effects; checkpoint state in the DB between stages so resumption is cheap.
- **No concurrency keys for rate-limited sends.** Implement manually via a `sender_locks` table.
- **No SQL escape hatch.** Analytics queries (calibration drift, approval rate per ICP) require either materialized aggregations in Convex or shipping to PostHog/Metabase. Accepted; revisit post-launch if it bites.
- **Vector search is approximate top-K from full set, filtered after.** Over-fetch and filter in app code; for our 3,500-row corpus this is fine.

**Multi-tenancy.** Every collection except `emailCorpus` carries `workspaceId`. The `withWorkspace(ctx, cb)` helper resolves the current user, looks up their workspace, and passes it to the callback. Direct `ctx.db.query()` calls outside this helper are banned by lint rule.

---

## 4. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend + API | Next.js 15 (App Router) on Vercel | Server actions for mutations that don't need reactivity |
| Database + Auth + Workflow | Convex | Cloud-hosted; `npx convex dev` for local |
| Auth provider | Convex Auth | Google OAuth + magic link |
| Generation | Claude Sonnet 4.6 | Prompt caching on voice samples + ICP |
| Judges | Claude Haiku 4.5 | Three independent calls in parallel |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dim |
| Email send | Gmail API + Microsoft Graph | OAuth per sender, called from Convex actions |
| Enrichment | Apify (`dev_fusion/linkedin-profile-scraper`) | Cached 90d in `prospects.enrichmentJsonb` |
| Billing | Stripe Checkout + webhook via Convex `httpAction` | Two tiers |
| Errors | Sentry | Frontend + serverless |
| Product analytics | PostHog | Event funnel, approval rates, calibration drift |
| Token encryption | Node `crypto` AES-256-GCM with `OAUTH_TOKEN_KEY` from env | OAuth tokens encrypted at rest in Convex |

---

## 5. Data model

Convex schema in `convex/schema.ts`. Every document has an auto-generated `_id` (typed `Id<"tableName">`) and `_creationTime` (number, ms since epoch). All custom timestamps below are also `v.number()` for consistency. Convex stores documents, not rows; relationships are unenforced `Id<"...">` references that app code is responsible for using correctly.

### 5.1 workspaces
```ts
{
  name: v.string(),
  ownerId: v.id("users"),                       // Convex Auth users table
  stripeCustomerId: v.optional(v.string()),
  plan: v.union(v.literal("free"), v.literal("solo"), v.literal("team")),
  monthlySendQuota: v.number(),
  monthlySendsUsed: v.number(),
  quotaResetAt: v.optional(v.number()),
}
.index("by_owner", ["ownerId"])
```

### 5.2 senders
```ts
{
  workspaceId: v.id("workspaces"),
  name: v.string(),
  email: v.string(),
  provider: v.union(v.literal("gmail"), v.literal("outlook")),
  domain: v.optional(v.string()),
  oauthAccessTokenEncrypted: v.bytes(),         // AES-256-GCM
  oauthRefreshTokenEncrypted: v.bytes(),
  oauthExpiresAt: v.optional(v.number()),
  voiceSamples: v.array(v.object({ subject: v.string(), body: v.string() })),
  voiceSamplesIndexedAt: v.optional(v.number()),
  dailySendCap: v.number(),                     // default 200
  sendsToday: v.number(),
  sendsTodayResetAt: v.optional(v.number()),
}
.index("by_workspace", ["workspaceId"])
.index("by_workspace_email", ["workspaceId", "email"])   // uniqueness enforced in app
```

### 5.3 icps
```ts
{
  workspaceId: v.id("workspaces"),
  name: v.string(),
  industry: v.array(v.string()),
  roleKeywords: v.array(v.string()),
  sizeRangeMin: v.optional(v.number()),
  sizeRangeMax: v.optional(v.number()),
  geo: v.array(v.string()),
  exclusions: v.array(v.string()),
  valueProp: v.optional(v.string()),
  thresholdDefault: v.number(),                 // default 70
}
.index("by_workspace", ["workspaceId"])
```

### 5.4 prospects
```ts
{
  workspaceId: v.id("workspaces"),
  senderId: v.optional(v.id("senders")),
  icpId: v.optional(v.id("icps")),
  email: v.string(),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  company: v.optional(v.string()),
  role: v.optional(v.string()),
  linkedinUrl: v.optional(v.string()),
  customFields: v.any(),                        // arbitrary CSV custom_* columns
  enrichment: v.optional(v.any()),
  enrichmentFetchedAt: v.optional(v.number()),
  enrichmentStatus: v.optional(v.union(
    v.literal("pending"), v.literal("ok"), v.literal("failed"), v.literal("fallback_csv_only"),
  )),
}
.index("by_workspace", ["workspaceId"])
.index("by_workspace_email", ["workspaceId", "email"])
```

### 5.5 generations
```ts
{
  workspaceId: v.id("workspaces"),
  prospectId: v.id("prospects"),
  senderId: v.id("senders"),
  icpId: v.optional(v.id("icps")),
  parentGenerationId: v.optional(v.id("generations")),
  subject: v.optional(v.string()),
  body: v.optional(v.string()),
  model: v.optional(v.string()),
  promptVersion: v.optional(v.string()),
  retryCount: v.number(),
  status: v.union(
    v.literal("pending"), v.literal("enriching"), v.literal("generating"),
    v.literal("scoring"), v.literal("needs_review"), v.literal("approved"),
    v.literal("rejected"), v.literal("flagged"), v.literal("sending"),
    v.literal("sent"), v.literal("failed"),
  ),
  overallScore: v.optional(v.number()),
  approvedBy: v.optional(v.id("users")),
  approvedAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
}
.index("by_workspace", ["workspaceId"])
.index("by_prospect", ["prospectId"])
.index("by_workspace_status", ["workspaceId", "status"])   // approval table
```

### 5.6 scores
```ts
{
  workspaceId: v.id("workspaces"),
  generationId: v.id("generations"),
  judgeName: v.union(
    v.literal("ai_detection"), v.literal("genericness"), v.literal("personalization"),
  ),
  score: v.number(),                            // 0–100
  subScores: v.any(),
  evidence: v.any(),
  judgeVersion: v.string(),
  scoredAt: v.number(),
}
.index("by_generation", ["generationId"])
.index("by_generation_judge", ["generationId", "judgeName"])   // uniqueness enforced in app
```

### 5.7 sends
```ts
{
  workspaceId: v.id("workspaces"),
  generationId: v.id("generations"),
  senderId: v.id("senders"),
  sentAt: v.optional(v.number()),
  sendMethod: v.optional(v.union(v.literal("gmail"), v.literal("outlook"))),
  externalMessageId: v.optional(v.string()),
  error: v.optional(v.string()),
  status: v.union(
    v.literal("queued"), v.literal("sent"), v.literal("failed"), v.literal("bounced"),
  ),
}
.index("by_workspace", ["workspaceId"])
```

### 5.8 emailCorpus (global, no workspaceId)
```ts
{
  source: v.optional(v.string()),
  origin: v.union(v.literal("ai"), v.literal("human"), v.literal("template")),
  model: v.optional(v.string()),
  vendor: v.optional(v.string()),
  subject: v.optional(v.string()),
  body: v.string(),
  embeddingOpener: v.array(v.float64()),        // length 1536
  embeddingBody: v.array(v.float64()),
  embeddingCta: v.array(v.float64()),
  metadata: v.any(),
}
.index("by_origin", ["origin"])
.vectorIndex("vec_opener", { vectorField: "embeddingOpener", dimensions: 1536, filterFields: ["origin"] })
.vectorIndex("vec_body",   { vectorField: "embeddingBody",   dimensions: 1536, filterFields: ["origin"] })
.vectorIndex("vec_cta",    { vectorField: "embeddingCta",    dimensions: 1536, filterFields: ["origin"] })
```

### 5.9 senderLocks (for rate-limited sends)
```ts
{
  senderId: v.id("senders"),
  acquiredAt: v.number(),
  expiresAt: v.number(),
}
.index("by_sender", ["senderId"])
```
Used to enforce per-sender concurrency. Acquire atomically in a mutation; release after send completes or expires.

---

## 6. Tenant isolation: the `withWorkspace` helper

Every query/mutation/action that touches tenant data must go through this helper. Located at `convex/lib/auth.ts`:

```ts
import { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";

export async function withWorkspace<T>(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  fn: (workspaceId: Id<"workspaces">) => Promise<T>,
): Promise<T> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const userId = identity.subject as Id<"users">;
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_owner", q => q.eq("ownerId", userId))
    .first();
  if (!workspace) throw new Error("No workspace");
  return fn(workspace._id);
}
```

**Usage pattern:**
```ts
export const listProspects = query({
  args: {},
  handler: (ctx) => withWorkspace(ctx, async (workspaceId) => {
    return ctx.db.query("prospects")
      .withIndex("by_workspace", q => q.eq("workspaceId", workspaceId))
      .collect();
  }),
});
```

**Enforcement:**
1. **Lint rule** (`eslint-plugin-no-restricted-syntax`) forbids `ctx.db.query` and `ctx.db.insert` calls outside files in `convex/lib/`. All app-level functions must route through helpers.
2. **Code review checklist** item: "every new query/mutation/action uses `withWorkspace`."
3. **Cross-tenant integration test** (see §18) attempts to read user A's data as user B and asserts empty.

**Honest failure mode.** A missed filter in a single function = silent data leak. The Postgres-RLS version of this product would refuse such queries at the DB. We accept this tradeoff for the simpler stack and pay it back with the lint rule, the test, and review discipline. **If we ever have a security incident traceable to a missed filter, RLS pgsql is the migration path.**

---

## 7. Corpus bootstrap (one-time before launch)

Script: `scripts/corpus/build.ts` (run with `npx convex run scripts:buildCorpus` after publishing it as a Convex action).

| Bucket | Target | Source | Cost |
|---|---|---|---|
| Synthetic AI | 2,000 | 4 LLMs (Sonnet, GPT-4o, Gemini 1.5, Llama 3.1 70B) × 50 ICP variants × 10 prompt styles | ~$50 |
| Human | 1,000 | r/sales replied-to threads, Twitter/X founder threads, Pavilion archive, Lavender blog samples | scrape time |
| Template | 500 | Public AI SDR vendor demo pages, Apollo/Outreach template galleries, GitHub awesome-sales-templates repos | scrape time |

**Pipeline.** For each email: extract `(subject, body)` → segment into `(opener, body_middle, cta)` via regex on first sentence / last paragraph with imperative or question → embed each segment with `text-embedding-3-small` → insert into `emailCorpus`.

**Quality gate.** Before launch, run `scripts/corpus/validate.ts`:
- ≥1,800 ai rows, ≥900 human rows, ≥400 template rows
- No row with empty `embeddingBody`
- Spot-check 50 random rows manually

---

## 8. Generation + eval loop

### 8.1 Action chain

```
prospect.uploaded                                          (mutation, enqueues action)
  → enrichProspect (action)                                 Apify or CSV fallback
    → generateDraft (action)                                Anthropic with prompt caching
      → scoreAll (action)                                   Promise.all over 3 judges
        → evaluateBlend (mutation)                          atomic threshold check
          ├─ below + retry<3 → schedule generateDraft       feedback in payload
          ├─ below + retry==3 → status='flagged'
          └─ above → status='needs_review'
```

Each step writes its result to the `generations` document before invoking the next. If an action dies, the next retry sees the most recent checkpoint and resumes from there — replacing Inngest's durable steps with explicit DB state.

### 8.2 Generation prompt structure

```
SYSTEM (cached via Anthropic prompt caching):
  - Role: cold email writer in user's voice
  - Voice samples (5–10) verbatim as few-shot
  - ICP definition
  - Hard rules: no em-dashes, no "hope this finds you well", no "I came across",
    no generic personalization tokens

USER (per-prospect):
  - Prospect: name, role, company, linkedin summary, custom fields
  - Enrichment context (recent posts, headline, about section)
  - [If retry] Previous draft + sub-score deltas + critique
  - Output JSON: { subject, body }
```

Prompt caching applied to the SYSTEM block. Cache hit ratio target: >70%.

### 8.3 Regeneration feedback

When `overallScore < threshold`, the next generation call receives:

```
PREVIOUS_DRAFT: <subject + body>
SCORES:
  ai_detection: 62 (below 70 because opener flagged as "hedging" and "AI rhythm")
  genericness: 81
  personalization: 58 (below 70: only 1 grounded reference, generic "{company}" token used)
CRITIQUE: <free-form Haiku critique, 2-3 sentences>
INSTRUCTIONS:
  - Rewrite to lift the lowest-scoring dimension first
  - Preserve anything the highest-scoring dimension rewarded
```

Both structured deltas and natural-language critique included. Max retries: **3**. After 3, set status `flagged`.

### 8.4 Score blend

```
overall = 0.4 × ai_detection + 0.3 × genericness + 0.3 × personalization
```

Threshold defaults to `icps.thresholdDefault` (70). Per-ICP override supported.

---

## 9. Judges

### 9.1 AI-Detection

**Model:** Haiku 4.5
**Input:** subject + body
**Output schema:**
```json
{
  "axis_scores": {
    "opener": 0-100, "structure": 0-100, "hedging": 0-100,
    "cta": 0-100, "vocabulary": 0-100, "punctuation": 0-100, "rhythm": 0-100
  },
  "overall": 0-100,
  "red_flags": [{ "axis": "...", "evidence": "...", "severity": "high|med|low" }, ...top 3]
}
```
Score interpretation: **higher = more human**. AI corpus should score low; human corpus should score high.

**Rubric.** Stored in `prompts/judges/ai_detection.md`, versioned.

**Calibration target (pre-launch):**
- Mean score on AI corpus: ≤30
- Mean score on human corpus: ≥70
- Overlap (AI rows >50 + human rows <50): <10% of corpus

### 9.2 Genericness (updated from v1 — bidirectional)

**Method:** Convex vector search with over-fetch + filter pattern, computing both distance-from-bad and closeness-to-good.

For each segment (opener, body, cta):
1. Use `ctx.vectorSearch("emailCorpus", "vec_opener", { vector, limit: 100, filter: q => q.or(q.eq("origin", "ai"), q.eq("origin", "template")) })` — over-fetch 100, top 3 after filter.
2. Same against `origin === "human"` for closeness-to-good.
3. `distance_from_bad = 1 - max_similarity_to_ai_template`
4. `closeness_to_good = max_similarity_to_human`
5. Per-segment score: `100 × (0.6 × distance_from_bad + 0.4 × closeness_to_good)`
6. Final judge score: `min(per-segment scores)` — penalize the worst segment.

Score interpretation: **higher = more unique AND more human-like**. Closes laksh's gap: a unique-but-bad email is far from bad corpus *and* far from human corpus, scoring poorly.

Evidence emitted to the score document: top 3 closest matches from each corpus with similarity scores, source, snippet.

No LLM call in this judge.

### 9.3 Personalization Depth

**Model:** Haiku 4.5
**Input:** body + full enrichment object
**Output schema:**
```json
{
  "references": [
    { "snippet": "...", "grounded_in": "enrichment.recent_posts[2]", "specificity": "high|med|low|generic" }
  ],
  "generic_token_hits": ["{company}", "your role at <company>"],
  "grounded_ref_count": 0,
  "score": 0
}
```
**Scoring rules:**
- Start at 0
- +20 per grounded high-specificity reference (cap 60)
- +10 per grounded med-specificity (cap 20)
- −30 per generic token hit
- −40 if `grounded_ref_count === 0`
- Floor 0, ceiling 100

---

## 10. Enrichment

**Path A — LinkedIn (preferred):** Apify actor `dev_fusion/linkedin-profile-scraper` via Convex action. Result cached in `prospects.enrichment` with `enrichmentStatus='ok'`. Fields used: headline, about, recent posts (top 5), current role tenure, skills.

**Path B — CSV-only fallback:** If `linkedinUrl` is missing or Apify returns nothing within 30s × 2 retries, set `enrichmentStatus='fallback_csv_only'` and proceed.

**Caching.** Re-enrichment is skipped if `enrichmentFetchedAt` is within 90 days. Manual refresh button per prospect in UI.

**Cost guardrail.** Hard monthly cap per workspace; banner in UI when 80% consumed.

---

## 11. Onboarding flow

Single linear wizard, 4 steps, persistent state in `workspaces`:

1. **Workspace.** Name. Auto-created on first sign-in if absent.
2. **Connect sender.** Google or Microsoft OAuth (separate from sign-in auth — `gmail.send` / `Mail.Send` scope). Refresh token encrypted with AES-256-GCM and stored in `senders.oauthRefreshTokenEncrypted`.
3. **Define ICP.** Form fields per §5.3. At least one industry and one role keyword required.
4. **Voice samples.** Textarea pairs (subject + body) ×5 minimum, 10 maximum.

Wizard cannot be skipped; CSV upload route returns user here if any step incomplete.

---

## 12. CSV upload

**Required columns:** `email`, `first_name`, `company`
**Optional:** `last_name`, `role`, `linkedin_url`
**Custom:** any column prefixed `custom_` is preserved in `customFields`

**Validation (client-side preview before insert):**
- Email regex + dedupe within file
- Reject rows with empty required cols
- Cap: 5,000 rows per upload (Solo), 50,000 (Team)
- Show 5-row preview before commit

On commit: bulk insert prospects via a single mutation (Convex supports batch inserts), then emit one `prospect.uploaded` event per row (scheduled action) so the eval pipeline picks them up.

---

## 13. Approval UI

Single table view, paginated 50/page. **Uses Convex's reactive `useQuery` so new scores appear without page refresh.**

Columns:
- Checkbox (bulk approve)
- Prospect (name, company, role)
- Subject + body preview (truncated, click to expand)
- Overall score (color-coded: green ≥80, yellow 70–79, red <70)
- Sub-scores (3 mini bars)
- Status badge

**Expanded row drawer:**
- Full email rendered as it will send
- Per-judge breakdown with axis scores and red flags
- Evidence: top similar corpus matches; grounded references highlighted in body
- Regenerate, Edit-and-approve, Reject buttons

Bulk actions: Approve all visible, Reject all visible, Approve all with score ≥X.

Flagged generations appear in a separate tab.

---

## 14. Send flow

**Trigger:** approval mutation schedules a `sendEmail` action with `runAfter(delayMs)` for drip + jitter.

**Rate limiting:** before each send, acquire a `senderLocks` row in a mutation:
```ts
// atomic acquire (Convex mutations are serializable)
const existing = await ctx.db.query("senderLocks")
  .withIndex("by_sender", q => q.eq("senderId", id))
  .filter(q => q.gt(q.field("expiresAt"), Date.now()))
  .first();
if (existing) throw new Error("Sender busy, retrying");
await ctx.db.insert("senderLocks", { senderId: id, acquiredAt: now, expiresAt: now + 60_000 });
```
Per-sender concurrency = 1. Drip schedule: random jitter 30–180s between sends. Honors `senders.dailySendCap` (default 200, max Gmail 500 / Outlook 1000).

**Send path:**
- Gmail: `users.messages.send`
- Outlook: `users/me/sendMail`
- Capture `external_message_id` into `sends`
- On 401: refresh OAuth token, retry once
- On 429: backoff, mark `failed` after 3 retries

**Daily counter reset:** scheduled Convex cron at UTC midnight resets `sendsToday`.

---

## 15. Billing

**Tiers (Stripe Products):**
| Tier | Price | Sends/mo | Senders | Prospects/upload |
|---|---|---|---|---|
| Solo | $300 | 2,000 | 1 | 5,000 |
| Team | $1,500 | 15,000 | 5 | 50,000 |

**Checkout:** Stripe-hosted Checkout via a server action; success URL polls a Convex query that watches the workspace plan.

**Webhook:** `checkout.session.completed` → Convex `httpAction` verifies signature → updates `workspaces.plan`, `monthlySendQuota`, sets `quotaResetAt`.

**Metering:** every successful `sends` insert increments `workspaces.monthlySendsUsed` in the same mutation (atomic). When `>= monthlySendQuota`, the `sendEmail` action short-circuits with status `failed`.

**Quota reset:** Convex daily cron resets `monthlySendsUsed` at `quotaResetAt`.

**Cost-per-send target:** $0.02. Gross margin target ~85%.

---

## 16. API surface

**Convex functions (called via the Convex client SDK from Next.js):**
- Queries: `prospects.list`, `generations.listForApproval`, `workspace.get`, `senders.list`, `scores.forGeneration`
- Mutations: `workspace.create`, `icp.update`, `prospect.uploadCsv`, `generation.approve`, `generation.reject`, `generation.regenerate`, `sender.revokeOauth`
- Actions: `sender.completeOauth`, `prospect.enrich`, `generation.draft`, `generation.scoreAll`, `email.send`
- httpActions: `stripeWebhook`, `gmailOauthCallback`, `outlookOauthCallback`
- scheduledFunctions: `quota.resetMonthly`, `sender.resetDaily`, `senderLocks.expire`

**Next.js route handlers (thin shims, only for things that need a public HTTP endpoint):**
- `/api/auth/[...convex]` — Convex Auth handler
- `/api/csv-preview` — CSV parse + validate, no insert

---

## 17. Observability

**Sentry:** server + browser. Tag every event with `workspaceId` when available.

**PostHog events:**
- `signup`, `workspace_created`, `sender_connected`, `icp_completed`, `voice_samples_saved`
- `csv_uploaded`, `generation_created`, `generation_scored`
- `generation_approved`, `generation_rejected`, `generation_flagged`
- `send_succeeded`, `send_failed`
- `checkout_started`, `subscription_active`

**Analytics queries** (calibration drift, approval rate per ICP, retry distribution) live in PostHog or are computed by nightly scheduled Convex functions that materialize summary documents. Direct ad-hoc SQL is not available — accepted tradeoff.

---

## 18. Security

- **OAuth tokens** encrypted at rest with Node `crypto.createCipheriv('aes-256-gcm', ...)` keyed by `OAUTH_TOKEN_KEY` env var (32 bytes hex)
- **Tenant isolation** enforced at the app layer via `withWorkspace`. Lint rule forbids raw `ctx.db.query` outside `convex/lib/`. Cross-tenant test asserts empty results across workspaces.
- **Convex Auth** handles session validation; functions reject unauthenticated requests via `ctx.auth.getUserIdentity()` in `withWorkspace`.
- **Webhook signature verification** for Stripe (`stripe.webhooks.constructEvent`) and Gmail push (if used post-MVP).
- **No PII in logs:** Sentry scrubbing rules strip `email`, `body`, `oauth_token*`.

---

## 19. Testing strategy

**Three test layers:**

1. **Eval calibration tests** (`tests/eval/`). Run the 3 judges over the corpus. Assert:
   - AI-Detection: mean ≤30 on ai rows, ≥70 on human rows
   - Genericness: mean ≤40 on ai rows, ≥60 on human rows (templates score lowest)
   - Personalization: needs synthetic prospect+enrichment pairs; assert grounded refs detected

2. **Integration tests** (`tests/integration/`). Use `convex-test`:
   - **Cross-tenant isolation test** (load-bearing): create two users, each calls `prospects.list`, verify each only sees their own
   - Full loop: upload prospect → generate → score → approve → fake-send
   - Sender concurrency lock holds
   - Quota enforcement halts at limit
   - OAuth token refresh path

3. **Unit tests** (`tests/unit/`). Pure functions: CSV parser, prompt builder, score blender, segment extractor.

**Pre-deploy smoke** (`scripts/smoke.ts`): typecheck, build, run all unit + integration tests.

---

## 20. Build sequence

Each step becomes its own implementation plan via `writing-plans`.

1. **Convex scaffolding + tenant isolation** (this plan — `2026-05-12-step-1-convex-scaffolding.md`)
2. Corpus generator + scraper + embedder + validator
3. AI-Detection judge + calibration test
4. Genericness similarity (bidirectional — both corpora)
5. Personalization Depth judge
6. Generation prompt + regeneration loop with feedback injection
7. Onboarding wizard
8. Prospect CSV upload + parser + Apify enrichment with fallback
9. Approval table UI with reactive `useQuery` + score breakdown + evidence
10. Gmail/Outlook send flow with sender locks + drip + jitter
11. Stripe Checkout + httpAction webhook + quota metering

Steps 3, 4, 5 are independent and can run in parallel after step 2.

---

## 21. Cut from MVP

Sequences · reply handling · CRM sync · LinkedIn channel · hallucination eval · ICP-fit eval · reply-likelihood model · vendor scorecards · A/B testing · voice cloning beyond prompt-sampling · SSO · custom rubrics · free tier · public benchmark report · open/click tracking · team membership beyond single owner · SQL analytics ad-hoc (defer to PostHog/Metabase later if needed)

---

## 22. Open questions resolved

| Question | Resolution |
|---|---|
| Threshold default | 70/100 overall; `icps.thresholdDefault` override per ICP |
| Regeneration feedback | Structured deltas + natural-language critique |
| Voice sample handling | Few-shot in cached prompt prefix |
| Send rate limits | Gmail 500/day, Outlook 1000/day surfaced in UI; configurable `senders.dailySendCap` (default 200) with drip + jitter |
| LinkedIn enrichment failure | CSV-only fallback path |
| Auth | Convex Auth (Google OAuth + magic link) |
| Multi-tenancy | App-level via `withWorkspace`; single-owner for MVP |
| Score blend weights | 0.4 AI-Detection · 0.3 Genericness · 0.3 Personalization |
| Genericness measure | Bidirectional: distance-from-bad + closeness-to-good (corpus-vs-corpus) |
| Max retries | 3, then `flagged` |
| Subject scoring | Subject scored within AI-Detection `opener` axis |
| Apify actor | `dev_fusion/linkedin-profile-scraper`, 90-day cache |
| Stripe enforcement | Hard-stop at quota, banner in UI |
| Workflow engine | Convex actions + scheduledFunctions; Inngest not used |
| Local dev | `npx convex dev`; no Docker |

---

## Appendix A — Reference prompts (skeletons)

`prompts/generation/v1.md`
```
You write cold emails in the voice of the sender. Match their cadence, sentence
length, openers, and CTA style. Never use: em-dashes, "I came across", "hope
this finds", "I noticed your role at <company>", "leverage", "synergize".

Voice samples:
{{#each voice_samples}}
---
Subject: {{subject}}
{{body}}
{{/each}}

ICP: {{icp.value_prop}}
Target: {{icp.role_keywords}} at {{icp.industry}} companies, {{icp.size_range}}

Output JSON: { "subject": "...", "body": "..." }
```

`prompts/judges/ai_detection.md`, `prompts/judges/personalization.md` — see §9.

---

## Appendix B — Defaults locked in for the builder

- TypeScript strict mode on
- pnpm for package management
- Convex generates client SDK and types — no separate ORM
- Tailwind v3 (Convex examples use v3; Tailwind v4 migration is a separate concern)
- ESLint + Prettier with default Next.js config, plus a `no-restricted-syntax` rule forbidding raw `ctx.db` outside `convex/lib/`
- Vercel preview deploys per PR
- Single `main` branch, trunk-based; feature branches squash-merge
- Convex dev runs in the cloud against a dev deployment per developer (`npx convex dev`)

---

**End of spec v2.**
