import Sqids from 'sqids'

// Database-related environment variables
export interface DbEnv {
  DB: any
  SQIDS_THREAD_ALPHABET: string
  SQIDS_CHECKPOINT_ALPHABET: string
}

// Helper to get Sqids instance with environment-specific alphabet
function getThreadSqids(env: DbEnv): Sqids {
  return new Sqids({
    alphabet: env.SQIDS_THREAD_ALPHABET,
    minLength: 6,
  })
}

function getCheckpointSqids(env: DbEnv): Sqids {
  return new Sqids({
    alphabet: env.SQIDS_CHECKPOINT_ALPHABET,
    minLength: 6,
  })
}

// Thread ID generation using atomic counters
export async function getNextThreadId(db: any, env: DbEnv): Promise<string> {
  const result = await db
    .prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value')
    .bind('thread_id')
    .first()

  const counter = result?.value || 1
  const sqids = getThreadSqids(env)
  return sqids.encode([counter])
}

// Checkpoint ID generation using atomic counters
export async function getNextCheckpointId(db: any, env: DbEnv): Promise<string> {
  const result = await db
    .prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value')
    .bind('checkpoint_id')
    .first()

  const counter = result?.value || 1
  const sqids = getCheckpointSqids(env)
  return sqids.encode([counter])
}

// Checkpoint ID mapping (Sqid <-> UUID)
export async function storeCheckpointIdMapping(db: any, sqid: string, uuid: string): Promise<void> {
  const now = Date.now()
  await db
    .prepare('INSERT OR IGNORE INTO checkpoint_ids (sqid, uuid, created_at) VALUES (?, ?, ?)')
    .bind(sqid, uuid, now)
    .run()
}

export async function getUuidFromSqid(db: any, sqid: string): Promise<string | null> {
  const result = await db
    .prepare('SELECT uuid FROM checkpoint_ids WHERE sqid = ?')
    .bind(sqid)
    .first()
  return result?.uuid || null
}

export async function getSqidFromUuid(db: any, uuid: string): Promise<string | null> {
  const result = await db
    .prepare('SELECT sqid FROM checkpoint_ids WHERE uuid = ?')
    .bind(uuid)
    .first()
  return result?.sqid || null
}

// Thread management
export async function verifyThreadOwnership(db: any, threadId: string, sessionId: string): Promise<boolean> {
  const result = await db
    .prepare('SELECT session_id FROM threads WHERE id = ?')
    .bind(threadId)
    .first()

  return result?.session_id === sessionId
}

export async function createThread(db: any, threadId: string, sessionId: string): Promise<void> {
  const now = Date.now()
  await db
    .prepare('INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(threadId, sessionId, now, now)
    .run()
}

export async function updateThreadTimestamp(db: any, threadId: string): Promise<void> {
  const now = Date.now()
  await db
    .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
    .bind(now, threadId)
    .run()
}

export async function deleteThread(db: any, threadId: string): Promise<void> {
  await db
    .prepare('DELETE FROM threads WHERE id = ?')
    .bind(threadId)
    .run()
}
