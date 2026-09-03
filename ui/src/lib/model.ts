// Derived views over the torrent list: status labels, sidebar filters, sort, folders, tracker health.
// Ported from the logic in design/src/rows.html so the mock and the app agree.

import { Status, type TorrentSummary, type TrackerStat } from '../rpc/types'
import { daysSince, gb } from './format'

export type ChipKind = 'dl' | 'seed' | 'wait' | 'stop' | 'err'

export interface StatusView { kind: ChipKind; bar: string; label: string }

export function statusView(t: TorrentSummary): StatusView {
  if (t.error !== 0) return { kind: 'err', bar: 'err', label: 'Error' }
  switch (t.status) {
    case Status.Download: return t.metadataPercentComplete < 1 ? { kind: 'dl', bar: 'striped', label: 'Fetching metadata' } : { kind: 'dl', bar: '', label: 'Downloading' }
    case Status.Seed: return { kind: 'seed', bar: 'seed', label: 'Seeding' }
    case Status.SeedWait: return { kind: 'wait', bar: 'wait striped', label: 'Queued to seed' }
    case Status.DownloadWait: return { kind: 'wait', bar: 'wait striped', label: 'Queued' }
    case Status.Check: return { kind: 'wait', bar: 'wait striped', label: 'Verifying' }
    case Status.CheckWait: return { kind: 'wait', bar: 'wait striped', label: 'Queued to verify' }
    default: return { kind: 'stop', bar: 'stop', label: 'Stopped' }
  }
}

export const isActive = (t: TorrentSummary) => t.rateDownload > 0 || t.rateUpload > 0
const isQueuedOrChecking = (t: TorrentSummary) => t.status === Status.Check || t.status === Status.CheckWait || t.status === Status.DownloadWait || t.status === Status.SeedWait

// ─── tracker health ───
export type TrackerFailure = 'ok' | 'tracker' | 'torrent' | 'rejected'

/** Classify a failed announce: tracker-level (host problem), client rejected (whitelist/ban), or torrent-level (unregistered). */
export function classifyAnnounce(ts: TrackerStat): TrackerFailure {
  if (!ts.hasAnnounced || ts.lastAnnounceSucceeded) return 'ok'
  const r = ts.lastAnnounceResult.toLowerCase()
  if (/whitelist|banned|client.*(reject|not allowed|unsupported)|user.?agent/.test(r)) return 'rejected'
  if (/unregistered|not registered|not found|not exist|unknown torrent|torrent not/.test(r)) return 'torrent'
  return 'tracker'
}

export const hasTrackerProblem = (t: TorrentSummary) => t.trackerStats.some(ts => classifyAnnounce(ts) !== 'ok')

export interface TrackerHealth {
  host: string
  count: number
  failing: number
  state: 'ok' | 'issues' | 'down' | 'rejected'
  since: number       // oldest failing lastAnnounceTime
  result: string      // representative error text
}

const DOWN_AFTER_S = 10 * 60

// When we first saw a host failing, so a re-announce (which refreshes lastAnnounceTime) doesn't reset the clock.
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

export function trackerHealth(torrents: TorrentSummary[]): TrackerHealth[] {
  const byHost = new Map<string, { count: number; announced: number; failing: number; rejected: number; torrentLevel: number; since: number; result: string }>()
  for (const t of torrents) {
    const seen = new Set<string>()
    for (const ts of t.trackerStats) {
      const host = hostOf(ts.announce)
      if (seen.has(host)) continue
      seen.add(host)
      const h = byHost.get(host) ?? { count: 0, announced: 0, failing: 0, rejected: 0, torrentLevel: 0, since: Infinity, result: '' }
      h.count++
      // stopped torrents never announce; they say nothing about the tracker
      if (ts.hasAnnounced) h.announced++
      const c = classifyAnnounce(ts)
      if (c === 'tracker' || c === 'rejected') {
        h.failing++
        if (c === 'rejected') h.rejected++
        h.since = Math.min(h.since, ts.lastAnnounceTime || Date.now() / 1000)
        // a failed scrape is older evidence of the same outage
        if (ts.hasScraped && !ts.lastScrapeSucceeded && ts.lastScrapeTime) h.since = Math.min(h.since, ts.lastScrapeTime)
        h.result = h.result || ts.lastAnnounceResult
      } else if (c === 'torrent') { h.torrentLevel++; h.result = h.result || ts.lastAnnounceResult }
      byHost.set(host, h)
    }
  }
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
  }).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
}

export function hostOf(announce: string): string {
  try {
    const u = new URL(announce)
    return u.hostname
  } catch {
    return announce
  }
}

function shortResult(r: string): string {
  const s = r.replace(/^Tracker gave (an? )?/i, '').replace(/\s*\(.*\)$/, '')
  return s.length > 28 ? s.slice(0, 27) + '…' : s
}

// ─── sidebar filters ───
export type FilterKey = 'all' | 'download' | 'seed' | 'active' | 'inactive' | 'finished' | 'queued' | 'stopped' | 'error' | 'trackererr'

export const FILTERS: Record<FilterKey, { label: string; f: (t: TorrentSummary) => boolean }> = {
  all: { label: 'All torrents', f: () => true },
  download: { label: 'Downloading', f: t => t.status === Status.Download },
  seed: { label: 'Seeding', f: t => t.status === Status.Seed },
  active: { label: 'Active', f: isActive },
  inactive: { label: 'Inactive', f: t => !isActive(t) && !isQueuedOrChecking(t) },
  finished: { label: 'Finished', f: t => t.isFinished || (t.percentDone >= 1 && t.metadataPercentComplete >= 1) },
  queued: { label: 'Queued / Checking', f: isQueuedOrChecking },
  stopped: { label: 'Stopped', f: t => t.status === Status.Stopped && t.error === 0 },
  error: { label: 'Error', f: t => t.error !== 0 },
  trackererr: { label: 'Tracker error', f: hasTrackerProblem },
}
export const FILTER_ORDER: FilterKey[] = ['all', 'download', 'seed', 'active', 'inactive', 'finished', 'queued', 'stopped', 'error', 'trackererr']

