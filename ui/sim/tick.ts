// Advancing the world. Called at the top of every request rather than on a timer, so an idle
// simulator costs nothing and there is no interval to leak.

import type { Peer, TorrentDetail } from '../src/rpc/types.ts'
import { ST, reconcile, hostOf } from './derive.ts'
import { MAGNET_REVEALS, TRACKERS, MOOD_RESULT, materializeMetadata, countPeersFrom, makePeer, flagsOf } from './data.ts'
import { type SimState, type SimFields, simFieldsFor } from './state.ts'

/** Longest wall-clock gap a single tick will honour, before the speed multiplier. */
export const MAX_DT = 5

const RATIO_NA = -1, RATIO_INF = -2

export function tick(state: SimState, nowMs: number): void {
  // Clamp the raw gap first and scale second, or TM_SIM_SPEED would do nothing against the cap.
  const raw = (nowMs - state.lastTickMs) / 1000
  const dt = Math.min(Math.max(raw, 0), MAX_DT) * state.speed
  state.lastTickMs = nowMs
  // `!(dt > 0)` rather than `dt <= 0`: a NaN speed would slip through the latter and poison every
  // accumulator, and the whole session would report null bytes with no error anywhere.
  if (!(dt > 0)) return
  const now = Math.floor(nowMs / 1000)

  trimRemoved(state, now)
  flapTrackers(state, now)

  const desired = new Map<number, { down: number; up: number }>()
  for (const t of state.torrents) desired.set(t.id, wantedRates(state, t, now))
  applySessionCaps(state, desired)

  let totalDown = 0, totalUp = 0
  for (const t of state.torrents) {
    const f = fields(state, t)
    const want = desired.get(t.id)!
    const changed = advance(state, t, f, want, dt, now)
    totalDown += t.rateDownload
    totalUp += t.rateUpload

    // Bump on the frame the rates fall to zero as well: mergeTorrents only overwrites rows that come
    // back, so a torrent that goes quiet without a final update keeps a stale rate on screen forever.
    if (t.rateDownload > 0 || t.rateUpload > 0 || f.prevDown > 0 || f.prevUp > 0 || changed) t.activityDate = now
    f.prevDown = t.rateDownload
    f.prevUp = t.rateUpload

    announce(state, t, now)
    driftPeers(t, f, dt)
  }

  promoteQueue(state, now)

  for (const blk of [state.cur, state.cum]) {
    blk.downloadedBytes += totalDown * dt
    blk.uploadedBytes += totalUp * dt
    blk.secondsActive += dt
  }
}

function fields(state: SimState, t: TorrentDetail): SimFields {
  let f = state.sim.get(t.id)
  if (!f) { f = simFieldsFor(t); state.sim.set(t.id, f) }
  return f
}

function trimRemoved(state: SimState, now: number): void {
  const cut = now - Math.max(state.recentWindowSec, 60) * 2
  state.removed = state.removed.filter(r => r.at >= cut)
}

// ─── rates ──────────────────────────────────────────────────────────────────

function wantedRates(state: SimState, t: TorrentDetail, now: number): { down: number; up: number } {
  const f = fields(state, t)
  const jitter = 1 + 0.25 * Math.sin(now / 7 + f.phase) + 0.08 * (f.rand() - 0.5)
  const stalled = f.stallUntil > now
  const fetching = t.metadataPercentComplete < 1

  let down = 0, up = 0
  if (t.status === ST.Download && !stalled) {
    down = fetching ? 6_000 : f.baseDown * jitter
  }
  if ((t.status === ST.Seed || t.status === ST.Download) && !stalled) {
    up = f.baseUp * jitter
  }

  if (t.downloadLimited) down = Math.min(down, t.downloadLimit * 1000)
  if (t.uploadLimited) up = Math.min(up, t.uploadLimit * 1000)
  return { down: Math.max(0, down), up: Math.max(0, up) }
}

