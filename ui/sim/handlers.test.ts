import { describe, expect, it } from 'vitest'
import { createState, type SimState } from './state.ts'
import { handle, RpcFailure } from './handlers.ts'
import { tick } from './tick.ts'
import { ST } from './derive.ts'

const T0 = 1_760_000_000_000
const NOW = Math.floor(T0 / 1000)

const fresh = () => createState({ seed: 5, nowMs: T0 })
const call = (s: SimState, method: string, args: Record<string, unknown> = {}, now = NOW) => handle(s, method, args, now)

describe('torrent-get', () => {
  it('returns only the requested fields', () => {
    const s = fresh()
    const r = call(s, 'torrent-get', { fields: ['id', 'name'] }) as { torrents: Record<string, unknown>[] }
    expect(Object.keys(r.torrents[0]).sort()).toEqual(['id', 'name'])
  })

  it('omits removed for an explicit id list', () => {
    const s = fresh()
    const r = call(s, 'torrent-get', { fields: ['id'], ids: [1] }) as Record<string, unknown>
    expect(r).not.toHaveProperty('removed')
  })
})

describe('recently-active', () => {
  it('returns only torrents active inside the window', () => {
    const s = fresh()
    for (const t of s.torrents) t.activityDate = NOW - 3600
    s.torrents[0].activityDate = NOW - 5
    s.torrents[1].activityDate = NOW - 59
    const r = call(s, 'torrent-get', { fields: ['id'], ids: 'recently-active' }) as { torrents: { id: number }[] }
    expect(r.torrents.map(t => t.id).sort((a, b) => a - b)).toEqual([s.torrents[0].id, s.torrents[1].id].sort((a, b) => a - b))
  })

  it('reports ids removed inside the window and forgets older ones', () => {
    const s = fresh()
    for (const t of s.torrents) t.activityDate = NOW - 3600
    call(s, 'torrent-remove', { ids: [3] })
    let r = call(s, 'torrent-get', { fields: ['id'], ids: 'recently-active' }) as { removed: number[] }
    expect(r.removed).toEqual([3])

    r = call(s, 'torrent-get', { fields: ['id'], ids: 'recently-active' }, NOW + 120) as { removed: number[] }
    expect(r.removed).toEqual([])
  })

  it('drops the torrent from the list as well', () => {
    const s = fresh()
    const before = s.torrents.length
    call(s, 'torrent-remove', { ids: [3, 4] })
    expect(s.torrents).toHaveLength(before - 2)
    expect(s.torrents.some(t => t.id === 3 || t.id === 4)).toBe(false)
  })
})

describe('start, stop and verify', () => {
  it('stop parks the rates and clears the eta', () => {
    const s = fresh()
    call(s, 'torrent-stop', { ids: [1] })
    const t = s.torrents.find(x => x.id === 1)!
    expect(t.status).toBe(ST.Stopped)
    expect(t.rateDownload).toBe(0)
    expect(t.eta).toBe(-1)
  })

  it('start clears an error', () => {
    const s = fresh()
    const broken = s.torrents.find(t => t.error !== 0)!
    call(s, 'torrent-start', { ids: [broken.id] })
    expect(broken.error).toBe(0)
    expect(broken.errorString).toBe('')
  })

  it('start-now jumps the queue', () => {
    const s = fresh()
    const last = [...s.torrents].sort((a, b) => b.queuePosition - a.queuePosition)[0]
    call(s, 'torrent-start-now', { ids: [last.id] })
    expect(last.queuePosition).toBe(0)
    expect(last.status === ST.Download || last.status === ST.Seed).toBe(true)
  })

  it('verify moves the valid bytes to unchecked and comes back to them', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.status === ST.Seed)!
    const had = t.haveValid
    call(s, 'torrent-verify', { ids: [t.id] })
    expect(t.haveValid).toBe(0)
    expect(t.haveUnchecked).toBe(had)
    for (let i = 1; i < 400; i++) tick(s, T0 + i * 2000)
    expect(t.haveValid).toBe(had)
    expect(t.haveUnchecked).toBe(0)
  })
})

