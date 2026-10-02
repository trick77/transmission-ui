// Derived views over the torrent list: status labels, sidebar filters, sort, folders, tracker health.
// Ported from the logic in design/src/rows.html so the mock and the app agree.

import { Status, type TorrentSummary, type TrackerStat } from '../rpc/types'
import { daysSince, gb, ratioValue } from './format'
import { trackerName } from './trackers'

/**
 * Per-torrent results cached on the row object itself. A poll replaces the object of a
 * torrent that changed and keeps the others, so a cached answer is exactly as fresh as
 * the row: unchanged torrents cost nothing on the next sort or filter pass.
 */
function perRow<V>(f: (t: TorrentSummary) => V): (t: TorrentSummary) => V {
  const seen = new WeakMap<TorrentSummary, V>()
  return t => {
    if (seen.has(t)) return seen.get(t)!
    const v = f(t)
    seen.set(t, v)
    return v
  }
}

/** Same order as String.localeCompare, without resolving the locale on every call. */
const collate = new Intl.Collator().compare

export type ChipKind = 'dl' | 'seed' | 'wait' | 'stop' | 'err'

export interface StatusView { kind: ChipKind; bar: string; label: string }

export function statusView(t: TorrentSummary): StatusView {
  if (t.error !== 0) return { kind: 'err', bar: 'err', label: 'Error' }
  switch (t.status) {
    case Status.Download: return t.metadata_percent_complete < 1 ? { kind: 'dl', bar: 'striped', label: 'Fetching metadata' } : { kind: 'dl', bar: '', label: 'Downloading' }
    case Status.Seed: return { kind: 'seed', bar: 'seed', label: 'Seeding' }
    case Status.SeedWait: return { kind: 'wait', bar: 'wait striped', label: 'Queued to seed' }
    case Status.DownloadWait: return { kind: 'wait', bar: 'wait striped', label: 'Queued' }
    case Status.Check: return { kind: 'wait', bar: 'wait striped', label: 'Verifying' }
    case Status.CheckWait: return { kind: 'wait', bar: 'wait striped', label: 'Queued to verify' }
    default: return { kind: 'stop', bar: 'stop', label: 'Stopped' }
  }
}

export const isActive = (t: TorrentSummary) => t.rate_download > 0 || t.rate_upload > 0
// Verifying on disk (Check) or queued to verify (CheckWait). Deliberately NOT the
// queue-wait states: DownloadWait/SeedWait are idle torrents awaiting their turn,
// and counting them as "Checking" reported verification that was not happening.
const isChecking = (t: TorrentSummary) => t.status === Status.Check || t.status === Status.CheckWait

// ─── tracker health ───
export type TrackerFailure = 'ok' | 'tracker' | 'torrent' | 'rejected'

/** Classify a failed announce: tracker-level (host problem), client rejected (whitelist/ban), or torrent-level (unregistered). */
export function classifyAnnounce(ts: TrackerStat): TrackerFailure {
  if (!ts.has_announced || ts.last_announce_succeeded) return 'ok'
  const r = ts.last_announce_result.toLowerCase()
  if (/whitelist|banned|client.*(reject|not allowed|unsupported)|user.?agent/.test(r)) return 'rejected'
  if (/unregistered|not registered|not found|not exist|unknown torrent|torrent not/.test(r)) return 'torrent'
  return 'tracker'
}

export const hasTrackerProblem = perRow(t => t.tracker_stats.some(ts => classifyAnnounce(ts) !== 'ok'))

export interface TrackerHealth {
  host: string
  count: number
  failing: number
  state: 'ok' | 'issues' | 'down' | 'rejected'
  since: number       // oldest failing last_announce_time
  result: string      // representative error text
}

const DOWN_AFTER_S = 10 * 60

