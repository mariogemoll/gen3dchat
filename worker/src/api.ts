import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { buildGraph, JscadValidator, type AgentEnv } from './agent';
import { CloudflareKVSaver } from './kv';
import {
  createThread,
  getNextThreadId,
  getSqidFromUuid,
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

// Export types derived from schemas
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;
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

    const config: any = {
      configurable: { thread_id: currentThreadId },
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

      // Build response based on what happened
      let responseMessage = '';
      if (result.userUpdate?.validationErrors) {
        responseMessage = `Validation error: ${result.userUpdate.validationErrors}`;
      } else if (result.lastValidCode) {
        responseMessage = code
          ? 'Code updated successfully'
          : 'Code generated successfully';
      } else {
        responseMessage = 'Request processed';
      }

      return c.json({
        threadId: currentThreadId,
        checkpointId: currentCheckpointSqid,
        message: responseMessage,
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
