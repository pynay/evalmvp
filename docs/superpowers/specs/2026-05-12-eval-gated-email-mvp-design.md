# Eval-Gated Email Generation MVP — System Spec

**Status:** Design v1.2 (aggressive bare-MVP scope)
**Source:** `handoff.md` (initial commit 829090f)
**Last updated:** 2026-05-13

> **The MVP's purpose:** answer ONE question — "can the eval engine produce cold emails the founders would actually send?" Anything that doesn't serve that question is stripped down to its minimal form or cut entirely.
>
> **v1.2 scope cuts (additive to v1.1):**
> - **Step 7 onboarding wizard → minimal admin form** (§10): single page to set workspace ICP + voice samples + sender's name/from-email. No multi-step UI, no Gmail OAuth in this step.
> - **Step 8 CSV upload → textarea paste** (§11): one prospect per line as `email, first_name, company, [linkedin_url]`. Apify enrichment still fires per prospect. No bulk-import UI, no preview-before-commit.
> - **Step 9 approval UI → minimal list** (§12): list view with overall score + body preview + click-to-expand. Per-judge sub-scores in the expanded row. No bulk actions, no regenerate button (initial cut — reject + re-paste prospect to retry).
> - **Step 10 send flow → copy-to-clipboard** (§13): on approval, the email body is rendered with a Copy button. The user pastes into Gmail manually. No Gmail OAuth, no Microsoft Graph, no drip + jitter, no rate limiting, no `sends` table populated.
>
> **v1.1 cuts (carried forward):**
> - Stripe billing + quota metering (§14): deferred until eval quality is validated.
> - Genericness judge gains a positive direction (§8.2): in addition to `distance from AI+template corpora`, score `closeness to human corpus` weighted 0.4. Addresses the "unique but bad" failure mode laksh flagged.
>
> **What's load-bearing and unchanged from v1:**
> - Corpus bootstrap (§6), all 3 judges (§8), generation + regen loop (§7), the 70/100 threshold and 3-retry cap, the score blend, the schema.
>
> **Forward compatibility:** every cut feature has its data-model surface preserved (workspaces.stripe_customer_id, senders.oauth_*, sends table, etc.). Re-adding any of these later requires no migration — only filling in code paths that today are no-ops.

---

## 1. Product

A web app that generates cold emails one prospect at a time, scores every draft with three independent judges, regenerates with feedback until a quality threshold is met, then queues drafts for human approval and sends through the user's own Gmail/Outlook.

**Differentiator.** Every send is provably above a quality bar. Competitors (Artisan, 11x, Regie, Cardinal) generate but do not score before sending. The eval engine — corpus + judges + calibration — is the moat.

**Success metric.** 5 paying customers actively running campaigns and renewing into month two.

**Scope guardrails.** Generation is the core product, not optional. Ship when output quality is something the founders would send themselves.

---

## 2. End-to-end flow

1. User signs up → creates workspace
2. Connects Gmail or Outlook via OAuth → becomes a `sender`
3. Defines ICP (industry, role keywords, company size, geo, exclusions, value prop, threshold)
4. Pastes 5–10 replied-to emails as voice samples
5. Uploads prospect CSV
6. For each prospect: enrich → generate → score (3 judges in parallel) → blend → regenerate if below threshold (max 3) → queue for approval (or flag for manual review if still below)
7. User reviews approval table with per-email score breakdown and evidence highlights
8. Approved emails send through the user's mailbox with drip + jitter rate limiting

---

## 3. Architecture

```
┌──────────────────┐      ┌────────────────────────────────────────┐
│  Next.js (App    │      │  Supabase (Postgres + pgvector + Auth) │
│  Router + API)   │◄────►│  - RLS scoped by workspace_id          │
│  on Vercel       │      │  - pgcrypto for token encryption       │
└────────┬─────────┘      └────────────────────────────────────────┘
         │
         │ enqueue
         ▼
┌──────────────────────────────────────────────────────────────────┐
│  Inngest (event-driven workflow)                                 │
│                                                                  │
│   prospect.uploaded ──► enrich.prospect ──► generate.draft       │
│                                                  │               │
│                                                  ▼               │
│                                          score.fanout            │
│                                          ├─ judge.ai_detect      │
│                                          ├─ judge.generic        │
│                                          └─ judge.personalize    │
│                                                  │               │
│                                                  ▼               │
│                                          evaluate.blend          │
│                                              │       │           │
│                                       below  │       │  pass     │
│                                              ▼       ▼           │
│                                       regenerate    queue        │
│                                       (≤3)          for approval │
│                                                                  │
│   approval.granted ──► send.email (Gmail / MS Graph)             │
└──────────────────────────────────────────────────────────────────┘

External:
  - Anthropic (Sonnet 4.6 generation, Haiku 4.5 judges)
  - OpenAI (text-embedding-3-small)
  - Apify (LinkedIn enrichment)
  - Stripe (DEFERRED — see §14)
  - Sentry, PostHog
```

