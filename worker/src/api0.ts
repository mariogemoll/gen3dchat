import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { HumanMessage } from '@langchain/core/messages'
import { checkDailyLimit } from './usage-tracker'
import {
  createAgent,
  createLangSmithCallbacks,
  flushLangSmithTraces,
  preValidateUserCode,
  type AgentEnv,
} from './agent0'
import { CloudflareKVSaver } from './kv'
import {
  createThread,
  deleteThread,
  getNextThreadId,
  getSqidFromUuid,
  getUuidFromSqid,
  updateThreadTimestamp,
  verifyThreadOwnership,
} from './db'

interface Env extends AgentEnv {
  DAILY_LLM_CALL_LIMIT?: string
}

// Validate required environment variables
function validateEnv(env: Env): void {
  const required = [
    'ANTHROPIC_API_KEY',
    'SQIDS_THREAD_ALPHABET',
    'SQIDS_CHECKPOINT_ALPHABET',
    'SYSTEM_PROMPT',
  ]

  const missing: string[] = []

  for (const key of required) {
    if (!env[key as keyof Env]) {
      missing.push(key)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      `Please set them in Cloudflare Dashboard: Workers & Pages > Settings > Environment variables`
    )
  }

  // Validate Sqids alphabets have enough characters
  if (env.SQIDS_THREAD_ALPHABET.length < 3) {
    throw new Error('SQIDS_THREAD_ALPHABET must be at least 3 characters long')
  }

  if (env.SQIDS_CHECKPOINT_ALPHABET.length < 3) {
    throw new Error('SQIDS_CHECKPOINT_ALPHABET must be at least 3 characters long')
  }
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

const app = new Hono<{ Bindings: Env }>()

// Middleware to validate environment on first request
app.use('*', async (c, next) => {
  validateEnv(c.env)
  await next()
})

// Middleware to check daily LLM call limits on API routes
app.use('/_/*', async (c, next) => {
  // Parse limit from environment variable
  const maxLLMCalls = c.env.DAILY_LLM_CALL_LIMIT ? parseInt(c.env.DAILY_LLM_CALL_LIMIT, 10) : undefined

  // Check if limit is configured
  if (maxLLMCalls !== undefined) {
    const limitCheck = await checkDailyLimit(c.env.DB, maxLLMCalls)

    if (limitCheck.exceeded) {
      return c.json({
        error: 'Daily limit reached',
        message: 'The daily resource limit has been reached. Please try again tomorrow.'
      }, 429) // 429 Too Many Requests
    }
  }

  await next()
})

app.get('/_/hello', (c) => c.json({ ok: true, time: new Date().toISOString() }))

app.post('/_/echo', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json({ you_sent: body })
})

app.post('/_/threads', async (c) => {
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

  // Initialize LangSmith callbacks
  const callbacks = createLangSmithCallbacks(c.env)

  // Set up checkpoint saver with KV
  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY, c.env.DB, c.env)

  // Create the agent graph
  const graph = createAgent(c.env, checkpointer)

  // Use provided threadId or generate new one
  const currentThreadId = threadId || await getNextThreadId(c.env.DB, c.env)

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

  // Pre-validate user code updates before invoking the graph
  const isCodeUpdate = message.includes('```')
  if (isCodeUpdate) {
    const validation = await preValidateUserCode(message, c.env.JSCAD_VALIDATION_SERVICE_URL)

    if (!validation.valid) {
      // Return error immediately without creating a checkpoint
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: currentThreadId } })
      const currentCheckpointUuid = tuple?.checkpoint?.id || crypto.randomUUID()
      const currentCheckpointSqid = await getSqidFromUuid(c.env.DB, currentCheckpointUuid) || currentCheckpointUuid

      const messages = tuple?.checkpoint?.channel_values?.messages as any[] || []
      const previousCode = tuple?.checkpoint?.channel_values?.currentCode as string || ''

      return c.json({
        response: `Validation error: ${validation.error}`,
        threadId: currentThreadId,
        checkpointId: currentCheckpointSqid,
        messageCount: messages.length,
        currentCode: previousCode,
        validationRetries: 1,
      })
    }
  }

  // Invoke the graph with the user message
  const result: any = await graph.invoke({ messages: [new HumanMessage(message)] } as any, config)

  // Extract the last message (AI response)
  const lastMessage = result.messages[result.messages.length - 1]
  const response = lastMessage?.content || ''

  // Get the checkpoint ID from the saved checkpoint
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: currentThreadId } })
  const currentCheckpointUuid = tuple?.checkpoint?.id || crypto.randomUUID()
  const currentCheckpointSqid = await getSqidFromUuid(c.env.DB, currentCheckpointUuid) || currentCheckpointUuid

  // Flush LangSmith traces
  await flushLangSmithTraces(c.env)

  return c.json({
    response,
    threadId: currentThreadId,
    checkpointId: currentCheckpointSqid,
    messageCount: result.messages.length,
    currentCode: result.currentCode || '',
    validationRetries: result.validationRetries || 0,
  })
})

app.get('/_/threads/:threadId/:checkpointId', async (c) => {
  const threadId = c.req.param('threadId')
  const checkpointSqid = c.req.param('checkpointId')

  // Try to resolve Sqid to UUID, if it fails assume it's already a UUID
  const checkpointUuid = await getUuidFromSqid(c.env.DB, checkpointSqid) || checkpointSqid

  // Get session and check ownership
  const sessionId = await getOrCreateSession(c)
  const isOwner = await verifyThreadOwnership(c.env.DB, threadId, sessionId)

  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY, c.env.DB, c.env)
  const tuple = await checkpointer.getCheckpointById(threadId, checkpointUuid)

  if (!tuple) {
    return c.json({ error: 'Checkpoint not found' }, 404)
  }

  // Add ownership header
  c.header('X-Thread-Owner', isOwner ? 'true' : 'false')

  return c.json({
    threadId,
    checkpointId: checkpointSqid,
    checkpoint: tuple.checkpoint,
    metadata: tuple.metadata,
  })
})

app.delete('/_/threads/:threadId', async (c) => {
  const threadId = c.req.param('threadId')

  // Get session and verify ownership
  const sessionId = await getOrCreateSession(c)
  const isOwner = await verifyThreadOwnership(c.env.DB, threadId, sessionId)

  if (!isOwner) {
    return c.json({ error: 'Unauthorized: You do not own this thread' }, 403)
  }

  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY, c.env.DB, c.env)
  await checkpointer.deleteThread(threadId)

  // Also delete from DB
  await deleteThread(c.env.DB, threadId)

  return c.json({ ok: true, message: 'Thread cleared' })
})

// export const onRequest = handle(app)
export default app