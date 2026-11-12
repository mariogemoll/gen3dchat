import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  getNextThreadId,
  type DbEnv,
} from './db'

// Custom Cloudflare KV checkpoint saver
export class CloudflareKVSaver extends BaseCheckpointSaver {
  constructor(private kv: any, private db: any, private env: DbEnv) {
    super()
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id
    if (!threadId) return undefined

    const checkpointId = config.configurable?.checkpoint_id || 'latest'
    const key = `checkpoint:${threadId}:${checkpointId}`
    const data: string | null = await this.kv.get(key, 'text')
    if (!data) return undefined
    const tuple: CheckpointTuple = await this.serde.loadsTyped('json', data)
    return {
      ...tuple,
      config: { configurable: { thread_id: threadId, checkpoint_id: tuple.checkpoint.id } },
      // Older checkpoints stored a parent without an ID, which would point back to latest forever.
      parentConfig: tuple.parentConfig?.configurable?.checkpoint_id ? tuple.parentConfig : undefined,
    }
  }

  async getCheckpointById(threadId: string, checkpointId: string): Promise<CheckpointTuple | undefined> {
    return this.getTuple({ configurable: { thread_id: threadId, checkpoint_id: checkpointId } })
  }

  async *list(config: RunnableConfig) {
    const tuple = await this.getTuple(config)
    if (tuple) {
      yield tuple
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id || await getNextThreadId(this.db, this.env)
    const checkpointUuid = checkpoint.id

    // Store checkpoint with UUID (LangGraph's internal ID)
    const specificKey = `checkpoint:${threadId}:${checkpointUuid}`
    // Also store as latest
    const latestKey = `checkpoint:${threadId}:latest`

    const checkpointConfig = { configurable: { thread_id: threadId, checkpoint_id: checkpointUuid } }
    const tuple: CheckpointTuple = {
      config: checkpointConfig,
      checkpoint,
      metadata,
      parentConfig: config.configurable?.checkpoint_id ? config : undefined,
    }

    // LangGraph's serializer preserves undefined channel values, unlike JSON.stringify.
    const [, serialized] = await this.serde.dumpsTyped(tuple)
    const value = new TextDecoder().decode(serialized)

    // Store both the specific checkpoint and update latest
    await Promise.all([
      this.kv.put(specificKey, value),
      this.kv.put(latestKey, value)
    ])

    return checkpointConfig
  }

  async putWrites(config: RunnableConfig, writes: any[], taskId: string): Promise<void> {
    // Not needed for basic implementation
  }

  async deleteThread(threadId: string): Promise<void> {
    // Note: This only deletes the latest checkpoint
    // In a production system, you'd want to list and delete all checkpoints for this thread
    await this.kv.delete(`checkpoint:${threadId}:latest`)
  }
}
