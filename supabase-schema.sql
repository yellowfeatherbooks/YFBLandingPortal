-- ============================================================
--  Yellow Feather Books — Supabase Schema
--  Generated from production database (tkulpytgguzdqvusyhwe)
--  Run this in the Supabase SQL Editor of a fresh project.
-- ============================================================

-- ── admins ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text,
  password_hash text NOT NULL,
  salt          text NOT NULL,
  created_at    timestamptz DEFAULT now()
);

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text UNIQUE NOT NULL,
  name                text NOT NULL,
  password_hash       text NOT NULL,
  salt                text NOT NULL,
  reset_token         text,
  reset_token_expiry  timestamptz,
  registered_at       timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now(),
  phone               text,
  roles               text[] DEFAULT '{}',
  marketing_consent   boolean DEFAULT true
);

-- ── subscriptions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text UNIQUE NOT NULL,
  plan_name        text,
  subscription_id  text,
  status           text DEFAULT 'active',
  subscribed_date  timestamptz DEFAULT now(),
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  access_until     timestamptz,
  extra_quota      int DEFAULT 0
);

-- ── submissions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text,
  author          text,
  publisher       text,
  category        text,
  genre           text,
  mrp             numeric,
  price           numeric,
  status          text DEFAULT 'under_review',
  submitted_date  timestamptz DEFAULT now(),
  submitted_by    text,
  shopify_id      text,
  created_at      timestamptz DEFAULT now(),
  subscription_id text
);
CREATE INDEX IF NOT EXISTS submissions_submitted_by_idx ON submissions(submitted_by);

-- ── book_club_members ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS book_club_members (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text UNIQUE NOT NULL,
  name                 text,
  phone                text,
  razorpay_payment_id  text,
  razorpay_order_id    text,
  shopify_created      boolean DEFAULT false,
  joined_at            timestamptz DEFAULT now(),
  plan                 text NOT NULL DEFAULT 'Annual Membership',
  valid_until          timestamptz,
  marketing_consent    boolean DEFAULT true
);

-- ── book_requests ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS book_requests (
  id           bigserial PRIMARY KEY,
  name         text,
  email        text,
  phone        text,
  book_title   text NOT NULL,
  author_name  text,
  publisher    text,
  year         text,
  notes        text,
  requested_at timestamptz DEFAULT now(),
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── signed_copy_requests ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS signed_copy_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_email  text NOT NULL,
  member_name   text,
  book_title    text NOT NULL,
  author_name   text,
  notes         text,
  requested_at  timestamptz DEFAULT now(),
  status        text DEFAULT 'pending',
  created_at    timestamptz DEFAULT now()
);

-- ── complaints ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaints (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  phone         text,
  order_number  text,
  category      text NOT NULL DEFAULT 'Other',
  subject       text NOT NULL,
  message       text NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  resolution    text,
  resolved_by   text,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaints_email_idx      ON complaints(email);
CREATE INDEX IF NOT EXISTS complaints_status_idx     ON complaints(status);
CREATE INDEX IF NOT EXISTS complaints_created_at_idx ON complaints(created_at DESC);

-- ── book_recommendations ───────────────────────────────────────
-- Caches AI-picked "Readers Also Loved" handles per book to avoid
-- calling Claude on every single book-modal open.
CREATE TABLE IF NOT EXISTS book_recommendations (
  handle              text PRIMARY KEY,
  recommended_handles jsonb NOT NULL DEFAULT '[]',
  generated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── member_sessions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_sessions (
  email      text PRIMARY KEY,
  cart_id    text,
  wishlist   jsonb DEFAULT '[]',
  updated_at timestamptz DEFAULT now()
);

-- ── search_logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_logs (
  id                   bigserial PRIMARY KEY,
  searched_at          timestamptz DEFAULT now(),
  prompt               text,
  search_query         text,
  explanation          text,
  results_count        int,
  shopify_match        boolean DEFAULT false,
  has_results          boolean DEFAULT true,
  claude_input_tokens  int,
  claude_output_tokens int,
  claude_cost_usd      numeric,
  serper_calls         int DEFAULT 1,
  serper_cost_usd      numeric,
  total_cost_usd       numeric
);

-- ── site_config ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);

-- ── Seed: flash sale default (off) ───────────────────────────
INSERT INTO site_config (key, value)
VALUES ('flash_sale', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Seed: featured books default (empty) ─────────────────────
INSERT INTO site_config (key, value)
VALUES ('featured_books', '{"books":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── wa_campaign_blacklist ──────────────────────────────────

-- ── wa_campaign_blacklist ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_campaign_blacklist (
  id              serial PRIMARY KEY,
  phone           text UNIQUE NOT NULL,
  email           text,
  name            text,
  reason          text,
  blacklisted_at  timestamptz DEFAULT now(),
  blacklisted_by  text
);
