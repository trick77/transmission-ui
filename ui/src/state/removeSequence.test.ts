import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDaemon, torrent, type FakeDaemon } from '../test/fakeDaemon'

// The store reads localStorage and the URL at import time, so each case re-imports it fresh.
async function freshStore() {
  localStorage.clear()
  history.replaceState(null, '', '/')
  vi.resetModules()
  return await import('./store')
}

/**
 * Resolve pending microtasks so one awaited RPC round-trip lands. A round-trip runs
 * through fetch, Response.json and several store updates, so this needs to be generous --
 * four ticks is not enough and the shortfall looks exactly like a logic bug.
 */
const settle = async (n = 25) => { for (let i = 0; i < n; i++) await Promise.resolve() }

const three = () => [
  torrent({ id: 1, name: 'alpha' }),
  torrent({ id: 2, name: 'bravo' }),
  torrent({ id: 3, name: 'charlie' }),
]

let d: FakeDaemon | null = null
beforeEach(() => { d?.restore(); d = null; localStorage.clear() })

describe('removeSequence with delete-data', () => {
  it('sends one torrent_remove per torrent, not one call with an id array', async () => {
    d = installFakeDaemon({ torrents: three() })
    const { removeSequence, set } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1, 2, 3], true)

    const calls = d.of('torrent_remove')
    expect(calls).toHaveLength(3)
    expect(calls.map(c => c.ids)).toEqual([[1], [2], [3]])
    expect(calls.every(c => c.delete_local_data === true)).toBe(true)
  })

  it('walks the batch in store order when the list has published none', async () => {
    d = installFakeDaemon({ torrents: three() })
    const { removeSequence, set } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    // ids arrive in the order the user clicked them
    await removeSequence([3, 1, 2], true)

    expect(d.of('torrent_remove').map(c => c.ids)).toEqual([[1], [2], [3]])
  })

  it('follows the order the rows are displayed in, not the store or the click order', async () => {
    d = installFakeDaemon({ torrents: three() })
    const { removeSequence, setViewOrder, set } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })
    // what List.tsx shows: sorted descending, so progress should walk 3, 2, 1
    setViewOrder([3, 2, 1])

    await removeSequence([1, 2, 3], true)

    expect(d.of('torrent_remove').map(c => c.ids)).toEqual([[3], [2], [1]])
  })

  it('drops each row as its own response lands, rather than waiting for a poll', async () => {
    const gates: (() => void)[] = []
    const seen: number[][] = []
    d = installFakeDaemon({
      torrents: three(),
      onRemove: () => new Promise<void>(r => { gates.push(r) }),
    })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    const done = removeSequence([1, 2, 3], true)
    for (let i = 0; i < 3; i++) {
      await settle()
      seen.push(get().torrents.map(t => t.id))
      gates.shift()?.()
      await settle()
    }
    await done

    // the first snapshot still has all three, and the list shrinks one torrent at a time
    expect(seen[0]).toEqual([1, 2, 3])
    expect(seen[1]).toEqual([2, 3])
    expect(seen[2]).toEqual([3])
  })

  it('marks the torrent being unlinked so the row can say so', async () => {
    // one gate per call: releasing the first must not also release the next
    const gates: (() => void)[] = []
    d = installFakeDaemon({ torrents: three(), onRemove: () => new Promise<void>(r => { gates.push(r) }) })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    const done = removeSequence([1, 2, 3], true)
    await settle()
    expect(get().removing?.active).toBe(1)
    expect(get().removing?.deleteData).toBe(true)

    gates.shift()?.()
    await settle()
    expect(get().removing?.active).toBe(2)

    gates.shift()?.(); await settle()
    gates.shift()?.(); await settle()
    await done
  })

  it('takes the batch out of the selection so a second remove cannot be fired at it', async () => {
    d = installFakeDaemon({ torrents: three() })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])), selected: new Set([1, 2, 3]) })

    await removeSequence([1, 2], true)

    expect([...get().selected]).toEqual([3])
  })
})