/** Session limits are a global budget, so everything that honours them is scaled to fit. */
function applySessionCaps(state: SimState, desired: Map<number, { down: number; up: number }>): void {
  const s = state.session
  const alt = s['alt-speed-enabled']
  const downCap = alt ? s['alt-speed-down'] * 1000 : s['speed-limit-down-enabled'] ? s['speed-limit-down'] * 1000 : Infinity
  const upCap = alt ? s['alt-speed-up'] * 1000 : s['speed-limit-up-enabled'] ? s['speed-limit-up'] * 1000 : Infinity

  for (const [cap, key] of [[downCap, 'down'], [upCap, 'up']] as const) {
    if (!Number.isFinite(cap)) continue
    let sum = 0
    for (const t of state.torrents) if (t.honorsSessionLimits) sum += desired.get(t.id)![key]
    if (sum <= cap || sum === 0) continue
    const scale = cap / sum
    for (const t of state.torrents) if (t.honorsSessionLimits) desired.get(t.id)![key] *= scale
  }
}

// ─── one torrent, one step ──────────────────────────────────────────────────

function advance(state: SimState, t: TorrentDetail, f: SimFields, want: { down: number; up: number }, dt: number, now: number): boolean {
  let changed = false

  if (t.metadataPercentComplete < 1) {
    // A paused or queued magnet is not talking to anyone, so its metadata does not arrive either.
    if (t.status !== ST.Download) {
      t.rateDownload = 0
      t.rateUpload = 0
      t.eta = -1
      return false
    }
    t.metadataPercentComplete = Math.min(1, t.metadataPercentComplete + dt / 25)
    t.rateDownload = Math.round(want.down)
    t.rateUpload = 0
    if (t.metadataPercentComplete >= 1) {
      const pick = MAGNET_REVEALS[Math.abs(t.id) % MAGNET_REVEALS.length]
      materializeMetadata(t, pick.name, pick.size, pick.files, pick.comment, f.swarm)
      f.baseDown = 1.6e6
      f.baseUp = 60e3
      changed = true
    }
    return true
  }

  if (t.status === ST.Check) {
    t.recheckProgress = Math.min(1, t.recheckProgress + dt / f.checkSecs)
    t.rateDownload = 0
    t.rateUpload = 0
    if (t.recheckProgress >= 1) {
      t.recheckProgress = 0
      t.haveValid += t.haveUnchecked
      t.haveUnchecked = 0
      reconcile(t)
      // A finished verify rejoins the queue rather than jumping straight back to running, which is
      // what the daemon does and what keeps the running count inside the queue size.
      t.status = (f.prevStatus === ST.Stopped ? ST.Stopped
        : t.percentDone >= 1 ? ST.SeedWait : ST.DownloadWait) as TorrentDetail['status']
      changed = true
    }
    return true
  }

  if (t.status !== ST.Download && t.status !== ST.Seed) {
    t.rateDownload = 0
    t.rateUpload = 0
    t.eta = -1
    return changed
  }

  const gained = Math.min(want.down * dt, t.leftUntilDone)
  if (gained > 0) {
    t.haveValid += gained
    t.downloadedEver += gained
    // The occasional bad piece, so the "wasted" figure in the inspector is not always zero.
    if (f.rand.chance(0.002)) t.corruptEver += Math.min(t.pieceSize, gained)
  }
  t.uploadedEver += want.up * dt
  reconcile(t)

  t.rateDownload = Math.round(t.status === ST.Download ? want.down : 0)
  t.rateUpload = Math.round(want.up)
  if (t.status === ST.Download) t.secondsDownloading += dt
  if (t.status === ST.Seed) t.secondsSeeding += dt

  t.uploadRatio = t.downloadedEver > 0 ? t.uploadedEver / t.downloadedEver
    : t.uploadedEver > 0 ? RATIO_INF : RATIO_NA

  // A download that occasionally parks at zero gives the inactive and stalled filters something real.
  if (t.status === ST.Download && t.rateDownload > 0 && f.rand.chance(0.004 * dt)) {
    f.stallUntil = now + f.rand.int(10, 30)
  }

  if (t.status === ST.Download && t.leftUntilDone <= 0) {
    t.status = ST.Seed as TorrentDetail['status']
    t.percentDone = 1
    t.doneDate = now
    t.rateDownload = 0
    f.baseUp = Math.max(f.baseUp, 120e3)
    changed = true
  }

  const goal = seedGoal(state, t)
  if (t.status === ST.Seed && goal != null && t.uploadRatio >= 0 && t.uploadRatio >= goal) {
    t.status = ST.Stopped as TorrentDetail['status']
    t.isFinished = true
    t.rateUpload = 0
    t.eta = -1
    changed = true
  }

  // Every so often a seed rechecks itself. Without this the verifying state would exist for the
  // first two minutes of a session and then never again.
  if (t.status === ST.Seed && f.rand.chance(0.0002 * dt)) {
    f.prevStatus = ST.Seed
    t.haveUnchecked = t.haveValid
    t.haveValid = 0
    t.recheckProgress = 0
    t.status = ST.CheckWait as TorrentDetail['status']
    return true
  }

  const idleLimit = seedIdleLimit(state, t)
  if (t.status === ST.Seed && idleLimit != null && now - t.activityDate > idleLimit * 60) {
    t.status = ST.Stopped as TorrentDetail['status']
    t.isFinished = true
    t.rateUpload = 0
    changed = true
  }

  t.eta = etaOf(t, goal)
  return changed
}