// When we first saw a host failing, so a re-announce (which refreshes last_announce_time) doesn't reset the clock.
const firstFailing = new Map<string, number>(readFirstFailing())
function readFirstFailing(): [string, number][] { try { return JSON.parse(localStorage.getItem('tm.trkfail') || '[]') } catch { return [] } }
function rememberFailing(host: string, since: number) {
  const cur = firstFailing.get(host)
  if (cur != null && cur <= since) return
  firstFailing.set(host, since)
  try { localStorage.setItem('tm.trkfail', JSON.stringify([...firstFailing])) } catch { /* ignore */ }
}
function forgetFailing(host: string) {
  if (!firstFailing.delete(host)) return
  try { localStorage.setItem('tm.trkfail', JSON.stringify([...firstFailing])) } catch { /* ignore */ }
}

// The sidebar and the list's notices both ask on every poll, for the same array.
let lastHealth: { torrents: TorrentSummary[]; out: TrackerHealth[] } | null = null
export function trackerHealth(torrents: TorrentSummary[]): TrackerHealth[] {
  if (lastHealth?.torrents !== torrents) lastHealth = { torrents, out: computeHealth(torrents) }
  return lastHealth.out
}

function computeHealth(torrents: TorrentSummary[]): TrackerHealth[] {
  const byHost = new Map<string, { count: number; announced: number; failing: number; rejected: number; torrentLevel: number; since: number; result: string }>()
  for (const t of torrents) {
    const seen = new Set<string>()
    for (const ts of usedTrackers(t)) {
      const host = hostOf(ts.announce)
      if (seen.has(host)) continue
      seen.add(host)
      const h = byHost.get(host) ?? { count: 0, announced: 0, failing: 0, rejected: 0, torrentLevel: 0, since: Infinity, result: '' }
      h.count++
      // stopped torrents never announce; they say nothing about the tracker
      if (ts.has_announced) h.announced++
      const c = classifyAnnounce(ts)
      if (c === 'tracker' || c === 'rejected') {
        h.failing++
        if (c === 'rejected') h.rejected++
        h.since = Math.min(h.since, ts.last_announce_time || Date.now() / 1000)
        // a failed scrape is older evidence of the same outage
        if (ts.has_scraped && !ts.last_scrape_succeeded && ts.last_scrape_time) h.since = Math.min(h.since, ts.last_scrape_time)
        h.result = h.result || ts.last_announce_result
      } else if (c === 'torrent') { h.torrentLevel++; h.result = h.result || ts.last_announce_result }
      byHost.set(host, h)
    }
  }
  // A host nobody announces to any more has no outage left to time. Not on an empty
  // list: that is the moment before the first poll, not a daemon without trackers.
  if (torrents.length) for (const host of [...firstFailing.keys()]) if (!byHost.has(host)) forgetFailing(host)
  const now = Date.now() / 1000
  return [...byHost.entries()].map(([host, h]) => {
    const allFailing = h.announced > 0 && h.failing === h.announced
    if (allFailing) rememberFailing(host, h.since); else forgetFailing(host)
    const since = Math.min(h.since, firstFailing.get(host) ?? Infinity)
    let state: TrackerHealth['state'] = 'ok'
    if (h.rejected > 0 && h.rejected === h.announced) state = 'rejected'
    else if (allFailing && now - since >= DOWN_AFTER_S) state = 'down'
    else if (h.failing > 0 || h.torrentLevel > 0) state = 'issues'
    return { host, count: h.count, failing: h.failing + h.torrentLevel, state, since, result: shortResult(h.result) }
  }).sort((a, b) => b.count - a.count || collate(trackerName(a.host), trackerName(b.host)))
}

/**
 * The trackers a torrent actually uses. One that never announced while a sibling
 * did is a backup the daemon never needed, and it says nothing about that tracker.
 * Stopped torrents announce to nothing at all, so they keep every tracker --
 * otherwise a daemon restart would empty the sidebar. The sidebar, the
 * `tracker:` filter and the re-announce notice all go through this, or they
 * disagree about which torrents a tracker has.
 */
