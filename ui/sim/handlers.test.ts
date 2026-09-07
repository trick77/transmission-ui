import { describe, expect, it } from 'vitest'
import { createState, type SimState } from './state.ts'
import { handle, RpcFailure } from './handlers.ts'
import { tick } from './tick.ts'
import { ST, isChecking } from './derive.ts'

const T0 = 1_760_000_000_000
const NOW = Math.floor(T0 / 1000)

const fresh = () => createState({ seed: 5, nowMs: T0 })
const call = (s: SimState, method: string, args: Record<string, unknown> = {}, now = NOW) => handle(s, method, args, now)

describe('torrent_get', () => {
  it('returns only the requested fields', () => {
    const s = fresh()
    const r = call(s, 'torrent_get', { fields: ['id', 'name'] }) as { torrents: Record<string, unknown>[] }
    expect(Object.keys(r.torrents[0]).sort()).toEqual(['id', 'name'])
  })

  it('omits removed for an explicit id list', () => {
    const s = fresh()
    const r = call(s, 'torrent_get', { fields: ['id'], ids: [1] }) as Record<string, unknown>
    expect(r).not.toHaveProperty('removed')
  })
})

describe('recently_active', () => {
  it('returns only torrents active inside the window', () => {
    const s = fresh()
    for (const t of s.torrents) t.activity_date = NOW - 3600
    s.torrents[0].activity_date = NOW - 5
    s.torrents[1].activity_date = NOW - 59
    const r = call(s, 'torrent_get', { fields: ['id'], ids: 'recently_active' }) as { torrents: { id: number }[] }
    expect(r.torrents.map(t => t.id).sort((a, b) => a - b)).toEqual([s.torrents[0].id, s.torrents[1].id].sort((a, b) => a - b))
  })

  it('reports ids removed inside the window and forgets older ones', () => {
    const s = fresh()
    for (const t of s.torrents) t.activity_date = NOW - 3600
    call(s, 'torrent_remove', { ids: [3] })
    let r = call(s, 'torrent_get', { fields: ['id'], ids: 'recently_active' }) as { removed: number[] }
    expect(r.removed).toEqual([3])

    r = call(s, 'torrent_get', { fields: ['id'], ids: 'recently_active' }, NOW + 120) as { removed: number[] }
    expect(r.removed).toEqual([])
  })

  it('drops the torrent from the list as well', () => {
    const s = fresh()
    const before = s.torrents.length
    call(s, 'torrent_remove', { ids: [3, 4] })
    expect(s.torrents).toHaveLength(before - 2)
    expect(s.torrents.some(t => t.id === 3 || t.id === 4)).toBe(false)
  })
})

describe('start, stop and verify', () => {
  it('stop parks the rates and clears the eta', () => {
    const s = fresh()
    call(s, 'torrent_stop', { ids: [1] })
    const t = s.torrents.find(x => x.id === 1)!
    expect(t.status).toBe(ST.Stopped)
    expect(t.rate_download).toBe(0)
    expect(t.eta).toBe(-1)
  })

  it('start clears an error', () => {
    const s = fresh()
    const broken = s.torrents.find(t => t.error !== 0)!
    call(s, 'torrent_start', { ids: [broken.id] })
    expect(broken.error).toBe(0)
    expect(broken.error_string).toBe('')
  })

  it('start-now jumps the queue', () => {
    const s = fresh()
    const last = [...s.torrents].sort((a, b) => b.queue_position - a.queue_position)[0]
    call(s, 'torrent_start_now', { ids: [last.id] })
    expect(last.queue_position).toBe(0)
    expect(last.status === ST.Download || last.status === ST.Seed).toBe(true)
  })

  it('ignores start while a verify is in flight, rather than stranding the bytes', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.status === ST.Seed)!
    const had = t.have_valid
    call(s, 'torrent_verify', { ids: [t.id] })
    call(s, 'torrent_start_now', { ids: [t.id] })
    expect(isChecking(t.status)).toBe(true)
    expect(t.have_unchecked).toBe(had)
    for (let i = 1; i < 400; i++) tick(s, T0 + i * 2000)
    expect(t.have_valid).toBe(had)
    expect(t.percent_done).toBe(1)
  })

  it('stop cancels a verify and keeps the progress', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.status === ST.Seed)!
    const had = t.have_valid
    call(s, 'torrent_verify', { ids: [t.id] })
    call(s, 'torrent_stop', { ids: [t.id] })
    expect(t.status).toBe(ST.Stopped)
    expect(t.have_valid).toBe(had)
    expect(t.have_unchecked).toBe(0)
    expect(t.percent_done).toBe(1)
  })

  it('verify moves the valid bytes to unchecked and comes back to them', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.status === ST.Seed)!
    const had = t.have_valid
    call(s, 'torrent_verify', { ids: [t.id] })
    expect(t.have_valid).toBe(0)
    expect(t.have_unchecked).toBe(had)
    for (let i = 1; i < 400; i++) tick(s, T0 + i * 2000)
    expect(t.have_valid).toBe(had)
    expect(t.have_unchecked).toBe(0)
  })
})

