// A fake transmission-daemon on a real port. Run it directly:
//
//   node ui/sim/server.ts            # :9092, then point TM_RPC_TARGET at it
//   TM_SIM_SPEED=30 node ui/sim/server.ts
//
// Needs Node >= 23.6 for built-in TypeScript type stripping. No build step, no dependencies.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createState } from './state.ts'
import { handle, RpcFailure } from './handlers.ts'
import { tick } from './tick.ts'

const PORT = Number(process.env.TM_SIM_PORT ?? 9092)
const SEED = Number(process.env.TM_SIM_SEED ?? 1)
const COUNT = Number(process.env.TM_SIM_COUNT ?? 1)
const SPEED = Number(process.env.TM_SIM_SPEED ?? 1)

const state = createState({ seed: SEED, count: COUNT, speed: SPEED })
// The daemon hands out one session id and rejects requests without it, which is what makes
// rpc/client.ts run its 409 retry path on the very first call.
const SESSION_ID = randomBytes(24).toString('hex')

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', c => { body += c })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  if (body === undefined) { res.end(); return }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/'
  if (!url.startsWith('/transmission/rpc')) return send(res, 404, undefined)
  if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST' })

  if (req.headers['x-transmission-session-id'] !== SESSION_ID) {
    return send(res, 409, undefined, { 'X-Transmission-Session-Id': SESSION_ID })
  }

  let parsed: { method?: string; arguments?: Record<string, unknown>; tag?: number }
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    return send(res, 400, undefined)
  }
  const method = String(parsed.method ?? '')
  const args = parsed.arguments ?? {}

  const nowMs = Date.now()
  tick(state, nowMs)
  const now = Math.floor(nowMs / 1000)

  try {
    const result = handle(state, method, args, now)
    send(res, 200, { result: 'success', arguments: result, ...(parsed.tag != null ? { tag: parsed.tag } : {}) })
  } catch (e) {
    const msg = e instanceof RpcFailure ? e.message : `sim error: ${e instanceof Error ? e.message : String(e)}`
    if (!(e instanceof RpcFailure)) console.error('[sim]', e)
    send(res, 200, { result: msg, arguments: {}, ...(parsed.tag != null ? { tag: parsed.tag } : {}) })
  }
})

server.listen(PORT, () => {
  const n = state.torrents.length
  console.log(`[sim] fake transmission-daemon ${state.session.version} on http://localhost:${PORT}/transmission/rpc`)
  console.log(`[sim] ${n} torrents, seed ${SEED}, speed ${SPEED}x`)
  console.log(`[sim] point the UI at it:  cd ui && TM_RPC_TARGET=http://localhost:${PORT} npm run dev`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
