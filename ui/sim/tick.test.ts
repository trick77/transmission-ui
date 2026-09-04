import { describe, expect, it } from 'vitest'
import { createState, type SimState } from './state.ts'
import { MAX_DT, tick } from './tick.ts'
import { handle } from './handlers.ts'
import { ST } from './derive.ts'

const T0 = 1_760_000_000_000

const fresh = (opts: Parameters<typeof createState>[0] = {}) => createState({ seed: 3, nowMs: T0, ...opts })

/** Run n steps of `step` seconds each, returning the final wall-clock ms. */
function run(s: SimState, steps: number, step = 2): number {
  let t = T0
  for (let i = 0; i < steps; i++) { t += step * 1000; tick(s, t) }
  return t
}

const invariant = (s: SimState) => s.torrents.every(t =>
  t.metadataPercentComplete < 1 || Math.abs(t.haveValid + t.haveUnchecked + t.leftUntilDone - t.sizeWhenDone) < 1)

describe('the tick', () => {
  it('keeps the byte invariant across a long run', () => {
    const s = fresh()
    run(s, 400)
    expect(invariant(s)).toBe(true)
  })

  it('never lets progress exceed one or go backwards', () => {
    const s = fresh()
    const seen = new Map(s.torrents.map(t => [t.id, t.percentDone]))
    for (let i = 0; i < 200; i++) {
      tick(s, T0 + i * 2000)
      for (const t of s.torrents) {
        if (t.status === ST.Check || t.metadataPercentComplete < 1) continue
        expect(t.percentDone).toBeLessThanOrEqual(1)
        expect(t.percentDone).toBeGreaterThanOrEqual((seen.get(t.id) ?? 0) - 1e-9)
        seen.set(t.id, t.percentDone)
      }
    }
  })

  it('clamps a huge wall-clock jump so a sleeping laptop cannot teleport the world', () => {
    const s = fresh()
    const t = s.torrents[0]
    const before = t.haveValid
    const ceiling = s.sim.get(t.id)!.baseDown * MAX_DT * 1.5
    tick(s, T0 + 10 * 3600 * 1000)
    expect(t.haveValid - before).toBeLessThan(ceiling)
    expect(t.haveValid - before).toBeGreaterThan(0)
  })

  it('scales the whole session by TM_SIM_SPEED', () => {
    const slow = fresh({ speed: 1 }), fast = fresh({ speed: 10 })
    const before = slow.torrents[0].haveValid
    tick(slow, T0 + 2000)
    tick(fast, T0 + 2000)
    expect(fast.torrents[0].haveValid - before).toBeGreaterThan((slow.torrents[0].haveValid - before) * 5)
  })

  it('finishes a download, flips it to seeding and stamps doneDate', () => {
    const s = fresh({ speed: 4000 })
    const t = s.torrents.find(x => x.status === ST.Download && x.rateDownload > 0)!
    run(s, 400)
    expect(t.status).not.toBe(ST.Download)
    expect(t.percentDone).toBe(1)
    expect(t.doneDate).toBeGreaterThan(0)
  })

  it('stops a seed once it reaches the session ratio goal and marks it finished', () => {
    const s = fresh({ speed: 20000 })
    const t = s.torrents.find(x => x.status === ST.Seed && x.seedRatioMode === 0)!
    run(s, 600)
    expect(t.status).toBe(ST.Stopped)
    expect(t.isFinished).toBe(true)
    expect(t.rateUpload).toBe(0)
  })

  it('never lets an unlimited seed be stopped by the session goal', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.seedRatioMode === 2 && x.status === ST.Seed)!
    run(s, 200)
    expect(t.status).toBe(ST.Seed)
  })

  it('honours the global alt-speed cap as a budget across every torrent', () => {
    const s = fresh()
    handle(s, 'session-set', { 'alt-speed-enabled': true, 'alt-speed-down': 500 }, T0 / 1000)
    run(s, 5)
    const total = s.torrents.reduce((n, t) => n + t.rateDownload, 0)
    expect(total).toBeLessThanOrEqual(500 * 1000 + 10)
  })

  it('keeps the number of downloading torrents inside the queue size, additions included', () => {
    const s = fresh()
    for (let i = 0; i < 100; i++) {
      tick(s, T0 + i * 2000)
      if (i === 50) handle(s, 'torrent-add', { filename: 'magnet:?xt=urn:btih:' + 'f'.repeat(40) }, T0 / 1000)
      expect(s.torrents.filter(t => t.status === ST.Download).length)
        .toBeLessThanOrEqual(s.session['download-queue-size'])
    }
  })

  it('promotes a queued torrent as soon as a slot frees', () => {
    const s = fresh()
    const queued = s.torrents.find(t => t.status === ST.DownloadWait)!
    const running = s.torrents.find(t => t.status === ST.Download)!
    handle(s, 'torrent-stop', { ids: [running.id] }, T0 / 1000)
    expect(queued.status).toBe(ST.Download)
  })

  it('verifies one torrent at a time and hands the rest back to the queue', () => {
    const s = fresh({ speed: 60 })
    // Turn the ratio goal off, so the assertion is about verifying rather than about seeding limits.
    s.session.seedRatioLimited = false
    const ids = s.torrents.filter(t => t.status === ST.Seed).slice(0, 3).map(t => t.id)
    handle(s, 'torrent-verify', { ids }, T0 / 1000)
    for (let i = 0; i < 300; i++) {
      tick(s, T0 + i * 2000)
      expect(s.torrents.filter(t => t.status === ST.Check).length).toBeLessThanOrEqual(1)
    }
    for (const id of ids) {
      const t = s.torrents.find(x => x.id === id)!
      expect([ST.Seed, ST.SeedWait]).toContain(t.status)
      expect(t.percentDone).toBe(1)
    }
  })

  it('turns a bare magnet into a real torrent once metadata arrives', () => {
    const s = fresh({ speed: 30 })
    const magnet = s.torrents.find(t => t.metadataPercentComplete < 1)!
    const wasName = magnet.name
    run(s, 60)
    expect(magnet.metadataPercentComplete).toBe(1)
    expect(magnet.name).not.toBe(wasName)
    expect(magnet.sizeWhenDone).toBeGreaterThan(0)
    expect(magnet.files.length).toBeGreaterThan(0)
  })

  it('bumps activityDate on the tick a rate falls to zero, not only while it is moving', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.status === ST.Download && x.rateDownload > 0)!
    run(s, 3)
    handle(s, 'torrent-stop', { ids: [t.id] }, Math.floor((T0 + 6000) / 1000))
    tick(s, T0 + 8000)
    expect(t.rateDownload).toBe(0)
    expect(t.activityDate).toBe(Math.floor((T0 + 8000) / 1000))
  })

  it('takes the flapping tracker down long enough to count as down', () => {
    const s = fresh()
    run(s, 2000, 5)
    // 10 000 simulated seconds is several full outage cycles.
    expect(s.trackerDown.size + s.trackerNext.size).toBeGreaterThan(0)
  })

  it('grows the cumulative counters', () => {
    const s = fresh()
    const before = s.cum.downloadedBytes
    run(s, 20)
    expect(s.cum.downloadedBytes).toBeGreaterThan(before)
    expect(s.cur.secondsActive).toBeGreaterThan(570_000)
  })
})
