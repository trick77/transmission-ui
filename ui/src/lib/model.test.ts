import { beforeEach, describe, expect, it } from 'vitest'
import { Status, type TorrentSummary, type TrackerStat } from '../rpc/types'
import {
  ADV, ADV_KEYS, ADV_LABEL, ADV_OPTIONS, advActive, advFn, classifyAnnounce, filterFn, FILTERS, FILTER_ORDER, folderTree, hasTrackerProblem,
  hostOf, labelCounts, rank, relDir, sortFn, statusView, swarmOf, trackerHealth,
} from './model'

const now = Math.floor(Date.now() / 1000)

function ts(o: Partial<TrackerStat> = {}): TrackerStat {
  return {
    id: 0, announce: 'http://tracker.example.org:6969/announce', host: 'tracker.example.org', tier: 0, announce_state: 1,
    has_announced: true, last_announce_succeeded: true, last_announce_result: 'Success', last_announce_time: now - 60, last_announce_peer_count: 5,
    next_announce_time: now + 600, has_scraped: true, last_scrape_succeeded: true, last_scrape_time: now - 100, seeder_count: 10, leecher_count: 2, download_count: 100, downloader_count: 3, is_backup: false, ...o,
  }
}

let nextId = 1
function tor(o: Partial<TorrentSummary> = {}): TorrentSummary {
  return {
    id: nextId++, name: `t${nextId}`, status: Status.Seed, error: 0, error_string: '', percent_done: 1, size_when_done: 2e9, total_size: 2e9, left_until_done: 0,
    rate_download: 0, rate_upload: 0, upload_ratio: 1.5, eta: -1, peers_connected: 0, peers_sending_to_us: 0, peers_getting_from_us: 0, labels: [],
    download_dir: '/data/torrents/iso', is_finished: false, queue_position: 0, added_date: now - 86400 * 2, activity_date: now - 3600, done_date: now - 3600,
    recheck_progress: 0, metadata_percent_complete: 1, tracker_stats: [ts()], bandwidth_priority: 0, hash_string: 'h', magnet_link: 'magnet:?xt=urn:btih:h', ...o,
  }
}

beforeEach(() => { localStorage.clear(); nextId = 1 })

describe('statusView', () => {
  it('maps every status and the error override', () => {
    expect(statusView(tor({ status: Status.Download })).label).toBe('Downloading')
    expect(statusView(tor({ status: Status.Download, metadata_percent_complete: 0 })).label).toBe('Fetching metadata')
    expect(statusView(tor({ status: Status.Seed })).kind).toBe('seed')
    expect(statusView(tor({ status: Status.SeedWait })).label).toBe('Queued to seed')
    expect(statusView(tor({ status: Status.DownloadWait })).label).toBe('Queued')
    expect(statusView(tor({ status: Status.Check })).label).toBe('Verifying')
    expect(statusView(tor({ status: Status.CheckWait })).label).toBe('Queued to verify')
    expect(statusView(tor({ status: Status.Stopped })).kind).toBe('stop')
    expect(statusView(tor({ status: Status.Seed, error: 3 })).kind).toBe('err')
  })
})

describe('classifyAnnounce', () => {
  it('distinguishes ok / tracker / torrent / rejected', () => {
    expect(classifyAnnounce(ts())).toBe('ok')
    expect(classifyAnnounce(ts({ has_announced: false, last_announce_succeeded: false }))).toBe('ok')
    expect(classifyAnnounce(ts({ last_announce_succeeded: false, last_announce_result: 'Could not connect to tracker' }))).toBe('tracker')
    expect(classifyAnnounce(ts({ last_announce_succeeded: false, last_announce_result: 'Connection timed out' }))).toBe('tracker')
    expect(classifyAnnounce(ts({ last_announce_succeeded: false, last_announce_result: 'Unregistered torrent' }))).toBe('torrent')
    expect(classifyAnnounce(ts({ last_announce_succeeded: false, last_announce_result: 'Torrent not found' }))).toBe('torrent')
    expect(classifyAnnounce(ts({ last_announce_succeeded: false, last_announce_result: 'Your client is not on the whitelist' }))).toBe('rejected')
    expect(classifyAnnounce(ts({ last_announce_succeeded: false, last_announce_result: 'Client banned' }))).toBe('rejected')
  })
  it('hasTrackerProblem', () => {
    expect(hasTrackerProblem(tor())).toBe(false)
    expect(hasTrackerProblem(tor({ tracker_stats: [ts({ last_announce_succeeded: false, last_announce_result: 'Unregistered torrent' })] }))).toBe(true)
  })
})