export function seedGoal(state: SimState, t: TorrentDetail): number | null {
  if (t.seedRatioMode === 1) return t.seedRatioLimit
  if (t.seedRatioMode === 0 && state.session.seedRatioLimited) return state.session.seedRatioLimit
  return null
}

function seedIdleLimit(state: SimState, t: TorrentDetail): number | null {
  if (t.seedIdleMode === 1) return t.seedIdleLimit
  if (t.seedIdleMode === 0 && state.session['idle-seeding-limit-enabled']) return state.session['idle-seeding-limit']
  return null
}

export function etaOf(t: TorrentDetail, goal: number | null): number {
  if (t.status === ST.Download && t.rateDownload > 0) return Math.round(t.leftUntilDone / t.rateDownload)
  if (t.status === ST.Seed && goal != null && t.rateUpload > 0) {
    const target = goal * t.downloadedEver - t.uploadedEver
    if (target > 0) return Math.round(target / t.rateUpload)
  }
  return -1
}

// ─── queue ──────────────────────────────────────────────────────────────────

/** Promote waiting torrents whenever a slot frees. Nothing running is ever demoted, as in the daemon. */
export function promoteQueue(state: SimState, now: number): void {
  const s = state.session
  const pass = (waiting: number, running: number, enabled: boolean, size: number) => {
    const queued = state.torrents.filter(t => t.status === waiting).sort((a, b) => a.queuePosition - b.queuePosition)
    for (const t of queued) {
      const active = state.torrents.filter(x => x.status === running).length
      if (enabled && active >= size) break
      t.status = running as TorrentDetail['status']
      t.activityDate = now
    }
  }
  pass(ST.DownloadWait, ST.Download, s['download-queue-enabled'], s['download-queue-size'])
  pass(ST.SeedWait, ST.Seed, s['seed-queue-enabled'], s['seed-queue-size'])

  // Only one torrent verifies at a time.
  if (!state.torrents.some(t => t.status === ST.Check)) {
    const next = state.torrents.filter(t => t.status === ST.CheckWait).sort((a, b) => a.queuePosition - b.queuePosition)[0]
    if (next) { next.status = ST.Check as TorrentDetail['status']; next.recheckProgress = 0; next.activityDate = now }
  }
}

// ─── trackers ───────────────────────────────────────────────────────────────

/** One host goes down for a while and comes back, so the 10-minute "tracker down" state is reachable. */
function flapTrackers(state: SimState, now: number): void {
  for (const def of Object.values(TRACKERS)) {
    if (def.mood !== 'flap') continue
    const host = hostOf(def.announce)
    const until = state.trackerDown.get(host)
    if (until != null) {
      if (now >= until) {
        state.trackerDown.delete(host)
        state.trackerNext.set(host, now + state.rand.int(420, 900))
      }
      continue
    }
    const next = state.trackerNext.get(host) ?? now
    if (now >= next) state.trackerDown.set(host, now + state.rand.int(780, 1200))
  }
}

