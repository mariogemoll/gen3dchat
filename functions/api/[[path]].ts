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

// Simple code syntax validator
// Valid commands:
// SET <variable> <value>
// PRINT <variable>
// ADD <variable> <value>
// IF <variable> EQUALS <value>
// END
// Lines starting with # are comments
function validateCode(code: string): { valid: boolean; error?: string } {
  const lines = code.split('\n')
  const validCommands = ['SET', 'PRINT', 'ADD', 'IF', 'END']
  const variables = new Set<string>()
  const ifStack: number[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue

    const tokens = line.split(/\s+/)
    const command = tokens[0].toUpperCase()

    if (!validCommands.includes(command)) {
      return { valid: false, error: `Line ${i + 1}: Unknown command '${command}'` }
    }

    if (command === 'SET') {
      if (tokens.length < 3) {
        return { valid: false, error: `Line ${i + 1}: SET requires variable and value` }
      }
      variables.add(tokens[1])
    } else if (command === 'PRINT') {
      if (tokens.length < 2) {
        return { valid: false, error: `Line ${i + 1}: PRINT requires variable` }
      }
    } else if (command === 'ADD') {
      if (tokens.length < 3) {
        return { valid: false, error: `Line ${i + 1}: ADD requires variable and value` }
      }
      variables.add(tokens[1])
    } else if (command === 'IF') {
      if (tokens.length < 4 || tokens[2].toUpperCase() !== 'EQUALS') {
        return { valid: false, error: `Line ${i + 1}: IF requires format: IF variable EQUALS value` }
      }
      ifStack.push(i)
    } else if (command === 'END') {
      if (ifStack.length === 0) {
        return { valid: false, error: `Line ${i + 1}: END without matching IF` }
      }
      ifStack.pop()
    }
  }

  if (ifStack.length > 0) {
    return { valid: false, error: `Unclosed IF statement at line ${ifStack[ifStack.length - 1] + 1}` }
  }

  return { valid: true }
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

  // Node: Handle user code update (validation already done before graph invocation)
  const handleUserCodeUpdate = async (state: typeof StateAnnotation.State) => {
    // Extract code from the last user message
    const lastMessage = state.messages[state.messages.length - 1]
    const content = typeof lastMessage.content === 'string' ? lastMessage.content : ''

    // Check if message contains code block
    const codeBlockMatch = content.match(/```(?:simple)?\n([\s\S]*?)\n```/)
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
      content: `You are a code editor assistant. Generate code using this simple syntax:
- SET <variable> <value> - Sets a variable
- PRINT <variable> - Prints a variable
- ADD <variable> <value> - Adds to a variable
- IF <variable> EQUALS <value> - Conditional
- END - Ends an IF block
- # comment - Comments start with #

Current code:
\`\`\`
${state.currentCode || '# Empty file'}
\`\`\`

${state.lastValidationError ? `Previous attempt failed with: ${state.lastValidationError}\n\nFix the error and try again.` : 'Generate a complete, valid code file based on the user request.'}

IMPORTANT: Always respond with BOTH:
1. A brief, human-readable explanation of what you changed or created (1-2 sentences)
2. The complete code in a \`\`\`simple code block

Example response format:
"I've created a simple counter that starts at 0 and increments by 1.

\`\`\`simple
SET counter 0
ADD counter 1
PRINT counter
\`\`\`"

The explanation text is important - users will only see this text, not the code in chat.
`
    }

    // Log the messages being sent to LLM
    console.log('=== Sending to LLM ===')
    console.log('System message:', systemMessage.content.substring(0, 200) + '...')
    console.log('State messages:', state.messages.length)
    state.messages.forEach((msg, idx) => {
      const msgType = msg.constructor.name
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      console.log(`  [${idx}] ${msgType}: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`)
    })
    console.log('=====================')

    const response = await llm.invoke([systemMessage, ...state.messages])

    // Extract code from response
    const responseContent = typeof response.content === 'string' ? response.content : ''
    const codeBlockMatch = responseContent.match(/```(?:simple)?\n([\s\S]*?)\n```/)

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
    const validation = validateCode(state.currentCode || '')

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
  const routeAfterValidation = (state: typeof StateAnnotation.State): string => {
    const validation = validateCode(state.currentCode || '')

    if (validation.valid) {
      return '__end__'
    }

    // If it's a user code update, don't retry - just fail
    if (state.isUserCodeUpdate) {
      return 'validationFailed'
    }

    // Only retry for LLM-generated code
    const retries = state.validationRetries || 0
    if (retries >= 3) {
      // Max retries reached - give up
      return 'validationFailed'
    }

    // Retry generation
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

  // Pre-validate user code updates before invoking the graph
  // This prevents creating unnecessary checkpoints for invalid code
  const isCodeUpdate = message.includes('```')
  if (isCodeUpdate) {
    const codeBlockMatch = message.match(/```(?:simple)?\n([\s\S]*?)\n```/)
    const code = codeBlockMatch ? codeBlockMatch[1] : message
    const validation = validateCode(code)

    if (!validation.valid) {
      // Return error immediately without creating a checkpoint
      // Get current checkpoint to maintain continuity
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: currentThreadId } })
      const currentCheckpointId = tuple?.checkpoint?.id || crypto.randomUUID()

      const messages = tuple?.checkpoint?.channel_values?.messages as any[] || []
      const previousCode = tuple?.checkpoint?.channel_values?.currentCode as string || ''

      return c.json({
        response: `Validation error: ${validation.error}`,
        threadId: currentThreadId,
        checkpointId: currentCheckpointId,
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
    currentCode: result.currentCode || '',
    validationRetries: result.validationRetries || 0,
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