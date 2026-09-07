import { describe, expect, it } from 'vitest'
import { createState, type SimState } from './state.ts'
import { MAX_DT, tick } from './tick.ts'
import { handle } from './handlers.ts'
import { ST, wantedSize } from './derive.ts'

const T0 = 1_760_000_000_000

const fresh = (opts: Parameters<typeof createState>[0] = {}) => createState({ seed: 3, nowMs: T0, ...opts })

/** Run n steps of `step` seconds each, returning the final wall-clock ms. */
function run(s: SimState, steps: number, step = 2): number {
  let t = T0
  for (let i = 0; i < steps; i++) { t += step * 1000; tick(s, t) }
  return t
}

const invariant = (s: SimState) => s.torrents.every(t =>
  t.metadata_percent_complete < 1 || Math.abs(t.have_valid + t.have_unchecked + t.left_until_done - t.size_when_done) < 1)

describe('the tick', () => {
  it('keeps the byte invariant across a long run', () => {
    const s = fresh()
    run(s, 400)
    expect(invariant(s)).toBe(true)
  })

  it('never lets progress exceed one or go backwards', () => {
    const s = fresh()
    const seen = new Map(s.torrents.map(t => [t.id, t.percent_done]))
    for (let i = 0; i < 200; i++) {
      tick(s, T0 + i * 2000)
      for (const t of s.torrents) {
        if (t.status === ST.Check || t.metadata_percent_complete < 1) continue
        expect(t.percent_done).toBeLessThanOrEqual(1)
        expect(t.percent_done).toBeGreaterThanOrEqual((seen.get(t.id) ?? 0) - 1e-9)
        seen.set(t.id, t.percent_done)
      }
    }
  })

  it('clamps a huge wall-clock jump so a sleeping laptop cannot teleport the world', () => {
    const s = fresh()
    const t = s.torrents[0]
    const before = t.have_valid
    const ceiling = s.sim.get(t.id)!.baseDown * MAX_DT * 1.5
    tick(s, T0 + 10 * 3600 * 1000)
    expect(t.have_valid - before).toBeLessThan(ceiling)
    expect(t.have_valid - before).toBeGreaterThan(0)
  })

  it('scales the whole session by TM_SIM_SPEED', () => {
    const slow = fresh({ speed: 1 }), fast = fresh({ speed: 10 })
    const before = slow.torrents[0].have_valid
    tick(slow, T0 + 2000)
    tick(fast, T0 + 2000)
    expect(fast.torrents[0].have_valid - before).toBeGreaterThan((slow.torrents[0].have_valid - before) * 5)
  })

  it('finishes a download, flips it to seeding and stamps done_date', () => {
    const s = fresh({ speed: 4000 })
    const t = s.torrents.find(x => x.status === ST.Download && x.rate_download > 0)!
    run(s, 400)
    expect(t.status).not.toBe(ST.Download)
    expect(t.percent_done).toBe(1)
    expect(t.done_date).toBeGreaterThan(0)
  })

  it('stops a seed once it reaches the session ratio goal and marks it finished', () => {
    const s = fresh({ speed: 20000 })
    const t = s.torrents.find(x => x.status === ST.Seed && x.seed_ratio_mode === 0)!
    run(s, 600)
    expect(t.status).toBe(ST.Stopped)
    expect(t.is_finished).toBe(true)
    expect(t.rate_upload).toBe(0)
  })

  it('never lets an unlimited seed be stopped by the session goal', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.seed_ratio_mode === 2 && x.status === ST.Seed)!
    run(s, 200)
    expect(t.status).toBe(ST.Seed)
  })

  it('honours the global alt-speed cap as a budget across every torrent', () => {
    const s = fresh()
    handle(s, 'session_set', { 'alt_speed_enabled': true, 'alt_speed_down': 500 }, T0 / 1000)
    run(s, 5)
    const total = s.torrents.reduce((n, t) => n + t.rate_download, 0)
    expect(total).toBeLessThanOrEqual(500 * 1000 + 10)
  })

  it('keeps the number of downloading torrents inside the queue size, additions included', () => {
    const s = fresh()
    for (let i = 0; i < 100; i++) {
      tick(s, T0 + i * 2000)
      if (i === 50) handle(s, 'torrent_add', { filename: 'magnet:?xt=urn:btih:' + 'f'.repeat(40) }, T0 / 1000)
      expect(s.torrents.filter(t => t.status === ST.Download).length)
        .toBeLessThanOrEqual(s.session.download_queue_size)
    }
  })

  it('promotes a queued torrent as soon as a slot frees', () => {
    const s = fresh()
    const queued = s.torrents.find(t => t.status === ST.DownloadWait)!
    const running = s.torrents.find(t => t.status === ST.Download)!
    handle(s, 'torrent_stop', { ids: [running.id] }, T0 / 1000)
    expect(queued.status).toBe(ST.Download)
  })

  it('verifies one torrent at a time and hands the rest back to the queue', () => {
    const s = fresh({ speed: 60 })
    // Turn the ratio goal off, so the assertion is about verifying rather than about seeding limits.
    s.session.seed_ratio_limited = false
    const ids = s.torrents.filter(t => t.status === ST.Seed).slice(0, 3).map(t => t.id)
    handle(s, 'torrent_verify', { ids }, T0 / 1000)
    for (let i = 0; i < 300; i++) {
      tick(s, T0 + i * 2000)
      expect(s.torrents.filter(t => t.status === ST.Check).length).toBeLessThanOrEqual(1)
    }
    for (const id of ids) {
      const t = s.torrents.find(x => x.id === id)!
      expect([ST.Seed, ST.SeedWait]).toContain(t.status)
      expect(t.percent_done).toBe(1)
    }
  })

  it('turns a bare magnet into a real torrent once metadata arrives', () => {
    const s = fresh({ speed: 30 })
    const magnet = s.torrents.find(t => t.metadata_percent_complete < 1)!
    const wasName = magnet.name
    run(s, 60)
    expect(magnet.metadata_percent_complete).toBe(1)
    expect(magnet.name).not.toBe(wasName)
    expect(magnet.size_when_done).toBeGreaterThan(0)
    expect(magnet.files.length).toBeGreaterThan(0)
  })

  it('bumps activity_date on the tick a rate falls to zero, not only while it is moving', () => {
    const s = fresh()
    const t = s.torrents.find(x => x.status === ST.Download && x.rate_download > 0)!
    run(s, 3)
    handle(s, 'torrent_stop', { ids: [t.id] }, Math.floor((T0 + 6000) / 1000))
    tick(s, T0 + 8000)
    expect(t.rate_download).toBe(0)
    expect(t.activity_date).toBe(Math.floor((T0 + 8000) / 1000))
  })

  it('takes the flapping tracker down long enough to count as down', () => {
    const s = fresh()
    run(s, 2000, 5)
    // 10 000 simulated seconds is several full outage cycles.
    expect(s.trackerDown.size + s.trackerNext.size).toBeGreaterThan(0)
  })

  it('refuses to advance on a NaN speed instead of poisoning every counter', () => {
    const s = fresh({ speed: Number('fast') })
    const before = { had: s.torrents[0].have_valid, cum: s.cum.downloaded_bytes }
    run(s, 20)
    expect(s.torrents[0].have_valid).toBe(before.had)
    expect(s.cum.downloaded_bytes).toBe(before.cum)
    expect(Number.isFinite(s.torrents[0].upload_ratio)).toBe(true)
  })

  it('boots with size_when_done already agreeing with the file table', () => {
    const s = fresh()
    for (const t of s.torrents) {
      if (t.metadata_percent_complete < 1) continue
      expect(t.size_when_done).toBe(wantedSize(t))
      const sum = t.files.reduce((n, f, i) => n + (t.file_stats[i]?.wanted !== false ? f.bytes_completed : 0), 0)
      expect(Math.abs(sum - t.have_valid)).toBeLessThan(2)
    }
  })

  it('grows the cumulative counters', () => {
    const s = fresh()
    const before = s.cum.downloaded_bytes
    run(s, 20)
    expect(s.cum.downloaded_bytes).toBeGreaterThan(before)
    expect(s.cur.seconds_active).toBeGreaterThan(570_000)
  })
})
