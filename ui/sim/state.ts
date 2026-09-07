// The live model. Everything mutable lives here; tick.ts moves it and handlers.ts reads and writes it.

import type { Session, TorrentDetail } from '../src/rpc/types.ts'
import { makeRand, seedOf, type Rand } from './rand.ts'
import { ST } from './derive.ts'
import { buildSession, buildSpace, buildTorrents, clampSeededRates, TRACKERS } from './data.ts'

/** Per-torrent simulation state that never goes over the wire. */
export interface SimFields {
  baseDown: number
  baseUp: number
  /** Phase offset so the rate curves of different torrents do not move in lockstep. */
  phase: number
  /** How long a full verify takes for this torrent, in simulated seconds. */
  checkSecs: number
  /** Status to restore when a verify finishes. */
  prevStatus: number
  /** Rates from the previous tick, so activity_date is still bumped on the frame they hit zero. */
  prevDown: number
  prevUp: number
  /** Simulated stall: rate parked at zero until this timestamp. */
  stallUntil: number
  /** Average swarm copies per piece, for the availability map. */
  swarm: number
  rand: Rand
}

export interface StatsBlockState {
  uploaded_bytes: number
  downloaded_bytes: number
  files_added: number
  session_count: number
  seconds_active: number
}

export interface SimState {
  torrents: TorrentDetail[]
  session: Session
  sim: Map<number, SimFields>
  /** Ids removed recently, with when, so `recently-active` can report them. */
  removed: { id: number; at: number }[]
  /** Tracker host -> unix time the outage ends. */
  trackerDown: Map<string, number>
  /** Tracker host -> unix time the next outage starts. */
  trackerNext: Map<string, number>
  space: Map<string, { size: number; total: number }>
  cur: StatsBlockState
  cum: StatsBlockState
  portOpen: boolean
  nextId: number
  seed: number
  speed: number
  /** How far back `recently-active` looks, in seconds. */
  recentWindowSec: number
  lastTickMs: number
  rand: Rand
}

export interface SimOptions {
  seed?: number
  count?: number
  speed?: number
  recentWindowSec?: number
  nowMs?: number
}

export function simFieldsFor(t: TorrentDetail): SimFields {
  const rand = makeRand(seedOf(t.hash_string) ^ 0x1b873593)
  const owned = t.availability.filter(v => v >= 0)
  const swarm = owned.length ? owned.reduce((a, v) => a + v, 0) / owned.length : 3
  return {
    baseDown: t.rate_download,
    baseUp: t.rate_upload,
    phase: rand.range(0, Math.PI * 2),
    // A verify runs at roughly 60 MB/s, and never finishes instantly even for a tiny torrent, so
    // the "Verifying" row stays on screen long enough to look at.
    checkSecs: Math.max(20, t.size_when_done / 60e6),
    prevStatus: t.percent_done >= 1 ? ST.Seed : ST.Download,
    prevDown: t.rate_download,
    prevUp: t.rate_upload,
    stallUntil: 0,
    swarm,
    rand,
  }
}

export function createState(opts: SimOptions = {}): SimState {
  const seed = opts.seed ?? 1
  const nowMs = opts.nowMs ?? Date.now()
  const torrents = buildTorrents({ seed, count: opts.count, now: Math.floor(nowMs / 1000) })
  const session = buildSession(torrents)
  clampSeededRates(torrents, session)
  const sim = new Map<number, SimFields>()
  for (const t of torrents) sim.set(t.id, simFieldsFor(t))

  const now = Math.floor(nowMs / 1000)
  const trackerNext = new Map<string, number>()
  for (const def of Object.values(TRACKERS)) {
    if (def.mood === 'flap') trackerNext.set(new URL(def.announce).hostname, now + 90)
  }

  return {
    torrents,
    session,
    sim,
    removed: [],
    trackerDown: new Map(),
    trackerNext,
    space: buildSpace(),
    cur: { uploaded_bytes: 1.31e9, downloaded_bytes: 5.14e9, files_added: 3, session_count: 1, seconds_active: 570_000 },
    cum: { uploaded_bytes: 391e9, downloaded_bytes: 218e9, files_added: 412, session_count: 37, seconds_active: 12_300_000 },
    portOpen: session.port_forwarding_enabled,
    nextId: torrents.length + 1,
    seed,
    speed: opts.speed ?? 1,
    recentWindowSec: opts.recentWindowSec ?? 60,
    lastTickMs: nowMs,
    rand: makeRand(seed ^ 0x27d4eb2f),
  }
}

export const byId = (s: SimState, id: number) => s.torrents.find(t => t.id === id)

/** Which mount a download dir belongs to, mirroring mountOf() in the store. */
export function mountOf(dir: string, base: string): string {
  if (base && (dir === base || dir.startsWith(base + '/'))) return base
  const parts = dir.split('/').filter(Boolean)
  return '/' + parts.slice(0, Math.min(2, parts.length)).join('/')
}
