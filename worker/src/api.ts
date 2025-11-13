// functions/api/[[path]].ts
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages'
import { StateGraph, Annotation, messagesStateReducer } from '@langchain/langgraph'
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import { Client } from 'langsmith'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'
import Sqids from 'sqids'
import { validateJscadCode } from './jscad-validator'
import { checkDailyLimit, incrementUsage } from './usage-tracker'

interface Env {
  CHAT_HISTORY: any
  DB: any
  OPENAI_API_KEY: string
  LANGCHAIN_TRACING_V2?: string
  LANGCHAIN_API_KEY?: string
  LANGCHAIN_PROJECT?: string
  SQIDS_THREAD_ALPHABET: string
  SQIDS_CHECKPOINT_ALPHABET: string
  SYSTEM_PROMPT: string
  JSCAD_VALIDATION_SERVICE_URL: string
  DAILY_LLM_CALL_LIMIT?: string
}

// Validate required environment variables
function validateEnv(env: Env): void {
  const required = [
    'OPENAI_API_KEY',
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

// Helper to get Sqids instance with environment-specific alphabet
function getThreadSqids(env: Env): Sqids {
  return new Sqids({
    alphabet: env.SQIDS_THREAD_ALPHABET,
    minLength: 6,
  })
}

function getCheckpointSqids(env: Env): Sqids {
  return new Sqids({
    alphabet: env.SQIDS_CHECKPOINT_ALPHABET,
    minLength: 6,
  })
}

// Helper functions for ID generation using atomic counters
async function getNextThreadId(db: any, env: Env): Promise<string> {
  // Atomically increment the counter and get the new value
  const result = await db
    .prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value')
    .bind('thread_id')
    .first()

  const counter = result?.value || 1
  const sqids = getThreadSqids(env)
  return sqids.encode([counter])
}

async function getNextCheckpointId(db: any, env: Env): Promise<string> {
  // Atomically increment the counter and get the new value
  const result = await db
    .prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value')
    .bind('checkpoint_id')
    .first()

  const counter = result?.value || 1
  const sqids = getCheckpointSqids(env)
  return sqids.encode([counter])
}

async function storeCheckpointIdMapping(db: any, sqid: string, uuid: string): Promise<void> {
  const now = Date.now()
  await db
    .prepare('INSERT OR IGNORE INTO checkpoint_ids (sqid, uuid, created_at) VALUES (?, ?, ?)')
    .bind(sqid, uuid, now)
    .run()
}

async function getUuidFromSqid(db: any, sqid: string): Promise<string | null> {
  const result = await db
    .prepare('SELECT uuid FROM checkpoint_ids WHERE sqid = ?')
    .bind(sqid)
    .first()
  return result?.uuid || null
}

async function getSqidFromUuid(db: any, uuid: string): Promise<string | null> {
  const result = await db
    .prepare('SELECT sqid FROM checkpoint_ids WHERE uuid = ?')
    .bind(uuid)
    .first()
  return result?.sqid || null
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
  constructor(private kv: any, private db: any, private env: Env) {
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

// JSCAD code validator
async function validateCode(code: string, validationServiceUrl: string): Promise<{ valid: boolean; error?: string }> {
  console.log('=== VALIDATION SERVICE CALL ===')
  console.log('Service URL:', validationServiceUrl)
  console.log('Code length:', code.length)
  console.log('Code preview:', code.substring(0, 200) + (code.length > 200 ? '...' : ''))

  const result = await validateJscadCode(code, validationServiceUrl)

  console.log('Validation result:', JSON.stringify(result, null, 2))
  console.log('===============================')

  if (result.ok) {
    return { valid: true }
  } else {
    return {
      valid: false,
      error: `${result.phase}: ${result.error}`
    }
  }
}

// Define the state for our graph
const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
  }),
  currentCode: Annotation<string>({
    reducer: (left?: string, right?: string) => right ?? left ?? '',
  }),
  previousValidCode: Annotation<string>({
    reducer: (left?: string, right?: string) => right ?? left ?? '',
  }),
  validationRetries: Annotation<number>({
    reducer: (left?: number, right?: number) => right ?? left ?? 0,
  }),
  isUserCodeUpdate: Annotation<boolean>({
    reducer: (left?: boolean, right?: boolean) => right ?? left ?? false,
  }),
  lastValidationError: Annotation<string | undefined>({
    reducer: (left?: string, right?: string) => right ?? left,
  }),
})

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
    // model: 'gpt-4o-mini',
    // model: 'gpt-5-mini-2025-08-07',
    model: 'gpt-5-nano-2025-08-07',
    apiKey: c.env.OPENAI_API_KEY,
    // temperature: 0.7,
  })

  // Node: Handle user code update (validation already done before graph invocation)
  const handleUserCodeUpdate = async (state: typeof StateAnnotation.State) => {
    // Extract code from the last user message
    const lastMessage = state.messages[state.messages.length - 1]
    const content = typeof lastMessage.content === 'string' ? lastMessage.content : ''

    // Check if message contains code block
    const codeBlockMatch = content.match(/```(?:javascript|js|jscad)?\n([\s\S]*?)\n```/)
    const code = codeBlockMatch ? codeBlockMatch[1] : content

    // Just update code, no message added (already validated outside graph)
    return {
      currentCode: code,
      previousValidCode: code,
      validationRetries: 0,
      isUserCodeUpdate: true,
    }
  }

  // Node: Generate code with LLM
  const generateCode = async (state: typeof StateAnnotation.State) => {
    const systemMessage = {
      role: 'system',
      content: c.env.SYSTEM_PROMPT
    }

    // Build messages array - system first, then all history, then optional error at the end
    const messagesToSend = [systemMessage, ...state.messages]

    // If there's a validation error from a previous attempt, append it as the last user message
    if (state.lastValidationError) {
      messagesToSend.push(new HumanMessage(`The previous JSCAD code had an error: ${state.lastValidationError}\n\nPlease fix the error and generate a corrected version.`))
    }

    // Log the messages being sent to LLM
    console.log('=== Sending to LLM ===')
    console.log('System message:', c.env.SYSTEM_PROMPT.substring(0, 200) + '...')
    console.log('State messages:', state.messages.length)
    console.log('Has validation error:', !!state.lastValidationError)
    state.messages.forEach((msg, idx) => {
      const msgType = msg.constructor.name
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      console.log(`  [${idx}] ${msgType}: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`)
    })
    console.log('=====================')

    const response = await llm.invoke(messagesToSend)

    // Increment LLM call counter
    await incrementUsage(c.env.DB)

    // Extract code from response
    const responseContent = typeof response.content === 'string' ? response.content : ''
    const codeBlockMatch = responseContent.match(/```(?:javascript|js|jscad)?\n([\s\S]*?)\n```/)

    if (codeBlockMatch) {
      return {
        messages: [response],
        currentCode: codeBlockMatch[1],
        isUserCodeUpdate: false,
      }
    }

    // No code block found - this is an error
    return {
      messages: [response],
      lastValidationError: 'No code block found in response',
    }
  }

  // Node: Validate code
  const validateCodeNode = async (state: typeof StateAnnotation.State) => {
    console.log('=== VALIDATE CODE NODE ===')
    console.log('Current retry count:', state.validationRetries || 0)
    console.log('Is user code update:', state.isUserCodeUpdate)

    const validation = await validateCode(state.currentCode || '', c.env.JSCAD_VALIDATION_SERVICE_URL)

    console.log('Validation valid:', validation.valid)
    if (!validation.valid) {
      console.log('Validation error:', validation.error)
    }
    console.log('==========================')

    if (validation.valid) {
      // Valid! Just update state, don't add validation message
      // The LLM's explanatory message is already in messages from generateCode
      return {
        previousValidCode: state.currentCode,
        validationRetries: 0,
        lastValidationError: undefined,
      }
    } else {
      // Invalid - increment retry counter
      return {
        validationRetries: (state.validationRetries || 0) + 1,
        lastValidationError: validation.error,
      }
    }
  }

  // Routing function: decide next step after validation
  const routeAfterValidation = async (state: typeof StateAnnotation.State): Promise<string> => {
    console.log('=== ROUTE AFTER VALIDATION ===')
    const validation = await validateCode(state.currentCode || '', c.env.JSCAD_VALIDATION_SERVICE_URL)

    console.log('Validation valid:', validation.valid)
    console.log('Is user code update:', state.isUserCodeUpdate)
    console.log('Current retries:', state.validationRetries || 0)

    if (validation.valid) {
      console.log('Routing decision: END (valid code)')
      console.log('==============================')
      return '__end__'
    }

    // If it's a user code update, don't retry - just fail
    if (state.isUserCodeUpdate) {
      console.log('Routing decision: VALIDATION_FAILED (user code)')
      console.log('==============================')
      return 'validationFailed'
    }

    // Only retry for LLM-generated code
    const retries = state.validationRetries || 0
    if (retries >= 3) {
      // Max retries reached - give up
      console.log('Routing decision: VALIDATION_FAILED (max retries)')
      console.log('==============================')
      return 'validationFailed'
    }

    // Retry generation
    console.log('Routing decision: RETRY (attempt', retries + 1, 'of 3)')
    console.log('==============================')
    return 'generateCode'
  }

  // Node: Handle validation failure
  const handleValidationFailure = async (state: typeof StateAnnotation.State) => {
    const errorMessage = state.isUserCodeUpdate
      ? `Validation error: ${state.lastValidationError}`
      : `Failed to generate valid code after 3 attempts. Last error: ${state.lastValidationError}`

    // For user code updates, don't add error to messages (no checkpoint needed)
    // Just restore the previous valid code and return the error in lastValidationError
    if (state.isUserCodeUpdate) {
      return {
        currentCode: state.previousValidCode || '',
        lastValidationError: errorMessage,
      }
    }

    // For LLM failures after 3 attempts, we do want to record it
    const errorMsg = new AIMessage({
      content: errorMessage,
    })
    return { messages: [errorMsg] }
  }

  // Routing function: decide if this is a user code update or LLM request
  const routeInitial = (state: typeof StateAnnotation.State): string => {
    const lastMessage = state.messages[state.messages.length - 1]
    const content = typeof lastMessage.content === 'string' ? lastMessage.content : ''

    // Check if message contains code block - if so, it's a user code update
    if (content.includes('```')) {
      return 'handleUserCodeUpdate'
    }

    // Otherwise, it's a change request for the LLM
    return 'generateCode'
  }

  // Build the graph
  const workflow = new StateGraph(StateAnnotation)
    .addNode('handleUserCodeUpdate', handleUserCodeUpdate)
    .addNode('generateCode', generateCode)
    .addNode('validateCode', validateCodeNode)
    .addNode('validationFailed', handleValidationFailure)
    .addConditionalEdges('__start__', routeInitial, {
      handleUserCodeUpdate: 'handleUserCodeUpdate',
      generateCode: 'generateCode',
    })
    .addEdge('handleUserCodeUpdate', '__end__') // User updates go directly to end (already validated)
    .addEdge('generateCode', 'validateCode') // LLM code needs validation
    .addConditionalEdges('validateCode', routeAfterValidation, {
      __end__: '__end__',
      generateCode: 'generateCode',
      validationFailed: 'validationFailed',
    })
    .addEdge('validationFailed', '__end__')

  // Set up checkpoint saver with KV
  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY, c.env.DB, c.env)
  const graph = workflow.compile({ checkpointer })

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
  // This prevents creating unnecessary checkpoints for invalid code
  const isCodeUpdate = message.includes('```')
  if (isCodeUpdate) {
    console.log('=== PRE-VALIDATION (User Code Update) ===')
    const codeBlockMatch = message.match(/```(?:javascript|js|jscad)?\n([\s\S]*?)\n```/)
    const code = codeBlockMatch ? codeBlockMatch[1] : message
    console.log('Extracted code length:', code.length)

    const validation = await validateCode(code, c.env.JSCAD_VALIDATION_SERVICE_URL)

    console.log('Pre-validation result:', validation.valid ? 'VALID' : 'INVALID')
    if (!validation.valid) {
      console.log('Pre-validation error:', validation.error)
      console.log('Returning error without creating checkpoint')
    } else {
      console.log('Pre-validation passed, proceeding to graph')
    }
    console.log('==========================================')

    if (!validation.valid) {
      // Return error immediately without creating a checkpoint
      // Get current checkpoint to maintain continuity
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: currentThreadId } })
      const currentCheckpointUuid = tuple?.checkpoint?.id || crypto.randomUUID()

      // Get the Sqids checkpoint ID for the response
      const currentCheckpointSqid = await getSqidFromUuid(c.env.DB, currentCheckpointUuid) || currentCheckpointUuid

      const messages = tuple?.checkpoint?.channel_values?.messages as any[] || []
      const previousCode = tuple?.checkpoint?.channel_values?.currentCode as string || ''

      return c.json({
        response: `Validation error: ${validation.error}`,
        threadId: currentThreadId,
        checkpointId: currentCheckpointSqid,
        messageCount: messages.length,
        currentCode: previousCode, // Return the last valid code
        validationRetries: 1,
      })
    }
  }

  // Invoke the graph with the user message
  const result = await graph.invoke({ messages: [new HumanMessage(message)] }, config)

  // Extract the last message (AI response)
  // For user code updates, there's no AI message added, so response will be empty
  const lastMessage = result.messages[result.messages.length - 1]
  const response = lastMessage?.content || ''

  // Get the checkpoint ID from the saved checkpoint
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: currentThreadId } })
  const currentCheckpointUuid = tuple?.checkpoint?.id || crypto.randomUUID()

  // Get the Sqids checkpoint ID for the response
  const currentCheckpointSqid = await getSqidFromUuid(c.env.DB, currentCheckpointUuid) || currentCheckpointUuid

  // Explicitly wait for LangSmith client to flush
  if (langsmithClient) {
    await langsmithClient.awaitPendingTraceBatches?.()
  }

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
  await c.env.DB
    .prepare('DELETE FROM threads WHERE id = ?')
    .bind(threadId)
    .run()

  return c.json({ ok: true, message: 'Thread cleared' })
})

// export const onRequest = handle(app)
export default app