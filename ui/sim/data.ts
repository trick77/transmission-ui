// The simulated world.
//
// Naming rule for this file: nothing in here may look like a copy of an in-copyright work. Every
// entry is a Linux distribution, a Blender Foundation open movie, a documented public-domain or CC0
// release, a US government work (uncopyrightable under 17 USC 105), or an openly published data
// dump. Two entries are US-public-domain only and marked as such below.

import type { FileStat, Peer, Session, TorrentDetail, TorrentFile, TrackerStat } from '../src/rpc/types.ts'
import { makeRand, hashOf, seedOf, type Rand } from './rand.ts'
import { ST, distributeBytes, magnetOf, reconcile, refreshPieceMap, renumberQueue, wantedSize } from './derive.ts'

export const BASE = '/data/torrents'
const D = {
  iso: `${BASE}/iso`,
  movies: `${BASE}/movies`,
  pd: `${BASE}/movies/public-domain`,
  archive: `${BASE}/archive`,
  wl: `${BASE}/archive/wikileaks`,
  books: `${BASE}/books`,
  buffer: `${BASE}/buffer`,
  radarr: `${BASE}/radarr`,
  sonarr: `${BASE}/sonarr/docs`,
}

const GB = 1e9, MB = 1e6, KB = 1e3
const DAY = 86400

// ─── trackers ───────────────────────────────────────────────────────────────
// `flap` is the host the tick takes down and brings back, so the sidebar's "tracker down" notice
// (which needs a failure older than 10 minutes) is reachable in a browser session.

type TrackerMood = 'ok' | 'timeout' | 'gone' | 'rejected' | 'flap'

interface TrackerDef { announce: string; mood: TrackerMood }

const TRACKERS: Record<string, TrackerDef> = {
  debian: { announce: 'http://bttracker.debian.org:6969/announce', mood: 'ok' },
  opentrackr: { announce: 'udp://tracker.opentrackr.org:1337/announce', mood: 'ok' },
  openbt: { announce: 'udp://tracker.openbittorrent.com:6969/announce', mood: 'ok' },
  eu: { announce: 'udp://tracker.torrent.eu.org:451/announce', mood: 'ok' },
  blender: { announce: 'http://tracker.blender.org:6969/announce', mood: 'ok' },
  archiveorg: { announce: 'http://bt1.archive.org:6969/announce', mood: 'gone' },
  moody: { announce: 'udp://tracker.moody-uplink.invalid:6969/announce', mood: 'flap' },
  gatekeeper: { announce: 'http://gatekeeper.private.invalid:2710/announce', mood: 'rejected' },
  // Healthy on purpose: with moody flapping and gatekeeper rejecting, a third failing host would
  // stack three notices on top of the list at once.
  attic: { announce: 'http://tracker.dusty-attic.invalid:6969/announce', mood: 'ok' },
}

const MOOD_RESULT: Record<TrackerMood, string> = {
  ok: 'Success',
  timeout: 'Connection timed out',
  gone: 'Tracker gave HTTP response code 404 (Not Found)',
  rejected: 'Client is not whitelisted',
  flap: 'Connection timed out',
}

function trackerStat(key: string, tier: number, id: number, now: number, r: Rand, announced: boolean): TrackerStat {
  const def = TRACKERS[key]
  const ok = def.mood === 'ok'
  const seeders = r.int(40, 4200)
  return {
    id,
    announce: def.announce,
    host: new URL(def.announce).hostname,
    tier,
    announceState: announced ? 1 : 0,
    hasAnnounced: announced,
    lastAnnounceSucceeded: announced && ok,
    lastAnnounceResult: announced ? MOOD_RESULT[def.mood] : '',
    // A failing host needs a failure older than DOWN_AFTER_S (10 min) before model.ts calls it down.
    lastAnnounceTime: announced ? now - (ok ? r.int(20, 280) : r.int(700, 2400)) : 0,
    lastAnnouncePeerCount: announced && ok ? r.int(20, 60) : 0,
    nextAnnounceTime: announced ? now + r.int(30, 300) : 0,
    hasScraped: announced,
    lastScrapeSucceeded: announced && ok,
    lastScrapeTime: announced ? now - r.int(60, 900) : 0,
    seederCount: ok ? seeders : 0,
    leecherCount: ok ? Math.round(seeders * r.range(0.05, 0.6)) : 0,
    downloadCount: ok ? seeders * r.int(3, 40) : 0,
    isBackup: false,
  }
}