describe('partial failure', () => {
  it('keeps going after one torrent fails, and remembers which', async () => {
    d = installFakeDaemon({
      torrents: three(),
      onRemove: ids => { if (ids[0] === 2) throw new Error('permission denied') },
    })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1, 2, 3], true)

    // all three were attempted
    expect(d.of('torrent_remove')).toHaveLength(3)
    const r = get().removing
    expect(r?.failed).toHaveLength(1)
    expect(r?.failed[0].id).toBe(2)
    expect(r?.failed[0].msg).toContain('permission denied')
  })

  it('leaves the summary on screen when something failed, instead of clearing itself', async () => {
    d = installFakeDaemon({ torrents: three(), onRemove: ids => { if (ids[0] === 2) throw new Error('nope') } })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1, 2, 3], true)

    // a failed removal must not vanish silently -- that is the bug this feature exists to fix
    expect(get().removing).not.toBeNull()
    expect(get().removing?.done).toBe(3)
  })

  it('clears itself and toasts when every torrent went', async () => {
    d = installFakeDaemon({ torrents: three() })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1, 2, 3], true)

    expect(get().removing).toBeNull()
    expect(get().toast).toContain('3 torrents')
  })

  it('lets the user retry the torrent that just failed, instead of swallowing it', async () => {
    let fail = true
    d = installFakeDaemon({ torrents: three(), onRemove: () => { if (fail) throw new Error('permission denied') } })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1], true)
    expect(get().removing?.failed).toHaveLength(1)   // summary still on screen

    // user fixes the permissions and tries again: this must start a new run, not be dropped
    fail = false
    await removeSequence([1], true)

    expect(d.of('torrent_remove')).toHaveLength(2)
    expect(get().removing).toBeNull()
  })

  it('refuses a second run while one is actually in flight, and says so', async () => {
    const gates: (() => void)[] = []
    d = installFakeDaemon({ torrents: three(), onRemove: () => new Promise<void>(r => { gates.push(r) }) })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    const done = removeSequence([1, 2], true)
    await settle()
    await removeSequence([3], true)

    expect(get().toast).toContain('already running')
    expect(d.of('torrent_remove').map(c => c.ids)).toEqual([[1]])   // torrent 3 was not sent

    gates.shift()?.(); await settle()
    gates.shift()?.(); await settle()
    await done
  })

  it('dismissRemoval clears a finished run with failures', async () => {
    d = installFakeDaemon({ torrents: three(), onRemove: ids => { if (ids[0] === 1) throw new Error('nope') } })
    const { removeSequence, dismissRemoval, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1], true)
    expect(get().removing).not.toBeNull()
    dismissRemoval()
    expect(get().removing).toBeNull()
  })
})

describe('remove from list', () => {
  it('stays a single call with the whole id array: it does not touch the disk', async () => {
    d = installFakeDaemon({ torrents: three() })
    const { removeSequence, set } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1, 2, 3], false)

    const calls = d.of('torrent_remove')
    expect(calls).toHaveLength(1)
    expect(calls[0].ids).toEqual([1, 2, 3])
    expect(calls[0].delete_local_data).toBe(false)
  })

  it('toasts a transport error instead of blaming every row in the batch', async () => {
    d = installFakeDaemon({ torrents: three(), onRemove: () => { throw new Error('HTTP 502') } })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    await removeSequence([1, 2, 3], false)

    // the batch never reached the daemon, so no individual torrent failed
    expect(get().toast).toContain('502')
    expect(get().removing).toBeNull()
  })
})

describe('a run that outlives its own stop', () => {
  it('does not keep deleting after Stop, even once a later run has started', async () => {
    const gates: (() => void)[] = []
    d = installFakeDaemon({ torrents: three(), onRemove: () => new Promise<void>(r => { gates.push(r) }) })
    const { removeSequence, stopRemoval, dismissRemoval, set } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    const first = removeSequence([1, 2, 3], true)
    await settle()
    stopRemoval()
    dismissRemoval()              // user clears the bar while torrent 1 is still unlinking

    // a fresh run starts before the old one's reply lands
    const second = removeSequence([3], true)
    await settle()
    gates.shift()?.()             // torrent 1 finally comes back, inside the stopped loop
    await settle()
    gates.shift()?.()
    await settle()
    await Promise.all([first, second])

    // torrent 2 must never have been asked for: the user pressed Stop
    expect(d.of('torrent_remove').map(c => c.ids)).toEqual([[1], [3]])
  })

  it('does not count a stale reply against the run now on screen', async () => {
    const gates: (() => void)[] = []
    d = installFakeDaemon({ torrents: three(), onRemove: () => new Promise<void>(r => { gates.push(r) }) })
    const { removeSequence, stopRemoval, dismissRemoval, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    const first = removeSequence([1, 2], true)
    await settle()
    stopRemoval(); dismissRemoval()

    const second = removeSequence([3], true)
    await settle()
    gates.shift()?.()             // the old run's reply
    await settle()
    // the new run has one torrent and has not had its own reply yet
    expect(get().removing?.done).toBe(0)

    gates.shift()?.(); await settle()
    await Promise.all([first, second])
  })
})

describe('the inspector', () => {
  it('closes when the torrent it is showing is deleted', async () => {
    d = installFakeDaemon({ torrents: three() })
    const { removeSequence, set, get } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])), focusId: 2 })

    await removeSequence([2], true)

    // the poll that would normally notice cannot run while the daemon is unlinking
    expect(get().focusId).toBeNull()
    expect(get().detail).toBeNull()
  })
})

describe('stopRemoval', () => {
  it('stops issuing further removes', async () => {
    const gates: (() => void)[] = []
    d = installFakeDaemon({ torrents: three(), onRemove: () => new Promise<void>(r => { gates.push(r) }) })
    const { removeSequence, stopRemoval, set } = await freshStore()
    set({ torrents: three(), byId: new Map(three().map(t => [t.id, t])) })

    const done = removeSequence([1, 2, 3], true)
    await settle()
    stopRemoval()
    gates.shift()?.()    // the in-flight one still completes: the daemon is mid-unlink
    await settle()
    await done

    // torrent 1 went, 2 and 3 were never asked for
    expect(d.of('torrent_remove').map(c => c.ids)).toEqual([[1]])
  })
})
