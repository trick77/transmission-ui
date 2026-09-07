import { afterEach, describe, expect, it, vi } from 'vitest'
import { rpc, RpcError } from './client'

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const nullBody = status === 409 || status === 204
  return new Response(nullBody ? null : JSON.stringify(body), { status, headers })
}

const ok = (result: unknown) => res(200, { jsonrpc: '2.0', id: 1, result })

describe('rpc', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('does the 409 session-id handshake once and reuses the id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(res(409, '', { 'X-Transmission-Session-Id': 'abc' }))
      .mockResolvedValueOnce(ok({ version: '4.1.3' }))
      .mockResolvedValueOnce(ok({ ok: 1 }))
    expect(await rpc('session_get')).toEqual({ version: '4.1.3' })
    expect(await rpc('session_stats')).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const third = fetchMock.mock.calls[2][1] as RequestInit
    expect((third.headers as Record<string, string>)['X-Transmission-Session-Id']).toBe('abc')
    expect(JSON.parse(third.body as string)).toMatchObject({ jsonrpc: '2.0', method: 'session_stats', params: {} })
  })

  it('sends a distinct id on every request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({}))
    await rpc('session_get')
    await rpc('session_get')
    const ids = fetchMock.mock.calls.map(c => JSON.parse((c[1] as RequestInit).body as string).id)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('maps 401 to unauthorized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(401))
    await expect(rpc('x')).rejects.toMatchObject({ name: 'RpcError', message: 'unauthorized' })
  })

  it('surfaces JSON-RPC errors and HTTP errors', async () => {
    // The daemon puts its own wording in data.error_string; message is the generic JSON-RPC text.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(200, {
      jsonrpc: '2.0', id: 1,
      error: { code: -32603, message: 'Internal error', data: { error_string: 'invalid or corrupt torrent file' } },
    }))
    await expect(rpc('torrent_add')).rejects.toThrow('invalid or corrupt torrent file')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(200, {
      jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' },
    }))
    await expect(rpc('nope')).rejects.toThrow('Method not found')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(500, {}))
    await expect(rpc('x')).rejects.toThrow('HTTP 500')
  })

  it('carries the error data through, so a failed port test says which family failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(200, {
      jsonrpc: '2.0', id: 1,
      error: { code: 7, message: 'HTTP error from backend service', data: { error_string: 'No Response (0)', result: { ip_protocol: 'ipv6' } } },
    }))
    const e = await rpc('port_test').catch(x => x)
    expect(e).toBeInstanceOf(RpcError)
    expect(e.data?.result).toEqual({ ip_protocol: 'ipv6' })
  })

  it('rejects a bespoke pre-4.1 response instead of returning its status string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(200, { result: 'method name not recognized', arguments: {} }))
    await expect(rpc('session_get')).rejects.toThrow('malformed response')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(200, { jsonrpc: '2.0', id: 1 }))
    await expect(rpc('session_get')).rejects.toThrow('malformed response')
  })

  it('accepts a null result from a void method', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(200, { jsonrpc: '2.0', id: 1, result: null }))
    await expect(rpc('torrent_start')).resolves.toBeNull()
  })

  it('treats a 204 notification response as an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(204))
    await expect(rpc('x')).rejects.toThrow('empty response')
  })

  it('gives up if the 409 carries no session id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(409))
    const e = await rpc('x').catch(x => x)
    expect(e).toBeInstanceOf(RpcError)
    expect(e.method).toBe('x')
  })
})