describe('torrent-set', () => {
  it('shrinks sizeWhenDone when files are deselected', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 3)!
    const full = t.sizeWhenDone
    call(s, 'torrent-set', { ids: [t.id], 'files-unwanted': [0] })
    expect(t.fileStats[0].wanted).toBe(false)
    expect(t.sizeWhenDone).toBeLessThan(full)
    expect(t.haveValid + t.haveUnchecked + t.leftUntilDone).toBe(t.sizeWhenDone)
  })

  it('keeps file bytes summing to haveValid', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 3 && x.percentDone > 0 && x.percentDone < 1)!
    call(s, 'torrent-set', { ids: [t.id], 'priority-high': [1] })
    const sum = t.files.reduce((n, f) => n + f.bytesCompleted, 0)
    expect(Math.abs(sum - t.haveValid)).toBeLessThan(2)
    expect(t.fileStats[1].priority).toBe(1)
  })

  it('rebuilds trackerStats from a trackerList, with tiers', () => {
    const s = fresh()
    const t = s.torrents[0]
    call(s, 'torrent-set', { ids: [t.id], trackerList: 'udp://a.invalid/announce\n\nudp://b.invalid/announce' })
    expect(t.trackerStats.map(x => x.announce)).toEqual(['udp://a.invalid/announce', 'udp://b.invalid/announce'])
    expect(t.trackerStats.map(x => x.tier)).toEqual([0, 1])
    expect(t.magnetLink).toContain('tr=udp%3A%2F%2Fa.invalid%2Fannounce')
  })

  it('writes plain torrent options straight through', () => {
    const s = fresh()
    call(s, 'torrent-set', { ids: [1], labels: ['fresh'], uploadLimited: true, uploadLimit: 42 })
    const t = s.torrents.find(x => x.id === 1)!
    expect(t.labels).toEqual(['fresh'])
    expect(t.uploadLimit).toBe(42)
  })
})

describe('locations and renames', () => {
  it('moves the download dir', () => {
    const s = fresh()
    call(s, 'torrent-set-location', { ids: [1], location: '/data/torrents/elsewhere', move: true })
    expect(s.torrents.find(t => t.id === 1)!.downloadDir).toBe('/data/torrents/elsewhere')
  })

  it('renames the torrent and re-prefixes its files', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 2)!
    const old = t.name
    call(s, 'torrent-rename-path', { ids: [t.id], path: old, name: 'renamed' })
    expect(t.name).toBe('renamed')
    expect(t.files.every(f => f.name.startsWith('renamed'))).toBe(true)
  })

  it('renames a single file inside the torrent', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 2)!
    const target = t.files[1].name
    call(s, 'torrent-rename-path', { ids: [t.id], path: target, name: 'other.bin' })
    expect(t.files[1].name.endsWith('/other.bin')).toBe(true)
  })
})

describe('queue moves', () => {
  it('moves to the top and to the bottom', () => {
    const s = fresh()
    const id = s.torrents[5].id
    call(s, 'queue-move-top', { ids: [id] })
    expect(s.torrents.find(t => t.id === id)!.queuePosition).toBe(0)
    call(s, 'queue-move-bottom', { ids: [id] })
    expect(s.torrents.find(t => t.id === id)!.queuePosition).toBe(s.torrents.length - 1)
  })

  it('keeps positions a contiguous permutation', () => {
    const s = fresh()
    call(s, 'queue-move-up', { ids: [s.torrents[4].id, s.torrents[9].id] })
    const pos = s.torrents.map(t => t.queuePosition).sort((a, b) => a - b)
    expect(pos).toEqual(s.torrents.map((_, i) => i))
  })
})

