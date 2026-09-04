// Fields the daemon computes rather than stores: the piece bitfield, availability, per-file byte
// distribution, queue positions, magnet links. Everything here is a pure function of torrent state,
// so the tick only has to move the primary numbers and call back in.

import type { TorrentDetail, TorrentFile, FileStat, TrackerStat } from '../src/rpc/types.ts'
import { makeRand, seedOf } from './rand.ts'

// rpc/types.ts declares Status as a `const enum`, which Node's type stripping cannot erase.
// Same numbers, plain object.
export const ST = Object.freeze({
  Stopped: 0, CheckWait: 1, Check: 2, DownloadWait: 3, Download: 4, SeedWait: 5, Seed: 6,
})

export type StatusNum = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const isDownloading = (s: number) => s === ST.Download
export const isSeeding = (s: number) => s === ST.Seed
export const isChecking = (s: number) => s === ST.Check || s === ST.CheckWait

/**
 * The order pieces get completed in. A small contiguous head (real clients grab the first pieces
 * early for streaming) followed by a seeded shuffle, so the piece strip in the inspector looks like
 * a swarm rather than a progress bar.
 */
const orderCache = new Map<string, Uint32Array>()

export function pieceOrder(count: number, seed: number): Uint32Array {
  const key = `${count}:${seed}`
  const hit = orderCache.get(key)
  if (hit) return hit
  const built = buildPieceOrder(count, seed)
  if (orderCache.size > 512) orderCache.clear()
  orderCache.set(key, built)
  return built
}

function buildPieceOrder(count: number, seed: number): Uint32Array {
  const head = Math.min(count, Math.max(1, Math.round(count * 0.02)))
  const rest: number[] = []
  for (let i = head; i < count; i++) rest.push(i)
  const shuffled = makeRand(seed).shuffle(rest)
  const out = new Uint32Array(count)
  for (let i = 0; i < head; i++) out[i] = i
  for (let i = 0; i < shuffled.length; i++) out[head + i] = shuffled[i]
  return out
}

/** How many pieces are complete at this progress. Exact, so the bitfield popcount matches. */
export const piecesHad = (count: number, pct: number) =>
  Math.max(0, Math.min(count, Math.round(count * pct)))

/**
 * Base64 piece bitfield, MSB first within each byte — the layout Inspector.tsx decodes with
 * `(bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1`.
 */
export function piecesB64(order: Uint32Array, pct: number): string {
  const count = order.length
  if (!count) return ''
  const want = piecesHad(count, pct)
  const bytes = new Uint8Array(Math.ceil(count / 8))
  for (let k = 0; k < want; k++) {
    const i = order[k]
    bytes[i >> 3] |= 0x80 >> (i & 7)
  }
  return Buffer.from(bytes).toString('base64')
}

/**
 * Per-piece availability. Owned pieces are -1 (the daemon's marker; the inspector counts them as one
 * copy), unowned pieces carry how many peers have them. A few holes at 0 keep the availability bar
 * honestly under 100 %.
 */
export function availabilityOf(order: Uint32Array, pct: number, swarm: number, seed: number): number[] {
  const count = order.length
  if (!count) return []
  const want = piecesHad(count, pct)
  const out = new Array<number>(count)
  const r = makeRand(seed)
  const base = Math.max(0, Math.min(9, Math.round(swarm)))
  for (let i = 0; i < count; i++) out[i] = base === 0 ? 0 : Math.max(0, base + r.int(-1, 1))
  // A handful of pieces nobody in the swarm has: this is what a stuck-at-99.9 % torrent looks like.
  if (base > 0 && r.chance(0.5)) {
    const holes = r.int(1, Math.max(1, Math.round(count * 0.01)))
    for (let h = 0; h < holes; h++) out[order[count - 1 - (h % count)]] = 0
  }
  for (let k = 0; k < want; k++) out[order[k]] = -1
  return out
}

/**
 * Spread haveValid over the wanted files in order, so Σ wanted files[].bytesCompleted === haveValid.
 *
 * Bytes already on disk for an unwanted file are left exactly where they are. Zeroing them would
 * throw away real data: unticking a file in the Files tab and ticking it again has to come back to
 * where it was, and the daemon does keep those bytes.
 */
export function distributeBytes(files: TorrentFile[], stats: FileStat[], haveValid: number): void {
  let left = haveValid
  for (let i = 0; i < files.length; i++) {
    if (stats[i]?.wanted === false) continue
    const take = Math.max(0, Math.min(files[i].length, left))
    files[i].bytesCompleted = Math.round(take)
    if (stats[i]) stats[i].bytesCompleted = Math.round(take)
    left -= take
  }
}

/** sizeWhenDone counts only the files the user wants. */
export const wantedSize = (t: TorrentDetail) =>
  t.files.reduce((n, f, i) => n + (t.fileStats[i]?.wanted !== false ? f.length : 0), 0)

/** Bytes already on disk for the files the user wants. The file table is the source of truth here. */
export const wantedHave = (t: TorrentDetail) =>
  t.files.reduce((n, f, i) => n + (t.fileStats[i]?.wanted !== false ? Math.min(f.bytesCompleted, f.length) : 0), 0)

/** haveValid + haveUnchecked + leftUntilDone === sizeWhenDone, always. */
export function reconcile(t: TorrentDetail): void {
  if (t.metadataPercentComplete < 1) return
  t.haveValid = Math.max(0, Math.min(t.sizeWhenDone, t.haveValid))
  t.haveUnchecked = Math.max(0, Math.min(t.sizeWhenDone - t.haveValid, t.haveUnchecked))
  t.leftUntilDone = Math.max(0, t.sizeWhenDone - t.haveValid - t.haveUnchecked)
  t.percentDone = t.sizeWhenDone > 0 ? t.haveValid / t.sizeWhenDone : 0
  if (t.percentDone > 1) t.percentDone = 1
}

/** Contiguous 0..n-1 queue positions in the current order. */
export function renumberQueue(torrents: TorrentDetail[]): void {
  const order = [...torrents].sort((a, b) => a.queuePosition - b.queuePosition || a.id - b.id)
  order.forEach((t, i) => { t.queuePosition = i })
}

export function magnetOf(hash: string, name: string, trackers: TrackerStat[]): string {
  const tr = trackers.map(ts => `&tr=${encodeURIComponent(ts.announce)}`).join('')
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`
}

export function hostOf(announce: string): string {
  try { return new URL(announce).hostname } catch { return announce }
}

/** Refresh pieces/availability from progress. Called whenever a detail view is served. */
export function refreshPieceMap(t: TorrentDetail, swarm: number): void {
  if (!t.pieceCount) { t.pieces = ''; t.availability = []; return }
  const seed = seedOf(t.hashString)
  const order = pieceOrder(t.pieceCount, seed)
  t.pieces = piecesB64(order, t.percentDone)
  t.availability = availabilityOf(order, t.percentDone, swarm, seed ^ 0x5bf03635)
}