export function usedTrackers(t: TorrentSummary): TrackerStat[] {
  const anyAnnounced = t.tracker_stats.some(ts => ts.has_announced)
  return anyAnnounced ? t.tracker_stats.filter(ts => ts.has_announced) : t.tracker_stats
}

/** Whether a torrent announces to `host` -- backups it never needed do not count. */
export const usesTracker = (t: TorrentSummary, host: string) =>
  usedTrackers(t).some(ts => hostOf(ts.announce) === host)

// A handful of distinct announce URLs, asked for once per tracker per torrent per poll.
const hosts = new Map<string, string>()
export function hostOf(announce: string): string {
  let h = hosts.get(announce)
  if (h === undefined) {
    try { h = new URL(announce).hostname } catch { h = announce }
    hosts.set(announce, h)
  }
  return h
}

function shortResult(r: string): string {
  const s = r.replace(/^Tracker gave (an? )?/i, '').replace(/\s*\(.*\)$/, '')
  return s.length > 28 ? s.slice(0, 27) + '…' : s
}

// ─── sidebar filters ───
export type FilterKey = 'all' | 'download' | 'seed' | 'active' | 'inactive' | 'finished' | 'queued' | 'stopped' | 'error'

export const FILTERS: Record<FilterKey, { label: string; f: (t: TorrentSummary) => boolean }> = {
  all: { label: 'All torrents', f: () => true },
  download: { label: 'Downloading', f: t => t.status === Status.Download },
  seed: { label: 'Seeding', f: t => t.status === Status.Seed },
  active: { label: 'Active', f: isActive },
  // Excludes only the checking ones, which have their own entry. A torrent waiting in
  // the queue is idle, so it belongs here rather than in no filter at all.
  inactive: { label: 'Inactive', f: t => !isActive(t) && !isChecking(t) },
  finished: { label: 'Completed', f: t => t.is_finished || (t.percent_done >= 1 && t.metadata_percent_complete >= 1) },
  // Checking means verifying, not waiting in the queue: a saturated download queue
  // would otherwise report "Checking N" while the daemon verifies nothing.
  queued: { label: 'Checking', f: isChecking },
  stopped: { label: 'Stopped', f: t => t.status === Status.Stopped && t.error === 0 },
  // A daemon error and a failing tracker are different conditions, but both mean
  // "this torrent needs looking at" and in practice the same torrents carry both,
  // so they share one entry. The predicate runs once per torrent, so a torrent
  // with both appears once.
  error: { label: 'Error', f: t => t.error !== 0 || hasTrackerProblem(t) },
}
// Sidebar list. 'queued' (Checking) is listed but not in Sidebar's PINNED set, so it
// only appears while something is actually being verified. 'seed' keeps its FILTERS
// entry though it has no entry here, so an existing ?filter=seed link still resolves.
export const FILTER_ORDER: FilterKey[] = ['all', 'download', 'active', 'finished', 'inactive', 'queued', 'stopped', 'error']

/** A filter string is a FilterKey, `label:<name>`, `dir:<path>` (prefix) or `tracker:<host>`. */
export function filterFn(filter: string, base: string): { label: string; f: (t: TorrentSummary) => boolean } {
  if (filter.startsWith('label:')) { const l = filter.slice(6); return { label: l, f: t => t.labels.includes(l) } }
  if (filter.startsWith('dir:')) { const d = filter.slice(4); return { label: relDir(d, base) || d, f: t => t.download_dir === d || t.download_dir.startsWith(d + '/') } }
  // The key stays the host so old links keep working; the label is what the sidebar shows.
  if (filter.startsWith('tracker:')) { const h = filter.slice(8); return { label: trackerName(h), f: t => usesTracker(t, h) } }
  // 'trackererr' was folded into 'error'; keep old links and bookmarks pointing at
  // the filter that still covers them rather than silently falling back to 'all'.
  if (filter === 'trackererr') return FILTERS.error
  return FILTERS[Object.hasOwn(FILTERS, filter) ? (filter as FilterKey) : 'all']
}

