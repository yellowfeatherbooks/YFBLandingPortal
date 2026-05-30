-- ============================================================
--  Yellow Feather Books — Supabase Schema
--  Run this in the Supabase SQL Editor of a fresh project
--  to recreate all tables used by the Netlify functions.
-- ============================================================

-- ── admins ───────────────────────────────────────────────────
-- Admin accounts for the portal dashboard
CREATE TABLE IF NOT EXISTS admins (
  id            bigserial PRIMARY KEY,
  email         text UNIQUE NOT NULL,
  name          text,
  password_hash text NOT NULL,
  salt          text NOT NULL,
  created_at    timestamptz DEFAULT now()
);

-- ── users ────────────────────────────────────────────────────
-- Registered author accounts
CREATE TABLE IF NOT EXISTS users (
  id                 bigserial PRIMARY KEY,
  email              text UNIQUE NOT NULL,
  name               text NOT NULL,
  phone              text,
  password_hash      text NOT NULL,
  salt               text NOT NULL,
  roles              text[]    DEFAULT ARRAY['author'],
  marketing_consent  boolean   DEFAULT true,
  shopify_customer_id text,
  created_at         timestamptz DEFAULT now()
);

-- ── subscriptions ────────────────────────────────────────────
-- Author portal subscriptions (Razorpay)
CREATE TABLE IF NOT EXISTS subscriptions (
  id               bigserial PRIMARY KEY,
  email            text UNIQUE NOT NULL,
  plan_name        text NOT NULL,           -- Starter | Growth | Publisher
  subscription_id  text,                    -- Razorpay sub_XXXX
  status           text DEFAULT 'active',   -- active | cancelling | cancelled
  access_until     timestamptz,             -- set when cancelling; null when active
  extra_quota      int  DEFAULT 0,
  subscribed_date  timestamptz DEFAULT now(),
  created_at       timestamptz DEFAULT now()
);

-- ── submissions ──────────────────────────────────────────────
-- Book submissions made via the author portal
CREATE TABLE IF NOT EXISTS submissions (
  id              bigserial PRIMARY KEY,
  title           text NOT NULL,
  author          text,
  publisher       text,
  genre           text,
  mrp             numeric(10,2),
  status          text DEFAULT 'under_review', -- under_review | active | rejected
  submitted_date  timestamptz DEFAULT now(),
  submitted_by    text,                         -- author email
  shopify_id      text,                         -- Shopify product numeric ID
  description     text,
  barcode         text,
  phone           text,
  cover_url       text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submissions_submitted_by_idx ON submissions(submitted_by);

-- ── book_club_members ─────────────────────────────────────────
-- Book club memberships (Razorpay one-time payment)
CREATE TABLE IF NOT EXISTS book_club_members (
  id                   bigserial PRIMARY KEY,
  email                text UNIQUE NOT NULL,
  name                 text NOT NULL,
  phone                text,
  plan                 text DEFAULT 'Annual Membership',
  razorpay_payment_id  text,
  razorpay_order_id    text,
  marketing_consent    boolean DEFAULT true,
  joined_at            timestamptz DEFAULT now(),
  valid_until          timestamptz
);

-- ── book_requests ─────────────────────────────────────────────
-- Reader requests for books not yet in the store
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
  status       text DEFAULT 'pending',  -- pending | fulfilled | rejected
  created_at   timestamptz DEFAULT now()
);

-- ── signed_copy_requests ──────────────────────────────────────
-- Book club member requests for signed copies
CREATE TABLE IF NOT EXISTS signed_copy_requests (
  id            bigserial PRIMARY KEY,
  member_email  text,
  member_name   text,
  book_title    text NOT NULL,
  author_name   text,
  notes         text,
  status        text DEFAULT 'pending',  -- pending | fulfilled | rejected
  created_at    timestamptz DEFAULT now()
);

-- ── member_sessions ───────────────────────────────────────────
-- Persisted cart / wishlist for logged-in book club members
CREATE TABLE IF NOT EXISTS member_sessions (
  id         bigserial PRIMARY KEY,
  email      text UNIQUE NOT NULL,
  cart_id    text,
  wishlist   jsonb DEFAULT '[]',
  updated_at timestamptz DEFAULT now()
);

-- ── search_logs ───────────────────────────────────────────────
-- AI book-search query log
CREATE TABLE IF NOT EXISTS search_logs (
  id            bigserial PRIMARY KEY,
  prompt        text,
  search_query  text,
  results_count int,
  has_results   boolean,
  created_at    timestamptz DEFAULT now()
);

-- ── site_config ───────────────────────────────────────────────
-- Key/value store for site-wide settings (e.g. flash_sale)
CREATE TABLE IF NOT EXISTS site_config (
  key        text PRIMARY KEY,
  value      jsonb,
  updated_at timestamptz DEFAULT now()
);

-- ── Seed: flash sale default (off) ───────────────────────────
INSERT INTO site_config (key, value)
VALUES ('flash_sale', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
--  Row Level Security
--  The functions use the service-role key (bypasses RLS) for
--  writes and the anon key for reads — enable RLS and open
--  SELECT only where needed, or leave disabled for test env.
-- ============================================================
-- ALTER TABLE subscriptions  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE submissions     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
-- (etc — configure policies to match production when needed)