describe('trackerHealth', () => {
  const dead = (o: Partial<TrackerStat> = {}) => ts({ last_announce_succeeded: false, last_announce_result: 'Could not connect to tracker', last_scrape_succeeded: false, last_scrape_time: now - 1200, ...o })
  it('ok when all announces succeed', () => {
    const h = trackerHealth([tor(), tor()])
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ host: 'tracker.example.org', count: 2, failing: 0, state: 'ok' })
  })
  it('issues when only some fail or the outage is young', () => {
    expect(trackerHealth([tor({ tracker_stats: [dead({ last_scrape_succeeded: true, last_announce_time: now - 30 })] }), tor()])[0].state).toBe('issues')
    expect(trackerHealth([tor({ tracker_stats: [dead({ last_scrape_succeeded: true, last_announce_time: now - 30 })] })])[0].state).toBe('issues')
  })
  it('down when every announced torrent fails for ≥ 10 min, dated by the older scrape failure', () => {
    const h = trackerHealth([tor({ tracker_stats: [dead({ last_announce_time: now - 30 })] }), tor({ tracker_stats: [dead({ last_announce_time: now - 45 })] })])
    expect(h[0].state).toBe('down')
    expect(h[0].since).toBeLessThanOrEqual(now - 1200)
    expect(h[0].result).toBe('Could not connect to tracker')
  })
  it('stopped torrents that never announced do not dilute the verdict', () => {
    const h = trackerHealth([tor({ tracker_stats: [dead()] }), tor({ status: Status.Stopped, tracker_stats: [ts({ has_announced: false, last_announce_succeeded: false })] })])
    expect(h[0]).toMatchObject({ count: 2, state: 'down' })
  })
  it('remembers first-seen across polls so re-announces do not reset the clock', () => {
    // fresh host: young failure → issues
    const young = (age: number) => tor({ tracker_stats: [dead({ announce: 'http://fresh.example.org/announce', last_scrape_succeeded: true, last_announce_time: now - age })] })
    expect(trackerHealth([young(30)])[0].state).toBe('issues')
    // same host keeps failing with ever-fresh announce times; once the remembered first-seen is old enough it is down
    const remembered = JSON.parse(localStorage.getItem('tm.trkfail') || '[]') as [string, number][]
    expect(remembered.find(([h]) => h === 'fresh.example.org')).toBeTruthy()
    const older = tor({ tracker_stats: [dead({ announce: 'http://old.example.org/announce', last_scrape_time: now - 5000 })] })
    expect(trackerHealth([older])[0].state).toBe('down')
    // recovery forgets the host
    const ok = tor({ tracker_stats: [ts({ announce: 'http://old.example.org/announce' })] })
    expect(trackerHealth([ok])[0].state).toBe('ok')
    expect((JSON.parse(localStorage.getItem('tm.trkfail') || '[]') as [string, number][]).find(([h]) => h === 'old.example.org')).toBeUndefined()
  })
  it('rejected when every announce is a whitelist/ban error', () => {
    const rej = tor({ tracker_stats: [dead({ last_announce_result: 'Your client is not on the whitelist' })] })
    expect(trackerHealth([rej])[0].state).toBe('rejected')
  })
  it('hostOf falls back to the raw string', () => {
    expect(hostOf('udp://tracker.opentrackr.org:1337/announce')).toBe('tracker.opentrackr.org')
    expect(hostOf('not a url')).toBe('not a url')
  })
})