// ─── attribute filters ───
export type AdvKey = 'size' | 'age' | 'ratio' | 'idle'
export type Adv = Partial<Record<AdvKey, string>>

export const ADV: Record<AdvKey, Record<string, (t: TorrentSummary) => boolean>> = {
  size: { lt1: t => gb(t.size_when_done) < 1, '1to10': t => gb(t.size_when_done) >= 1 && gb(t.size_when_done) <= 10, gt10: t => gb(t.size_when_done) > 10 },
  age: { '1d': t => daysSince(t.added_date) < 1, '7d': t => daysSince(t.added_date) < 7, '30d': t => daysSince(t.added_date) < 30, older: t => daysSince(t.added_date) >= 30 },
  ratio: { lt1: t => ratioValue(t.upload_ratio) < 1, gte1: t => ratioValue(t.upload_ratio) >= 1, gte2: t => ratioValue(t.upload_ratio) >= 2 },
  idle: { active: isActive, idle7: t => !isActive(t) && daysSince(t.activity_date) > 7, idle30: t => !isActive(t) && daysSince(t.activity_date) > 30 },
}
export const ADV_OPTIONS: Record<AdvKey, { v: string; l: string }[]> = {
  size: [{ v: 'any', l: 'Any' }, { v: 'lt1', l: '< 1 GB' }, { v: '1to10', l: '1–10 GB' }, { v: 'gt10', l: '> 10 GB' }],
  age: [{ v: 'any', l: 'Any' }, { v: '1d', l: 'Today' }, { v: '7d', l: '< 7 d' }, { v: '30d', l: '< 30 d' }, { v: 'older', l: 'Older' }],
  ratio: [{ v: 'any', l: 'Any' }, { v: 'lt1', l: '< 1' }, { v: 'gte1', l: '≥ 1' }, { v: 'gte2', l: '≥ 2' }],
  idle: [{ v: 'any', l: 'Any' }, { v: 'active', l: 'Active' }, { v: 'idle7', l: 'Idle 7 d+' }, { v: 'idle30', l: 'Idle 30 d+' }],
}
export const ADV_LABEL: Record<AdvKey, Record<string, string>> = {
  size: { lt1: '< 1 GB', '1to10': '1–10 GB', gt10: '> 10 GB' },
  age: { '1d': 'added today', '7d': 'added < 7 d', '30d': 'added < 30 d', older: 'added > 30 d' },
  ratio: { lt1: 'ratio < 1', gte1: 'ratio ≥ 1', gte2: 'ratio ≥ 2' },
  idle: { active: 'active now', idle7: 'idle > 7 d', idle30: 'idle > 30 d' },
}
export const ADV_KEYS: AdvKey[] = ['size', 'age', 'ratio', 'idle']
export const advActive = (adv: Adv) => ADV_KEYS.filter(k => adv[k] && adv[k] !== 'any')
export function advFn(adv: Adv): (t: TorrentSummary) => boolean {
  const tests = advActive(adv).map(k => ADV[k][adv[k]!]).filter(Boolean)
  return t => tests.every(f => f(t))
}

// ─── sort ───
export type SortKey = 'state' | 'name' | 'size' | 'progress' | 'down' | 'up' | 'ratio' | 'eta' | 'added' | 'activity' | 'seeds' | 'uploaded' | 'tracker' | 'path'

/** Problems first, then by how much attention a torrent needs. */
export const rank = perRow(rankOf)
function rankOf(t: TorrentSummary): number {
  if (t.error !== 0) return 0
  if (hasTrackerProblem(t)) return 1
  switch (t.status) {
    case Status.Check: case Status.CheckWait: return 2
    case Status.DownloadWait: return 3
    case Status.Download: return 4
    case Status.SeedWait: return 5
    case Status.Seed: return 6
    default: return 7
  }
}