**Why Inngest.** Fan-out for the 3 parallel judge calls is the load-bearing reason. Built-in retries, concurrency control per sender (for rate limiting), and step-level observability replace ~200 lines of bespoke queue code.

**Tenant isolation.** Every table that holds tenant data carries `workspace_id`. Postgres RLS policies enforce that authenticated users only see their own workspace's rows. Service-role key is used only inside Inngest functions and server actions; never exposed to the client.

---

## 4. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend + API | Next.js 15 (App Router) on Vercel | Server actions for mutations |
| DB + Auth | Supabase (Postgres 15 + pgvector + Auth) | Google OAuth primary |
| Workflow | Inngest | Cloud-hosted, signed webhooks |
| Generation | Claude Sonnet 4.6 | Prompt caching on voice samples + ICP |
| Judges | Claude Haiku 4.5 | Three independent calls in parallel |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dim |
| Email send | Gmail API + Microsoft Graph | OAuth per sender |
| Enrichment | Apify (`dev_fusion/linkedin-profile-scraper`) | Cached 90d |
| Billing | DEFERRED — see §14 | Re-added after eval quality is validated |
| Errors | Sentry | Frontend + serverless |
| Product analytics | PostHog | Event funnel, approval rates |
| Secrets | Vercel env + pgcrypto for token-at-rest | App-level key from env |

---

## 5. Data model

All tables carry `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz`, and tenant rows additionally carry `workspace_id uuid not null references workspaces(id) on delete cascade` with an index.

### 5.1 workspaces
```
id, name text, owner_id uuid references auth.users(id),
stripe_customer_id text, plan text check (plan in ('free','solo','team')),
monthly_send_quota int, monthly_sends_used int default 0,
quota_reset_at timestamptz
```

### 5.2 senders
```
workspace_id, name text, email citext unique per workspace,
provider text check (provider in ('gmail','outlook')), domain text,
oauth_access_token_encrypted bytea, oauth_refresh_token_encrypted bytea,
oauth_expires_at timestamptz,
voice_samples_jsonb jsonb,    -- array of { subject, body }
voice_samples_indexed_at timestamptz,
daily_send_cap int default 200,
sends_today int default 0, sends_today_reset_at timestamptz
```
Voice samples: 5–10 replied-to emails pasted by the user. Stored verbatim. Injected into the prompt prefix (cached). Not embedded in MVP.

### 5.3 icps
```
workspace_id, name text,
industry text[], role_keywords text[], size_range int4range,
geo text[], exclusions text[], value_prop text,
threshold_default int default 70 check (threshold_default between 0 and 100)
```

### 5.4 prospects
```
workspace_id, sender_id, icp_id,
email citext, first_name text, last_name text, company text, role text,
linkedin_url text, custom_fields_jsonb jsonb,
enrichment_jsonb jsonb, enrichment_fetched_at timestamptz,
enrichment_status text check (status in ('pending','ok','failed','fallback_csv_only'))
```
Unique constraint on `(workspace_id, email)`.

### 5.5 generations
```
prospect_id, sender_id, icp_id,
subject text, body text, model text, prompt_version text,
retry_count int default 0,
status text check (status in (
  'pending','enriching','generating','scoring','needs_review',
  'approved','rejected','flagged','sending','sent','failed')),
overall_score numeric(5,2),
approved_by uuid references auth.users(id), approved_at timestamptz,
last_error text
```
A prospect can have multiple generations across retry attempts. `retry_count` resets to 0 for each new manual run; auto-retries within a run share the same generation chain via `parent_generation_id uuid references generations(id)`.

### 5.6 scores
```
generation_id, judge_name text check (judge_name in (
  'ai_detection','genericness','personalization')),
score numeric(5,2),                -- 0–100
sub_scores_jsonb jsonb,            -- per-axis or per-section breakdown
evidence_jsonb jsonb,              -- top flags, similar matches, grounded refs
judge_version text, scored_at timestamptz
```
One row per judge per generation. UI joins on `generation_id` to render breakdown.

