// Shapes as returned by transmission-daemon 4.1.x (rpc_version 19). Field names are the
// daemon's: snake_case throughout, as of rpc_version 18.

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
  announce_state: number
  has_announced: boolean
  last_announce_succeeded: boolean
  last_announce_result: string
  last_announce_time: number
  last_announce_peer_count: number
  next_announce_time: number
  has_scraped: boolean
  last_scrape_succeeded: boolean
  last_scrape_time: number
  seeder_count: number
  leecher_count: number
  download_count: number
  /** Peers the tracker currently sees downloading this torrent. New in rpc 18. */
  downloader_count: number
  is_backup: boolean
}

export interface TorrentFile { name: string; length: number; bytes_completed: number }
export interface FileStat { wanted: boolean; priority: -1 | 0 | 1; bytes_completed: number }

export interface Peer {
  address: string
  client_name: string
  progress: number
  rate_to_client: number
  rate_to_peer: number
  flag_str: string
  is_encrypted: boolean
  is_incoming: boolean
  is_downloading_from: boolean
  is_uploading_to: boolean
  is_utp: boolean
  port: number
}

export interface PeersFrom {
  from_cache: number
  from_dht: number
  from_incoming: number
  from_lpd: number
  from_ltep: number
  from_pex: number
  from_tracker: number
}

/** Fields fetched for every row on every poll. */
export interface TorrentSummary {
  id: number
  name: string
  status: Status
  error: number
  error_string: string
  percent_done: number
  size_when_done: number
  total_size: number
  left_until_done: number
  rate_download: number
  rate_upload: number
  upload_ratio: number
  eta: number
  peers_connected: number
  peers_sending_to_us: number
  peers_getting_from_us: number
  labels: string[]
  download_dir: string
  is_finished: boolean
  queue_position: number
  added_date: number
  activity_date: number
  done_date: number
  recheck_progress: number
  metadata_percent_complete: number
  tracker_stats: TrackerStat[]
  bandwidth_priority: -1 | 0 | 1
  // In the summary so "Copy magnet / hash" can write the clipboard synchronously in the
  // click handler; Safari refuses clipboard writes after an awaited round-trip.
  hash_string: string
  magnet_link: string
}

/** Extra fields fetched for the selected torrent only. */
export interface TorrentDetail extends TorrentSummary {
  torrent_file: string
  comment: string
  creator: string
  date_created: number
  is_private: boolean
  piece_count: number
  piece_size: number
  pieces: string
  availability: number[]
  have_valid: number
  have_unchecked: number
  corrupt_ever: number
  downloaded_ever: number
  uploaded_ever: number
  seconds_downloading: number
  seconds_seeding: number
  peers_from: PeersFrom
  seed_ratio_limit: number
  seed_ratio_mode: 0 | 1 | 2
  seed_idle_limit: number
  seed_idle_mode: 0 | 1 | 2
  honors_session_limits: boolean
  download_limit: number
  download_limited: boolean
  upload_limit: number
  upload_limited: boolean
  peer_limit: number
  sequential_download: boolean
  sequential_download_from_piece: number
  files: TorrentFile[]
  file_stats: FileStat[]
  peers: Peer[]
  tracker_list: string
  webseeds_sending_to_us: number
}

export const SUMMARY_FIELDS: (keyof TorrentSummary)[] = [
  'id', 'name', 'status', 'error', 'error_string', 'percent_done', 'size_when_done', 'total_size', 'left_until_done',
  'rate_download', 'rate_upload', 'upload_ratio', 'eta', 'peers_connected', 'peers_sending_to_us', 'peers_getting_from_us',
  'labels', 'download_dir', 'is_finished', 'queue_position', 'added_date', 'activity_date', 'done_date',
  'recheck_progress', 'metadata_percent_complete', 'tracker_stats', 'bandwidth_priority', 'hash_string', 'magnet_link',
]

export const DETAIL_FIELDS: (keyof TorrentDetail)[] = [
  ...SUMMARY_FIELDS,
  'torrent_file', 'comment', 'creator', 'date_created', 'is_private', 'piece_count', 'piece_size',
  'pieces', 'availability', 'have_valid', 'have_unchecked', 'corrupt_ever', 'downloaded_ever', 'uploaded_ever',
  'seconds_downloading', 'seconds_seeding', 'peers_from', 'seed_ratio_limit', 'seed_ratio_mode', 'seed_idle_limit', 'seed_idle_mode',
  'honors_session_limits', 'download_limit', 'download_limited', 'upload_limit', 'upload_limited', 'peer_limit',
  'sequential_download', 'sequential_download_from_piece',
  'files', 'file_stats', 'peers', 'tracker_list', 'webseeds_sending_to_us',
]

export interface StatsBlock {
  uploaded_bytes: number
  downloaded_bytes: number
  files_added: number
  session_count: number
  seconds_active: number
}

export interface SessionStats {
  active_torrent_count: number
  paused_torrent_count: number
  torrent_count: number
  download_speed: number
  upload_speed: number
  cumulative_stats: StatsBlock
  current_stats: StatsBlock
}

/**
 * Transport protocols in `preferred_transports`, most preferred first. A protocol left out
 * of the list is disabled, which is how the deprecated `tcp_enabled` / `utp_enabled` are
 * expressed from rpc 18 on.
 */
export type Transport = 'tcp' | 'utp'

/** session_get keys the UI reads or writes. */
export interface Session {
  version: string
  rpc_version_semver: string
  download_dir: string
  alt_speed_enabled: boolean
  alt_speed_down: number
  alt_speed_up: number
  alt_speed_time_enabled: boolean
  alt_speed_time_begin: number
  alt_speed_time_end: number
  alt_speed_time_day: number
  speed_limit_down: number
  speed_limit_down_enabled: boolean
  speed_limit_up: number
  speed_limit_up_enabled: boolean
  incomplete_dir: string
  incomplete_dir_enabled: boolean
  rename_partial_files: boolean
  start_added_torrents: boolean
  trash_original_torrent_files: boolean
  script_torrent_done_enabled: boolean
  script_torrent_done_filename: string
  script_torrent_done_seeding_enabled: boolean
  script_torrent_done_seeding_filename: string
  cache_size_mib: number
  seed_ratio_limit: number
  seed_ratio_limited: boolean
  idle_seeding_limit: number
  idle_seeding_limit_enabled: boolean
  sequential_download: boolean
  download_queue_size: number
  download_queue_enabled: boolean
  seed_queue_size: number
  seed_queue_enabled: boolean
  queue_stalled_minutes: number
  queue_stalled_enabled: boolean
  peer_port: number
  peer_port_random_on_start: boolean
  port_forwarding_enabled: boolean
  dht_enabled: boolean
  pex_enabled: boolean
  lpd_enabled: boolean
  preferred_transports: Transport[]
  peer_limit_per_torrent: number
  peer_limit_global: number
  encryption: 'required' | 'preferred' | 'allowed'
  blocklist_enabled: boolean
  blocklist_url: string
  blocklist_size: number
}

export interface FreeSpace { path: string; size_bytes: number; total_size: number }