// ─── peers ──────────────────────────────────────────────────────────────────

const CLIENTS = [
  'Transmission 4.0.5', 'Transmission 3.00', 'qBittorrent 5.0.4', 'qBittorrent 4.6.7',
  'Deluge 2.1.1', 'libtorrent (Rakshasa) 0.13.8', 'Tixati 3.29', 'BiglyBT 3.5.0.0',
  'Vuze 5.7.7.0', 'WebTorrent 2.5.1', 'µTorrent 3.5.5', 'Free Download Manager 6.2',
  'Transmission 2.94', 'aria2 1.37.0', 'PicoTorrent 0.25',
]

/** Documentation-only address ranges (RFC 5737, RFC 3849): nothing here can be a real host. */
export function peerAddress(r: Rand): string {
  const n = r.int(0, 9)
  if (n === 0) return `2001:db8:${r.int(0, 0xffff).toString(16)}::${r.int(1, 0xffff).toString(16)}`
  if (n < 5) return `203.0.113.${r.int(1, 254)}`
  return `198.51.100.${r.int(1, 254)}`
}

/** Transmission's peer flag letters, composed from what the peer is actually doing. */
export function flagsOf(p: Peer): string {
  let s = ''
  if (p.isDownloadingFrom) s += 'D'
  else if (p.rateToClient > 0) s += 'd'
  if (p.isUploadingTo) s += 'U'
  else if (p.rateToPeer > 0) s += 'u'
  if (p.isEncrypted) s += 'E'
  if (p.isUTP) s += 'T'
  if (p.isIncoming) s += 'I'
  else s += 'H'
  return s || 'K'
}

export function makePeer(r: Rand, downloading: boolean): Peer {
  const progress = downloading ? r.range(0.15, 1) : r.range(0.02, 0.98)
  const p: Peer = {
    address: peerAddress(r),
    clientName: r.pick(CLIENTS),
    progress,
    rateToClient: downloading && r.chance(0.55) ? r.int(40, 3400) * KB : 0,
    rateToPeer: !downloading && r.chance(0.5) ? r.int(10, 900) * KB : 0,
    flagStr: '',
    isEncrypted: r.chance(0.8),
    isIncoming: r.chance(0.35),
    isDownloadingFrom: false,
    isUploadingTo: false,
    isUTP: r.chance(0.45),
    port: r.int(1024, 65535),
  }
  p.isDownloadingFrom = p.rateToClient > 0
  p.isUploadingTo = p.rateToPeer > 0
  p.flagStr = flagsOf(p)
  return p
}

// ─── the dataset ────────────────────────────────────────────────────────────

interface Spec {
  name: string
  dir: string
  labels: string[]
  status: number
  size: number
  /** Fraction complete; defaults to 1. */
  pct?: number
  /** Target upload ratio; -1 means nothing has moved yet. */
  ratio?: number
  /** Base download / upload rate in bytes per second, before jitter and limits. */
  down?: number
  up?: number
  /** Days ago. */
  added: number
  idle?: number
  trackers?: string[]
  files?: number
  comment?: string
  creator?: string
  isPrivate?: boolean
  error?: number
  errorString?: string
  meta?: number
  recheck?: number
  /** Average swarm copies per piece, for the availability bar. 0 = nobody has the rest. */
  swarm?: number
}

