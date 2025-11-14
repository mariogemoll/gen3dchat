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
  ];

  const missing: string[] = [];

  for (const key of required) {
    if (!env[key as keyof Env]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      `Please set them in Cloudflare Dashboard: Workers & Pages > Settings > Environment variables`
    );
  }

  // Validate Sqids alphabets have enough characters
  if (env.SQIDS_THREAD_ALPHABET.length < 3) {
    throw new Error('SQIDS_THREAD_ALPHABET must be at least 3 characters long');
  }

  if (env.SQIDS_CHECKPOINT_ALPHABET.length < 3) {
    throw new Error('SQIDS_CHECKPOINT_ALPHABET must be at least 3 characters long');
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
      const indexUrl = new URL('/index.html', url.origin)
      const indexReq = new Request(indexUrl.toString(), request)
      return env.ASSETS.fetch(indexReq)
    }

    // 3) Everything else → static assets
    return env.ASSETS.fetch(request)
  },
}