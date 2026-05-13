# Handoff — Eval-Gated Email Generation MVP

## What we're building
A web app that generates cold emails one prospect at a time, scores each draft with an eval engine, and regenerates until the draft clears a quality threshold. The user reviews, approves, and sends via their own Gmail/Outlook.

The differentiator is the eval-gated loop: every send is provably above a quality bar. Competitors (Artisan, 11x, Regie, Cardinal) generate but do not score before sending.

## Constraints
- Two-person team
- Generation is the core product, not optional
- No timelines committed
- Ship when output quality is something we would send ourselves

## End-to-end flow
1. User onboards: connects Gmail/Outlook, defines ICP (industry, role, size, geo, value prop), pastes 5–10 replied-to emails as voice samples
2. Uploads a prospect CSV (email, name, company, role, linkedin_url, optional custom fields)
3. For each prospect, the system enriches → generates → scores → regenerates if below threshold → queues for approval
4. User reviews the approval table with per-email score breakdown and evidence highlights
5. Approved emails send through the user's connected mailbox

## The generation + eval loop
```
enrich (LinkedIn via Apify + CSV fields)
  → generate draft (Claude Sonnet 4.6, voice-sampled, prospect-specific)
  → score in parallel:
      - AI-Detection (Haiku judge with rubric)
      - Genericness (pgvector cosine similarity vs corpus)
      - Personalization Depth (Haiku judge over enrichment context)
  → overall score = weighted blend
  → if score >= threshold: queue for approval
  → else: regenerate with feedback ("previous draft scored low on X because Y"), max 3 retries
  → if still below threshold after 3: flag for manual review
```

## Judges (V1, three only)

**AI-Detection.** LLM judge (Haiku) scores 0–100 across 7 axes: opener, structure, hedging, CTA, vocabulary, punctuation, rhythm. Returns top 3 red flags. Calibrated against the synthetic AI corpus (should score AI-ish) and human corpus (should score human-ish).

**Genericness.** Embed opener, body, CTA separately. Run pgvector cosine similarity against the AI + template corpora. Score = inverse of max similarity. Low score = "this looks like every other AI SDR email."

**Personalization Depth.** LLM judge over the enrichment context. Counts prospect-specific references, verifies they are grounded in enrichment data, and rejects generic personalization tokens ("noticed your role at {company}").

Hallucination, ICP-Fit, and Reply-Likelihood judges are deferred until after first paying customers.

## Corpus to bootstrap (one-time, before launch)
- 2,000 synthetic AI emails — 4 LLMs × ICP variants × prompt styles (~$50 in API spend)
- 1,000 human emails — scraped from r/sales, Twitter threads, Pavilion, Lavender blog
- 500 template emails — public AI SDR vendor demos and template galleries

All embedded with OpenAI text-embedding-3-small, stored in pgvector with separate columns for opener, body, and CTA embeddings.

## Stack
- **Frontend + API:** Next.js on Vercel
- **DB + auth:** Supabase (Postgres + pgvector + auth)
- **Queue:** Inngest (fan-out for parallel judge calls)
- **Generation model:** Claude Sonnet 4.6 with prompt caching on voice samples and ICP context
- **Judge model:** Claude Haiku 4.5
- **Embeddings:** OpenAI text-embedding-3-small
- **Send:** Gmail API (OAuth) + Microsoft Graph (Outlook OAuth)
- **Enrichment:** Apify for LinkedIn scrape
- **Billing:** Stripe Checkout
- **Observability:** Sentry + PostHog

## Data model (8 tables)
```
workspaces          id, name, owner_id, created_at
senders             workspace_id, name, email, domain, oauth_token, voice_samples_indexed
icps                workspace_id, industry, role_keywords, size_range, geo,
                    exclusions, value_prop, threshold_default
prospects           workspace_id, email, first_name, last_name, company, role,
                    linkedin_url, custom_fields_jsonb, enrichment_jsonb,
                    enrichment_fetched_at
generations         prospect_id, sender_id, icp_id, subject, body, model,
                    prompt_version, retry_count, status, approved_by, approved_at
scores              generation_id, judge_name, score, sub_scores_jsonb,
                    evidence_jsonb, judge_version, scored_at
sends               generation_id, sender_id, sent_at, send_method,
                    external_message_id
email_corpus        source, origin (ai|human|template), model, vendor, body,
                    subject, embedding_opener, embedding_body, embedding_cta,
                    metadata_jsonb
```

## Build sequence
1. Supabase project + Next.js + Inngest scaffolding
2. Corpus generator script (synthetic + scraped + templates) → embed → load into pgvector
3. AI-Detection judge + calibration test against corpus
4. Genericness similarity over pgvector
5. Personalization Depth judge
6. Generation prompt + regeneration loop with feedback injection
7. Onboarding flow (workspace → sender OAuth → ICP → voice samples)
8. Prospect CSV upload + parser + Apify enrichment
9. Approval table UI with per-email score breakdown
10. Gmail/Outlook send flow
11. Stripe Checkout for two tiers

## Pricing
- Solo: $300/mo — 2,000 emails, 1 sender
- Team: $1,500/mo — 15,000 emails, 5 senders
- Cost per send ~$0.02 (generation + scoring). Gross margin ~85%.

## Cut from MVP (defer until customers ask)
Sequences · reply handling · CRM sync · LinkedIn channel · hallucination eval · ICP-fit eval · reply-likelihood model · vendor scorecards · A/B testing · voice cloning beyond prompt-sampling · SSO · custom rubrics · free tier · public benchmark report

## The bet
Eval-gated regeneration produces measurably better output than Artisan/11x/Cardinal at the same price. The eval engine is also the moat: once we have the corpus and calibrated judges, "good cold email" becomes a measurable thing we can credibly claim and prove.

## Success metric
5 paying customers actively running campaigns and renewing into month two.

## Open questions for the builder
- Threshold default: start at 70/100 overall, tune per ICP based on early customer data
- Regeneration feedback format: structured (sub-score deltas) vs natural language critique — test both
- Voice sample handling: inject as few-shot examples in prompt vs fine-tune (MVP = prompt only)
- Send rate limits: Gmail caps at 500/day per user, Outlook ~1000/day — surface this in UI
- LinkedIn URL enrichment failure rate is high; have a fallback path that generates from CSV fields only
