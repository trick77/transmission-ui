// An in-memory transmission-daemon behind global fetch: enough of the RPC surface for component
// tests to render real views and assert real writes, without a container.
import { vi } from 'vitest'
import { Status, type Session, type TorrentDetail, type TrackerStat } from '../rpc/types'

const now = Math.floor(Date.now() / 1000)

export function tracker(o: Partial<TrackerStat> = {}): TrackerStat {
  return {
    id: 0, announce: 'http://bttracker.debian.org:6969/announce', host: 'bttracker.debian.org', tier: 0, announceState: 1,
    hasAnnounced: true, lastAnnounceSucceeded: true, lastAnnounceResult: 'Success', lastAnnounceTime: now - 38, lastAnnouncePeerCount: 50,
    nextAnnounceTime: now + 262, hasScraped: true, lastScrapeSucceeded: true, lastScrapeTime: now - 120, seederCount: 1204, leecherCount: 311, downloadCount: 8932, isBackup: false, ...o,
  }
}

export const BASE = '/data/torrents'

export function torrent(o: Partial<TorrentDetail> = {}): TorrentDetail {
  const id = o.id ?? 1
  return {
    id, name: `torrent-${id}`, status: Status.Seed, error: 0, errorString: '', percentDone: 1, sizeWhenDone: 4.71e9, totalSize: 4.71e9, leftUntilDone: 0,
    rateDownload: 0, rateUpload: 0, uploadRatio: 1.12, eta: -1, peersConnected: 0, peersSendingToUs: 0, peersGettingFromUs: 0, labels: [],
    downloadDir: `${BASE}/iso`, isFinished: false, queuePosition: id, addedDate: now - 86400 * 3, activityDate: now - 3600, doneDate: now - 3000,
    recheckProgress: 0, metadataPercentComplete: 1, trackerStats: [tracker()], bandwidthPriority: 0,
    hashString: '6b7a2c1f2e9d8a4b3c0e5f7a1d9c8b2e4f6a0c3d', magnetLink: 'magnet:?xt=urn:btih:6b7a2c1f', torrentFile: '/config/torrents/x.torrent',
    comment: 'fixture', creator: 'mktorrent 1.1', dateCreated: now - 86400 * 20, isPrivate: false,
    pieceCount: 1920, pieceSize: 2_621_440, pieces: btoa(String.fromCharCode(...new Array(240).fill(0xff))), availability: new Array(1920).fill(3),
    haveValid: 4.71e9, haveUnchecked: 0, corruptEver: 0, downloadedEver: 4.71e9, uploadedEver: 5.2e9, secondsDownloading: 900, secondsSeeding: 86400,
    peersFrom: { fromCache: 0, fromDht: 12, fromIncoming: 4, fromLpd: 0, fromLtep: 0, fromPex: 7, fromTracker: 23 },
    seedRatioLimit: 2, seedRatioMode: 0, seedIdleLimit: 30, seedIdleMode: 0, honorsSessionLimits: true,
    downloadLimit: 5000, downloadLimited: false, uploadLimit: 500, uploadLimited: false, 'peer-limit': 50,
    files: [{ name: `torrent-${id}/torrent-${id}.iso`, length: 4.7e9, bytesCompleted: 4.7e9 }, { name: `torrent-${id}/SHA512SUMS`, length: 1200, bytesCompleted: 1200 }],
    fileStats: [{ wanted: true, priority: 0, bytesCompleted: 4.7e9 }, { wanted: true, priority: 0, bytesCompleted: 1200 }],
    peers: [{ address: '185.21.100.42', clientName: 'Transmission 4.0.5', progress: 1, rateToClient: 2_700_000, rateToPeer: 0, flagStr: 'DE', isEncrypted: true, isIncoming: false, isDownloadingFrom: true, isUploadingTo: false, isUTP: false, port: 51413 }],
    trackerList: 'http://bttracker.debian.org:6969/announce',
    webseedsSendingToUs: 0,
    ...o,
  }
}

