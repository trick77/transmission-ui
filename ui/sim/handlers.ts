// The RPC surface. One switch, daemon field names throughout, every write mutating real state so
// the UI's next poll shows the consequence.

import type { Session, TorrentDetail, TrackerStat } from '../src/rpc/types.ts'
import { createHash } from 'node:crypto'
import { decode } from '../src/lib/bencode.ts'
import { ST, hostOf, isChecking, magnetOf, refreshPieceMap, reconcile, renumberQueue, wantedHave, wantedSize } from './derive.ts'
import { newTorrent, TRACKERS, BASE } from './data.ts'
import { byId, mountOf, simFieldsFor, type SimState } from './state.ts'
import { promoteQueue, seedGoal, etaOf } from './tick.ts'

export class RpcFailure extends Error {}

type Args = Record<string, unknown>

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/**
 * The RPC spec lets `ids` be an array, a single id, a hash string, or "recently-active"; the bundled
 * UI only ever sends arrays, but `make sim-server` invites curl, where a bare `{"ids": 5}` falling
 * through to "all torrents" would turn one remove into a wipe. Undefined still means all, as it must.
 */
export function normalizeIds(state: SimState, raw: unknown): number[] | 'recently-active' | undefined {
  if (raw == null) return undefined
  if (raw === 'recently-active') return 'recently-active'
  const one = (v: unknown): number[] => {
    if (typeof v === 'number') return Number.isFinite(v) ? [v] : []
    if (typeof v === 'string') {
      const byHash = state.torrents.find(t => t.hashString === v.toLowerCase())
      return byHash ? [byHash.id] : []
    }
    return []
  }
  return Array.isArray(raw) ? raw.flatMap(one) : one(raw)
}

