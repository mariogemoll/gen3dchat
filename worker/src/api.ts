import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { buildGraph, JscadValidator, type AgentEnv, createLangSmithCallbacks, flushLangSmithTraces } from './agent';
import { CloudflareKVSaver } from './kv';
import {
  createThread,
  getNextThreadId,
  getSqidFromUuid,
  getUuidFromSqid,
  verifyThreadOwnership,
  updateThreadTimestamp,
} from './db';

export interface Env extends AgentEnv {
  DAILY_LLM_CALL_LIMIT?: string;
  ANTHROPIC_API_KEY?: string;
}

// Zod schemas for request/response validation
export const CreateThreadRequestSchema = z.object({
  message: z.string().optional().openapi({
    description: 'A text prompt or message for the agent',
    example: 'Create a red cube',
  }),
  code: z.string().optional().openapi({
    description: 'JSCAD code to validate and execute',
    example: 'function main() {\n  const { primitives } = jscadModeling\n  return primitives.cube({ size: 10 })\n}',
  }),
}).refine(
  (data) => data.message || data.code,
  { message: 'Either message or code must be provided' }
).openapi('CreateThreadRequest');

export const CreateThreadResponseSchema = z.object({
  threadId: z.string().openapi({
    description: 'Unique thread identifier',
    example: 'abc123',
  }),
  checkpointId: z.string().openapi({
    description: 'Checkpoint identifier',
    example: 'xyz789',
  }),
  message: z.string().openapi({
    description: 'Assistant response message',
    example: 'Code updated successfully',
  }),
  code: z.string().optional().openapi({
    description: 'Updated JSCAD code (if available)',
    example: 'function main() {\n  return primitives.cube({ size: 10 })\n}',
  }),
}).openapi('CreateThreadResponse');

export const ErrorResponseSchema = z.object({
  error: z.string().openapi({
    description: 'Error message',
  }),
  details: z.string().optional().openapi({
    description: 'Detailed error information',
  }),
  threadId: z.string().optional().openapi({
    description: 'Thread ID if available',
  }),
}).openapi('ErrorResponse');

export const ContinueThreadRequestSchema = z.object({
  checkpointId: z.string().openapi({
    description: 'Checkpoint ID to resume from (MANDATORY)',
    example: 'xyz789',
  }),
  message: z.string().optional().openapi({
    description: 'A text prompt or message for the agent',
    example: 'Make the cube bigger',
  }),
  code: z.string().optional().openapi({
    description: 'JSCAD code to validate and execute',
    example: 'function main() {\n  const { primitives } = jscadModeling\n  return primitives.cube({ size: 20 })\n}',
  }),
}).refine(
  (data) => data.message || data.code,
  { message: 'Either message or code must be provided' }
).openapi('ContinueThreadRequest');

export const ContinueThreadResponseSchema = z.object({
  threadId: z.string().openapi({
    description: 'Thread identifier',
    example: 'abc123',
  }),
  checkpointId: z.string().openapi({
    description: 'New checkpoint identifier',
    example: 'xyz999',
  }),
  message: z.string().openapi({
    description: 'Assistant response message',
    example: 'Code updated successfully',
  }),
  code: z.string().optional().openapi({
    description: 'Updated JSCAD code (if available)',
    example: 'function main() {\n  return primitives.cube({ size: 20 })\n}',
  }),
}).openapi('ContinueThreadResponse');

// Export types derived from schemas
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;
export type ContinueThreadRequest = z.infer<typeof ContinueThreadRequestSchema>;
export type ContinueThreadResponse = z.infer<typeof ContinueThreadResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// Helper functions for session management
async function getOrCreateSession(c: any): Promise<string> {
  let sessionId = getCookie(c, 'session_id');

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    setCookie(c, 'session_id', sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24,
      path: '/',
    });
  }

  return sessionId;
}

const app = new OpenAPIHono<{ Bindings: Env }>();

// Define the route schema
const createThreadRoute = createRoute({
  method: 'post',
  path: '/_/threads',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateThreadRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: CreateThreadResponseSchema,
        },
      },
      description: 'Thread created successfully',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Server error',
    },
    501: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Not implemented',
    },
  },
  tags: ['Threads'],
  summary: 'Create a new thread',
  description: 'Creates a new thread with a message. The message can be a text prompt for code generation or a code block for validation.',
});