const SPECS: Spec[] = [
  // ── Linux distributions ───────────────────────────────────────────────────
  {
    name: 'debian-13.1.0-amd64-DVD-1.iso', dir: D.iso, labels: ['linux'], status: ST.Download,
    size: 4.71 * GB, pct: 0.632, ratio: 0.18, down: 12.4 * MB, up: 1.2 * MB, added: 0.04,
    trackers: ['debian', 'opentrackr'], creator: 'mktorrent 1.1', comment: 'Debian CD image',
    swarm: 6,
  },
  {
    name: 'archlinux-2026.09.01-x86_64.iso', dir: D.iso, labels: ['linux'], status: ST.DownloadWait,
    size: 1.23 * GB, pct: 0, ratio: -1, added: 0.01, trackers: ['opentrackr', 'eu'],
    comment: 'Waiting its turn. Patiently. Like an Arch user explaining systemd.', swarm: 5,
  },
  {
    name: 'ubuntu-26.04.1-desktop-amd64.iso', dir: D.iso, labels: ['linux'], status: ST.Check,
    size: 6.02 * GB, pct: 0.41, recheck: 0.41, ratio: 0.04, added: 2, trackers: ['opentrackr'],
    swarm: 7,
  },
  {
    name: 'nixos-25.11-minimal-x86_64-linux.iso', dir: D.iso, labels: ['linux'], status: ST.Seed,
    size: 1.04 * GB, ratio: 1.42, up: 310 * KB, added: 18, trackers: ['opentrackr', 'eu'],
    comment: 'Reproducible, unlike my sleep schedule.', swarm: 4,
  },
  {
    name: 'tails-6.22-amd64.img', dir: D.iso, labels: ['linux'], status: ST.Seed,
    size: 1.5 * GB, ratio: 3.08, up: 520 * KB, added: 64, trackers: ['gatekeeper'], isPrivate: true,
    comment: 'Private tracker. Mind the ratio.', swarm: 3,
  },
  {
    name: 'fedora-Workstation-Live-x86_64-43.iso', dir: D.iso, labels: ['linux'], status: ST.Stopped,
    size: 2.31 * GB, ratio: 0.62, added: 210, idle: 44, trackers: ['opentrackr'], swarm: 3,
  },

  // ── Blender Foundation open movies (CC BY) ────────────────────────────────
  {
    name: 'Big Buck Bunny (2008) 4K 60fps', dir: D.movies, labels: ['blender'], status: ST.Seed,
    size: 7.28 * GB, ratio: 3.42, up: 840 * KB, added: 96, trackers: ['blender', 'openbt'],
    comment: 'CC BY, Blender Foundation. The rabbit has no notes.', files: 3, swarm: 5,
  },
  {
    name: 'Sintel (2010) 4K remaster', dir: D.movies, labels: ['blender'], status: ST.Seed,
    size: 5.9 * GB, ratio: 1.86, up: 410 * KB, added: 88, trackers: ['blender', 'opentrackr'],
    comment: 'CC BY, Blender Foundation.', files: 2, swarm: 4,
  },
  {
    name: 'Elephants Dream (2006) 1080p', dir: D.movies, labels: ['blender'], status: ST.Stopped,
    size: 1.12 * GB, ratio: 0.74, added: 430, idle: 96, trackers: ['blender'],
    comment: 'CC BY. The first one. Still the strangest one.', swarm: 2,
  },
  {
    name: 'Tears of Steel (2012) 4K', dir: D.movies, labels: ['blender'], status: ST.SeedWait,
    size: 4.4 * GB, ratio: 0.98, added: 25, trackers: ['blender', 'attic'], files: 2, swarm: 3,
  },
  {
    name: 'Cosmos Laundromat (2015) 2K', dir: D.buffer, labels: ['blender'], status: ST.Seed,
    size: 3.02 * GB, ratio: 0.44, up: 190 * KB, added: 12, trackers: ['blender', 'attic'],
    comment: 'CC BY. Ask the sheep.', swarm: 3,
  },
  {
    name: 'Spring (2019) 2K', dir: D.movies, labels: ['blender'], status: ST.Download,
    size: 2.6 * GB, pct: 0.09, ratio: 0.01, down: 260 * KB, up: 40 * KB, added: 1,
    trackers: ['blender', 'moody'], comment: 'CC BY. Slow, but so is spring.', swarm: 2,
  },

  // ── Public domain film ────────────────────────────────────────────────────
  {
    name: 'Nosferatu (1922) restored 2K', dir: D.pd, labels: ['pd-film'], status: ST.Seed,
    size: 8.6 * GB, ratio: 2.31, up: 620 * KB, added: 140, trackers: ['archiveorg', 'openbt'],
    comment: 'Public domain: Murnau d. 1931, Galeen d. 1949, Erdmann d. 1942.', files: 2, swarm: 4,
  },
  {
    name: 'Night of the Living Dead (1968) 4K restoration', dir: D.pd, labels: ['pd-film'], status: ST.Seed,
    size: 12.4 * GB, ratio: 5.17, up: 1.1 * MB, added: 51, trackers: ['archiveorg', 'opentrackr'],
    comment: 'US public domain: the retitled prints shipped without a copyright notice.', files: 4, swarm: 6,
  },
  {
    name: 'Sherlock Jr. (1924) 1080p', dir: D.pd, labels: ['pd-film'], status: ST.Stopped,
    size: 3.9 * GB, ratio: 1.04, added: 320, idle: 61, trackers: ['archiveorg'],
    comment: 'US public domain: 1924, the 95-year term expired in 2020.', swarm: 2,
  },
  {
    name: 'Sita Sings the Blues (2008) CC0 1080p', dir: D.pd, labels: ['pd-film'], status: ST.Seed,
    size: 4.02 * GB, ratio: 2.68, up: 380 * KB, added: 72, trackers: ['archiveorg', 'openbt'],
    comment: 'Nina Paley released this under CC0 in 2013.', files: 2, swarm: 3,
  },

  // ── NASA (17 USC 105: not copyrightable) ──────────────────────────────────
  {
    name: 'apollo-11-16mm-onboard-film-4k', dir: D.sonarr, labels: ['space', 'archive'], status: ST.Stopped,
    size: 9.12 * GB, pct: 0.57, ratio: 0.3, added: 34, idle: 9, error: 3,
    errorString: 'No data found! Ensure your drives are connected or use "Set Location". To re-download, remove the torrent and re-add it.',
    trackers: ['archiveorg'], files: 6, swarm: 1,
  },
  {
    name: 'voyager-golden-record-24bit-flac', dir: D.archive, labels: ['space'], status: ST.Seed,
    size: 6.4 * GB, ratio: 12.41, up: 1.4 * MB, added: 388, trackers: ['archiveorg', 'opentrackr'],
    comment: 'Greetings in 55 languages, and whale song. Seeded since forever.', files: 31, swarm: 5,
  },
  {
    name: 'mars-perseverance-raw-images-sol-0001-1200.tar', dir: D.archive, labels: ['space'], status: ST.Download,
    size: 41.7 * GB, pct: 0.223, ratio: 0.06, down: 3.1 * MB, up: 180 * KB, added: 5,
    trackers: ['archiveorg', 'moody'], swarm: 3,
  },

  // ── Books and spoken word ─────────────────────────────────────────────────
  {
    name: 'Pride and Prejudice — LibriVox — 128kbps MP3', dir: D.books, labels: ['books'], status: ST.Stopped,
    size: 318 * MB, ratio: 2.05, added: 156, idle: 38, trackers: ['archiveorg'], files: 61,
    comment: 'Public domain recording of a public domain book. Two for two.',
  },
  {
    name: 'Die Verwandlung — Franz Kafka — LibriVox — Hörbuch', dir: D.books, labels: ['books', 'german'], status: ST.Seed,
    size: 96 * MB, ratio: 1.19, up: 44 * KB, added: 41, trackers: ['archiveorg'], files: 4,
    comment: 'Kafka gest. 1924. Gemeinfrei, und immer noch beunruhigend.',
  },
  {
    name: 'Project Gutenberg — complete DVD image (2010)', dir: D.books, labels: ['books', 'archive'], status: ST.Seed,
    size: 8.9 * GB, ratio: 2.44, up: 260 * KB, added: 520, trackers: ['archiveorg', 'openbt'], files: 42,
    comment: 'Every book anyone ever finished. And a few nobody started.', swarm: 2,
  },

  // ── Open data dumps ───────────────────────────────────────────────────────
  {
    name: 'planet-latest.osm.pbf', dir: D.archive, labels: ['archive'], status: ST.Download,
    size: 85.3 * GB, pct: 0.071, ratio: 0.01, down: 74 * KB, up: 12 * KB, added: 3,
    trackers: ['eu', 'attic'], comment: 'OpenStreetMap, ODbL. The whole planet, one packet at a time.',
    swarm: 2,
  },
  {
    name: 'wikipedia_en_all_maxi_2026-08.zim', dir: D.archive, labels: ['archive'], status: ST.Download,
    size: 112.6 * GB, pct: 0.999, ratio: 0.42, down: 0, up: 0, added: 29, idle: 11,
    trackers: ['attic', 'moody'], comment: 'Kiwix ZIM. 99.9 %. It has been 99.9 % for eleven days.',
    swarm: 0,
  },
  {
    name: 'enwiki-20260801-pages-articles.xml.bz2', dir: D.archive, labels: ['archive'], status: ST.Seed,
    size: 22.4 * GB, ratio: 1.61, up: 730 * KB, added: 33, trackers: ['eu', 'openbt'], swarm: 3,
  },

  // ── WikiLeaks insurance files ─────────────────────────────────────────────
  {
    name: 'insurance.aes256', dir: D.wl, labels: ['insurance', 'archive'], status: ST.Seed,
    size: 1.4 * GB, ratio: 8.72, up: 940 * KB, added: 720, trackers: ['openbt', 'opentrackr'],
    comment: 'The 2010 one. Nobody has the key. Everybody has the file.', swarm: 8,
  },
  {
    name: 'wlinsurance-20130815-C.aes256', dir: D.wl, labels: ['insurance', 'archive'], status: ST.Download,
    size: 325.4 * GB, pct: 0.184, ratio: 0.09, down: 210 * KB, up: 90 * KB, added: 61,
    trackers: ['openbt', 'moody'], comment: '325 GB of nothing anyone can read. ETA measured in weeks.',
    swarm: 4,
  },
  {
    name: '2016-12-09_WL-Insurance.aes256', dir: D.wl, labels: ['insurance'], status: ST.Stopped,
    size: 90.1 * GB, pct: 0.34, ratio: 0.02, added: 118, idle: 74, trackers: ['openbt'], swarm: 2,
  },

  // ── A bare magnet, metadata still coming in ───────────────────────────────
  {
    name: '', dir: D.radarr, labels: [], status: ST.Download, size: 0, pct: 0, ratio: -1,
    added: 0.002, meta: 0.34, trackers: ['opentrackr', 'eu'],
  },
]