export function defaultTorrents(): TorrentDetail[] {
  return [
    torrent({ id: 1, name: 'debian-13.1.0-amd64-DVD-1.iso', status: Status.Download, percentDone: .632, rateDownload: 12_400_000, rateUpload: 1_210_000, uploadRatio: .18, eta: 192, peersConnected: 42, peersSendingToUs: 18, peersGettingFromUs: 7, labels: ['linux'], leftUntilDone: 1.7e9 }),
    torrent({ id: 2, name: 'Big Buck Bunny (2008) 4K 60fps', status: Status.Seed, rateUpload: 840_000, uploadRatio: 3.42, peersConnected: 9, peersGettingFromUs: 9, labels: ['blender'], downloadDir: `${BASE}/radarr`, sizeWhenDone: 7.28e9 }),
    torrent({ id: 3, name: 'Tears of Steel (2012) 4K', status: Status.SeedWait, uploadRatio: .98, labels: ['blender'], downloadDir: `${BASE}/radarr` }),
    torrent({ id: 4, name: 'archlinux-2026.08.01-x86_64.iso', status: Status.DownloadWait, percentDone: 0, uploadRatio: 0, labels: ['linux'], sizeWhenDone: 1.23e9 }),
    torrent({ id: 5, name: 'ubuntu-26.04.1-desktop-amd64.iso', status: Status.Check, percentDone: .41, recheckProgress: .41, uploadRatio: 0, labels: ['linux'], sizeWhenDone: 6.02e9 }),
    torrent({ id: 6, name: 'Pride and Prejudice — LibriVox', status: Status.Stopped, uploadRatio: 2.05, labels: ['audiobook'], downloadDir: `${BASE}/audiobooks`, sizeWhenDone: 3.18e8, trackerStats: [tracker({ hasAnnounced: false, lastAnnounceSucceeded: false })] }),
    torrent({ id: 7, name: 'Apollo 11 Flight Journal', status: Status.Stopped, error: 3, errorString: 'No data found! Ensure your drives are connected', percentDone: .57, uploadRatio: .3, labels: ['archive'], downloadDir: `${BASE}/sonarr/docs`, sizeWhenDone: 9.12e8,
      trackerStats: [tracker({ announce: 'http://archive.org/announce', host: 'archive.org', lastAnnounceSucceeded: false, lastAnnounceResult: 'Tracker gave HTTP response code 404 (Not Found)' })] }),
    torrent({ id: 8, name: 'Cosmos Laundromat (2015)', status: Status.Seed, labels: ['blender'], downloadDir: `${BASE}/buffer`, sizeWhenDone: 3.02e9, uploadRatio: .44,
      trackerStats: [tracker(), tracker({ id: 1, announce: 'udp://tracker.opentrackr.org:1337/announce', host: 'tracker.opentrackr.org', tier: 1, lastAnnounceSucceeded: false, lastAnnounceResult: 'Connection timed out', lastScrapeSucceeded: false, lastScrapeTime: now - 1500 })] }),
  ]
}

export function defaultSession(): Session {
  return {
    version: '4.0.5 (a6fe2a64aa)', 'rpc-version': 17, 'download-dir': BASE,
    'alt-speed-enabled': false, 'alt-speed-down': 2000, 'alt-speed-up': 250, 'alt-speed-time-enabled': true, 'alt-speed-time-begin': 480, 'alt-speed-time-end': 1380, 'alt-speed-time-day': 62,
    'speed-limit-down': 20000, 'speed-limit-down-enabled': true, 'speed-limit-up': 2500, 'speed-limit-up-enabled': true,
    'incomplete-dir': `${BASE}/.incomplete`, 'incomplete-dir-enabled': true, 'rename-partial-files': true, 'start-added-torrents': true, 'trash-original-torrent-files': false,
    'script-torrent-done-enabled': false, 'script-torrent-done-filename': '', 'script-torrent-done-seeding-enabled': false, 'script-torrent-done-seeding-filename': '', 'cache-size-mb': 16,
    seedRatioLimit: 2, seedRatioLimited: true, 'idle-seeding-limit': 30, 'idle-seeding-limit-enabled': false,
    'download-queue-size': 3, 'download-queue-enabled': true, 'seed-queue-size': 8, 'seed-queue-enabled': true, 'queue-stalled-minutes': 30, 'queue-stalled-enabled': true,
    'peer-port': 51413, 'peer-port-random-on-start': false, 'port-forwarding-enabled': true, 'dht-enabled': true, 'pex-enabled': true, 'lpd-enabled': false, 'utp-enabled': true,
    'peer-limit-per-torrent': 50, 'peer-limit-global': 200, encryption: 'preferred', 'blocklist-enabled': true, 'blocklist-url': 'https://example.org/level1.gz', 'blocklist-size': 312904,
  }
}

export interface FakeDaemon {
  torrents: TorrentDetail[]
  session: Session
  calls: { method: string; args: Record<string, unknown> }[]
  /** Calls of one method. */
  of(method: string): Record<string, unknown>[]
  portOpen: boolean
  restore(): void
}

