import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import {
  getNextThreadId,
  getNextCheckpointId,
  storeCheckpointIdMapping,
  type DbEnv,
} from './db'

// Custom Cloudflare KV checkpoint saver
export class CloudflareKVSaver extends BaseCheckpointSaver {
  constructor(private kv: any, private db: any, private env: DbEnv) {
    super()
  }

  async getTuple(config: { configurable?: { thread_id: string } }): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id
    if (!threadId) return undefined

    const key = `checkpoint:${threadId}:latest`
    const data = await this.kv.get(key, 'json') as CheckpointTuple | null
    return data || undefined
  }

  async getCheckpointById(threadId: string, checkpointId: string): Promise<CheckpointTuple | undefined> {
    const key = `checkpoint:${threadId}:${checkpointId}`
    const data = await this.kv.get(key, 'json') as CheckpointTuple | null
    return data || undefined
  }

  async *list(config: { configurable?: { thread_id: string } }) {
    const tuple = await this.getTuple(config)
    if (tuple) {
      yield tuple
    }
  }

  async put(config: { configurable?: { thread_id: string } }, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<{ configurable: { thread_id: string } }> {
    const threadId = config.configurable?.thread_id || await getNextThreadId(this.db, this.env)
    const checkpointUuid = checkpoint.id

    // Generate Sqids checkpoint ID and store the mapping
    const checkpointSqid = await getNextCheckpointId(this.db, this.env)
    await storeCheckpointIdMapping(this.db, checkpointSqid, checkpointUuid)

    // Store checkpoint with UUID (LangGraph's internal ID)
    const specificKey = `checkpoint:${threadId}:${checkpointUuid}`
    // Also store as latest
    const latestKey = `checkpoint:${threadId}:latest`

    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: threadId } },
      checkpoint,
      metadata,
      parentConfig: config.configurable?.thread_id ? config : undefined,
    }

    // Store both the specific checkpoint and update latest
    await Promise.all([
      this.kv.put(specificKey, JSON.stringify(tuple)),
      this.kv.put(latestKey, JSON.stringify(tuple))
    ])

    return { configurable: { thread_id: threadId } }
  }

  async putWrites(config: { configurable?: { thread_id: string } }, writes: any[], taskId: string): Promise<void> {
    // Not needed for basic implementation
  }

  async deleteThread(threadId: string): Promise<void> {
    // Note: This only deletes the latest checkpoint
    // In a production system, you'd want to list and delete all checkpoints for this thread
    await this.kv.delete(`checkpoint:${threadId}:latest`)
  }
}
