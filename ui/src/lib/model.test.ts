import { beforeEach, describe, expect, it } from 'vitest'
import { Status, type TorrentSummary, type TrackerStat } from '../rpc/types'
import {
  ADV, ADV_KEYS, ADV_LABEL, ADV_OPTIONS, advActive, advFn, classifyAnnounce, filterFn, FILTERS, FILTER_ORDER, folderTree, hasTrackerProblem,
  hostOf, labelCounts, rank, relDir, sortFn, statusView, swarmOf, trackerHealth,
} from './model'

const now = Math.floor(Date.now() / 1000)

function ts(o: Partial<TrackerStat> = {}): TrackerStat {
  return {
    id: 0, announce: 'http://tracker.example.org:6969/announce', host: 'tracker.example.org', tier: 0, announceState: 1,
    hasAnnounced: true, lastAnnounceSucceeded: true, lastAnnounceResult: 'Success', lastAnnounceTime: now - 60, lastAnnouncePeerCount: 5,
    nextAnnounceTime: now + 600, hasScraped: true, lastScrapeSucceeded: true, lastScrapeTime: now - 100, seederCount: 10, leecherCount: 2, downloadCount: 100, isBackup: false, ...o,
  }
}

let nextId = 1
function tor(o: Partial<TorrentSummary> = {}): TorrentSummary {
  return {
    id: nextId++, name: `t${nextId}`, status: Status.Seed, error: 0, errorString: '', percentDone: 1, sizeWhenDone: 2e9, totalSize: 2e9, leftUntilDone: 0,
    rateDownload: 0, rateUpload: 0, uploadRatio: 1.5, eta: -1, peersConnected: 0, peersSendingToUs: 0, peersGettingFromUs: 0, labels: [],
    downloadDir: '/data/torrents/iso', isFinished: false, queuePosition: 0, addedDate: now - 86400 * 2, activityDate: now - 3600, doneDate: now - 3600,
    recheckProgress: 0, metadataPercentComplete: 1, trackerStats: [ts()], bandwidthPriority: 0, hashString: 'h', magnetLink: 'magnet:?xt=urn:btih:h', ...o,
  }
}

beforeEach(() => { localStorage.clear(); nextId = 1 })

