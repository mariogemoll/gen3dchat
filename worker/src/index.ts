import app from './api'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // 1) /_/... → Hono app
    if (path.startsWith('/_/')) {
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