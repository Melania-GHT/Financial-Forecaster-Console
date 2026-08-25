-- Clarity Console by Mel database schema
-- Run this once in Render's PostgreSQL dashboard (or via psql) before first deploy.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_data (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Stores a snapshot of a user's data whenever they click "Start Fresh (New Month)",
-- so that month-over-month history (e.g. Money Tracker trends) survives the reset
-- instead of being permanently lost. One row per user per calendar month; clicking
-- "Start Fresh" more than once in the same month overwrites that month's snapshot
-- rather than creating duplicates.
CREATE TABLE IF NOT EXISTS monthly_snapshots (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_month DATE NOT NULL,
  data JSONB NOT NULL,
  archived_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, snapshot_month)
);
CREATE INDEX IF NOT EXISTS idx_monthly_snapshots_user_month ON monthly_snapshots(user_id, snapshot_month);


-- Session store table (used automatically by connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" ADD CONSTRAINT IF NOT EXISTS "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
