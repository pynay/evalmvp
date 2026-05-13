import {
  pgTable, uuid, text, timestamp, integer, jsonb, numeric, customType,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Custom types Drizzle doesn't ship natively
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

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