// ─── building torrents ──────────────────────────────────────────────────────

function fileList(name: string, size: number, count: number, r: Rand): { files: TorrentFile[]; stats: FileStat[] } {
  const files: TorrentFile[] = []
  if (count <= 1) {
    files.push({ name, length: size, bytesCompleted: 0 })
  } else {
    // A handful of small companions plus the payload split evenly, so the Files tab has both.
    const extras = [
      { n: 'README.txt', len: 2_100 },
      { n: 'SHA256SUMS', len: 1_400 },
      { n: 'LICENSE.txt', len: 18_000 },
    ].slice(0, Math.min(3, count - 1))
    const bulk = count - extras.length
    const each = Math.floor((size - extras.reduce((a, e) => a + e.len, 0)) / bulk)
    for (let i = 0; i < bulk; i++) {
      const sub = bulk > 20 ? `part-${String(Math.floor(i / 10) + 1).padStart(2, '0')}/` : ''
      files.push({ name: `${name}/${sub}${String(i + 1).padStart(3, '0')}.bin`, length: each, bytesCompleted: 0 })
    }
    for (const e of extras) files.push({ name: `${name}/${e.n}`, length: e.len, bytesCompleted: 0 })
  }
  const stats: FileStat[] = files.map(() => ({ wanted: true, priority: 0, bytesCompleted: 0 }))
  if (files.length > 6 && r.chance(0.5)) { stats[files.length - 1].wanted = false; stats[0].priority = 1 }
  return { files, stats }
}