describe('torrent_set', () => {
  it('shrinks size_when_done when files are deselected', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 3)!
    const full = t.size_when_done
    call(s, 'torrent_set', { ids: [t.id], 'files_unwanted': [0] })
    expect(t.file_stats[0].wanted).toBe(false)
    expect(t.size_when_done).toBeLessThan(full)
    expect(t.have_valid + t.have_unchecked + t.left_until_done).toBe(t.size_when_done)
  })

  it('keeps file bytes summing to have_valid', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 3 && x.percent_done > 0 && x.percent_done < 1)!
    call(s, 'torrent_set', { ids: [t.id], 'priority_high': [1] })
    const sum = t.files.reduce((n, f) => n + f.bytes_completed, 0)
    expect(Math.abs(sum - t.have_valid)).toBeLessThan(2)
    expect(t.file_stats[1].priority).toBe(1)
  })

  it('gives the bytes back when a deselected file is selected again', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 3 && x.percent_done >= 1)!
    const size = t.size_when_done
    const had = t.have_valid
    call(s, 'torrent_set', { ids: [t.id], 'files_unwanted': [0] })
    expect(t.size_when_done).toBeLessThan(size)
    call(s, 'torrent_set', { ids: [t.id], 'files_wanted': [0] })
    expect(t.size_when_done).toBe(size)
    expect(t.have_valid).toBe(had)
    expect(t.percent_done).toBe(1)
  })

  it('keeps the byte invariant while files are deselected', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 3 && x.percent_done > 0 && x.percent_done < 1)!
    call(s, 'torrent_set', { ids: [t.id], 'files_unwanted': [0, 1] })
    expect(t.have_valid + t.have_unchecked + t.left_until_done).toBe(t.size_when_done)
    expect(t.percent_done).toBeLessThanOrEqual(1)
  })

  it('rebuilds tracker_stats from a tracker_list, with tiers', () => {
    const s = fresh()
    const t = s.torrents[0]
    call(s, 'torrent_set', { ids: [t.id], tracker_list: 'udp://a.invalid/announce\n\nudp://b.invalid/announce' })
    expect(t.tracker_stats.map(x => x.announce)).toEqual(['udp://a.invalid/announce', 'udp://b.invalid/announce'])
    expect(t.tracker_stats.map(x => x.tier)).toEqual([0, 1])
    expect(t.magnet_link).toContain('tr=udp%3A%2F%2Fa.invalid%2Fannounce')
  })

  it('writes plain torrent options straight through', () => {
    const s = fresh()
    call(s, 'torrent_set', { ids: [1], labels: ['fresh'], upload_limited: true, upload_limit: 42 })
    const t = s.torrents.find(x => x.id === 1)!
    expect(t.labels).toEqual(['fresh'])
    expect(t.upload_limit).toBe(42)
  })
})

describe('locations and renames', () => {
  it('moves the download dir', () => {
    const s = fresh()
    call(s, 'torrent_set_location', { ids: [1], location: '/data/torrents/elsewhere', move: true })
    expect(s.torrents.find(t => t.id === 1)!.download_dir).toBe('/data/torrents/elsewhere')
  })

  it('renames the torrent and re-prefixes its files', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 2)!
    const old = t.name
    call(s, 'torrent_rename_path', { ids: [t.id], path: old, name: 'renamed' })
    expect(t.name).toBe('renamed')
    expect(t.files.every(f => f.name.startsWith('renamed'))).toBe(true)
  })

  it('renames a single file inside the torrent', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.files.length > 2)!
    const target = t.files[1].name
    call(s, 'torrent_rename_path', { ids: [t.id], path: target, name: 'other.bin' })
    expect(t.files[1].name.endsWith('/other.bin')).toBe(true)
  })
})

