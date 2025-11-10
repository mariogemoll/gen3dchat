// functions/api/[[path]].ts
import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { getCookie, setCookie } from 'hono/cookie'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages'
import { StateGraph, Annotation, messagesStateReducer } from '@langchain/langgraph'
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import { Client } from 'langsmith'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'

interface Env {
  CHAT_HISTORY: any
  DB: any
  OPENAI_API_KEY: string
  LANGCHAIN_TRACING_V2?: string
  LANGCHAIN_API_KEY?: string
  LANGCHAIN_PROJECT?: string
}

// Helper functions for session management
async function getOrCreateSession(c: any): Promise<string> {
  let sessionId = getCookie(c, 'session_id')

  if (!sessionId) {
    sessionId = crypto.randomUUID()
    setCookie(c, 'session_id', sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24,
      path: '/',
    })
  }

  return sessionId
}

async function verifyThreadOwnership(db: any, threadId: string, sessionId: string): Promise<boolean> {
  const result = await db
    .prepare('SELECT session_id FROM threads WHERE id = ?')
    .bind(threadId)
    .first()

  return result?.session_id === sessionId
}

async function createThread(db: any, threadId: string, sessionId: string): Promise<void> {
  const now = Date.now()
  await db
    .prepare('INSERT INTO threads (id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(threadId, sessionId, now, now)
    .run()
}

async function updateThreadTimestamp(db: any, threadId: string): Promise<void> {
  const now = Date.now()
  await db
    .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
    .bind(now, threadId)
    .run()
}

// Custom Cloudflare KV checkpoint saver
class CloudflareKVSaver extends BaseCheckpointSaver {
  constructor(private kv: any) {
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
    const threadId = config.configurable?.thread_id || crypto.randomUUID()
    const checkpointId = checkpoint.id

    // Store checkpoint with its specific ID
    const specificKey = `checkpoint:${threadId}:${checkpointId}`
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

// Define the state for our graph
const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
  }),
})

const app = new Hono<{ Bindings: Env }>().basePath('/api')

app.get('/hello', (c) => c.json({ ok: true, time: new Date().toISOString() }))

app.post('/echo', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json({ you_sent: body })
})

app.post('/threads', async (c) => {
  const { message, threadId } = await c.req.json()

  if (!message) {
    return c.json({ error: 'Message is required' }, 400)
  }

  // Get or create session
  const sessionId = await getOrCreateSession(c)

  // If threadId is provided, verify ownership
  if (threadId) {
    const isOwner = await verifyThreadOwnership(c.env.DB, threadId, sessionId)
    if (!isOwner) {
      return c.json({ error: 'Unauthorized: You do not own this thread' }, 403)
    }
  }

  // Initialize LangSmith client and tracer if tracing enabled
  const langsmithClient = c.env.LANGCHAIN_TRACING_V2 === 'true' && c.env.LANGCHAIN_API_KEY
    ? new Client({
      apiKey: c.env.LANGCHAIN_API_KEY,
      apiUrl: 'https://api.smith.langchain.com',
    })
    : undefined

  const callbacks = langsmithClient
    ? [new LangChainTracer({ projectName: c.env.LANGCHAIN_PROJECT || 'gen3dchat', client: langsmithClient })]
    : []

  // Initialize LLM
  const llm = new ChatOpenAI({
    model: 'gpt-4o-mini',
    apiKey: c.env.OPENAI_API_KEY,
    temperature: 0.7,
  })

  // Create the chatbot node
  const callModel = async (state: typeof StateAnnotation.State) => {
    const systemMessage = {
      role: 'system',
      content: 'You are a helpful AI assistant.',
    }
    const response = await llm.invoke([systemMessage, ...state.messages])
    return { messages: [response] }
  }

  // Build the graph
  const workflow = new StateGraph(StateAnnotation)
    .addNode('chatbot', callModel)
    .addEdge('__start__', 'chatbot')
    .addEdge('chatbot', '__end__')

  // Set up checkpoint saver with KV
  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY)
  const graph = workflow.compile({ checkpointer })

  // Use provided threadId or generate new one
  const currentThreadId = threadId || crypto.randomUUID()

  // Create thread in DB if it's new
  if (!threadId) {
    await createThread(c.env.DB, currentThreadId, sessionId)
  } else {
    await updateThreadTimestamp(c.env.DB, currentThreadId)
  }

  const config: any = {
    configurable: { thread_id: currentThreadId },
    callbacks,
  }

  // Invoke the graph with the user message
  const result = await graph.invoke({ messages: [new HumanMessage(message)] }, config)

  // Extract the last message (AI response)
  const lastMessage = result.messages[result.messages.length - 1]
  const response = lastMessage.content

  // Get the checkpoint ID from the saved checkpoint
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: currentThreadId } })
  const currentCheckpointId = tuple?.checkpoint?.id || crypto.randomUUID()

  // Explicitly wait for LangSmith client to flush
  if (langsmithClient) {
    await langsmithClient.awaitPendingTraceBatches?.()
  }

  return c.json({
    response,
    threadId: currentThreadId,
    checkpointId: currentCheckpointId,
    messageCount: result.messages.length,
  })
})

app.get('/threads/:threadId/:checkpointId', async (c) => {
  const threadId = c.req.param('threadId')
  const checkpointId = c.req.param('checkpointId')

  // Get session and check ownership
  const sessionId = await getOrCreateSession(c)
  const isOwner = await verifyThreadOwnership(c.env.DB, threadId, sessionId)

  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY)
  const tuple = await checkpointer.getCheckpointById(threadId, checkpointId)

  if (!tuple) {
    return c.json({ error: 'Checkpoint not found' }, 404)
  }

  // Add ownership header
  c.header('X-Thread-Owner', isOwner ? 'true' : 'false')

  return c.json({
    threadId,
    checkpointId,
    checkpoint: tuple.checkpoint,
    metadata: tuple.metadata,
  })
})

app.delete('/threads/:threadId', async (c) => {
  const threadId = c.req.param('threadId')

  // Get session and verify ownership
  const sessionId = await getOrCreateSession(c)
  const isOwner = await verifyThreadOwnership(c.env.DB, threadId, sessionId)

  if (!isOwner) {
    return c.json({ error: 'Unauthorized: You do not own this thread' }, 403)
  }

  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY)
  await checkpointer.deleteThread(threadId)

  // Also delete from DB
  await c.env.DB
    .prepare('DELETE FROM threads WHERE id = ?')
    .bind(threadId)
    .run()

  return c.json({ ok: true, message: 'Thread cleared' })
})

export const onRequest = handle(app)