// The backend's orphan finder, faked for the sim: /api/orphans and its scan, keep and
// delete routes over a fixed set of leftovers. One delete is refused by the recheck and one
// fails, so the review's every row state shows without a real disk.

export interface SimOrphan {
  id: string
  group: string
  path: string
  kind: 'file' | 'dir' | 'empty' | 'symlink' | 'state'
  size: number
  files: number
  mtime: number
  flags?: string[]
  inside?: string
  match?: string
  name?: string
  hash?: string
  types?: Record<string, number>
  children?: { name: string; dir: boolean; size: number; files: number }[]
}

export interface OrphanStore {
  enabled: boolean
  entries: SimOrphan[]
  kept: { path: string; size: number; files: number; mtime: number }[]
  scans: number
  lastScan: number
}

export interface Answer {
  status: number
  body?: unknown
  /** NDJSON lines, streamed with a pause between them, instead of a JSON body. */
  lines?: unknown[]
}

const GB = 1e9
const DAY = 86400

export function createOrphans(enabled: boolean, now: number): OrphanStore {
  const e = (o: Omit<SimOrphan, 'id'>, i: number): SimOrphan => ({ id: `e${i + 1}`, ...o })
  const entries: Omit<SimOrphan, 'id'>[] = [
    { group: '/data/torrents', path: '/data/torrents/nasa-apollo-11-mission-audio', kind: 'dir', size: 18.4 * GB, files: 2904, mtime: now - 400 * DAY,
      types: { audio: 2896, document: 8 },
      children: [
        { name: '01 - Launch', dir: true, size: 2.6 * GB, files: 412 },
        { name: '02 - Translunar coast', dir: true, size: 4.4 * GB, files: 688 },
        { name: '03 - Lunar orbit', dir: true, size: 5.8 * GB, files: 903 },
      ] },
    { group: '/data/torrents', path: '/data/torrents/blender/Tears of Steel (2012) 4K', kind: 'dir', size: 11.8 * GB, files: 3, mtime: now - 240 * DAY,
      flags: ['hardlink'], types: { video: 1, subtitle: 1, document: 1 },
      children: [
        { name: 'tears_of_steel_4k.mov', dir: false, size: 11.7 * GB, files: 1 },
        { name: 'tears_of_steel_4k.en.srt', dir: false, size: 64e3, files: 1 },
      ] },
    { group: '/data/torrents', path: '/data/torrents/Big Buck Bunny (2008) 4K 60fps/bbb-extracted.mkv', kind: 'file', size: 7.1 * GB, files: 1, mtime: now - 21 * DAY,
      flags: ['inside'], inside: 'Big Buck Bunny (2008) 4K 60fps', types: { video: 1 } },
    { group: '/data/torrents', path: '/data/torrents/movies/public-domain/Plan 9 from Outer Space (1957)', kind: 'dir', size: 6.1 * GB, files: 4, mtime: now - 150 * DAY,
      types: { video: 1, subtitle: 1, image: 1, document: 1 },
      children: [{ name: 'Plan 9 from Outer Space (1957).mkv', dir: false, size: 6 * GB, files: 1 }] },
    { group: '/data/torrents', path: '/data/torrents/ubuntu-22.04.4-desktop-amd64.iso', kind: 'file', size: 4.7 * GB, files: 1, mtime: now - 210 * DAY,
      types: { 'disk image': 1 } },
    { group: '/data/torrents', path: '/data/torrents/sonarr/docs-old', kind: 'empty', size: 0, files: 0, mtime: now - 60 * DAY },
    { group: '/data/torrents', path: '/data/torrents/watch/archlinux-2025.11.01-x86_64.iso.torrent', kind: 'file', size: 100e3, files: 1, mtime: now - 365 * DAY,
      flags: ['torrent'], name: 'archlinux-2025.11.01-x86_64.iso', types: { torrent: 1 } },
    { group: '/data/incomplete', path: '/data/incomplete/debian-12.5.0-amd64-DVD-1.iso.part', kind: 'file', size: 2.3 * GB, files: 1, mtime: now - 120 * DAY,
      flags: ['partial'], types: { partial: 1 } },
    { group: '/data/incomplete', path: '/data/incomplete/fedora-Workstation-Live-41.iso.part', kind: 'file', size: 1.2 * GB, files: 1, mtime: now - 120,
      flags: ['partial', 'recent'], types: { partial: 1 } },
    { group: 'Transmission state', path: '/config/resume/3f2a9c1d7e5b4a6f8c0d2e1f3a5b7c9d0e2f4c91.resume', kind: 'state', size: 49e3, files: 2, mtime: now - 180 * DAY,
      flags: ['state'], name: 'openstreetmap-planet-2025-06', hash: '3f2a9c1d7e5b4a6f8c0d2e1f3a5b7c9d0e2f4c91' },
  ]
  return { enabled, entries: entries.map(e), kept: [], scans: 0, lastScan: 0 }
}

/** The ids whose delete the sim refuses, and how. */
const REFUSE: Record<string, Answer> = {
  e3: { status: 409, body: { error: 'now belongs to Big Buck Bunny (2008) 4K 60fps' } },
  e5: { status: 500, body: { error: 'permission denied' } },
}

export function orphanRoute(s: OrphanStore, method: string, path: string, body: string, now: number): Answer {
  if (!s.enabled) return { status: 404, body: { error: 'the orphan finder is not set up' } }
  let ref: { scan_id?: string; id?: string } = {}
  if (body) {
    try {
      ref = JSON.parse(body)
    } catch {
      return { status: 400, body: { error: 'bad JSON' } }
    }
  }
  const visible = () => s.entries.filter(e => !s.kept.some(k => k.path === e.path))
  const scanId = `sim-${s.scans}`
  const known = () => ref.scan_id === scanId && s.entries.find(e => e.id === ref.id)
  if (method === 'GET' && path === '') {
    return { status: 200, body: {
      roots: [{ path: '/data/torrents', free: 412 * GB }, { path: '/data/incomplete', free: 412 * GB }],
      config: '/config', kept: s.kept, ...(s.lastScan ? { last_scan: s.lastScan } : {}),
    } }
  }
  if (method === 'POST' && path === '/scan') {
    s.scans++
    s.lastScan = now
    const entries = visible()
    return { status: 200, lines: [
      { progress: { looked: 4120, path: '/data/torrents/movies' } },
      { progress: { looked: 9870, path: '/data/torrents/nasa-apollo-11-mission-audio' } },
      { progress: { looked: 14212, path: '/data/incomplete' } },
      { result: { scan_id: `sim-${s.scans}`, at: now, took_ms: 900, looked: 14212, hidden_kept: s.entries.length - entries.length, entries } },
    ] }
  }
  if (method === 'POST' && path === '/forget') {
    s.kept = []
    return { status: 200, body: { ok: true } }
  }
  if (method === 'POST' && (path === '/keep' || path === '/unkeep' || path === '/delete')) {
    const e = known()
    if (!e) return { status: 410, body: { error: 'this scan has expired, scan again' } }
    if (path === '/keep') {
      s.kept = s.kept.filter(k => k.path !== e.path)
      s.kept.push({ path: e.path, size: e.size, files: e.files, mtime: e.mtime })
      return { status: 200, body: { ok: true } }
    }
    if (path === '/unkeep') {
      s.kept = s.kept.filter(k => k.path !== e.path)
      return { status: 200, body: { ok: true } }
    }
    const refused = REFUSE[e.id]
    if (refused) return refused
    s.entries = s.entries.filter(x => x !== e)
    return { status: 200, body: { ok: true } }
  }
  return { status: 404, body: { error: 'no such route' } }
}