function buildOne(spec: Spec, id: number, now: number, seed: number): TorrentDetail {
  const isMagnet = spec.meta != null && spec.meta < 1
  const hashSeed = seed
  const hash = hashOf(spec.name || `magnet-${id}`, hashSeed)
  const name = spec.name || hash
  const r = makeRand(seedOf(hash))

  const pct = isMagnet ? 0 : (spec.pct ?? 1)
  const size = isMagnet ? 0 : spec.size
  const haveValid = Math.round(size * pct)
  const downloadedEver = Math.round(haveValid * r.range(1.0, 1.02))
  const ratio = spec.ratio ?? 0
  const uploadedEver = ratio < 0 ? 0 : Math.round(downloadedEver * ratio)

  const trackerKeys = spec.trackers ?? ['opentrackr']
  const announced = spec.status !== ST.Stopped
  const trackerStats = trackerKeys.map((k, i) => trackerStat(k, i, i, now, r, announced))

  const pieceSize = size > 40 * GB ? 16 * 1024 * 1024 : size > 4 * GB ? 4 * 1024 * 1024 : 2 * 1024 * 1024
  const pieceCount = isMagnet ? 0 : Math.max(1, Math.ceil(size / pieceSize))

  const { files, stats } = fileList(name, size, spec.files ?? 1, r)
  distributeBytes(files, stats, haveValid)

  const downloading = spec.status === ST.Download && !isMagnet
  const peerCount = spec.status === ST.Stopped ? 0 : r.int(downloading ? 8 : 2, downloading ? 46 : 22)
  const peers: Peer[] = []
  for (let i = 0; i < Math.min(peerCount, 24); i++) peers.push(makePeer(r, downloading))

  const activity = spec.idle != null ? now - Math.round(spec.idle * DAY)
    : spec.status === ST.Stopped ? now - r.int(3600, 6 * DAY)
      : now - r.int(0, 90)

  const t: TorrentDetail = {
    id,
    name,
    status: spec.status as TorrentDetail['status'],
    error: spec.error ?? 0,
    errorString: spec.errorString ?? '',
    percentDone: pct,
    sizeWhenDone: size,
    totalSize: size,
    leftUntilDone: size - haveValid,
    // Seed the rates from the spec: state.ts reads these back as each torrent's base rate, and the
    // very first render already shows a moving list.
    rateDownload: spec.status === ST.Download ? Math.round(spec.down ?? 0) : 0,
    rateUpload: spec.status === ST.Download || spec.status === ST.Seed ? Math.round(spec.up ?? 0) : 0,
    uploadRatio: ratio < 0 ? -1 : ratio,
    eta: -1,
    peersConnected: peerCount,
    peersSendingToUs: downloading ? Math.round(peerCount * r.range(0.3, 0.55)) : 0,
    peersGettingFromUs: spec.status === ST.Seed ? Math.round(peerCount * r.range(0.4, 0.8)) : Math.round(peerCount * r.range(0, 0.2)),
    labels: spec.labels,
    downloadDir: spec.dir,
    isFinished: false,
    queuePosition: id,
    addedDate: now - Math.round(spec.added * DAY),
    activityDate: activity,
    doneDate: pct >= 1 ? now - Math.round((spec.added * DAY) / 2) : 0,
    recheckProgress: spec.recheck ?? 0,
    metadataPercentComplete: spec.meta ?? 1,
    trackerStats,
    bandwidthPriority: 0,
    hashString: hash,
    magnetLink: magnetOf(hash, name, trackerStats),

    torrentFile: `/config/torrents/${hash}.torrent`,
    comment: spec.comment ?? '',
    creator: spec.creator ?? 'mktorrent 1.1',
    dateCreated: now - Math.round((spec.added + r.int(1, 40)) * DAY),
    isPrivate: spec.isPrivate ?? false,
    pieceCount,
    pieceSize,
    pieces: '',
    availability: [],
    haveValid,
    haveUnchecked: 0,
    corruptEver: r.chance(0.3) ? r.int(1, 40) * MB : 0,
    downloadedEver,
    uploadedEver,
    secondsDownloading: Math.round(spec.added * DAY * r.range(0.02, 0.3)),
    secondsSeeding: pct >= 1 ? Math.round(spec.added * DAY * r.range(0.4, 0.95)) : 0,
    peersFrom: { fromCache: 0, fromDht: 0, fromIncoming: 0, fromLpd: 0, fromLtep: 0, fromPex: 0, fromTracker: 0 },
    // Anything already past the session ratio goal must be marked unlimited, or the seed-goal rule
    // in the tick stops it on the very first request.
    seedRatioLimit: 2,
    seedRatioMode: ratio >= 2 ? 2 : 0,
    seedIdleLimit: 30,
    seedIdleMode: 0,
    honorsSessionLimits: true,
    downloadLimit: 5000,
    downloadLimited: false,
    uploadLimit: 500,
    uploadLimited: false,
    'peer-limit': 50,
    files,
    fileStats: stats,
    peers,
    trackerList: trackerStats.map(ts => ts.announce).join('\n'),
    webseedsSendingToUs: 0,
  }
  countPeersFrom(t)
  // fileList may mark a file unwanted, and splitting a size across files loses a few bytes to
  // rounding. Take the totals from the file table so the boot state already agrees with the Files
  // tab, instead of shifting the moment the first torrent-set arrives.
  if (!isMagnet) {
    t.sizeWhenDone = wantedSize(t)
    t.haveValid = Math.min(t.haveValid, t.sizeWhenDone)
    distributeBytes(t.files, t.fileStats, t.haveValid)
    reconcile(t)
  }
  refreshPieceMap(t, spec.swarm ?? 3)
  return t
}