/** A filter string is a FilterKey, `label:<name>`, `dir:<path>` (prefix) or `tracker:<host>`. */
export function filterFn(filter: string, base: string): { label: string; f: (t: TorrentSummary) => boolean } {
  if (filter.startsWith('label:')) { const l = filter.slice(6); return { label: l, f: t => t.labels.includes(l) } }
  if (filter.startsWith('dir:')) { const d = filter.slice(4); return { label: relDir(d, base) || d, f: t => t.downloadDir === d || t.downloadDir.startsWith(d + '/') } }
  if (filter.startsWith('tracker:')) { const h = filter.slice(8); return { label: h, f: t => t.trackerStats.some(ts => hostOf(ts.announce) === h) } }
  return FILTERS[(filter as FilterKey) in FILTERS ? (filter as FilterKey) : 'all']
}

// ─── attribute filters ───
export type AdvKey = 'size' | 'age' | 'ratio' | 'idle'
export type Adv = Partial<Record<AdvKey, string>>

export const ADV: Record<AdvKey, Record<string, (t: TorrentSummary) => boolean>> = {
  size: { lt1: t => gb(t.sizeWhenDone) < 1, '1to10': t => gb(t.sizeWhenDone) >= 1 && gb(t.sizeWhenDone) <= 10, gt10: t => gb(t.sizeWhenDone) > 10 },
  age: { '1d': t => daysSince(t.addedDate) < 1, '7d': t => daysSince(t.addedDate) < 7, '30d': t => daysSince(t.addedDate) < 30, older: t => daysSince(t.addedDate) >= 30 },
  ratio: { lt1: t => t.uploadRatio < 1, gte1: t => t.uploadRatio >= 1, gte2: t => t.uploadRatio >= 2 },
  idle: { active: isActive, idle7: t => !isActive(t) && daysSince(t.activityDate) > 7, idle30: t => !isActive(t) && daysSince(t.activityDate) > 30 },
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
export const advFn = (adv: Adv) => (t: TorrentSummary) => advActive(adv).every(k => ADV[k][adv[k]!]?.(t) ?? true)

// ─── sort ───
export type SortKey = 'state' | 'name' | 'size' | 'progress' | 'down' | 'up' | 'ratio' | 'eta' | 'added' | 'activity'

/** Problems first, then by how much attention a torrent needs. */
export function rank(t: TorrentSummary): number {
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

export function sortFn(key: SortKey, dir: 1 | -1): (a: TorrentSummary, b: TorrentSummary) => number {
  const num = (f: (t: TorrentSummary) => number) => (a: TorrentSummary, b: TorrentSummary) => (f(a) - f(b)) * dir || a.name.localeCompare(b.name)
  switch (key) {
    case 'name': return (a, b) => a.name.localeCompare(b.name) * dir
    case 'size': return num(t => t.sizeWhenDone)
    case 'progress': return num(t => t.percentDone)
    case 'down': return num(t => t.rateDownload)
    case 'up': return num(t => t.rateUpload)
    case 'ratio': return num(t => t.uploadRatio)
    case 'eta': return num(t => (t.eta < 0 ? Number.MAX_SAFE_INTEGER : t.eta))
    case 'added': return num(t => t.addedDate)
    case 'activity': return num(t => t.activityDate)
    default: return (a, b) => (rank(a) - rank(b)) * dir || b.activityDate - a.activityDate || a.name.localeCompare(b.name)
  }
}

// ─── folders ───
export function relDir(dir: string, base: string): string {
  if (base && dir.startsWith(base + '/')) return dir.slice(base.length + 1)
  if (dir === base) return ''
  return dir
}

export interface FolderNode { path: string; name: string; depth: number; count: number }

/** Flattened folder tree of every download dir relative to the session download-dir. */
export function folderTree(torrents: TorrentSummary[], base: string): FolderNode[] {
  const dirs = [...new Set(torrents.map(t => t.downloadDir))].sort()
  const seen = new Set<string>()
  const out: FolderNode[] = []
  for (const d of dirs) {
    const inBase = !!base && d.startsWith(base + '/')
    const parts = inBase ? relDir(d, base).split('/') : d === base ? [] : d.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      const p = (inBase ? base + '/' : '/') + parts.slice(0, i).join('/')
      if (seen.has(p)) continue
      seen.add(p)
      out.push({ path: p, name: parts[i - 1], depth: i - 1, count: torrents.filter(t => t.downloadDir === p || t.downloadDir.startsWith(p + '/')).length })
    }
  }
  return out
}

export function labelCounts(torrents: TorrentSummary[]): { label: string; count: number }[] {
  const m = new Map<string, number>()
  for (const t of torrents) for (const l of t.labels) m.set(l, (m.get(l) ?? 0) + 1)
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Peers/swarm text under the name. */
export function swarmOf(t: TorrentSummary): { seeds: number; leechers: number } {
  let seeds = 0, leechers = 0
  for (const ts of t.trackerStats) { seeds = Math.max(seeds, ts.seederCount); leechers = Math.max(leechers, ts.leecherCount) }
  return { seeds, leechers }
}