export function handle(state: SimState, method: string, args: Args, now: number): unknown {
  const ids = normalizeIds(state, args.ids)
  const selected = (): TorrentDetail[] =>
    Array.isArray(ids) ? state.torrents.filter(t => ids.includes(t.id)) : state.torrents
  const touch = (ts: TorrentDetail[]) => { for (const t of ts) t.activityDate = now }

  switch (method) {
    // ── session ──────────────────────────────────────────────────────────────
    case 'session-get':
      return { ...state.session }

    case 'session-set': {
      const patch = { ...args }
      delete patch.ids
      Object.assign(state.session, patch as Partial<Session>)
      state.portOpen = state.session['port-forwarding-enabled']
      // A bigger queue takes effect immediately rather than a poll later.
      promoteQueue(state, now)
      return {}
    }

    case 'session-stats': {
      const active = state.torrents.filter(t => t.status !== ST.Stopped).length
      return {
        activeTorrentCount: active,
        pausedTorrentCount: state.torrents.length - active,
        torrentCount: state.torrents.length,
        downloadSpeed: state.torrents.reduce((n, t) => n + t.rateDownload, 0),
        uploadSpeed: state.torrents.reduce((n, t) => n + t.rateUpload, 0),
        'current-stats': round(state.cur),
        'cumulative-stats': round(state.cum),
      }
    }

    case 'free-space': {
      const path = String(args.path ?? BASE)
      const mount = mountOf(path, state.session['download-dir'])
      const e = state.space.get(mount) ?? state.space.get(BASE)!
      return { path, 'size-bytes': Math.round(e.size), total_size: Math.round(e.total) }
    }

    case 'port-test':
      return { 'port-is-open': state.portOpen }

    case 'blocklist-update': {
      const size = 300_000 + state.rand.int(0, 200_000)
      state.session['blocklist-size'] = size
      return { 'blocklist-size': size }
    }

    // ── reads ────────────────────────────────────────────────────────────────
    case 'torrent-get': {
      const fields = (args.fields as string[] | undefined) ?? []
      const wantsDetail = fields.includes('pieces') || fields.includes('availability')
      let list: TorrentDetail[]
      let removed: number[] | undefined

      if (ids === 'recently-active') {
        const cut = now - state.recentWindowSec
        list = state.torrents.filter(t => t.activityDate >= cut)
        removed = state.removed.filter(r => r.at >= cut).map(r => r.id)
      } else {
        list = selected()
      }
      if (wantsDetail) for (const t of list) refreshPieceMap(t, state.sim.get(t.id)?.swarm ?? 3)
      const torrents = list.map(t => pick(t, fields))
      return removed ? { torrents, removed } : { torrents }
    }

    // ── writes ───────────────────────────────────────────────────────────────
    case 'torrent-start':
    case 'torrent-start-now': {
      // A verify in flight owns the torrent's bytes: haveValid is parked in haveUnchecked until it
      // finishes. Starting here would read the stale percentDone and strand them, so the daemon
      // makes start a no-op on a checking torrent and so do we.
      const ts = selected().filter(t => !isChecking(t.status))
      for (const t of ts) {
        t.error = 0
        t.errorString = ''
        t.isFinished = false
        const done = t.percentDone >= 1 && t.metadataPercentComplete >= 1
        if (method === 'torrent-start-now') {
          t.status = (done ? ST.Seed : ST.Download) as TorrentDetail['status']
          t.queuePosition = -1
          renumberQueue(state.torrents)
        } else {
          t.status = (done ? ST.SeedWait : ST.DownloadWait) as TorrentDetail['status']
        }
      }
      touch(ts)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent-stop': {
      const ts = selected()
      for (const t of ts) {
        // Stopping cancels a verify. Fold the unchecked bytes back so progress survives it.
        if (isChecking(t.status)) {
          t.haveValid += t.haveUnchecked
          t.haveUnchecked = 0
          t.recheckProgress = 0
          reconcile(t)
        }
        t.status = ST.Stopped as TorrentDetail['status']
        t.rateDownload = 0
        t.rateUpload = 0
        t.eta = -1
      }
      touch(ts)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent-verify': {
      const ts = selected()
      for (const t of ts) {
        const f = state.sim.get(t.id)
        if (f) f.prevStatus = t.status === ST.Stopped ? ST.Stopped : t.percentDone >= 1 ? ST.Seed : ST.Download
        t.haveUnchecked = t.haveValid
        t.haveValid = 0
        t.recheckProgress = 0
        t.status = ST.CheckWait as TorrentDetail['status']
      }
      touch(ts)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent-reannounce': {
      const ts = selected()
      for (const t of ts) for (const s of t.trackerStats) s.nextAnnounceTime = now
      touch(ts)
      return {}
    }

    case 'torrent-remove': {
      const gone = selected()
      const keep = new Set(gone.map(t => t.id))
      state.torrents = state.torrents.filter(t => !keep.has(t.id))
      for (const t of gone) {
        state.removed.push({ id: t.id, at: now })
        state.sim.delete(t.id)
        if (args['delete-local-data']) {
          const e = state.space.get(mountOf(t.downloadDir, state.session['download-dir']))
          if (e) e.size += t.haveValid
        }
      }
      renumberQueue(state.torrents)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent-set': {
      const ts = selected()
      const rest = { ...args }
      delete rest.ids
      const idx = (k: string) => (rest[k] as number[] | undefined) ?? []
      for (const t of ts) {
        for (const i of idx('files-wanted')) if (t.fileStats[i]) t.fileStats[i].wanted = true
        for (const i of idx('files-unwanted')) if (t.fileStats[i]) t.fileStats[i].wanted = false
        for (const i of idx('priority-high')) if (t.fileStats[i]) t.fileStats[i].priority = 1
        for (const i of idx('priority-normal')) if (t.fileStats[i]) t.fileStats[i].priority = 0
        for (const i of idx('priority-low')) if (t.fileStats[i]) t.fileStats[i].priority = -1
        const clean = { ...rest }
        for (const k of ['files-wanted', 'files-unwanted', 'priority-high', 'priority-normal', 'priority-low', 'trackerList']) delete clean[k]
        Object.assign(t, clean)
        if (typeof rest.trackerList === 'string') setTrackers(t, rest.trackerList)
        // Deselecting files shrinks the torrent, exactly as the daemon reports it. Recompute the
        // totals from the file table rather than clamping haveValid: clamping would discard the
        // bytes of a deselected file for good, so re-selecting it could never bring them back.
        t.sizeWhenDone = wantedSize(t)
        t.haveValid = wantedHave(t)
        reconcile(t)
        t.eta = etaOf(t, seedGoal(state, t))
      }
      touch(ts)
      return {}
    }

    case 'torrent-set-location': {
      const ts = selected()
      const to = String(args.location ?? BASE)
      for (const t of ts) {
        if (args.move !== false) {
          const from = state.space.get(mountOf(t.downloadDir, state.session['download-dir']))
          const dest = state.space.get(mountOf(to, state.session['download-dir']))
          if (from && dest && from !== dest) { from.size += t.haveValid; dest.size -= t.haveValid }
        }
        t.downloadDir = to
      }
      touch(ts)
      return {}
    }

    case 'torrent-rename-path': {
      const ts = selected()
      const path = String(args.path ?? '')
      const name = String(args.name ?? '')
      for (const t of ts) {
        if (path === t.name) {
          for (const f of t.files) f.name = f.name === path ? name : name + f.name.slice(path.length)
          t.name = name
          t.magnetLink = magnetOf(t.hashString, name, t.trackerStats)
        } else {
          const f = t.files.find(x => x.name === path)
          if (f) f.name = path.slice(0, path.lastIndexOf('/') + 1) + name
        }
      }
      touch(ts)
      return {}
    }

    case 'torrent-add':
      return addTorrent(state, args, now)

    default:
      if (method.startsWith('queue-move-')) {
        queueMove(state, method.slice('queue-move-'.length), Array.isArray(ids) ? ids : [])
        touch(selected())
        promoteQueue(state, now)
        return {}
      }
      throw new RpcFailure(`unhandled method: ${method}`)
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function round(b: { uploadedBytes: number; downloadedBytes: number; filesAdded: number; sessionCount: number; secondsActive: number }) {
  return {
    uploadedBytes: Math.round(b.uploadedBytes),
    downloadedBytes: Math.round(b.downloadedBytes),
    filesAdded: b.filesAdded,
    sessionCount: b.sessionCount,
    secondsActive: Math.round(b.secondsActive),
  }
}

function pick(t: TorrentDetail, fields: string[]): Record<string, unknown> {
  const src = t as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f in src) out[f] = src[f]
  return out
}

/** trackerList is newline separated, a blank line starting a new tier. */
function setTrackers(t: TorrentDetail, list: string): void {
  const stats: TrackerStat[] = []
  let tier = 0
  let id = 0
  for (const raw of list.split('\n')) {
    const line = raw.trim()
    if (!line) { if (stats.length) tier++; continue }
    const existing = t.trackerStats.find(s => s.announce === line)
    if (existing) { stats.push({ ...existing, id: id++, tier }); continue }
    stats.push({
      id: id++, announce: line, host: hostOf(line), tier, announceState: 0,
      hasAnnounced: false, lastAnnounceSucceeded: false, lastAnnounceResult: '', lastAnnounceTime: 0,
      lastAnnouncePeerCount: 0, nextAnnounceTime: 0, hasScraped: false, lastScrapeSucceeded: false,
      lastScrapeTime: 0, seederCount: 0, leecherCount: 0, downloadCount: 0, isBackup: tier > 0,
    })
  }
  t.trackerStats = stats
  t.trackerList = stats.map(s => s.announce).join('\n')
  t.magnetLink = magnetOf(t.hashString, t.name, stats)
}

function queueMove(state: SimState, where: string, ids: number[]): void {
  const set = new Set(ids)
  const moving = state.torrents.filter(t => set.has(t.id)).sort((a, b) => a.queuePosition - b.queuePosition)
  const rest = state.torrents.filter(t => !set.has(t.id)).sort((a, b) => a.queuePosition - b.queuePosition)
  if (!moving.length) return
  let order: TorrentDetail[]
  if (where === 'top') order = [...moving, ...rest]
  else if (where === 'bottom') order = [...rest, ...moving]
  else {
    order = [...state.torrents].sort((a, b) => a.queuePosition - b.queuePosition)
    const step = where === 'up' ? -1 : 1
    const seq = step < 0 ? moving : [...moving].reverse()
    for (const t of seq) {
      const i = order.indexOf(t)
      const j = i + step
      if (j < 0 || j >= order.length || set.has(order[j].id)) continue
      order[i] = order[j]
      order[j] = t
    }
  }
  order.forEach((t, i) => { t.queuePosition = i })
}

const HASH_RE = /\b([0-9a-f]{40})\b/i

function addTorrent(state: SimState, args: Args, now: number): unknown {
  let name = ''
  let hash = ''
  let size: number | undefined
  let fileCount: number | undefined
  let meta: number | undefined

  const filename = typeof args.filename === 'string' ? args.filename : ''
  if (filename.startsWith('magnet:')) {
    const q = new URLSearchParams(filename.slice(filename.indexOf('?') + 1))
    const xt = q.get('xt') ?? ''
    hash = (HASH_RE.exec(xt)?.[1] ?? '').toLowerCase()
    name = q.get('dn') ?? ''
    // A magnet arrives with no metadata: it has to fetch it first, which is the striped row.
    meta = 0
  } else if (typeof args.metainfo === 'string') {
    const parsed = fromMetainfo(args.metainfo)
    name = parsed.name
    size = parsed.size
    fileCount = parsed.fileCount
    // Derive the hash from the file itself, so re-adding the same .torrent reports a duplicate
    // instead of quietly making a second copy.
    hash = createHash('sha1').update(args.metainfo).digest('hex')
  } else if (filename) {
    name = filename.replace(/^.*\//, '').replace(/\.torrent$/, '')
  }

  if (!hash) hash = randomHash(state)
  if (!name) name = hash

  const dup = state.torrents.find(t => t.hashString === hash)
  if (dup) return { 'torrent-duplicate': { id: dup.id, name: dup.name, hashString: dup.hashString } }

  const t = newTorrent(state.nextId++, name, hash, String(args['download-dir'] ?? state.session['download-dir']), now, {
    labels: (args.labels as string[] | undefined) ?? [],
    size,
    fileCount,
    meta,
    priority: (args.bandwidthPriority as -1 | 0 | 1 | undefined) ?? 0,
    paused: args.paused === true || state.session['start-added-torrents'] === false,
  })
  if (meta === 0) {
    // While metadata is still coming in there is no file list and no size; the daemon shows the
    // magnet's own display name if it carried one, and falls back to the hash if it did not.
    t.metadataPercentComplete = 0
    t.files = []
    t.fileStats = []
    t.sizeWhenDone = 0
    t.totalSize = 0
    t.leftUntilDone = 0
    t.haveValid = 0
    t.pieceCount = 0
    t.pieces = ''
    t.availability = []
  }

  for (const i of (args['files-unwanted'] as number[] | undefined) ?? []) if (t.fileStats[i]) t.fileStats[i].wanted = false
  for (const i of (args['priority-high'] as number[] | undefined) ?? []) if (t.fileStats[i]) t.fileStats[i].priority = 1
  for (const i of (args['priority-low'] as number[] | undefined) ?? []) if (t.fileStats[i]) t.fileStats[i].priority = -1
  t.sizeWhenDone = wantedSize(t)
  reconcile(t)

  // The daemon queues an added torrent rather than starting it outright, which is what the Add
  // dialog's own "added to the download queue" footer promises. promoteQueue below starts it if a
  // slot is free. torrent-start-now is the deliberate way past the queue.
  if (t.status !== ST.Stopped) t.status = ST.DownloadWait as TorrentDetail['status']
  t.queuePosition = state.torrents.length
  state.torrents.push(t)
  state.sim.set(t.id, simFieldsFor(t))
  renumberQueue(state.torrents)
  state.cur.filesAdded += Math.max(1, t.files.length)
  state.cum.filesAdded += Math.max(1, t.files.length)
  promoteQueue(state, now)
  return { 'torrent-added': { id: t.id, name: t.name, hashString: t.hashString } }
}

function randomHash(state: SimState): string {
  let s = ''
  while (s.length < 40) s += state.rand.int(0, 15).toString(16)
  return s
}

interface Parsed { name: string; size?: number; fileCount?: number }

/** Read a name and size out of a base64 .torrent, reusing the UI's own bencode decoder. */
function fromMetainfo(b64: string): Parsed {
  try {
    const buf = new Uint8Array(Buffer.from(b64, 'base64'))
    const root = decode(buf) as Record<string, unknown>
    const info = root.info as Record<string, unknown> | undefined
    if (!info) return { name: '' }
    const td = new TextDecoder()
    const raw = info.name
    const name = ArrayBuffer.isView(raw) ? td.decode(raw as Uint8Array) : ''
    const files = info.files as { length?: number }[] | undefined
    if (Array.isArray(files)) {
      return { name, size: files.reduce((n, f) => n + (typeof f.length === 'number' ? f.length : 0), 0), fileCount: files.length }
    }
    return { name, size: typeof info.length === 'number' ? info.length : undefined, fileCount: 1 }
  } catch {
    return { name: '' }
  }
}

export { TRACKERS, byId, num }