describe('queue moves', () => {
  it('moves to the top and to the bottom', () => {
    const s = fresh()
    const id = s.torrents[5].id
    call(s, 'queue_move_top', { ids: [id] })
    expect(s.torrents.find(t => t.id === id)!.queue_position).toBe(0)
    call(s, 'queue_move_bottom', { ids: [id] })
    expect(s.torrents.find(t => t.id === id)!.queue_position).toBe(s.torrents.length - 1)
  })

  it('keeps positions a contiguous permutation', () => {
    const s = fresh()
    call(s, 'queue_move_up', { ids: [s.torrents[4].id, s.torrents[9].id] })
    const pos = s.torrents.map(t => t.queue_position).sort((a, b) => a - b)
    expect(pos).toEqual(s.torrents.map((_, i) => i))
  })
})

describe('torrent_add', () => {
  const magnet = (hash: string, dn: string) =>
    `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}&tr=${encodeURIComponent('udp://tracker.example.invalid:1337/announce')}`

  it('parses a magnet and starts it fetching metadata', () => {
    const s = fresh()
    const hash = 'b'.repeat(40)
    const r = call(s, 'torrent_add', { filename: magnet(hash, 'Some Thing') }) as { 'torrent_added': { id: number } }
    const t = s.torrents.find(x => x.id === r.torrent_added.id)!
    expect(t.hash_string).toBe(hash)
    expect(t.metadata_percent_complete).toBe(0)
    expect(t.name).toBe('Some Thing')
  })

  it('falls back to the hash as the name when the magnet carries no dn', () => {
    const s = fresh()
    const hash = '7'.repeat(40)
    const r = call(s, 'torrent_add', { filename: `magnet:?xt=urn:btih:${hash}` }) as { 'torrent_added': { id: number } }
    expect(s.torrents.find(x => x.id === r.torrent_added.id)!.name).toBe(hash)
  })

  it('reports a duplicate instead of adding twice', () => {
    const s = fresh()
    const existing = s.torrents[2]
    const r = call(s, 'torrent_add', { filename: magnet(existing.hash_string, 'x') }) as Record<string, { id: number }>
    expect(r.torrent_duplicate.id).toBe(existing.id)
    expect(r.torrent_added).toBeUndefined()
  })

  it('honours download-dir, labels and paused', () => {
    const s = fresh()
    const r = call(s, 'torrent_add', {
      filename: magnet('c'.repeat(40), 'y'), 'download_dir': '/data/torrents/books', labels: ['x'], paused: true,
    }) as { 'torrent_added': { id: number } }
    const t = s.torrents.find(x => x.id === r.torrent_added.id)!
    expect(t.download_dir).toBe('/data/torrents/books')
    expect(t.labels).toEqual(['x'])
    expect(t.status).toBe(ST.Stopped)
  })

  it('queues the addition when the download queue is full', () => {
    const s = fresh()
    const r = call(s, 'torrent_add', { filename: magnet('d'.repeat(40), 'z') }) as { 'torrent_added': { id: number } }
    const t = s.torrents.find(x => x.id === r.torrent_added.id)!
    expect(t.status).toBe(ST.DownloadWait)
    expect(s.torrents.filter(x => x.status === ST.Download).length).toBe(s.session.download_queue_size)
  })

  it('starts the addition straight away when the queue is off', () => {
    const s = fresh()
    call(s, 'session_set', { 'download_queue_enabled': false })
    const r = call(s, 'torrent_add', { filename: magnet('e'.repeat(40), 'z') }) as { 'torrent_added': { id: number } }
    expect(s.torrents.find(x => x.id === r.torrent_added.id)!.status).toBe(ST.Download)
  })

  it('reads a name and size out of a base64 metainfo', () => {
    const s = fresh()
    // d4:infod6:lengthi1234e4:name8:demo.isoee
    const torrent = 'd4:infod6:lengthi1234e4:name8:demo.isoee'
    const r = call(s, 'torrent_add', { metainfo: Buffer.from(torrent, 'utf8').toString('base64') }) as { 'torrent_added': { name: string } }
    expect(r.torrent_added.name).toBe('demo.iso')
    const t = s.torrents.find(x => x.name === 'demo.iso')!
    expect(t.size_when_done).toBe(1234)
  })

  it('reports a duplicate when the same .torrent is added twice', () => {
    const s = fresh()
    const b64 = Buffer.from('d4:infod6:lengthi99e4:name5:a.isoee', 'utf8').toString('base64')
    const first = call(s, 'torrent_add', { metainfo: b64 }) as Record<string, { id: number }>
    const again = call(s, 'torrent_add', { metainfo: b64 }) as Record<string, { id: number }>
    expect(again.torrent_duplicate?.id).toBe(first.torrent_added.id)
  })

  it('shows the magnet display name and no file list until metadata lands', () => {
    const s = fresh()
    const r = call(s, 'torrent_add', { filename: magnet('9'.repeat(40), 'Pending Thing') }) as { 'torrent_added': { id: number } }
    const t = s.torrents.find(x => x.id === r.torrent_added.id)!
    expect(t.name).toBe('Pending Thing')
    expect(t.files).toEqual([])
    expect(t.size_when_done).toBe(0)
    expect(t.piece_count).toBe(0)
  })

  it('does not fetch metadata for a paused magnet', () => {
    const s = fresh()
    const r = call(s, 'torrent_add', { filename: magnet('8'.repeat(40), 'Paused'), paused: true }) as { 'torrent_added': { id: number } }
    const t = s.torrents.find(x => x.id === r.torrent_added.id)!
    for (let i = 1; i < 200; i++) tick(s, T0 + i * 2000)
    expect(t.status).toBe(ST.Stopped)
    expect(t.metadata_percent_complete).toBe(0)
  })
})