/** peersFrom has to add up to peersConnected or the inspector's swarm breakdown looks broken. */
export function countPeersFrom(t: TorrentDetail): void {
  const r = makeRand(seedOf(t.hashString) ^ 0x2545f491)
  const n = t.peersConnected
  const shares = [0.42, 0.24, 0.14, 0.1, 0.06, 0.04]
  const keys: (keyof TorrentDetail['peersFrom'])[] = ['fromTracker', 'fromDht', 'fromPex', 'fromIncoming', 'fromLtep', 'fromCache']
  let left = n
  const from = { fromCache: 0, fromDht: 0, fromIncoming: 0, fromLpd: 0, fromLtep: 0, fromPex: 0, fromTracker: 0 }
  keys.forEach((k, i) => {
    const take = i === keys.length - 1 ? left : Math.min(left, Math.round(n * shares[i] * r.range(0.7, 1.3)))
    from[k] = Math.max(0, take)
    left -= from[k]
  })
  if (left > 0) from.fromTracker += left
  t.peersFrom = from
}

export interface DatasetOptions { seed?: number; count?: number; now?: number }

export function buildTorrents(opts: DatasetOptions = {}): TorrentDetail[] {
  const seed = opts.seed ?? 1
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const copies = Math.max(1, Math.round(opts.count ?? 1))
  const out: TorrentDetail[] = []
  let id = 1
  for (let c = 0; c < copies; c++) {
    for (const spec of SPECS) {
      const s = c === 0 ? spec : { ...spec, name: spec.name ? `${spec.name} (copy ${c + 1})` : '' }
      out.push(buildOne(s, id, now, seed + c * 7919))
      id++
    }
  }
  renumberQueue(out)
  return out
}

