// functions/api/[[path]].ts
import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages'
import { StateGraph, Annotation, messagesStateReducer } from '@langchain/langgraph'
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import { Client } from 'langsmith'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'

interface Env {
  CHAT_HISTORY: any
  OPENAI_API_KEY: string
  LANGCHAIN_TRACING_V2?: string
  LANGCHAIN_API_KEY?: string
  LANGCHAIN_PROJECT?: string
}

// Custom Cloudflare KV checkpoint saver
class CloudflareKVSaver extends BaseCheckpointSaver {
  constructor(private kv: any) {
    super()
  }

  async getTuple(config: { configurable?: { thread_id: string } }): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id
    if (!threadId) return undefined

    const key = `checkpoint:${threadId}`
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
    const key = `checkpoint:${threadId}`

    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: threadId } },
      checkpoint,
      metadata,
      parentConfig: config.configurable?.thread_id ? config : undefined,
    }

    await this.kv.put(key, JSON.stringify(tuple))
    return { configurable: { thread_id: threadId } }
  }

  async putWrites(config: { configurable?: { thread_id: string } }, writes: any[], taskId: string): Promise<void> {
    // Not needed for basic implementation
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.kv.delete(`checkpoint:${threadId}`)
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
  const config: any = {
    configurable: { thread_id: currentThreadId },
    callbacks,
  }

  // Invoke the graph with the user message
  const result = await graph.invoke({ messages: [new HumanMessage(message)] }, config)

  // Extract the last message (AI response)
  const lastMessage = result.messages[result.messages.length - 1]
  const response = lastMessage.content

  // Explicitly wait for LangSmith client to flush
  if (langsmithClient) {
    await langsmithClient.awaitPendingTraceBatches?.()
  }

  return c.json({
    response,
    threadId: currentThreadId,
    messageCount: result.messages.length,
  })
})

app.delete('/threads/:threadId', async (c) => {
  const threadId = c.req.param('threadId')
  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY)
  await checkpointer.deleteThread(threadId)
  return c.json({ ok: true, message: 'Thread cleared' })
})

export const onRequest = handle(app)