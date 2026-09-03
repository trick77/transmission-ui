import { afterEach, describe, expect, it, vi } from 'vitest'
import { rpc, RpcError } from './client'

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(status === 409 ? '' : JSON.stringify(body), { status, headers })
}

describe('rpc', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('does the 409 session-id handshake once and reuses the id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(res(409, '', { 'X-Transmission-Session-Id': 'abc' }))
      .mockResolvedValueOnce(res(200, { result: 'success', arguments: { version: '4.0.5' } }))
      .mockResolvedValueOnce(res(200, { result: 'success', arguments: { ok: 1 } }))
    expect(await rpc('session-get')).toEqual({ version: '4.0.5' })
    expect(await rpc('session-stats')).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const third = fetchMock.mock.calls[2][1] as RequestInit
    expect((third.headers as Record<string, string>)['X-Transmission-Session-Id']).toBe('abc')
    expect(JSON.parse(third.body as string)).toMatchObject({ method: 'session-stats', arguments: {} })
  })

  it('maps 401 to unauthorized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(401))
    await expect(rpc('x')).rejects.toMatchObject({ name: 'RpcError', message: 'unauthorized' })
  })

  it('surfaces non-success results and HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(200, { result: 'invalid or corrupt torrent file', arguments: {} }))
    await expect(rpc('torrent-add')).rejects.toThrow('invalid or corrupt torrent file')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(500, {}))
    await expect(rpc('x')).rejects.toThrow('HTTP 500')
  })

  it('gives up if the 409 carries no session id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(409))
    const e = await rpc('x').catch(x => x)
    expect(e).toBeInstanceOf(RpcError)
    expect(e.method).toBe('x')
  })
})