app.openapi(createThreadRoute, async (c) => {
    const { message, code } = c.req.valid('json');

    // Get or create session
    const sessionId = await getOrCreateSession(c);

    // Set up checkpoint saver with KV
    const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY, c.env.DB, c.env);

    // Create the validator
    const validator = new JscadValidator(c.env.JSCAD_VALIDATION_SERVICE_URL);

    // Create the agent graph with persistence
    const graph = buildGraph({
      validator,
      checkpointer,
      apiKey: c.env.ANTHROPIC_API_KEY,
    });

    // Always create a new thread
    const currentThreadId = await getNextThreadId(c.env.DB, c.env);
    await createThread(c.env.DB, currentThreadId, sessionId);

    // Initialize LangSmith callbacks
    const callbacks = createLangSmithCallbacks(c.env);

    const config: any = {
      configurable: { thread_id: currentThreadId },
      callbacks,
    };

    // Build initial state based on what was provided
    let initialState: any = {
      userPrompt: message || undefined,
      userUpdate: code ? { code } : undefined,
    };

    try {
      // Invoke the graph
      const result = await graph.invoke(initialState, config);

      // Get the checkpoint ID from the saved checkpoint
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: currentThreadId } });
      const currentCheckpointUuid = tuple?.checkpoint?.id || crypto.randomUUID();
      const currentCheckpointSqid = await getSqidFromUuid(c.env.DB, currentCheckpointUuid) || currentCheckpointUuid;

      // Flush LangSmith traces
      await flushLangSmithTraces(c.env);

      return c.json({
        threadId: currentThreadId,
        checkpointId: currentCheckpointSqid,
        message: result.response?.message || 'Request processed',
        code: result.lastValidCode || undefined,
      }, 200);
    } catch (error: any) {
      console.error('Error processing request:', error);

      // Check for missing API key
      if (error.message?.includes('API key') || !c.env.ANTHROPIC_API_KEY) {
        return c.json({
          error: 'AI-powered code generation requires an API key to be configured.',
          threadId: currentThreadId,
        }, 500);
      }

      return c.json({
        error: 'Failed to process request',
        details: error.message,
        threadId: currentThreadId,
      }, 500);
    }
  },
);

// Define the route schema for continuing a thread
const continueThreadRoute = createRoute({
  method: 'post',
  path: '/_/threads/{threadId}',
  request: {
    params: z.object({
      threadId: z.string().openapi({
        description: 'Thread ID',
        example: 'abc123',
      }),
    }),
    body: {
      content: {
        'application/json': {
          schema: ContinueThreadRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ContinueThreadResponseSchema,
        },
      },
      description: 'Thread continued successfully',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized - thread ownership verification failed',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Thread or checkpoint not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Server error',
    },
  },
  tags: ['Threads'],
  summary: 'Continue an existing thread',
  description: 'Continues an existing thread from a specific checkpoint. Requires checkpointId and either message or code.',
});

app.openapi(continueThreadRoute, async (c) => {
  const threadId = c.req.param('threadId');
  const { checkpointId, message, code } = c.req.valid('json');

  // Get session and verify ownership
  const sessionId = await getOrCreateSession(c);
  const isOwner = await verifyThreadOwnership(c.env.DB, threadId, sessionId);

  if (!isOwner) {
    return c.json({
      error: 'Unauthorized: You do not own this thread',
    }, 403);
  }

  // Update thread timestamp
  await updateThreadTimestamp(c.env.DB, threadId);

  // Try to resolve Sqid to UUID, if it fails assume it's already a UUID
  const checkpointUuid = await getUuidFromSqid(c.env.DB, checkpointId) || checkpointId;

  // Set up checkpoint saver with KV
  const checkpointer = new CloudflareKVSaver(c.env.CHAT_HISTORY, c.env.DB, c.env);

  // Verify the checkpoint exists
  const existingCheckpoint = await checkpointer.getCheckpointById(threadId, checkpointUuid);
  if (!existingCheckpoint) {
    return c.json({
      error: 'Checkpoint not found',
      details: `No checkpoint found with ID ${checkpointId} for thread ${threadId}`,
    }, 404);
  }

  // Create the validator
  const validator = new JscadValidator(c.env.JSCAD_VALIDATION_SERVICE_URL);

  // Create the agent graph with persistence
  const graph = buildGraph({
    validator,
    checkpointer,
    apiKey: c.env.ANTHROPIC_API_KEY,
  });

  // Initialize LangSmith callbacks
  const callbacks = createLangSmithCallbacks(c.env);

  const config: any = {
    configurable: { thread_id: threadId },
    callbacks,
  };

  // Build initial state based on what was provided
  let initialState: any = {
    userPrompt: message || undefined,
    userUpdate: code ? { code } : undefined,
  };

  try {
    // Invoke the graph to continue from the checkpoint
    const result = await graph.invoke(initialState, config);

    // Get the new checkpoint ID from the saved checkpoint
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
    const newCheckpointUuid = tuple?.checkpoint?.id || crypto.randomUUID();
    const newCheckpointSqid = await getSqidFromUuid(c.env.DB, newCheckpointUuid) || newCheckpointUuid;

    // Flush LangSmith traces
    await flushLangSmithTraces(c.env);

    return c.json({
      threadId,
      checkpointId: newCheckpointSqid,
      message: result.response?.message || 'Request processed',
      code: result.lastValidCode || undefined,
    }, 200);
  } catch (error: any) {
    console.error('Error processing request:', error);

    // Check for missing API key
    if (error.message?.includes('API key') || !c.env.ANTHROPIC_API_KEY) {
      return c.json({
        error: 'AI-powered code generation requires an API key to be configured.',
        threadId,
      }, 500);
    }

    return c.json({
      error: 'Failed to process request',
      details: error.message,
      threadId,
    }, 500);
  }
});

// OpenAPI documentation endpoint (JSON)
app.doc('/doc', {
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'Gen3D Chat API',
    description: 'API for creating and managing 3D design threads with JSCAD code generation',
  },
  tags: [
    {
      name: 'Threads',
      description: 'Thread management endpoints',
    },
  ],
});

// Swagger UI endpoint
app.get('/docs', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gen3D Chat API Documentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/doc',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>`);
});

export default app;
