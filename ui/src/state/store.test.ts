import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store reads localStorage and the URL at import time, so each case re-imports it fresh.
async function freshStore(url = '/', local: Record<string, string> = {}) {
  localStorage.clear()
  for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v)
  history.replaceState(null, '', url)
  vi.resetModules()
  return await import('./store')
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/') })

describe('initial sort', () => {
  it('sorts by name, so the error torrent no longer jumps to the top', async () => {
    const { get } = await freshStore()
    expect(get().sort).toBe('name')
    expect(get().sortDir).toBe(1)
  })

  it('still honours ?sort= from the URL', async () => {
    const { get } = await freshStore('/?sort=ratio')
    expect(get().sort).toBe('ratio')
  })

  it('keeps name out of the URL and puts any other sort in', async () => {
    const { set, syncUrl } = await freshStore()
    syncUrl()
    expect(location.search).toBe('')
    set({ sort: 'size' })
    syncUrl()
    expect(new URLSearchParams(location.search).get('sort')).toBe('size')
  })
})

describe('initial density', () => {
  it('defaults to compact, the one-line row', async () => {
    const { get } = await freshStore()
    expect(get().density).toBe('compact')
  })

  it('restores a saved comfortable setting', async () => {
    // Settings writes through writeLocal, which JSON-encodes
    const { get } = await freshStore('/', { 'tm.density': JSON.stringify('comfortable') })
    expect(get().density).toBe('comfortable')
  })

  it('falls back to compact when the stored value is unreadable', async () => {
    const { get } = await freshStore('/', { 'tm.density': 'not json' })
    expect(get().density).toBe('compact')
  })
})
