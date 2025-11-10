-- Threads table to associate threads with sessions
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Index for faster session lookups
CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