### 5.7 sends
```
generation_id, sender_id,
sent_at timestamptz, send_method text check (in ('gmail','outlook')),
external_message_id text,
error text, status text check (status in ('queued','sent','failed','bounced'))
```

### 5.8 email_corpus
```
source text,                                  -- url / dataset / generator
origin text check (origin in ('ai','human','template')),
model text, vendor text,                      -- only for ai/template
subject text, body text,
embedding_opener vector(1536),
embedding_body vector(1536),
embedding_cta vector(1536),
metadata_jsonb jsonb
```
HNSW indexes on each embedding column. No `workspace_id` — corpus is global.

---

## 6. Corpus bootstrap (one-time before launch)

Script: `scripts/corpus/build.ts`. Outputs to `email_corpus`.

| Bucket | Target | Source | Cost |
|---|---|---|---|
| Synthetic AI | 2,000 | 4 LLMs (Sonnet, GPT-4o, Gemini 1.5, Llama 3.1 70B) × 50 ICP variants × 10 prompt styles | ~$50 |
| Human | 1,000 | r/sales replied-to threads, Twitter/X founder threads, Pavilion archive, Lavender blog samples | scrape time |
| Template | 500 | Public AI SDR vendor demo pages, Apollo/Outreach template galleries, GitHub awesome-sales-templates repos | scrape time |

**Pipeline.** For each email: extract `(subject, body)` → segment into `(opener, body_middle, cta)` via simple regex on first sentence / last paragraph with imperative or question → embed each segment with `text-embedding-3-small` → upsert.

**Quality gate.** Before launch, run `scripts/corpus/validate.ts`:
- ≥1,800 ai rows, ≥900 human rows, ≥400 template rows
- No row with empty `embedding_body`
- Spot-check 50 random rows manually

---

## 7. Generation + eval loop

### 7.1 Inngest functions

```
prospect.uploaded         → enrichProspect()
prospect.enriched         → generateDraft()
generation.created        → scoreFanout()  // parallel 3
scores.complete           → evaluateBlend()
generation.below_threshold→ generateDraft() with feedback
approval.granted          → sendEmail()
```

### 7.2 Generation prompt structure

```
SYSTEM (cached):
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

### 7.3 Regeneration feedback

When `overall_score < threshold`, the next generation call receives:

```
PREVIOUS_DRAFT: <subject + body>
SCORES:
  ai_detection: 62 (was below 70 because opener flagged as "hedging" and "AI rhythm")
  genericness: 81
  personalization: 58 (was below 70: only 1 grounded reference, generic "{company}" token used)
CRITIQUE: <free-form Haiku critique, 2-3 sentences>
INSTRUCTIONS:
  - Rewrite to lift the lowest-scoring dimension first
  - Preserve anything the highest-scoring dimension rewarded
