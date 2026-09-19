// Transmission RPC transport: JSON-RPC 2.0 over one POST endpoint, plus the 409 session-id
// handshake. The backend terminates auth: it holds the OIDC session and attaches the daemon's
// basic auth upstream, so the browser never sees daemon credentials. A 401 here means the
// session is gone, and the app sends the user to /api/auth/login.
//
// The daemon speaks JSON-RPC 2.0 from 4.1.0 (rpc_version 18) on. The older bespoke envelope
// still works but is deprecated upstream and this client does not use it.

export class RpcError extends Error {
  constructor(message: string, public readonly method: string, public readonly data?: RpcErrorData) {
    super(message)
    this.name = 'RpcError'
  }
}

/** JSON-RPC error `data`: an optional longer message plus method-defined extra keys. */
export interface RpcErrorData { error_string?: string; result?: Record<string, unknown> }

// The app may be served under a path prefix (seedbox.example.com/transmission),
// where an origin-absolute path would escape the prefix and miss the reverse
// proxy's route. The backend states its prefix in a meta tag when it serves
// index.html; it cannot be derived from location.pathname, because on the
// bundle-only path the daemon serves the UI from /transmission/web/ while its
// RPC stays at the fixed /transmission/rpc.
export function basePath(): string {
  const meta = document.querySelector('meta[name="tmui-base"]')
  const v = meta?.getAttribute('content')?.trim() ?? ''
  return v === '/' ? '' : v.replace(/\/$/, '')
}

// Resolved on first use, not at module load: the meta tag is in <head>, so it
// is parsed before any script runs, but keeping this lazy avoids depending on
// module evaluation order.
let endpoint: string | null = null
function rpcEndpoint(): string {
  if (endpoint === null) {
    endpoint = (import.meta.env.VITE_RPC_URL as string | undefined) || `${basePath()}/transmission/rpc`
  }
  return endpoint
}
let sessionId: string | null = null
let id = 0

type RpcResponse<T> = {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: { code: number; message: string; data?: RpcErrorData }
}

export async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (sessionId) headers['X-Transmission-Session-Id'] = sessionId
  const res = await fetch(rpcEndpoint(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id }),
    credentials: 'same-origin',
  })
  if (res.status === 409) {
    const sid = res.headers.get('X-Transmission-Session-Id')
    if (sid && retry) {
      sessionId = sid
      return rpc<T>(method, params, false)
    }
    throw new RpcError('session id handshake failed', method)
  }
  if (res.status === 401 || res.status === 403) throw new RpcError('unauthorized', method)
  // 204 is the JSON-RPC notification response. We never send notifications, so a 204 means
  // the request lost its id somewhere and there is nothing to parse.
  if (res.status === 204) throw new RpcError('empty response', method)
  if (!res.ok) throw new RpcError(`HTTP ${res.status}`, method)
  const body = (await res.json()) as RpcResponse<T>
  if (body.error) throw new RpcError(body.error.data?.error_string || body.error.message, method, body.error.data)
  // Guard against a body that is not a JSON-RPC response at all. The `jsonrpc` member is the
  // discriminator: an old bespoke daemon answers `{"result": "<status text>", "arguments": {}}`,
  // which has a `result` key too, so checking for that key alone would hand the status string
  // back as the payload. `in`, not a falsy check: a void method may answer `"result": null`.
  if (body.jsonrpc !== '2.0' || !('result' in body)) throw new RpcError('malformed response', method)
  return body.result as T
}