describe('filters', () => {
  const set = [
    tor({ status: Status.Download, rate_download: 100, percent_done: .5, is_finished: false }),
    tor({ status: Status.Seed, rate_upload: 100 }),
    tor({ status: Status.Seed }),
    tor({ status: Status.Check }),
    tor({ status: Status.DownloadWait }),
    tor({ status: Status.Stopped }),
    tor({ status: Status.Stopped, error: 3 }),
    tor({ status: Status.Seed, tracker_stats: [ts({ last_announce_succeeded: false, last_announce_result: 'timed out' })], labels: ['x'], download_dir: '/data/torrents/radarr/sub' }),
  ]
  it('sidebar filters partition sensibly', () => {
    const count = (k: keyof typeof FILTERS) => set.filter(FILTERS[k].f).length
    expect(count('all')).toBe(8)
    expect(count('download')).toBe(1)
    expect(count('seed')).toBe(3)
    expect(count('active')).toBe(2)
    expect(count('inactive')).toBe(4)
    expect(count('finished')).toBe(7)
    expect(count('queued')).toBe(2)
    expect(count('stopped')).toBe(1)
    expect(count('error')).toBe(1)
    expect(count('trackererr')).toBe(1)
    expect(FILTER_ORDER).toContain('trackererr')
  })
  it('filterFn handles label:, dir:, tracker: and unknown keys', () => {
    const base = '/data/torrents'
    expect(set.filter(filterFn('label:x', base).f)).toHaveLength(1)
    expect(filterFn('dir:/data/torrents/radarr', base).label).toBe('radarr')
    expect(set.filter(filterFn('dir:/data/torrents/radarr', base).f)).toHaveLength(1)
    expect(set.filter(filterFn('tracker:tracker.example.org', base).f)).toHaveLength(8)
    expect(filterFn('bogus', base).label).toBe('All torrents')
    expect(filterFn('constructor', base).label).toBe('All torrents')   // prototype keys are not filters
    expect(filterFn('dir:/elsewhere', base).label).toBe('/elsewhere')
  })
  it('attribute filters', () => {
    const t = tor({ size_when_done: 12e9, added_date: now - 86400 * 40, upload_ratio: 0.5, activity_date: now - 86400 * 10 })
    expect(ADV.size.gt10(t)).toBe(true); expect(ADV.size.lt1(t)).toBe(false); expect(ADV.size['1to10'](tor())).toBe(true)
    expect(ADV.age.older(t)).toBe(true); expect(ADV.age['1d'](t)).toBe(false); expect(ADV.age['7d'](tor())).toBe(true); expect(ADV.age['30d'](tor())).toBe(true)
    expect(ADV.ratio.lt1(t)).toBe(true); expect(ADV.ratio.gte1(tor())).toBe(true); expect(ADV.ratio.gte2(tor())).toBe(false)
    expect(ADV.idle.idle7(t)).toBe(true); expect(ADV.idle.idle30(t)).toBe(false); expect(ADV.idle.active(t)).toBe(false)
    expect(advActive({ size: 'gt10', age: 'any', ratio: undefined })).toEqual(['size'])
    expect(advFn({ size: 'gt10', ratio: 'lt1' })(t)).toBe(true)
    expect(advFn({ size: 'lt1' })(t)).toBe(false)
    expect(advFn({})(t)).toBe(true)
    for (const k of ADV_KEYS) for (const o of ADV_OPTIONS[k]) if (o.v !== 'any') expect(ADV_LABEL[k][o.v]).toBeTruthy()
  })
})

