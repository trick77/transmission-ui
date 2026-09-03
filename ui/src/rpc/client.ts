// Transmission RPC transport: one POST endpoint, JSON body, and the 409 session-id handshake.
// Auth is the daemon's HTTP basic auth; the browser prompts, we never store credentials.

export class RpcError extends Error {
  constructor(message: string, public readonly method: string) {
    super(message)
    this.name = 'RpcError'
  }
}

const ENDPOINT = (import.meta.env.VITE_RPC_URL as string | undefined) || '/transmission/rpc'
let sessionId: string | null = null
let tag = 0

type RpcResponse<T> = { result: string; arguments: T; tag?: number }

export async function rpc<T = Record<string, unknown>>(method: string, args: Record<string, unknown> = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (sessionId) headers['X-Transmission-Session-Id'] = sessionId
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method, arguments: args, tag: ++tag }),
    credentials: 'same-origin',
  })
  if (res.status === 409) {
    const id = res.headers.get('X-Transmission-Session-Id')
    if (id && retry) {
      sessionId = id
      return rpc<T>(method, args, false)
    }
    throw new RpcError('session id handshake failed', method)
  }
  if (res.status === 401 || res.status === 403) throw new RpcError('unauthorized', method)
  if (!res.ok) throw new RpcError(`HTTP ${res.status}`, method)
  const body = (await res.json()) as RpcResponse<T>
  if (body.result !== 'success') throw new RpcError(body.result, method)
  return body.arguments
}
