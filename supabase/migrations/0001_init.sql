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