export function buildSession(torrents: TorrentDetail[]): Session {
  // Queue sizes are taken from the dataset rather than guessed, so nothing gets demoted or promoted
  // on the very first tick and the queued rows stay queued.
  const downloading = torrents.filter(t => t.status === ST.Download).length
  const seeding = torrents.filter(t => t.status === ST.Seed).length
  return {
    version: '4.0.5 (a6fe2a64aa)',
    'rpc-version': 17,
    'download-dir': BASE,
    'alt-speed-enabled': false,
    'alt-speed-down': 2000,
    'alt-speed-up': 250,
    'alt-speed-time-enabled': true,
    'alt-speed-time-begin': 480,
    'alt-speed-time-end': 1380,
    'alt-speed-time-day': 62,
    'speed-limit-down': 30000,
    'speed-limit-down-enabled': true,
    'speed-limit-up': 2500,
    'speed-limit-up-enabled': true,
    'incomplete-dir': `${BASE}/.incomplete`,
    'incomplete-dir-enabled': true,
    'rename-partial-files': true,
    'start-added-torrents': true,
    'trash-original-torrent-files': false,
    'script-torrent-done-enabled': false,
    'script-torrent-done-filename': '',
    'script-torrent-done-seeding-enabled': false,
    'script-torrent-done-seeding-filename': '',
    'cache-size-mb': 16,
    seedRatioLimit: 2,
    seedRatioLimited: true,
    'idle-seeding-limit': 30,
    'idle-seeding-limit-enabled': false,
    'download-queue-size': Math.max(1, downloading),
    'download-queue-enabled': true,
    'seed-queue-size': Math.max(1, seeding),
    'seed-queue-enabled': true,
    'queue-stalled-minutes': 30,
    'queue-stalled-enabled': true,
    'peer-port': 51413,
    'peer-port-random-on-start': false,
    'port-forwarding-enabled': true,
    'dht-enabled': true,
    'pex-enabled': true,
    'lpd-enabled': false,
    'utp-enabled': true,
    'peer-limit-per-torrent': 50,
    'peer-limit-global': 240,
    encryption: 'preferred',
    'blocklist-enabled': true,
    'blocklist-url': 'https://example.org/level1.gz',
    'blocklist-size': 312904,
  }
}

/**
 * Scale the seeded rates down to the session limits. The tick does this on every step anyway, but a
 * frozen world (TM_SIM_SPEED=0) or a multiplied dataset would otherwise open above the limit.
 */