export function installFakeDaemon(opts: { torrents?: TorrentDetail[]; session?: Partial<Session>; unauthorized?: boolean } = {}): FakeDaemon {
  const d: FakeDaemon = {
    torrents: opts.torrents ?? defaultTorrents(),
    session: { ...defaultSession(), ...opts.session },
    calls: [],
    of: m => d.calls.filter(c => c.method === m).map(c => c.args),
    portOpen: true,
    restore: () => { fetchMock.mockRestore() },
  }
  let handshake = false
  const pick = (t: TorrentDetail, fields: string[]) => Object.fromEntries(fields.filter(f => f in t).map(f => [f, (t as unknown as Record<string, unknown>)[f]]))
  const handle = (method: string, a: Record<string, unknown>): unknown => {
    const ids = (a.ids as number[] | 'recently-active' | undefined)
    const sel = () => Array.isArray(ids) ? d.torrents.filter(t => ids.includes(t.id)) : d.torrents
    switch (method) {
      case 'session-get': return d.session
      case 'session-set': Object.assign(d.session, a); return {}
      case 'session-stats': return {
        activeTorrentCount: 3, pausedTorrentCount: 2, torrentCount: d.torrents.length,
        downloadSpeed: d.torrents.reduce((x, t) => x + t.rateDownload, 0), uploadSpeed: d.torrents.reduce((x, t) => x + t.rateUpload, 0),
        'current-stats': { uploadedBytes: 1.31e9, downloadedBytes: 5.14e9, filesAdded: 3, sessionCount: 1, secondsActive: 570_000 },
        'cumulative-stats': { uploadedBytes: 391e9, downloadedBytes: 218e9, filesAdded: 412, sessionCount: 37, secondsActive: 12_300_000 },
      }
      case 'torrent-get': return { torrents: sel().map(t => pick(t, a.fields as string[])), ...(ids === 'recently-active' ? { removed: [] } : {}) }
      case 'torrent-start': case 'torrent-start-now': sel().forEach(t => { t.status = t.percentDone >= 1 ? Status.Seed : Status.Download; t.error = 0 }); return {}
      case 'torrent-stop': sel().forEach(t => { t.status = Status.Stopped }); return {}
      case 'torrent-verify': sel().forEach(t => { t.status = Status.Check }); return {}
      case 'torrent-reannounce': return {}
      case 'torrent-remove': d.torrents = d.torrents.filter(t => !(ids as number[]).includes(t.id)); return {}
      case 'torrent-set': sel().forEach(t => {
        const { ids: _i, ...rest } = a
        const idx = (k: string) => (rest[k] as number[] | undefined) ?? []
        idx('files-wanted').forEach(i => { t.fileStats[i].wanted = true }); idx('files-unwanted').forEach(i => { t.fileStats[i].wanted = false })
        idx('priority-high').forEach(i => { t.fileStats[i].priority = 1 }); idx('priority-normal').forEach(i => { t.fileStats[i].priority = 0 }); idx('priority-low').forEach(i => { t.fileStats[i].priority = -1 })
        for (const k of ['files-wanted', 'files-unwanted', 'priority-high', 'priority-normal', 'priority-low']) delete rest[k]
        Object.assign(t, rest)
      }); return {}
      case 'torrent-set-location': sel().forEach(t => { t.downloadDir = a.location as string }); return {}
      case 'torrent-rename-path': sel().forEach(t => { t.name = a.name as string }); return {}
      case 'torrent-add': { const id = Math.max(0, ...d.torrents.map(t => t.id)) + 1; const name = String(a.filename ?? 'added.torrent').replace(/^.*dn=([^&]+).*$/, '$1'); d.torrents.push(torrent({ id, name, status: a.paused ? Status.Stopped : Status.Download, percentDone: 0, labels: (a.labels as string[]) ?? [], downloadDir: (a['download-dir'] as string) ?? BASE })); return { 'torrent-added': { id, name, hashString: 'x' } } }
      case 'free-space': return { path: a.path, 'size-bytes': 412e9, total_size: 1.8e12 }
      case 'port-test': return { 'port-is-open': d.portOpen }
      case 'blocklist-update': d.session['blocklist-size'] = 400_000; return { 'blocklist-size': 400_000 }
      default: if (method.startsWith('queue-move-')) return {}; throw new Error('unhandled ' + method)
    }
  }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (opts.unauthorized) return new Response('', { status: 401 })
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (!handshake && !headers['X-Transmission-Session-Id']) { handshake = true; return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': 'fake' } }) }
    const body = JSON.parse(String(init?.body)) as { method: string; arguments: Record<string, unknown> }
    d.calls.push({ method: body.method, args: body.arguments })
    try { return Response.json({ result: 'success', arguments: handle(body.method, body.arguments) }) }
    catch (e) { return Response.json({ result: (e as Error).message, arguments: {} }) }
  })
  return d
}