function moodOf(state: SimState, announce: string): 'ok' | 'bad' {
  const def = Object.values(TRACKERS).find(d => d.announce === announce)
  if (!def) return 'ok'
  if (def.mood === 'flap') return state.trackerDown.has(hostOf(announce)) ? 'bad' : 'ok'
  return def.mood === 'ok' ? 'ok' : 'bad'
}

function resultFor(url: string): string {
  const def = Object.values(TRACKERS).find(d => d.announce === url)
  return def ? MOOD_RESULT[def.mood] : 'Success'
}

function announce(state: SimState, t: TorrentDetail, now: number): void {
  if (t.status === ST.Stopped) return
  const r = state.rand
  for (const ts of t.trackerStats) {
    if (ts.nextAnnounceTime > now) continue
    const ok = moodOf(state, ts.announce) === 'ok'
    ts.hasAnnounced = true
    ts.announceState = 1
    ts.lastAnnounceTime = now
    ts.lastAnnounceSucceeded = ok
    ts.lastAnnounceResult = ok ? 'Success' : resultFor(ts.announce)
    ts.nextAnnounceTime = now + r.int(240, 360)
    if (ok) {
      ts.lastAnnouncePeerCount = r.int(20, 60)
      ts.hasScraped = true
      ts.lastScrapeSucceeded = true
      ts.lastScrapeTime = now
      ts.seederCount = Math.max(0, ts.seederCount + r.int(-8, 9))
      ts.leecherCount = Math.max(0, ts.leecherCount + r.int(-5, 6))
    } else {
      ts.lastAnnouncePeerCount = 0
      ts.lastScrapeSucceeded = false
    }
  }
}

// ─── peers ──────────────────────────────────────────────────────────────────

function driftPeers(t: TorrentDetail, f: SimFields, dt: number): void {
  const r = f.rand
  if (t.status === ST.Stopped) {
    t.peersConnected = 0
    t.peersSendingToUs = 0
    t.peersGettingFromUs = 0
    t.peers = []
    countPeersFrom(t)
    return
  }
  const limit = t['peer-limit'] || 50
  const downloading = t.status === ST.Download
  const target = downloading ? limit * 0.8 : limit * 0.35
  const drift = r.int(-1, 1) + (t.peersConnected < target ? 1 : t.peersConnected > target * 1.2 ? -1 : 0)
  t.peersConnected = Math.max(0, Math.min(limit, t.peersConnected + drift))
  t.peersSendingToUs = downloading ? Math.round(t.peersConnected * r.range(0.3, 0.55)) : 0
  t.peersGettingFromUs = Math.round(t.peersConnected * (t.status === ST.Seed ? r.range(0.4, 0.8) : r.range(0, 0.25)))

  const shown = Math.min(t.peersConnected, 24)
  const peers: Peer[] = t.peers.slice(0, shown)
  for (const p of peers) {
    p.progress = Math.min(1, p.progress + r.range(0, 0.004) * dt)
    if (downloading) p.rateToClient = r.chance(0.6) ? Math.round(r.int(40, 3400) * 1000) : 0
    else p.rateToClient = 0
    p.rateToPeer = r.chance(0.5) ? Math.round(r.int(10, 900) * 1000) : 0
    p.isDownloadingFrom = p.rateToClient > 0
    p.isUploadingTo = p.rateToPeer > 0
    p.flagStr = flagsOf(p)
  }
  if (peers.length && r.chance(0.15)) peers.splice(r.int(0, peers.length - 1), 1)
  while (peers.length < shown) peers.push(makePeer(r, downloading))
  t.peers = peers
  countPeersFrom(t)
  // The piece map is only regenerated when a detail view actually asks for it (see handlers.ts):
  // rebuilding a 7000-piece bitfield for every torrent on every poll is pure waste.
}