/** `base` is the session download dir, so Path sorts on what the row actually shows. */
export function sortFn(key: SortKey, dir: 1 | -1, base = ''): (a: TorrentSummary, b: TorrentSummary) => number {
  const num = (f: (t: TorrentSummary) => number) => (a: TorrentSummary, b: TorrentSummary) => (f(a) - f(b)) * dir || collate(a.name, b.name)
  // A missing tracker or path is the absence of a value, not a value that sorts low, so it
  // parks last in both directions. (An unknown ETA differs: there it is a real extreme.)
  const text = (f: (t: TorrentSummary) => string) => (a: TorrentSummary, b: TorrentSummary) => {
    const x = f(a), y = f(b)
    if (!x !== !y) return x ? -1 : 1
    return collate(x, y) * dir || collate(a.name, b.name)
  }
  switch (key) {
    case 'name': return (a, b) => collate(a.name, b.name) * dir
    case 'size': return num(t => t.size_when_done)
    case 'progress': return num(t => t.percent_done)
    case 'down': return num(t => t.rate_download)
    case 'up': return num(t => t.rate_upload)
    case 'ratio': return num(t => ratioValue(t.upload_ratio))
    case 'eta': return num(t => (t.eta < 0 ? Number.MAX_SAFE_INTEGER : t.eta))
    case 'added': return num(t => t.added_date)
    case 'activity': return num(t => t.activity_date)
    case 'seeds': return num(t => swarmOf(t).seeds)
    case 'uploaded': return num(t => t.uploaded_ever)
    case 'tracker': return text(firstTrackerName)
    case 'path': return text(t => relDir(t.download_dir, base))
    default: return (a, b) => (rank(a) - rank(b)) * dir || b.activity_date - a.activity_date || collate(a.name, b.name)
  }
}

const firstTrackerName = perRow(t => t.tracker_stats.length ? trackerName(hostOf(t.tracker_stats[0].announce)) : '')

// ─── folders ───
export function relDir(dir: string, base: string): string {
  if (base && dir.startsWith(base + '/')) return dir.slice(base.length + 1)
  if (dir === base) return ''
  return dir
}

export interface FolderNode { path: string; name: string; depth: number; count: number }

/** Flattened folder tree of every download dir relative to the session download-dir. */
export function folderTree(torrents: TorrentSummary[], base: string): FolderNode[] {
  const perDir = new Map<string, number>()
  for (const t of torrents) perDir.set(t.download_dir, (perDir.get(t.download_dir) ?? 0) + 1)
  // A folder holds its own torrents and those of every folder below it: hand each
  // directory's count to all of its ancestors once, rather than scan the list per folder.
  const within = new Map<string, number>()
  for (const [d, n] of perDir) {
    for (let i = d.indexOf('/', 1); i !== -1; i = d.indexOf('/', i + 1)) within.set(d.slice(0, i), (within.get(d.slice(0, i)) ?? 0) + n)
    within.set(d, (within.get(d) ?? 0) + n)
  }
  const dirs = [...perDir.keys()].sort()
  const seen = new Set<string>()
  const out: FolderNode[] = []
  for (const d of dirs) {
    const inBase = !!base && d.startsWith(base + '/')
    const parts = inBase ? relDir(d, base).split('/') : d === base ? [] : d.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      const p = (inBase ? base + '/' : '/') + parts.slice(0, i).join('/')
      if (seen.has(p)) continue
      seen.add(p)
      out.push({ path: p, name: parts[i - 1], depth: i - 1, count: within.get(p) ?? 0 })
    }
  }
  return out
}

export function labelCounts(torrents: TorrentSummary[]): { label: string; count: number }[] {
  const m = new Map<string, number>()
  for (const t of torrents) for (const l of t.labels) m.set(l, (m.get(l) ?? 0) + 1)
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || collate(a.label, b.label))
}

/** Peers/swarm text under the name. */
export const swarmOf = perRow((t): { seeds: number; leechers: number } => {
  let seeds = 0, leechers = 0
  for (const ts of t.tracker_stats) { seeds = Math.max(seeds, ts.seeder_count); leechers = Math.max(leechers, ts.leecher_count) }
  return { seeds, leechers }
})
