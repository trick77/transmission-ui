import { describe, expect, it } from 'vitest'
import { availabilityOf, distributeBytes, magnetOf, pieceOrder, piecesB64, piecesHad, renumberQueue, reconcile } from './derive.ts'
import { buildTorrents } from './data.ts'
import { hashOf } from './rand.ts'

const NOW = 1_760_000_000

/** The decode Inspector.tsx does, so the bitfield layout is asserted the way the UI reads it. */
function ownedPieces(b64: string, count: number): number[] {
  const bin = Buffer.from(b64, 'base64')
  const out: number[] = []
  for (let i = 0; i < count; i++) if ((bin[i >> 3] >> (7 - (i & 7))) & 1) out.push(i)
  return out
}

describe('piece bitfield', () => {
  it('has exactly as many bits set as the progress implies', () => {
    const order = pieceOrder(1000, 42)
    for (const pct of [0, 0.001, 0.25, 0.5, 0.999, 1]) {
      expect(ownedPieces(piecesB64(order, pct), 1000)).toHaveLength(piecesHad(1000, pct))
    }
  })

  it('scatters pieces instead of filling a prefix', () => {
    const order = pieceOrder(1000, 42)
    const owned = ownedPieces(piecesB64(order, 0.5), 1000)
    // A prefix fill would put every owned piece below 500.
    expect(owned.some(i => i >= 500)).toBe(true)
    expect(owned.some(i => i < 500)).toBe(true)
  })

  it('grows monotonically, so the strip never loses a piece it had', () => {
    const order = pieceOrder(500, 7)
    const before = new Set(ownedPieces(piecesB64(order, 0.3), 500))
    const after = new Set(ownedPieces(piecesB64(order, 0.6), 500))
    for (const i of before) expect(after.has(i)).toBe(true)
  })
})

describe('availability', () => {
  it('marks owned pieces with -1 and matches the piece count', () => {
    const order = pieceOrder(400, 11)
    const avail = availabilityOf(order, 0.4, 4, 11)
    expect(avail).toHaveLength(400)
    expect(avail.filter(v => v < 0)).toHaveLength(piecesHad(400, 0.4))
  })

  it('reports nothing available beyond what we own when the swarm is empty', () => {
    const order = pieceOrder(200, 3)
    const avail = availabilityOf(order, 0.5, 0, 3)
    expect(avail.filter(v => v !== 0)).toHaveLength(100)
  })
})

describe('file bytes', () => {
  it('distributes haveValid across wanted files exactly', () => {
    const files = [
      { name: 'a', length: 100, bytesCompleted: 0 },
      { name: 'b', length: 200, bytesCompleted: 0 },
      { name: 'c', length: 300, bytesCompleted: 0 },
    ]
    const stats = files.map(() => ({ wanted: true, priority: 0 as const, bytesCompleted: 0 }))
    distributeBytes(files, stats, 250)
    expect(files.map(f => f.bytesCompleted)).toEqual([100, 150, 0])
    expect(stats.map(s => s.bytesCompleted)).toEqual([100, 150, 0])
  })

  it('skips files the user does not want', () => {
    const files = [
      { name: 'a', length: 100, bytesCompleted: 0 },
      { name: 'b', length: 100, bytesCompleted: 0 },
    ]
    const stats = [
      { wanted: false, priority: 0 as const, bytesCompleted: 0 },
      { wanted: true, priority: 0 as const, bytesCompleted: 0 },
    ]
    distributeBytes(files, stats, 60)
    expect(files.map(f => f.bytesCompleted)).toEqual([0, 60])
  })
})

describe('reconcile', () => {
  it('keeps haveValid + haveUnchecked + leftUntilDone equal to sizeWhenDone', () => {
    const t = buildTorrents({ now: NOW })[0]
    t.haveValid = t.sizeWhenDone * 2
    reconcile(t)
    expect(t.haveValid + t.haveUnchecked + t.leftUntilDone).toBe(t.sizeWhenDone)
    expect(t.percentDone).toBe(1)
  })
})

describe('queue positions', () => {
  it('renumbers to a contiguous permutation', () => {
    const ts = buildTorrents({ now: NOW })
    ts[0].queuePosition = 999
    ts[5].queuePosition = -4
    renumberQueue(ts)
    expect([...ts].map(t => t.queuePosition).sort((a, b) => a - b)).toEqual(ts.map((_, i) => i))
  })
})

describe('hashes and magnets', () => {
  it('produces a stable 40-hex hash per name', () => {
    expect(hashOf('debian.iso', 1)).toMatch(/^[0-9a-f]{40}$/)
    expect(hashOf('debian.iso', 1)).toBe(hashOf('debian.iso', 1))
    expect(hashOf('debian.iso', 1)).not.toBe(hashOf('debian.iso', 2))
  })

  it('gives every torrent in the dataset a unique hash', () => {
    const ts = buildTorrents({ now: NOW, count: 4 })
    expect(new Set(ts.map(t => t.hashString)).size).toBe(ts.length)
  })

  it('builds a magnet with a display name and every tracker', () => {
    const m = magnetOf('a'.repeat(40), 'Some Name', [
      { announce: 'udp://tracker.example.invalid:1337/announce' } as never,
    ])
    expect(m).toContain('xt=urn:btih:' + 'a'.repeat(40))
    expect(m).toContain('dn=Some%20Name')
    expect(m).toContain('tr=udp%3A%2F%2Ftracker.example.invalid%3A1337%2Fannounce')
  })
})
