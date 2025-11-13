-- Counters table for atomic ID generation
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Initialize counters for thread and checkpoint IDs
INSERT OR IGNORE INTO counters (name, value) VALUES ('thread_id', 0);
INSERT OR IGNORE INTO counters (name, value) VALUES ('checkpoint_id', 0);

-- Checkpoint ID mapping table (Sqids to UUID)
CREATE TABLE IF NOT EXISTS checkpoint_ids (
  sqid TEXT PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Index for UUID lookups
CREATE INDEX IF NOT EXISTS idx_checkpoint_uuid ON checkpoint_ids(uuid);

-- Threads table to associate threads with sessions
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Index for faster session lookups
CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);

-- Daily usage tracking table for LLM call limits
CREATE TABLE IF NOT EXISTS daily_usage (
  date TEXT PRIMARY KEY,  -- YYYY-MM-DD format
  llm_call_count INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL
);
