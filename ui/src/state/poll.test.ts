import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDaemon, type FakeDaemon } from '../test/fakeDaemon'

// The poll loop keeps its counters at module level, so each case imports a fresh store.
let daemon: FakeDaemon
async function start(opts: Parameters<typeof installFakeDaemon>[0] = {}, url = '/') {
  localStorage.clear()
  history.replaceState(null, '', url)
  vi.resetModules()
  daemon = installFakeDaemon(opts)
  const store = await import('./store')
  store.startPolling()
  await settle()
  return store
}
// Lets the in-flight requests resolve without reaching the next 2 s tick.
const settle = () => vi.advanceTimersByTimeAsync(50)
const tick = () => vi.advanceTimersByTimeAsync(2000)
const lists = () => daemon.of('torrent_get').filter(a => (a.fields as string[]).includes('name'))
const details = () => daemon.of('torrent_get').filter(a => !(a.fields as string[]).includes('name'))

/** Holds every request `match` picks until release() is called. */
function gate(match: (method: string, params: Record<string, unknown>) => boolean) {
  // fetch is already the fake daemon's spy; wrap its implementation rather than spy again.
  const inner = vi.mocked(globalThis.fetch).getMockImplementation()!
  let open: () => void = () => {}
  const held = new Promise<void>(r => { open = r })
  vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
    if (match(body.method, body.params)) await held
    return inner(url, init)
  })
  return open
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { daemon?.restore(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('list poll', () => {
  it('starts with one full pass that also reads the session', async () => {
    const { get } = await start()
    expect(get().torrents).toHaveLength(8)
    expect(get().connection).toBe('ok')
    expect(lists()).toHaveLength(1)
    expect(lists()[0].ids).toBeUndefined()
    expect(daemon.of('session_get')).toHaveLength(1)
  })

  it('a delta with nothing in it leaves the list untouched', async () => {
    const { get } = await start()
    const { torrents, byId } = get()
    await tick()
    expect(lists().at(-1)!.ids).toBe('recently_active')
    expect(get().torrents).toBe(torrents)
    expect(get().byId).toBe(byId)
  })

  it('a delta replaces only the rows that changed and drops the removed ones', async () => {
    const { get } = await start()
    const before = get().byId
    daemon.torrents[0].rate_download = 1
    daemon.torrents = daemon.torrents.filter(t => t.id !== 2)
    await tick()
    expect(get().byId.get(1)).not.toBe(before.get(1))
    expect(get().byId.get(1)!.rate_download).toBe(1)
    expect(get().byId.get(3)).toBe(before.get(3))
    expect(get().byId.has(2)).toBe(false)
    expect(get().torrents).toHaveLength(7)
  })

  it('refreshNow during a poll in flight still gets its full pass', async () => {
    const { refreshNow } = await start()
    const release = gate(m => m === 'session_stats')
    await tick()                       // a delta pass, now stuck on its stats request
    expect(lists().at(-1)!.ids).toBe('recently_active')
    const sessions = daemon.of('session_get').length
    refreshNow()
    release()
    await settle()
    expect(lists().at(-1)!.ids).toBeUndefined()
    expect(daemon.of('session_get')).toHaveLength(sessions + 1)
  })

  it('stops polling once signed out', async () => {
    await start({ unauthorized: true })
    const { get } = await import('./store')
    expect(get().connection).toBe('unauthorized')
    const calls = vi.mocked(globalThis.fetch).mock.calls.length
    await tick(); await tick()
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(calls)
  })
})

describe('inspector poll', () => {
  it('fetches everything on focus, then only what the open tab shows', async () => {
    const { get, focus, setInspectorTab } = await start()
    focus(8)
    await settle()
    expect(details()).toHaveLength(1)
    expect(details()[0].fields).toContain('files')
    const files = get().detail!.files
    await tick()
    expect(details().at(-1)!.fields).toEqual(expect.arrayContaining(['id', 'pieces']))
    expect(details().at(-1)!.fields).not.toContain('files')
    expect(details().at(-1)!.fields).not.toContain('peers')
    // untouched, so the file tree is not rebuilt
    expect(get().detail!.files).toBe(files)
    setInspectorTab('peers')
    await settle()
    expect(details().at(-1)!.fields).toEqual(['id', 'peers'])
  })

  it('a reply for the torrent focused before never lands on the next one', async () => {
    const { get, focus } = await start()
    focus(8)
    await settle()
    const release = gate((m, p) => m === 'torrent_get' && Array.isArray(p.ids) && p.ids[0] === 8)
    await tick()                       // 8's refresh is now held
    focus(1)
    await settle()
    expect(get().detail!.id).toBe(1)
    release()
    await settle()
    expect(get().detail!.id).toBe(1)
  })

  it('closes on a torrent that is gone, and takes it out of the URL', async () => {
    const { get } = await start({}, '/?sel=999')
    expect(get().focusId).toBeNull()
    expect(location.search).toBe('')
  })
})

describe('toast', () => {
  it('a repeat of the same message gets its own full time on screen', async () => {
    const { get, toast } = await start()
    toast('Remove failed')
    await vi.advanceTimersByTimeAsync(3000)
    toast('Remove failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(get().toast).toBe('Remove failed')
    await vi.advanceTimersByTimeAsync(2600)
    expect(get().toast).toBe('')
  })
})