describe('session', () => {
  it('writes settings through and follows port forwarding', () => {
    const s = fresh()
    call(s, 'session_set', { 'port_forwarding_enabled': false, 'peer_port': 6881 })
    expect(s.session.peer_port).toBe(6881)
    expect((call(s, 'port_test') as Record<string, boolean>).port_is_open).toBe(false)
  })

  it('derives the stats from the live list', () => {
    const s = fresh()
    const r = call(s, 'session_stats') as { torrent_count: number; active_torrent_count: number; paused_torrent_count: number }
    expect(r.torrent_count).toBe(s.torrents.length)
    expect(r.active_torrent_count + r.paused_torrent_count).toBe(s.torrents.length)
  })

  it('updates the blocklist size', () => {
    const s = fresh()
    const r = call(s, 'blocklist_update') as Record<string, number>
    expect(r.blocklist_size).toBe(s.session.blocklist_size)
  })

  it('answers free-space for any path under the download dir', () => {
    const s = fresh()
    const r = call(s, 'free_space', { path: '/data/torrents/books' }) as Record<string, number | string>
    expect(r.path).toBe('/data/torrents/books')
    expect(r.size_bytes).toBeGreaterThan(0)
  })

  it('rejects a method it does not implement', () => {
    const s = fresh()
    expect(() => call(s, 'torrent-teleport')).toThrow(RpcFailure)
  })
})

describe('ids', () => {
  it('treats a bare id as one torrent, not as every torrent', () => {
    const s = fresh()
    const before = s.torrents.length
    call(s, 'torrent_remove', { ids: 3 })
    expect(s.torrents).toHaveLength(before - 1)
    expect(s.torrents.some(t => t.id === 3)).toBe(false)
  })

  it('resolves a hash string', () => {
    const s = fresh()
    const t = s.torrents[4]
    const r = call(s, 'torrent_get', { fields: ['id'], ids: t.hash_string }) as { torrents: { id: number }[] }
    expect(r.torrents).toEqual([{ id: t.id }])
  })

  it('still means every torrent when omitted', () => {
    const s = fresh()
    const r = call(s, 'torrent_get', { fields: ['id'] }) as { torrents: unknown[] }
    expect(r.torrents).toHaveLength(s.torrents.length)
  })

  it('selects nothing for an id that does not exist', () => {
    const s = fresh()
    const before = s.torrents.length
    call(s, 'torrent_remove', { ids: 99999 })
    expect(s.torrents).toHaveLength(before)
  })
})