describe('statusView', () => {
  it('maps every status and the error override', () => {
    expect(statusView(tor({ status: Status.Download })).label).toBe('Downloading')
    expect(statusView(tor({ status: Status.Download, metadataPercentComplete: 0 })).label).toBe('Fetching metadata')
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
    expect(classifyAnnounce(ts({ hasAnnounced: false, lastAnnounceSucceeded: false }))).toBe('ok')
    expect(classifyAnnounce(ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Could not connect to tracker' }))).toBe('tracker')
    expect(classifyAnnounce(ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Connection timed out' }))).toBe('tracker')
    expect(classifyAnnounce(ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Unregistered torrent' }))).toBe('torrent')
    expect(classifyAnnounce(ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Torrent not found' }))).toBe('torrent')
    expect(classifyAnnounce(ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Your client is not on the whitelist' }))).toBe('rejected')
    expect(classifyAnnounce(ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Client banned' }))).toBe('rejected')
  })
  it('hasTrackerProblem', () => {
    expect(hasTrackerProblem(tor())).toBe(false)
    expect(hasTrackerProblem(tor({ trackerStats: [ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Unregistered torrent' })] }))).toBe(true)
  })
})

describe('trackerHealth', () => {
  const dead = (o: Partial<TrackerStat> = {}) => ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'Could not connect to tracker', lastScrapeSucceeded: false, lastScrapeTime: now - 1200, ...o })
  it('ok when all announces succeed', () => {
    const h = trackerHealth([tor(), tor()])
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ host: 'tracker.example.org', count: 2, failing: 0, state: 'ok' })
  })
  it('issues when only some fail or the outage is young', () => {
    expect(trackerHealth([tor({ trackerStats: [dead({ lastScrapeSucceeded: true, lastAnnounceTime: now - 30 })] }), tor()])[0].state).toBe('issues')
    expect(trackerHealth([tor({ trackerStats: [dead({ lastScrapeSucceeded: true, lastAnnounceTime: now - 30 })] })])[0].state).toBe('issues')
  })
  it('down when every announced torrent fails for ≥ 10 min, dated by the older scrape failure', () => {
    const h = trackerHealth([tor({ trackerStats: [dead({ lastAnnounceTime: now - 30 })] }), tor({ trackerStats: [dead({ lastAnnounceTime: now - 45 })] })])
    expect(h[0].state).toBe('down')
    expect(h[0].since).toBeLessThanOrEqual(now - 1200)
    expect(h[0].result).toBe('Could not connect to tracker')
  })
  it('stopped torrents that never announced do not dilute the verdict', () => {
    const h = trackerHealth([tor({ trackerStats: [dead()] }), tor({ status: Status.Stopped, trackerStats: [ts({ hasAnnounced: false, lastAnnounceSucceeded: false })] })])
    expect(h[0]).toMatchObject({ count: 2, state: 'down' })
  })
  it('remembers first-seen across polls so re-announces do not reset the clock', () => {
    // fresh host: young failure → issues
    const young = (age: number) => tor({ trackerStats: [dead({ announce: 'http://fresh.example.org/announce', lastScrapeSucceeded: true, lastAnnounceTime: now - age })] })
    expect(trackerHealth([young(30)])[0].state).toBe('issues')
    // same host keeps failing with ever-fresh announce times; once the remembered first-seen is old enough it is down
    const remembered = JSON.parse(localStorage.getItem('tm.trkfail') || '[]') as [string, number][]
    expect(remembered.find(([h]) => h === 'fresh.example.org')).toBeTruthy()
    const older = tor({ trackerStats: [dead({ announce: 'http://old.example.org/announce', lastScrapeTime: now - 5000 })] })
    expect(trackerHealth([older])[0].state).toBe('down')
    // recovery forgets the host
    const ok = tor({ trackerStats: [ts({ announce: 'http://old.example.org/announce' })] })
    expect(trackerHealth([ok])[0].state).toBe('ok')
    expect((JSON.parse(localStorage.getItem('tm.trkfail') || '[]') as [string, number][]).find(([h]) => h === 'old.example.org')).toBeUndefined()
  })
  it('rejected when every announce is a whitelist/ban error', () => {
    const rej = tor({ trackerStats: [dead({ lastAnnounceResult: 'Your client is not on the whitelist' })] })
    expect(trackerHealth([rej])[0].state).toBe('rejected')
  })
  it('hostOf falls back to the raw string', () => {
    expect(hostOf('udp://tracker.opentrackr.org:1337/announce')).toBe('tracker.opentrackr.org')
    expect(hostOf('not a url')).toBe('not a url')
  })
})

describe('filters', () => {
  const set = [
    tor({ status: Status.Download, rateDownload: 100, percentDone: .5, isFinished: false }),
    tor({ status: Status.Seed, rateUpload: 100 }),
    tor({ status: Status.Seed }),
    tor({ status: Status.Check }),
    tor({ status: Status.DownloadWait }),
    tor({ status: Status.Stopped }),
    tor({ status: Status.Stopped, error: 3 }),
    tor({ status: Status.Seed, trackerStats: [ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'timed out' })], labels: ['x'], downloadDir: '/data/torrents/radarr/sub' }),
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
    const t = tor({ sizeWhenDone: 12e9, addedDate: now - 86400 * 40, uploadRatio: 0.5, activityDate: now - 86400 * 10 })
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
    expect(rank(tor({ trackerStats: [ts({ lastAnnounceSucceeded: false, lastAnnounceResult: 'x' })] }))).toBe(1)
    expect(rank(tor({ status: Status.Check }))).toBe(2)
    expect(rank(tor({ status: Status.DownloadWait }))).toBe(3)
    expect(rank(tor({ status: Status.Download }))).toBe(4)
    expect(rank(tor({ status: Status.SeedWait }))).toBe(5)
    expect(rank(tor({ status: Status.Seed }))).toBe(6)
    expect(rank(tor({ status: Status.Stopped }))).toBe(7)
  })
  it('sortFn by every key and direction', () => {
    const a = tor({ name: 'a', sizeWhenDone: 1, percentDone: .1, rateDownload: 1, rateUpload: 9, uploadRatio: 1, eta: 5, addedDate: 1, activityDate: 1 })
    const b = tor({ name: 'b', sizeWhenDone: 2, percentDone: .9, rateDownload: 9, rateUpload: 1, uploadRatio: 2, eta: -1, addedDate: 2, activityDate: 2 })
    expect([b, a].sort(sortFn('name', 1)).map(t => t.name)).toEqual(['a', 'b'])
    expect([a, b].sort(sortFn('name', -1)).map(t => t.name)).toEqual(['b', 'a'])
    expect([a, b].sort(sortFn('size', -1))[0]).toBe(b)
    expect([a, b].sort(sortFn('progress', 1))[0]).toBe(a)
    expect([a, b].sort(sortFn('down', -1))[0]).toBe(b)
    expect([a, b].sort(sortFn('up', -1))[0]).toBe(a)
    expect([a, b].sort(sortFn('ratio', -1))[0]).toBe(b)
    const inf = tor({ name: 'inf', uploadRatio: -2 })
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
    const tree = folderTree([tor({ downloadDir: '/data/torrents/sonarr/docs' }), tor({ downloadDir: '/data/torrents/sonarr' }), tor({ downloadDir: '/data/torrents/iso' }), tor({ downloadDir: '/mnt/x' })], '/data/torrents')
    expect(tree.map(n => [n.name, n.depth, n.count])).toEqual([['iso', 0, 1], ['sonarr', 0, 2], ['docs', 1, 1], ['mnt', 0, 1], ['x', 1, 1]])
    expect(tree.map(n => n.path)).toEqual(['/data/torrents/iso', '/data/torrents/sonarr', '/data/torrents/sonarr/docs', '/mnt', '/mnt/x'])
  })
  it('labelCounts', () => {
    expect(labelCounts([tor({ labels: ['a', 'b'] }), tor({ labels: ['a'] })])).toEqual([{ label: 'a', count: 2 }, { label: 'b', count: 1 }])
  })
  it('swarmOf takes the max over trackers', () => {
    expect(swarmOf(tor({ trackerStats: [ts({ seederCount: 3, leecherCount: 9 }), ts({ seederCount: 8, leecherCount: 1 })] }))).toEqual({ seeds: 8, leechers: 9 })
  })
})
