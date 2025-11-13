// Usage tracking utilities for daily limit enforcement using D1 atomic operations

export interface UsageStats {
  date: string // YYYY-MM-DD format
  llmCallCount: number
  lastUpdated: number // timestamp
}

/**
 * Get the current date in YYYY-MM-DD format (UTC)
 * Note: We use TEXT type because SQLite doesn't have a native DATE type
 */
function getCurrentDate(): string {
  const now = new Date()
  return now.toISOString().split('T')[0]
}

/**
 * Get usage stats for today
 */
export async function getTodayUsage(db: any): Promise<UsageStats> {
  const today = getCurrentDate()

  const result = await db
    .prepare('SELECT date, llm_call_count, last_updated FROM daily_usage WHERE date = ?')
    .bind(today)
    .first()

  if (!result) {
    // No data for today, return fresh stats
    return {
      date: today,
      llmCallCount: 0,
      lastUpdated: Date.now()
    }
  }

  return {
    date: result.date,
    llmCallCount: result.llm_call_count,
    lastUpdated: result.last_updated
  }
}

/**
 * Atomically increment LLM call counter for today
 */
export async function incrementUsage(db: any): Promise<UsageStats> {
  const today = getCurrentDate()
  const now = Date.now()

  // Atomically increment or insert if doesn't exist
  await db
    .prepare(`
      INSERT INTO daily_usage (date, llm_call_count, last_updated)
      VALUES (?, 1, ?)
      ON CONFLICT(date) DO UPDATE SET
        llm_call_count = llm_call_count + 1,
        last_updated = excluded.last_updated
    `)
    .bind(today, now)
    .run()

  // Get updated stats
  return getTodayUsage(db)
}

/**
 * Check if daily limit has been reached
 */
export async function checkDailyLimit(
  db: any,
  maxLLMCalls?: number
): Promise<{ exceeded: boolean; reason?: string; stats: UsageStats }> {
  const stats = await getTodayUsage(db)

  // Check LLM call limit
  if (maxLLMCalls !== undefined && stats.llmCallCount >= maxLLMCalls) {
    return {
      exceeded: true,
      reason: `Daily LLM call limit of ${maxLLMCalls} exceeded (${stats.llmCallCount} calls today)`,
      stats
    }
  }

  return { exceeded: false, stats }
}
