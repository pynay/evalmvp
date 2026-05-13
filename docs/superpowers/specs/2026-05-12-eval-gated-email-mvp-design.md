# Eval-Gated Email Generation MVP — System Spec

**Status:** Design v1.1 (bare-MVP scope, no billing)
**Source:** `handoff.md` (initial commit 829090f)
**Last updated:** 2026-05-13

> **v1.1 scope cuts** (from v1, dated 2026-05-13):
> - **Stripe billing + quota metering removed** (§14, §20). The MVP exists to answer "can the eval engine produce cold emails the founders would actually send." Billing is deferred until that question is answered yes.
> - **Genericness judge gains a positive direction** (§8.2 — TBD when Step 4 lands): in addition to `distance from AI+template corpora`, score `closeness to human corpus` with a 0.4 weight. Addresses the "unique but bad" failure mode.

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

## 10. Onboarding flow

Single linear wizard, 4 steps, persistent state in `workspaces` row:

1. **Workspace.** Name. Auto-created on first sign-in if absent.
2. **Connect sender.** Google or Microsoft OAuth. Required scopes: `gmail.send` (Gmail) or `Mail.Send` (Graph). Refresh token stored encrypted.
3. **Define ICP.** Form fields per §5.3. At least one industry and one role keyword required.
4. **Voice samples.** Textarea pairs (subject + body) ×5 minimum, 10 maximum. Persisted as JSONB on `senders`.

Wizard cannot be skipped; CSV upload route returns user here if any step incomplete.

---

## 11. CSV upload

**Required columns:** `email`, `first_name`, `company`
**Optional:** `last_name`, `role`, `linkedin_url`
**Custom:** any column prefixed `custom_` is preserved in `custom_fields_jsonb`

**Validation (client-side preview before insert):**
- Email regex + dedupe within file
- Reject rows with empty required cols, show line numbers
- Cap: 5,000 rows per upload (Solo plan), 50,000 (Team)
- Show 5-row preview with parsed fields before commit

On commit: bulk insert prospects, then emit one `prospect.uploaded` event per row.

---

## 12. Approval UI

Single table view, paginated 50/page. Columns:
- Checkbox (bulk approve)
- Prospect (name, company, role)
- Subject + body preview (truncated, click to expand)
- Overall score (color-coded: green ≥80, yellow 70–79, red <70)
- Sub-scores (3 mini bars: ai-detection, genericness, personalization)
- Status badge

**Expanded row drawer:**
- Full email rendered as it will send
- Per-judge breakdown with axis scores and red flags
- Evidence: for genericness, similar corpus matches with snippets; for personalization, grounded references highlighted in body
- Regenerate button (manual retry, counts against quota)
- Edit-and-approve (small inline edits don't re-score)
- Reject button (sets status=rejected, no send)

Bulk actions: Approve all visible, Reject all visible, Approve all with score ≥X.

Flagged generations (after 3 failed retries) appear in a separate tab with the lowest sub-score surfaced so the user knows why.

---

## 13. Send flow

**Trigger:** user approval (single or bulk) emits `approval.granted` event.

**Rate limiting:** per `senders.daily_send_cap` (default 200, max 500 Gmail / 1000 Outlook). Inngest concurrency key `sender:{id}` with throttle. Drip schedule: sends staggered with random jitter 30–180 seconds between sends per sender.

**Send path:**
- Gmail: `users.messages.send` with raw RFC822
- Outlook: `users/me/sendMail` with JSON payload
- Capture `external_message_id` into `sends` row
- On 401: refresh OAuth token, retry once
- On 429: backoff per provider docs, mark `failed` after 3 retries

**Daily counter reset:** Inngest cron at sender's local midnight (or UTC for MVP) resets `sends_today`.

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

## 19. Build sequence

Each step below becomes its own implementation plan (via `writing-plans` skill).

1. Supabase project + Next.js + Inngest scaffolding + RLS skeleton
2. Corpus generator + scraper + embedder + validator
3. AI-Detection judge + calibration test against corpus
4. Genericness similarity over pgvector
5. Personalization Depth judge
6. Generation prompt + regeneration loop with feedback injection
7. Onboarding wizard (workspace → sender OAuth → ICP → voice samples)
8. Prospect CSV upload + parser + Apify enrichment with fallback
9. Approval table UI with per-email score breakdown and evidence
10. Gmail/Outlook send flow with drip + jitter rate limiting

Steps 3, 4, 5 are independent and can run in parallel after step 2.

---

## 20. Cut from MVP (defer until customers ask)

**Cut to focus on the eval-quality question:**
Stripe Checkout · quota metering · pricing tiers · cost-per-send tracking

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
