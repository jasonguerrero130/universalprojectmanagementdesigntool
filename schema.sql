-- D1 schema for Project Blueprint Designer, running on Cloudflare Pages.
--
-- How to run this: after creating your D1 database (see SETUP.md Step 1),
-- run from your project folder:
--   npx wrangler d1 execute blueprint-designer-db --remote --file=./schema.sql
--
-- Note: D1 is SQLite, not Postgres — that's why this looks different from
-- the earlier Supabase version (no "timestamp with time zone" type, dates
-- are stored as ISO text strings instead).
--
-- Also note: D1 has no Row Level Security concept, because it isn't exposed
-- as a public API the way Supabase is — only your own Pages Functions (via
-- the "DB" binding in wrangler.toml) can ever touch this database at all.
-- There's no separate access-control step needed for that reason.

CREATE TABLE IF NOT EXISTS anon_usage (
  anon_id TEXT PRIMARY KEY,
  generation_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'free', -- 'free' | 'active'
  access_expires_at TEXT,                            -- ISO date string; when paid access ends
  created_at TEXT DEFAULT (datetime('now'))
);