export function clampSeededRates(torrents: TorrentDetail[], session: Session): void {
  const caps: [number, 'rateDownload' | 'rateUpload'][] = [
    [session['speed-limit-down-enabled'] ? session['speed-limit-down'] * 1000 : Infinity, 'rateDownload'],
    [session['speed-limit-up-enabled'] ? session['speed-limit-up'] * 1000 : Infinity, 'rateUpload'],
  ]
  for (const [cap, key] of caps) {
    if (!Number.isFinite(cap)) continue
    const sum = torrents.reduce((n, t) => n + t[key], 0)
    if (sum <= cap || sum === 0) continue
    for (const t of torrents) t[key] = Math.round(t[key] * (cap / sum))
  }
}

/** Free space per mount, so the sidebar disk widget has something to show. */
export function buildSpace(): Map<string, { size: number; total: number }> {
  return new Map([[BASE, { size: 412e9, total: 1.8e12 }]])
}

// ─── magnet reveal and freshly added torrents ───────────────────────────────

/** What a bare magnet turns out to be once its metadata finishes downloading. */
export const MAGNET_REVEALS: { name: string; size: number; files: number; comment: string }[] = [
  { name: 'Caminandes — Llamigos (2016) 4K', size: 1.8 * GB, files: 2, comment: 'CC BY, Blender Foundation. The llama is fine.' },
  { name: 'openstreetmap-carto-shapefiles-2026.tar.gz', size: 3.4 * GB, files: 5, comment: 'ODbL.' },
  { name: 'gutenberg-audio-human-read-2025.tar', size: 12.1 * GB, files: 28, comment: 'Public domain readings, read by actual humans.' },
  { name: 'nasa-earthdata-modis-2025-composite.tar', size: 27.6 * GB, files: 12, comment: 'NASA, 17 USC 105.' },
]

/** Fill in everything a torrent only learns once its metadata has arrived. */
export function materializeMetadata(t: TorrentDetail, name: string, size: number, fileCount: number, comment: string, swarm: number): void {
  const r = makeRand(seedOf(t.hashString) ^ 0x9e3779b9)
  t.name = name
  t.comment = comment
  t.sizeWhenDone = size
  t.totalSize = size
  t.pieceSize = size > 40 * GB ? 16 * 1024 * 1024 : size > 4 * GB ? 4 * 1024 * 1024 : 2 * 1024 * 1024
  t.pieceCount = Math.max(1, Math.ceil(size / t.pieceSize))
  const built = fileList(name, size, fileCount, r)
  t.files = built.files
  t.fileStats = built.stats
  t.haveValid = 0
  t.haveUnchecked = 0
  t.leftUntilDone = size
  t.percentDone = 0
  t.metadataPercentComplete = 1
  t.magnetLink = magnetOf(t.hashString, name, t.trackerStats)
  t.trackerList = t.trackerStats.map(ts => ts.announce).join('\n')
  distributeBytes(t.files, t.fileStats, 0)
  refreshPieceMap(t, swarm)
}

export interface NewTorrentOptions {
  labels?: string[]
  size?: number
  fileCount?: number
  trackers?: string[]
  meta?: number
  priority?: -1 | 0 | 1
  paused?: boolean
}

/** Build a torrent from scratch for torrent-add. */
export function newTorrent(id: number, name: string, hash: string, dir: string, now: number, opts: NewTorrentOptions = {}): TorrentDetail {
  const spec: Spec = {
    name,
    dir,
    labels: opts.labels ?? [],
    status: opts.paused ? ST.Stopped : ST.Download,
    size: opts.size ?? 2.4 * GB,
    pct: 0,
    ratio: -1,
    down: 900 * KB,
    up: 0,
    added: 0,
    trackers: opts.trackers ?? ['opentrackr', 'eu'],
    files: opts.fileCount ?? 1,
    meta: opts.meta,
    swarm: 4,
  }
  const t = buildOne(spec, id, now, 1)
  // buildOne derives a hash from the name; an added torrent keeps the hash it arrived with.
  t.hashString = hash
  t.magnetLink = magnetOf(hash, t.name, t.trackerStats)
  t.torrentFile = `/config/torrents/${hash}.torrent`
  t.addedDate = now
  t.activityDate = now
  t.bandwidthPriority = opts.priority ?? 0
  return t
}

export { TRACKERS, MOOD_RESULT, CLIENTS, D as DIRS }
export type { TrackerMood }