describe('torrent-add', () => {
  const magnet = (hash: string, dn: string) =>
    `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}&tr=${encodeURIComponent('udp://tracker.example.invalid:1337/announce')}`

  it('parses a magnet and starts it fetching metadata', () => {
    const s = fresh()
    const hash = 'b'.repeat(40)
    const r = call(s, 'torrent-add', { filename: magnet(hash, 'Some Thing') }) as { 'torrent-added': { id: number } }
    const t = s.torrents.find(x => x.id === r['torrent-added'].id)!
    expect(t.hashString).toBe(hash)
    expect(t.metadataPercentComplete).toBe(0)
    expect(t.name).toBe(hash)
  })

  it('reports a duplicate instead of adding twice', () => {
    const s = fresh()
    const existing = s.torrents[2]
    const r = call(s, 'torrent-add', { filename: magnet(existing.hashString, 'x') }) as Record<string, { id: number }>
    expect(r['torrent-duplicate'].id).toBe(existing.id)
    expect(r['torrent-added']).toBeUndefined()
  })

  it('honours download-dir, labels and paused', () => {
    const s = fresh()
    const r = call(s, 'torrent-add', {
      filename: magnet('c'.repeat(40), 'y'), 'download-dir': '/data/torrents/books', labels: ['x'], paused: true,
    }) as { 'torrent-added': { id: number } }
    const t = s.torrents.find(x => x.id === r['torrent-added'].id)!
    expect(t.downloadDir).toBe('/data/torrents/books')
    expect(t.labels).toEqual(['x'])
    expect(t.status).toBe(ST.Stopped)
  })

  it('queues the addition when the download queue is full', () => {
    const s = fresh()
    const r = call(s, 'torrent-add', { filename: magnet('d'.repeat(40), 'z') }) as { 'torrent-added': { id: number } }
    const t = s.torrents.find(x => x.id === r['torrent-added'].id)!
    expect(t.status).toBe(ST.DownloadWait)
    expect(s.torrents.filter(x => x.status === ST.Download).length).toBe(s.session['download-queue-size'])
  })

  it('starts the addition straight away when the queue is off', () => {
    const s = fresh()
    call(s, 'session-set', { 'download-queue-enabled': false })
    const r = call(s, 'torrent-add', { filename: magnet('e'.repeat(40), 'z') }) as { 'torrent-added': { id: number } }
    expect(s.torrents.find(x => x.id === r['torrent-added'].id)!.status).toBe(ST.Download)
  })

  it('reads a name and size out of a base64 metainfo', () => {
    const s = fresh()
    // d4:infod6:lengthi1234e4:name8:demo.isoee
    const torrent = 'd4:infod6:lengthi1234e4:name8:demo.isoee'
    const r = call(s, 'torrent-add', { metainfo: Buffer.from(torrent, 'utf8').toString('base64') }) as { 'torrent-added': { name: string } }
    expect(r['torrent-added'].name).toBe('demo.iso')
    const t = s.torrents.find(x => x.name === 'demo.iso')!
    expect(t.sizeWhenDone).toBe(1234)
  })
})

describe('session', () => {
  it('writes settings through and follows port forwarding', () => {
    const s = fresh()
    call(s, 'session-set', { 'port-forwarding-enabled': false, 'peer-port': 6881 })
    expect(s.session['peer-port']).toBe(6881)
    expect((call(s, 'port-test') as Record<string, boolean>)['port-is-open']).toBe(false)
  })

  it('derives the stats from the live list', () => {
    const s = fresh()
    const r = call(s, 'session-stats') as { torrentCount: number; activeTorrentCount: number; pausedTorrentCount: number }
    expect(r.torrentCount).toBe(s.torrents.length)
    expect(r.activeTorrentCount + r.pausedTorrentCount).toBe(s.torrents.length)
  })

  it('updates the blocklist size', () => {
    const s = fresh()
    const r = call(s, 'blocklist-update') as Record<string, number>
    expect(r['blocklist-size']).toBe(s.session['blocklist-size'])
  })

  it('answers free-space for any path under the download dir', () => {
    const s = fresh()
    const r = call(s, 'free-space', { path: '/data/torrents/books' }) as Record<string, number | string>
    expect(r.path).toBe('/data/torrents/books')
    expect(r['size-bytes']).toBeGreaterThan(0)
  })

  it('rejects a method it does not implement', () => {
    const s = fresh()
    expect(() => call(s, 'torrent-teleport')).toThrow(RpcFailure)
  })
})