```

Both structured deltas and natural-language critique are included — the handoff says test both, MVP includes both and we tune later.

Max retries: **3**. If still below threshold after 3, set status `flagged` and surface to user with explanation.

### 7.4 Score blend

```
overall = 0.4 × ai_detection + 0.3 × genericness + 0.3 × personalization
```

Threshold defaults to `icps.threshold_default` (70). Per-ICP override supported. No per-judge minimums in MVP — only the blended score gates.

---

## 8. Judges

### 8.1 AI-Detection

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

**Rubric.** Stored in `prompts/judges/ai_detection.md`, versioned. Each axis defines specific tells:
- opener: "I came across", "hope this finds", "I noticed your"
- structure: rigid 3-paragraph rhythm, every email same shape
- hedging: "might be", "could potentially", "I think this could be"
- cta: low-commitment dual-option asks ("worth a quick chat or open to ideas?")
- vocabulary: "leverage", "synergize", "streamline", "robust", "innovative"
- punctuation: em-dash density, semicolon overuse
- rhythm: identical sentence length variance, no fragments

**Calibration target (pre-launch):**
- Mean score on AI corpus: ≤30
- Mean score on human corpus: ≥70
- Overlap (AI rows >50 + human rows <50): <10% of corpus

### 8.2 Genericness

**Method:** pure pgvector cosine similarity.

1. Embed candidate's `(opener, body, cta)` separately
2. For each segment, compute `max(1 - cosine_distance)` against the AI corpus and the template corpus
3. Take the max across segments → `peak_similarity`
4. `score = round(100 × (1 - peak_similarity))`

Score interpretation: **higher = more unique**. Low score = "looks like every other AI SDR email."

Evidence: top 3 most-similar corpus rows with their similarity scores, source, and snippet.

No LLM call in this judge.

### 8.3 Personalization Depth

**Model:** Haiku 4.5
**Input:** body + full enrichment JSON
**Output schema:**
```json
{
  "references": [
    { "snippet": "...", "grounded_in": "enrichment.recent_posts[2]", "specificity": "high|med|low|generic" }
  ],
  "generic_token_hits": ["{company}", "your role at <company>"],
  "grounded_ref_count": int,
  "score": 0-100
}
```
**Scoring rules:**
- Start at 0
- +20 per grounded high-specificity reference (cap 60)
- +10 per grounded med-specificity (cap 20)
- −30 per generic token hit
- −40 if grounded_ref_count == 0
- Floor 0, ceiling 100

Score interpretation: **higher = more personalized**.

---

## 9. Enrichment

**Path A — LinkedIn (preferred):** Apify actor `dev_fusion/linkedin-profile-scraper` with the prospect's `linkedin_url`. Result cached in `prospects.enrichment_jsonb` with `enrichment_status='ok'`. Fields used: headline, about, recent posts (top 5), current role tenure, skills.

**Path B — CSV-only fallback:** If `linkedin_url` is missing or Apify returns nothing within 30s × 2 retries, set `enrichment_status='fallback_csv_only'` and proceed with whatever CSV fields exist. Personalization Depth scores will naturally trend lower; that is acceptable signal.

**Caching.** Re-enrichment is skipped if `enrichment_fetched_at` is within 90 days. Manual refresh button per prospect in UI.

**Cost guardrail.** Apify pay-per-result. Hard monthly cap per workspace tracked in PostHog; surface in UI when 80% consumed.

---

## 10. Onboarding flow — **STRIPPED (v1.2)**

**Bare-MVP form:** single page at `/setup` with three sections, all on one screen:

1. **ICP** — industry (text array), role keywords (text array), value prop (textarea). At least one industry + one role keyword required.
2. **Sender identity** — name, from-email. NO OAuth in the bare MVP; the from-email is used for the email's "From:" line in the copy-paste output only.
3. **Voice samples** — 5–10 `(subject, body)` pairs, persisted as JSONB on `senders.voice_samples_jsonb`.

Workspace auto-created on first sign-in (already implemented in `0002_workspace_autocreate.sql`). The `/setup` page just populates the workspace's ICP and creates the sender row. No multi-step wizard.

**Full wizard (deferred):** the original 4-step linear flow with Gmail/Outlook OAuth as step 2. When send automation is added (re-adding §13), the setup page expands to include the OAuth flow.

---

## 11. Prospect input — **STRIPPED (v1.2)**

**Bare-MVP form:** textarea on the dashboard. One prospect per line in the format:
```
email, first_name, company[, linkedin_url]
```

On submit: parse, dedup against existing prospects in the workspace, insert. Apify enrichment fires per prospect via Inngest (`prospect.uploaded` event), same as the original design. No per-row preview, no file upload widget, no error display beyond a line-count + "N rows imported, M skipped (dupes)" toast.

**CSV upload (deferred):** the original column-validation + 5-row preview + 50k-row cap UI. Re-added if/when alpha testers need batch import. Until then, "paste 50 prospects at a time" works for founder-driven testing.

---

## 12. Approval UI — **STRIPPED (v1.2)**

**Bare-MVP form:** single list view at `/dashboard`, paginated 25/page. Each row:
- Prospect (name, company)
- Subject line
- Body preview (truncated, ~120 chars)
- Overall score, color-coded (green ≥80, yellow 70–79, red <70)
- Status badge

Click a row to expand inline:
- Full email rendered with the sender's name and from-email in a "To: {prospect.email}" header
- Three sub-score bars (AI-Detection, Genericness, Personalization) with raw scores
- **Copy to clipboard** button (copies the body)
- **Approve** button (sets status='approved' — the only effect today is marking the row visually so the user knows they've already copy-pasted it)
- **Reject** button (sets status='rejected')

A separate tab/filter shows flagged generations (`status='flagged'` — the regen loop gave up after 3 retries). Surface the lowest sub-score so the user knows why it failed.

**Deferred until send automation lands (re-adding §13):** per-judge evidence drawer (corpus matches, grounded references highlighted in body), bulk actions, regenerate button, edit-and-approve.

---

## 13. Send flow — **DEFERRED (v1.2)**

No automated sending in the bare MVP. The approval UI renders the email body with a Copy button; the user pastes into Gmail / their mail client manually. Approval just transitions `generations.status` from `needs_review` → `approved`. The `sends` table remains empty.

**Why deferred:** Gmail OAuth + Microsoft Graph + drip + jitter + per-sender concurrency is the largest single chunk of non-eval work in the original plan. The eval-quality question doesn't need it. Re-validating from real-world reply rate is the trigger to add it back.

**Re-add path:** the `senders` table already has `oauth_access_token_encrypted`, `oauth_refresh_token_encrypted`, `oauth_expires_at`, `daily_send_cap`, `sends_today`, `sends_today_reset_at` columns. The `generations.status` enum already includes `sending` and `sent`. The `sends` table exists and is empty. Adding the send flow requires:
- Gmail OAuth flow in the setup page
- An Inngest function on `approval.granted` that handles the send + token refresh + drip
- A daily cron for `sends_today` reset

No schema changes. Estimated 4-5 days of work when we're ready.

---

## 14. Billing — **DEFERRED**

Billing is cut from the bare MVP. The MVP exists to answer one question — "can the eval engine produce cold emails the founders would actually send" — and Stripe + quota metering serves a different question ("can we charge for this") that we only ask once the first is answered yes.

**State of the data model:** the `workspaces` table retains `stripe_customer_id`, `plan`, `monthly_send_quota`, `monthly_sends_used`, `quota_reset_at` columns from the original schema. They are intentionally left in place so that re-adding billing later doesn't require a migration. For now: every workspace gets `plan = 'solo'` and `monthly_send_quota = 999999` at creation; the `send.email` flow does not check or increment these counters.

**When to re-add:** after 3-5 alpha users confirm the eval engine produces emails they'd send. At that point, "what would they pay" becomes a real product question, not a hypothetical.

**Cost-per-send (informational, unchanged):** ~$0.02 per generation (generation + cache + judges + amortized enrichment).

---

## 15. API surface (Next.js App Router)

Server actions handle all mutations. Public route handlers exist only for webhooks and OAuth callbacks.

```
POST  /api/auth/google/callback          OAuth callback (sender connect)
POST  /api/auth/microsoft/callback       OAuth callback
POST  /api/webhooks/inngest              Inngest signature-verified endpoint
GET   /api/prospects/preview-csv         Parse + validate, no insert
```

Server actions (RSC):
```
createWorkspace, updateIcp,
uploadProspects, enqueueGenerate,
approveGenerations, rejectGenerations, regenerate,
revokeOAuth, deleteWorkspace
```

All server actions check `auth.uid()` against `workspaces.owner_id` (or future membership row).

---

## 16. Observability

**Sentry:** server + browser. Tag every event with `workspace_id` when available.

**PostHog events (funnel):**
- `signup`, `workspace_created`
- `sender_connected` (props: provider)
- `icp_completed`, `voice_samples_saved` (props: count)
- `csv_uploaded` (props: row_count)
- `generation_created`, `generation_scored` (props: overall, ai_detection, genericness, personalization)
- `generation_approved`, `generation_rejected`, `generation_flagged`
- `send_succeeded`, `send_failed`
- `checkout_started`, `subscription_active`

**Internal dashboard (post-MVP):** corpus calibration drift over time, mean overall score per ICP, approval rate per ICP, retry distribution.

---

## 17. Security

- **OAuth tokens** encrypted at rest with `pgcrypto.pgp_sym_encrypt` keyed by `OAUTH_TOKEN_KEY` env var (rotated quarterly, dual-key decrypt window)
- **RLS** enforced on every tenant table. Policies verified by `scripts/security/rls-test.ts` (attempts cross-workspace reads, expects 0 rows)
- **Service-role key** never reaches the client; used only in Inngest function handlers and server actions
- **CSRF:** Next.js server actions provide built-in CSRF; webhooks verify signatures (Inngest)
- **Rate limit on public endpoints:** Vercel WAF or Upstash Ratelimit on `/api/webhooks/*` and OAuth callbacks
- **No PII in logs:** Sentry scrubbing rules strip `email`, `body`, `oauth_token*` from breadcrumbs

---

## 18. Testing strategy

**Three test layers, in order of importance:**

1. **Eval calibration tests** (`tests/eval/`). Run the 3 judges over the corpus. Assert:
   - AI-Detection: mean ≤30 on ai rows, ≥70 on human rows
   - Genericness: mean ≤40 on ai rows, ≥60 on human rows (templates score lowest)
   - Personalization: needs synthetic prospect+enrichment pairs; assert grounded refs detected

2. **Integration tests** (`tests/integration/`). Real Supabase test instance:
   - Full loop: upload prospect → generate → score → approve → fake-send
   - Rate limit caps respected
   - Quota enforcement halts at limit
   - OAuth token refresh path

3. **Unit tests** (`tests/unit/`). Pure functions: CSV parser, prompt builder, score blender, segment extractor.

**Smoke test before any deploy:** `npm run smoke` runs one synthetic prospect through the entire loop against staging.

---

## 19. Build sequence (v1.2 bare-MVP)

Each step becomes its own implementation plan.

1. ✅ Supabase + Next.js + Inngest scaffolding + RLS skeleton
2. Corpus generator + scraper + embedder + validator
3. AI-Detection judge + calibration test against corpus
4. Genericness similarity over pgvector — **with positive direction** (closeness-to-human-corpus weighted 0.4)
5. Personalization Depth judge
6. Generation prompt + regeneration loop with feedback injection
7. Setup page (ICP + voice samples + sender identity) — **stripped, single form, no OAuth**
8. Prospect input (textarea paste) + Apify enrichment with CSV-only fallback — **stripped, no file-upload UI**
9. Approval list UI (overall score + body preview + click-to-expand + Copy + Approve/Reject) — **stripped, no per-judge evidence drawer**

Steps 3, 4, 5 are independent and can run in parallel after step 2.

**Cut / deferred (was steps 10–11 in v1):**
- Send flow with Gmail/Outlook OAuth + drip + jitter (§13)
- Stripe Checkout + quota metering (§14)

---

## 20. Cut from MVP

**Cut to focus on "can we generate good cold emails":**
Stripe Checkout · quota metering · pricing tiers · cost-per-send tracking · Gmail/Outlook send automation · drip + jitter rate limiting · `sends` table population · onboarding wizard (replaced with single setup page) · CSV upload UI (replaced with textarea paste) · per-judge evidence drawer in approval UI · bulk approval actions · edit-and-approve · regenerate button on approval rows

**Deferred until first paying customers exist:**
Sequences · reply handling · CRM sync · LinkedIn channel · hallucination eval · ICP-fit eval · reply-likelihood model · vendor scorecards · A/B testing · voice cloning beyond prompt-sampling · SSO · custom rubrics · free tier · public benchmark report · open/click tracking · team membership beyond single owner

---

## 21. Open questions resolved

| Question | Resolution |
|---|---|
| Threshold default | 70/100 overall; `icps.threshold_default` override per ICP |
| Regeneration feedback format | Structured sub-score deltas **and** natural-language critique; test which lifts scores more post-launch |
| Voice sample handling | Few-shot in cached prompt prefix; no fine-tune in MVP |
| Send rate limits | Gmail 500/day, Outlook 1000/day surfaced in UI; configurable `senders.daily_send_cap` (default 200) with drip + jitter |
| LinkedIn enrichment failure | CSV-only fallback path; `enrichment_status='fallback_csv_only'` |
| Auth | Supabase Auth, Google OAuth primary (reuses Gmail scope grant) |
| Multi-tenancy | Workspace-scoped RLS; single-owner for MVP, member table deferred |
| Score blend weights | 0.4 AI-Detection · 0.3 Genericness · 0.3 Personalization |
| Max retries | 3, then `flagged` |
| Subject scoring | Subject scored within AI-Detection `opener` axis |
| Apify actor | `dev_fusion/linkedin-profile-scraper`, 90-day cache |
| Billing / quota enforcement | DEFERRED — see §14. Workspaces default to unlimited send quota in the bare MVP. |
| Email tracking | Out of scope for MVP |

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

`prompts/judges/ai_detection.md`, `prompts/judges/personalization.md` — see §8.

---

## Appendix B — Out-of-the-box decisions for the builder

These are reasonable defaults locked in to avoid stalling. Each is overridable; none are load-bearing on the architecture.

- TypeScript strict mode on
- pnpm for package management
- Drizzle ORM over the raw Supabase client (RLS-aware, easier migrations)
- Inngest local dev via `npx inngest-cli dev`
- ESLint + Prettier with default Next.js config
- Vercel preview deploys per PR
- Single `main` branch, trunk-based; feature branches squash-merge

---

**End of spec.**