describe('sort', () => {
  it('rank puts problems first', () => {
    expect(rank(tor({ error: 1 }))).toBe(0)
    expect(rank(tor({ tracker_stats: [ts({ last_announce_succeeded: false, last_announce_result: 'x' })] }))).toBe(1)
    expect(rank(tor({ status: Status.Check }))).toBe(2)
    expect(rank(tor({ status: Status.DownloadWait }))).toBe(3)
    expect(rank(tor({ status: Status.Download }))).toBe(4)
    expect(rank(tor({ status: Status.SeedWait }))).toBe(5)
    expect(rank(tor({ status: Status.Seed }))).toBe(6)
    expect(rank(tor({ status: Status.Stopped }))).toBe(7)
  })
  it('sortFn by every key and direction', () => {
    const a = tor({ name: 'a', size_when_done: 1, percent_done: .1, rate_download: 1, rate_upload: 9, upload_ratio: 1, eta: 5, added_date: 1, activity_date: 1 })
    const b = tor({ name: 'b', size_when_done: 2, percent_done: .9, rate_download: 9, rate_upload: 1, upload_ratio: 2, eta: -1, added_date: 2, activity_date: 2 })
    expect([b, a].sort(sortFn('name', 1)).map(t => t.name)).toEqual(['a', 'b'])
    expect([a, b].sort(sortFn('name', -1)).map(t => t.name)).toEqual(['b', 'a'])
    expect([a, b].sort(sortFn('size', -1))[0]).toBe(b)
    expect([a, b].sort(sortFn('progress', 1))[0]).toBe(a)
    expect([a, b].sort(sortFn('down', -1))[0]).toBe(b)
    expect([a, b].sort(sortFn('up', -1))[0]).toBe(a)
    expect([a, b].sort(sortFn('ratio', -1))[0]).toBe(b)
    const inf = tor({ name: 'inf', upload_ratio: -2 })
    expect([a, inf, b].sort(sortFn('ratio', -1))[0]).toBe(inf)          // infinite ratio sorts first, not below zero
    expect(ADV.ratio.gte2(inf)).toBe(true)
    expect([b, a].sort(sortFn('eta', 1))[0]).toBe(a)   // unknown eta sorts last
    expect([a, b].sort(sortFn('added', -1))[0]).toBe(b)
    expect([a, b].sort(sortFn('activity', -1))[0]).toBe(b)
    const err = tor({ error: 1, name: 'z' })
    expect([a, err, b].sort(sortFn('state', 1))[0]).toBe(err)
  })
})

describe('folders / labels / swarm', () => {
  it('relDir', () => {
    expect(relDir('/data/torrents/radarr', '/data/torrents')).toBe('radarr')
    expect(relDir('/data/torrents', '/data/torrents')).toBe('')
    expect(relDir('/other', '/data/torrents')).toBe('/other')
  })
  it('folderTree nests and counts subfolders', () => {
    const tree = folderTree([tor({ download_dir: '/data/torrents/sonarr/docs' }), tor({ download_dir: '/data/torrents/sonarr' }), tor({ download_dir: '/data/torrents/iso' }), tor({ download_dir: '/mnt/x' })], '/data/torrents')
    expect(tree.map(n => [n.name, n.depth, n.count])).toEqual([['iso', 0, 1], ['sonarr', 0, 2], ['docs', 1, 1], ['mnt', 0, 1], ['x', 1, 1]])
    expect(tree.map(n => n.path)).toEqual(['/data/torrents/iso', '/data/torrents/sonarr', '/data/torrents/sonarr/docs', '/mnt', '/mnt/x'])
  })
  it('labelCounts', () => {
    expect(labelCounts([tor({ labels: ['a', 'b'] }), tor({ labels: ['a'] })])).toEqual([{ label: 'a', count: 2 }, { label: 'b', count: 1 }])
  })
  it('swarmOf takes the max over trackers', () => {
    expect(swarmOf(tor({ tracker_stats: [ts({ seeder_count: 3, leecher_count: 9 }), ts({ seeder_count: 8, leecher_count: 1 })] }))).toEqual({ seeds: 8, leechers: 9 })
  })
})
