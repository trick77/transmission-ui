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
 * The RPC spec lets `ids` be an array, a single id, a hash string, or "recently_active"; the bundled
 * UI only ever sends arrays, but `make sim-server` invites curl, where a bare `{"ids": 5}` falling
 * through to "all torrents" would turn one remove into a wipe. Undefined still means all, as it must.
 */
export function normalizeIds(state: SimState, raw: unknown): number[] | 'recently_active' | undefined {
  if (raw == null) return undefined
  if (raw === 'recently_active') return 'recently_active'
  const one = (v: unknown): number[] => {
    if (typeof v === 'number') return Number.isFinite(v) ? [v] : []
    if (typeof v === 'string') {
      const byHash = state.torrents.find(t => t.hash_string === v.toLowerCase())
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
  const touch = (ts: TorrentDetail[]) => { for (const t of ts) t.activity_date = now }

  switch (method) {
    // ── session ──────────────────────────────────────────────────────────────
    case 'session_get':
      return { ...state.session }

    case 'session_set': {
      const patch = { ...args }
      delete patch.ids
      Object.assign(state.session, patch as Partial<Session>)
      state.portOpen = state.session.port_forwarding_enabled
      // A bigger queue takes effect immediately rather than a poll later.
      promoteQueue(state, now)
      return {}
    }

    case 'session_stats': {
      const active = state.torrents.filter(t => t.status !== ST.Stopped).length
      return {
        active_torrent_count: active,
        paused_torrent_count: state.torrents.length - active,
        torrent_count: state.torrents.length,
        download_speed: state.torrents.reduce((n, t) => n + t.rate_download, 0),
        upload_speed: state.torrents.reduce((n, t) => n + t.rate_upload, 0),
        'current_stats': round(state.cur),
        'cumulative_stats': round(state.cum),
      }
    }

    case 'free_space': {
      const path = String(args.path ?? BASE)
      const mount = mountOf(path, state.session.download_dir)
      const e = state.space.get(mount) ?? state.space.get(BASE)!
      return { path, 'size_bytes': Math.round(e.size), total_size: Math.round(e.total) }
    }

    case 'port_test':
      return { 'port_is_open': state.portOpen, ip_protocol: args.ip_protocol }

    case 'blocklist_update': {
      const size = 300_000 + state.rand.int(0, 200_000)
      state.session.blocklist_size = size
      return { 'blocklist_size': size }
    }

    // ── reads ────────────────────────────────────────────────────────────────
    case 'torrent_get': {
      const fields = (args.fields as string[] | undefined) ?? []
      const wantsDetail = fields.includes('pieces') || fields.includes('availability')
      let list: TorrentDetail[]
      let removed: number[] | undefined

      if (ids === 'recently_active') {
        const cut = now - state.recentWindowSec
        list = state.torrents.filter(t => t.activity_date >= cut)
        removed = state.removed.filter(r => r.at >= cut).map(r => r.id)
      } else {
        list = selected()
      }
      if (wantsDetail) for (const t of list) refreshPieceMap(t, state.sim.get(t.id)?.swarm ?? 3)
      const torrents = list.map(t => pick(t, fields))
      return removed ? { torrents, removed } : { torrents }
    }

    // ── writes ───────────────────────────────────────────────────────────────
    case 'torrent_start':
    case 'torrent_start_now': {
      // A verify in flight owns the torrent's bytes: have_valid is parked in have_unchecked until it
      // finishes. Starting here would read the stale percent_done and strand them, so the daemon
      // makes start a no-op on a checking torrent and so do we.
      const ts = selected().filter(t => !isChecking(t.status))
      for (const t of ts) {
        t.error = 0
        t.error_string = ''
        t.is_finished = false
        const done = t.percent_done >= 1 && t.metadata_percent_complete >= 1
        if (method === 'torrent_start_now') {
          t.status = (done ? ST.Seed : ST.Download) as TorrentDetail['status']
          t.queue_position = -1
          renumberQueue(state.torrents)
        } else {
          t.status = (done ? ST.SeedWait : ST.DownloadWait) as TorrentDetail['status']
        }
      }
      touch(ts)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent_stop': {
      const ts = selected()
      for (const t of ts) {
        // Stopping cancels a verify. Fold the unchecked bytes back so progress survives it.
        if (isChecking(t.status)) {
          t.have_valid += t.have_unchecked
          t.have_unchecked = 0
          t.recheck_progress = 0
          reconcile(t)
        }
        t.status = ST.Stopped as TorrentDetail['status']
        t.rate_download = 0
        t.rate_upload = 0
        t.eta = -1
      }
      touch(ts)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent_verify': {
      const ts = selected()
      for (const t of ts) {
        const f = state.sim.get(t.id)
        if (f) f.prevStatus = t.status === ST.Stopped ? ST.Stopped : t.percent_done >= 1 ? ST.Seed : ST.Download
        t.have_unchecked = t.have_valid
        t.have_valid = 0
        t.recheck_progress = 0
        t.status = ST.CheckWait as TorrentDetail['status']
      }
      touch(ts)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent_reannounce': {
      const ts = selected()
      for (const t of ts) for (const s of t.tracker_stats) s.next_announce_time = now
      touch(ts)
      return {}
    }

    case 'torrent_remove': {
      const gone = selected()
      const keep = new Set(gone.map(t => t.id))
      state.torrents = state.torrents.filter(t => !keep.has(t.id))
      for (const t of gone) {
        state.removed.push({ id: t.id, at: now })
        state.sim.delete(t.id)
        if (args.delete_local_data) {
          const e = state.space.get(mountOf(t.download_dir, state.session.download_dir))
          if (e) e.size += t.have_valid
        }
      }
      renumberQueue(state.torrents)
      promoteQueue(state, now)
      return {}
    }

    case 'torrent_set': {
      const ts = selected()
      const rest = { ...args }
      delete rest.ids
      const idx = (k: string) => (rest[k] as number[] | undefined) ?? []
      for (const t of ts) {
        for (const i of idx('files_wanted')) if (t.file_stats[i]) t.file_stats[i].wanted = true
        for (const i of idx('files_unwanted')) if (t.file_stats[i]) t.file_stats[i].wanted = false
        for (const i of idx('priority_high')) if (t.file_stats[i]) t.file_stats[i].priority = 1
        for (const i of idx('priority_normal')) if (t.file_stats[i]) t.file_stats[i].priority = 0
        for (const i of idx('priority_low')) if (t.file_stats[i]) t.file_stats[i].priority = -1
        const clean = { ...rest }
        for (const k of ['files_wanted', 'files_unwanted', 'priority_high', 'priority_normal', 'priority_low', 'tracker_list']) delete clean[k]
        Object.assign(t, clean)
        if (typeof rest.tracker_list === 'string') setTrackers(t, rest.tracker_list)
        // Deselecting files shrinks the torrent, exactly as the daemon reports it. Recompute the
        // totals from the file table rather than clamping have_valid: clamping would discard the
        // bytes of a deselected file for good, so re-selecting it could never bring them back.
        t.size_when_done = wantedSize(t)
        t.have_valid = wantedHave(t)
        reconcile(t)
        t.eta = etaOf(t, seedGoal(state, t))
      }
      touch(ts)
      return {}
    }

    case 'torrent_set_location': {
      const ts = selected()
      const to = String(args.location ?? BASE)
      for (const t of ts) {
        if (args.move !== false) {
          const from = state.space.get(mountOf(t.download_dir, state.session.download_dir))
          const dest = state.space.get(mountOf(to, state.session.download_dir))
          if (from && dest && from !== dest) { from.size += t.have_valid; dest.size -= t.have_valid }
        }
        t.download_dir = to
      }
      touch(ts)
      return {}
    }

    case 'torrent_rename_path': {
      const ts = selected()
      const path = String(args.path ?? '')
      const name = String(args.name ?? '')
      for (const t of ts) {
        if (path === t.name) {
          for (const f of t.files) f.name = f.name === path ? name : name + f.name.slice(path.length)
          t.name = name
          t.magnet_link = magnetOf(t.hash_string, name, t.tracker_stats)
        } else {
          const f = t.files.find(x => x.name === path)
          if (f) f.name = path.slice(0, path.lastIndexOf('/') + 1) + name
        }
      }
      touch(ts)
      return {}
    }

    case 'torrent_add':
      return addTorrent(state, args, now)

    default:
      if (method.startsWith('queue_move_')) {
        queueMove(state, method.slice('queue_move_'.length), Array.isArray(ids) ? ids : [])
        touch(selected())
        promoteQueue(state, now)
        return {}
      }
      throw new RpcFailure(`unhandled method: ${method}`)
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function round(b: { uploaded_bytes: number; downloaded_bytes: number; files_added: number; session_count: number; seconds_active: number }) {
  return {
    uploaded_bytes: Math.round(b.uploaded_bytes),
    downloaded_bytes: Math.round(b.downloaded_bytes),
    files_added: b.files_added,
    session_count: b.session_count,
    seconds_active: Math.round(b.seconds_active),
  }
}

function pick(t: TorrentDetail, fields: string[]): Record<string, unknown> {
  const src = t as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f in src) out[f] = src[f]
  return out
}

/** tracker_list is newline separated, a blank line starting a new tier. */
function setTrackers(t: TorrentDetail, list: string): void {
  const stats: TrackerStat[] = []
  let tier = 0
  let id = 0
  for (const raw of list.split('\n')) {
    const line = raw.trim()
    if (!line) { if (stats.length) tier++; continue }
    const existing = t.tracker_stats.find(s => s.announce === line)
    if (existing) { stats.push({ ...existing, id: id++, tier }); continue }
    stats.push({
      id: id++, announce: line, host: hostOf(line), tier, announce_state: 0,
      has_announced: false, last_announce_succeeded: false, last_announce_result: '', last_announce_time: 0,
      last_announce_peer_count: 0, next_announce_time: 0, has_scraped: false, last_scrape_succeeded: false,
      last_scrape_time: 0, seeder_count: 0, leecher_count: 0, download_count: 0, downloader_count: 0, is_backup: tier > 0,
    })
  }
  t.tracker_stats = stats
  t.tracker_list = stats.map(s => s.announce).join('\n')
  t.magnet_link = magnetOf(t.hash_string, t.name, stats)
}

function queueMove(state: SimState, where: string, ids: number[]): void {
  const set = new Set(ids)
  const moving = state.torrents.filter(t => set.has(t.id)).sort((a, b) => a.queue_position - b.queue_position)
  const rest = state.torrents.filter(t => !set.has(t.id)).sort((a, b) => a.queue_position - b.queue_position)
  if (!moving.length) return
  let order: TorrentDetail[]
  if (where === 'top') order = [...moving, ...rest]
  else if (where === 'bottom') order = [...rest, ...moving]
  else {
    order = [...state.torrents].sort((a, b) => a.queue_position - b.queue_position)
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
  order.forEach((t, i) => { t.queue_position = i })
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

  const dup = state.torrents.find(t => t.hash_string === hash)
  if (dup) return { 'torrent_duplicate': { id: dup.id, name: dup.name, hash_string: dup.hash_string } }

  const t = newTorrent(state.nextId++, name, hash, String(args.download_dir ?? state.session.download_dir), now, {
    labels: (args.labels as string[] | undefined) ?? [],
    size,
    fileCount,
    meta,
    priority: (args.bandwidth_priority as -1 | 0 | 1 | undefined) ?? 0,
    paused: args.paused === true || state.session.start_added_torrents === false,
  })
  if (meta === 0) {
    // While metadata is still coming in there is no file list and no size; the daemon shows the
    // magnet's own display name if it carried one, and falls back to the hash if it did not.
    t.metadata_percent_complete = 0
    t.files = []
    t.file_stats = []
    t.size_when_done = 0
    t.total_size = 0
    t.left_until_done = 0
    t.have_valid = 0
    t.piece_count = 0
    t.pieces = ''
    t.availability = []
  }

  for (const i of (args.files_unwanted as number[] | undefined) ?? []) if (t.file_stats[i]) t.file_stats[i].wanted = false
  for (const i of (args.priority_high as number[] | undefined) ?? []) if (t.file_stats[i]) t.file_stats[i].priority = 1
  for (const i of (args.priority_low as number[] | undefined) ?? []) if (t.file_stats[i]) t.file_stats[i].priority = -1
  t.size_when_done = wantedSize(t)
  reconcile(t)

  // The daemon queues an added torrent rather than starting it outright, which is what the Add
  // dialog's own "added to the download queue" footer promises. promoteQueue below starts it if a
  // slot is free. torrent-start-now is the deliberate way past the queue.
  if (t.status !== ST.Stopped) t.status = ST.DownloadWait as TorrentDetail['status']
  t.queue_position = state.torrents.length
  state.torrents.push(t)
  state.sim.set(t.id, simFieldsFor(t))
  renumberQueue(state.torrents)
  state.cur.files_added += Math.max(1, t.files.length)
  state.cum.files_added += Math.max(1, t.files.length)
  promoteQueue(state, now)
  return { 'torrent_added': { id: t.id, name: t.name, hash_string: t.hash_string } }
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
