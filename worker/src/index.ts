import app from './api'
import type { Env as ApiEnv } from './api'

// Extend API env with Cloudflare-specific bindings
interface Env extends ApiEnv {
  ASSETS: Fetcher
}

// Validate required environment variables
function validateEnv(env: Env): void {
  const required = [
    'SQIDS_THREAD_ALPHABET',
    'SQIDS_CHECKPOINT_ALPHABET',
    'ANTHROPIC_API_KEY',
    'DAILY_LLM_CALL_LIMIT',
    'JSCAD_VALIDATION_SERVICE_URL',
  ];

  const missing: string[] = [];

  for (const key of required) {
    if (!env[key as keyof Env]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}.`);
  }

  // Validate Sqids alphabets have enough characters
  if (env.SQIDS_THREAD_ALPHABET.length < 3) {
    throw new Error('SQIDS_THREAD_ALPHABET must be at least 3 characters long');
  }

  if (env.SQIDS_CHECKPOINT_ALPHABET.length < 3) {
    throw new Error('SQIDS_CHECKPOINT_ALPHABET must be at least 3 characters long');
  }

  // Validate DAILY_LLM_CALL_LIMIT is a valid number
  const dailyLimit = parseInt(env.DAILY_LLM_CALL_LIMIT, 10);
  if (isNaN(dailyLimit) || dailyLimit < 1) {
    throw new Error('DAILY_LLM_CALL_LIMIT must be a positive integer');
  }
}

// Validate environment on worker startup
let envValidated = false

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Validate environment on first request (workers don't have a true startup hook)
    if (!envValidated) {
      validateEnv(env)
      envValidated = true
    }

    const url = new URL(request.url)
    const path = url.pathname

    // 1) API routes → Hono app
    // - /_/... → API endpoints
    // - /doc → OpenAPI spec (JSON)
    // - /docs → Swagger UI
    if (path.startsWith('/_/') || path === '/doc' || path === '/docs') {
      return app.fetch(request, env, ctx)
    }

    // 2) / and /t/SOMECODE/SOMECODE → SPA/index.html
    const isRoot = path === '/'
    const isThreadRoute = /^\/t\/[^/]+\/[^/]+\/?$/.test(path)

    if (isRoot || isThreadRoute) {
      console.log('Serving index.html for SPA route:', path)
      // Create a new request for index.html
      const indexUrl = new URL(request.url)
      indexUrl.pathname = '/index.html'
      const indexReq = new Request(indexUrl.toString(), {
        method: request.method,
        headers: request.headers,
      })
      const response = await env.ASSETS.fetch(indexReq)
      
      // If ASSETS returns a redirect, follow it and return the final content
      if (response.status >= 300 && response.status < 400 && response.headers.get('Location')) {
        const redirectUrl = new URL(response.headers.get('Location')!, indexUrl)
        const redirectReq = new Request(redirectUrl.toString(), {
          method: request.method,
          headers: request.headers,
        })
        const finalResponse = await env.ASSETS.fetch(redirectReq)
        // Return the final response without redirecting (preserve original URL)
        return new Response(finalResponse.body, {
          status: finalResponse.status,
          statusText: finalResponse.statusText,
          headers: finalResponse.headers,
        })
      }
      
      // Return the response directly (no redirect)
      return response
    }

    // 3) Everything else → static assets
    return env.ASSETS.fetch(request)
  },
}