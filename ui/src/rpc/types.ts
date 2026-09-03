// Shapes as returned by transmission-daemon 4.0.x (rpc-version 17). Field names are the daemon's.

export const enum Status {
  Stopped = 0,
  CheckWait = 1,
  Check = 2,
  DownloadWait = 3,
  Download = 4,
  SeedWait = 5,
  Seed = 6,
}

export interface TrackerStat {
  id: number
  announce: string
  host: string
  tier: number
  announceState: number
  hasAnnounced: boolean
  lastAnnounceSucceeded: boolean
  lastAnnounceResult: string
  lastAnnounceTime: number
  lastAnnouncePeerCount: number
  nextAnnounceTime: number
  hasScraped: boolean
  lastScrapeSucceeded: boolean
  lastScrapeTime: number
  seederCount: number
  leecherCount: number
  downloadCount: number
  isBackup: boolean
}

export interface TorrentFile { name: string; length: number; bytesCompleted: number }
export interface FileStat { wanted: boolean; priority: -1 | 0 | 1; bytesCompleted: number }

export interface Peer {
  address: string
  clientName: string
  progress: number
  rateToClient: number
  rateToPeer: number
  flagStr: string
  isEncrypted: boolean
  isIncoming: boolean
  isDownloadingFrom: boolean
  isUploadingTo: boolean
  isUTP: boolean
  port: number
}

export interface PeersFrom {
  fromCache: number
  fromDht: number
  fromIncoming: number
  fromLpd: number
  fromLtep: number
  fromPex: number
  fromTracker: number
}

/** Fields fetched for every row on every poll. */
export interface TorrentSummary {
  id: number
  name: string
  status: Status
  error: number
  errorString: string
  percentDone: number
  sizeWhenDone: number
  totalSize: number
  leftUntilDone: number
  rateDownload: number
  rateUpload: number
  uploadRatio: number
  eta: number
  peersConnected: number
  peersSendingToUs: number
  peersGettingFromUs: number
  labels: string[]
  downloadDir: string
  isFinished: boolean
  queuePosition: number
  addedDate: number
  activityDate: number
  doneDate: number
  recheckProgress: number
  metadataPercentComplete: number
  trackerStats: TrackerStat[]
  bandwidthPriority: -1 | 0 | 1
}

/** Extra fields fetched for the selected torrent only. */
export interface TorrentDetail extends TorrentSummary {
  hashString: string
  magnetLink: string
  torrentFile: string
  comment: string
  creator: string
  dateCreated: number
  isPrivate: boolean
  pieceCount: number
  pieceSize: number
  pieces: string
  availability: number[]
  haveValid: number
  haveUnchecked: number
  corruptEver: number
  downloadedEver: number
  uploadedEver: number
  secondsDownloading: number
  secondsSeeding: number
  peersFrom: PeersFrom
  seedRatioLimit: number
  seedRatioMode: 0 | 1 | 2
  seedIdleLimit: number
  seedIdleMode: 0 | 1 | 2
  honorsSessionLimits: boolean
  downloadLimit: number
  downloadLimited: boolean
  uploadLimit: number
  uploadLimited: boolean
  'peer-limit': number
  files: TorrentFile[]
  fileStats: FileStat[]
  peers: Peer[]
  trackerList: string
  webseedsSendingToUs: number
}

export const SUMMARY_FIELDS: (keyof TorrentSummary)[] = [
  'id', 'name', 'status', 'error', 'errorString', 'percentDone', 'sizeWhenDone', 'totalSize', 'leftUntilDone',
  'rateDownload', 'rateUpload', 'uploadRatio', 'eta', 'peersConnected', 'peersSendingToUs', 'peersGettingFromUs',
  'labels', 'downloadDir', 'isFinished', 'queuePosition', 'addedDate', 'activityDate', 'doneDate',
  'recheckProgress', 'metadataPercentComplete', 'trackerStats', 'bandwidthPriority',
]

export const DETAIL_FIELDS: (keyof TorrentDetail)[] = [
  ...SUMMARY_FIELDS,
  'hashString', 'magnetLink', 'torrentFile', 'comment', 'creator', 'dateCreated', 'isPrivate', 'pieceCount', 'pieceSize',
  'pieces', 'availability', 'haveValid', 'haveUnchecked', 'corruptEver', 'downloadedEver', 'uploadedEver',
  'secondsDownloading', 'secondsSeeding', 'peersFrom', 'seedRatioLimit', 'seedRatioMode', 'seedIdleLimit', 'seedIdleMode',
  'honorsSessionLimits', 'downloadLimit', 'downloadLimited', 'uploadLimit', 'uploadLimited', 'peer-limit',
  'files', 'fileStats', 'peers', 'trackerList', 'webseedsSendingToUs',
]

export interface StatsBlock {
  uploadedBytes: number
  downloadedBytes: number
  filesAdded: number
  sessionCount: number
  secondsActive: number
}

export interface SessionStats {
  activeTorrentCount: number
  pausedTorrentCount: number
  torrentCount: number
  downloadSpeed: number
  uploadSpeed: number
  'cumulative-stats': StatsBlock
  'current-stats': StatsBlock
}

/** session-get keys the UI reads or writes. */
export interface Session {
  version: string
  'rpc-version': number
  'download-dir': string
  'alt-speed-enabled': boolean
  'alt-speed-down': number
  'alt-speed-up': number
  'alt-speed-time-enabled': boolean
  'alt-speed-time-begin': number
  'alt-speed-time-end': number
  'alt-speed-time-day': number
  'speed-limit-down': number
  'speed-limit-down-enabled': boolean
  'speed-limit-up': number
  'speed-limit-up-enabled': boolean
  'incomplete-dir': string
  'incomplete-dir-enabled': boolean
  'rename-partial-files': boolean
  'start-added-torrents': boolean
  'trash-original-torrent-files': boolean
  'script-torrent-done-enabled': boolean
  'script-torrent-done-filename': string
  'script-torrent-done-seeding-enabled': boolean
  'script-torrent-done-seeding-filename': string
  'cache-size-mb': number
  seedRatioLimit: number
  seedRatioLimited: boolean
  'idle-seeding-limit': number
  'idle-seeding-limit-enabled': boolean
  'download-queue-size': number
  'download-queue-enabled': boolean
  'seed-queue-size': number
  'seed-queue-enabled': boolean
  'queue-stalled-minutes': number
  'queue-stalled-enabled': boolean
  'peer-port': number
  'peer-port-random-on-start': boolean
  'port-forwarding-enabled': boolean
  'dht-enabled': boolean
  'pex-enabled': boolean
  'lpd-enabled': boolean
  'utp-enabled': boolean
  'peer-limit-per-torrent': number
  'peer-limit-global': number
  encryption: 'required' | 'preferred' | 'tolerated'
  'blocklist-enabled': boolean
  'blocklist-url': string
  'blocklist-size': number
}

export interface FreeSpace { path: string; 'size-bytes': number; total_size?: number }
