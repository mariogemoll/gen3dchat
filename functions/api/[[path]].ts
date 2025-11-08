// functions/api/[[path]].ts
import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'

const app = new Hono().basePath('/api')

app.get('/hello', (c) => c.json({ ok: true, time: new Date().toISOString() }))

app.post('/echo', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json({ you_sent: body })
})

export const onRequest = handle(app)