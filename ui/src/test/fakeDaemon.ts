// An in-memory transmission-daemon behind global fetch: enough of the RPC surface for component
// tests to render real views and assert real writes, without a container.
import { vi } from 'vitest'
import { Status, type Session, type TorrentDetail, type TrackerStat } from '../rpc/types'

const now = Math.floor(Date.now() / 1000)

export function tracker(o: Partial<TrackerStat> = {}): TrackerStat {
  return {
    id: 0, announce: 'http://bttracker.debian.org:6969/announce', host: 'bttracker.debian.org', tier: 0, announce_state: 1,
    has_announced: true, last_announce_succeeded: true, last_announce_result: 'Success', last_announce_time: now - 38, last_announce_peer_count: 50,
    next_announce_time: now + 262, has_scraped: true, last_scrape_succeeded: true, last_scrape_time: now - 120, seeder_count: 1204, leecher_count: 311, download_count: 8932, downloader_count: 47, is_backup: false, ...o,
  }
}

export const BASE = '/data/torrents'

export function torrent(o: Partial<TorrentDetail> = {}): TorrentDetail {
  const id = o.id ?? 1
  return {
    id, name: `torrent-${id}`, status: Status.Seed, error: 0, error_string: '', percent_done: 1, size_when_done: 4.71e9, total_size: 4.71e9, left_until_done: 0,
    rate_download: 0, rate_upload: 0, upload_ratio: 1.12, eta: -1, peers_connected: 0, peers_sending_to_us: 0, peers_getting_from_us: 0, labels: [],
    download_dir: `${BASE}/iso`, is_finished: false, queue_position: id, added_date: now - 86400 * 3, activity_date: now - 3600, done_date: now - 3000,
    recheck_progress: 0, metadata_percent_complete: 1, tracker_stats: [tracker()], bandwidth_priority: 0,
    sequential_download: false, sequential_download_from_piece: 0,
    hash_string: '6b7a2c1f2e9d8a4b3c0e5f7a1d9c8b2e4f6a0c3d', magnet_link: 'magnet:?xt=urn:btih:6b7a2c1f', torrent_file: '/config/torrents/x.torrent',
    comment: 'fixture', creator: 'mktorrent 1.1', date_created: now - 86400 * 20, is_private: false,
    piece_count: 1920, piece_size: 2_621_440, pieces: btoa(String.fromCharCode(...new Array(240).fill(0xff))), availability: new Array(1920).fill(3),
    have_valid: 4.71e9, have_unchecked: 0, corrupt_ever: 0, downloaded_ever: 4.71e9, uploaded_ever: 5.2e9, seconds_downloading: 900, seconds_seeding: 86400,
    peers_from: { from_cache: 0, from_dht: 12, from_incoming: 4, from_lpd: 0, from_ltep: 0, from_pex: 7, from_tracker: 23 },
    seed_ratio_limit: 2, seed_ratio_mode: 0, seed_idle_limit: 30, seed_idle_mode: 0, honors_session_limits: true,
    download_limit: 5000, download_limited: false, upload_limit: 500, upload_limited: false, 'peer_limit': 50,
    files: [{ name: `torrent-${id}/torrent-${id}.iso`, length: 4.7e9, bytes_completed: 4.7e9 }, { name: `torrent-${id}/SHA512SUMS`, length: 1200, bytes_completed: 1200 }],
    file_stats: [{ wanted: true, priority: 0, bytes_completed: 4.7e9 }, { wanted: true, priority: 0, bytes_completed: 1200 }],
    peers: [{ address: '185.21.100.42', client_name: 'Transmission 4.1.3', progress: 1, rate_to_client: 2_700_000, rate_to_peer: 0, flag_str: 'DE', is_encrypted: true, is_incoming: false, is_downloading_from: true, is_uploading_to: false, is_utp: false, port: 51413 }],
    tracker_list: 'http://bttracker.debian.org:6969/announce',
    webseeds_sending_to_us: 0,
    ...o,
  }
}

export function defaultTorrents(): TorrentDetail[] {
  return [
    torrent({ id: 1, name: 'debian-13.1.0-amd64-DVD-1.iso', status: Status.Download, percent_done: .632, rate_download: 12_400_000, rate_upload: 1_210_000, upload_ratio: .18, eta: 192, peers_connected: 42, peers_sending_to_us: 18, peers_getting_from_us: 7, labels: ['linux'], left_until_done: 1.7e9 }),
    torrent({ id: 2, name: 'Big Buck Bunny (2008) 4K 60fps', status: Status.Seed, rate_upload: 840_000, upload_ratio: 3.42, peers_connected: 9, peers_getting_from_us: 9, labels: ['blender'], download_dir: `${BASE}/radarr`, size_when_done: 7.28e9 }),
    torrent({ id: 3, name: 'Tears of Steel (2012) 4K', status: Status.SeedWait, upload_ratio: .98, labels: ['blender'], download_dir: `${BASE}/radarr` }),
    torrent({ id: 4, name: 'archlinux-2026.08.01-x86_64.iso', status: Status.DownloadWait, percent_done: 0, upload_ratio: 0, labels: ['linux'], size_when_done: 1.23e9 }),
    torrent({ id: 5, name: 'ubuntu-26.04.1-desktop-amd64.iso', status: Status.Check, percent_done: .41, recheck_progress: .41, upload_ratio: 0, labels: ['linux'], size_when_done: 6.02e9 }),
    torrent({ id: 6, name: 'Pride and Prejudice — LibriVox', status: Status.Stopped, upload_ratio: 2.05, labels: ['audiobook'], download_dir: `${BASE}/audiobooks`, size_when_done: 3.18e8, tracker_stats: [tracker({ has_announced: false, last_announce_succeeded: false })] }),
    torrent({ id: 7, name: 'Apollo 11 Flight Journal', status: Status.Stopped, error: 3, error_string: 'No data found! Ensure your drives are connected', percent_done: .57, upload_ratio: .3, labels: ['archive'], download_dir: `${BASE}/sonarr/docs`, size_when_done: 9.12e8,
      tracker_stats: [tracker({ announce: 'http://archive.org/announce', host: 'archive.org', last_announce_succeeded: false, last_announce_result: 'Tracker gave HTTP response code 404 (Not Found)' })] }),
    torrent({ id: 8, name: 'Cosmos Laundromat (2015)', status: Status.Seed, labels: ['blender'], download_dir: `${BASE}/buffer`, size_when_done: 3.02e9, upload_ratio: .44,
      tracker_stats: [tracker(), tracker({ id: 1, announce: 'udp://tracker.opentrackr.org:1337/announce', host: 'tracker.opentrackr.org', tier: 1, last_announce_succeeded: false, last_announce_result: 'Connection timed out', last_scrape_succeeded: false, last_scrape_time: now - 1500 })] }),
  ]
}

export function defaultSession(): Session {
  return {
    version: '4.1.3 (a6fe2a64aa)', rpc_version_semver: '6.0.1', download_dir: BASE,
    'alt_speed_enabled': false, 'alt_speed_down': 2000, 'alt_speed_up': 250, 'alt_speed_time_enabled': true, 'alt_speed_time_begin': 480, 'alt_speed_time_end': 1380, 'alt_speed_time_day': 62,
    'speed_limit_down': 20000, 'speed_limit_down_enabled': true, 'speed_limit_up': 2500, 'speed_limit_up_enabled': true,
    'incomplete_dir': `${BASE}/.incomplete`, 'incomplete_dir_enabled': true, 'rename_partial_files': true, 'start_added_torrents': true, 'trash_original_torrent_files': false,
    'script_torrent_done_enabled': false, 'script_torrent_done_filename': '', 'script_torrent_done_seeding_enabled': false, 'script_torrent_done_seeding_filename': '', 'cache_size_mib': 16,
    seed_ratio_limit: 2, seed_ratio_limited: true, sequential_download: false, 'idle_seeding_limit': 30, 'idle_seeding_limit_enabled': false,
    'download_queue_size': 3, 'download_queue_enabled': true, 'seed_queue_size': 8, 'seed_queue_enabled': true, 'queue_stalled_minutes': 30, 'queue_stalled_enabled': true,
    'peer_port': 51413, 'peer_port_random_on_start': false, 'port_forwarding_enabled': true, 'dht_enabled': true, 'pex_enabled': true, 'lpd_enabled': false, preferred_transports: ['tcp', 'utp'],
    'peer_limit_per_torrent': 50, 'peer_limit_global': 200, encryption: 'preferred', 'blocklist_enabled': true, 'blocklist_url': 'https://example.org/level1.gz', 'blocklist_size': 312904,
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
    const ids = (a.ids as number[] | 'recently_active' | undefined)
    const sel = () => Array.isArray(ids) ? d.torrents.filter(t => ids.includes(t.id)) : d.torrents
    switch (method) {
      case 'session_get': return d.session
      case 'session_set': Object.assign(d.session, a); return {}
      case 'session_stats': return {
        active_torrent_count: 3, paused_torrent_count: 2, torrent_count: d.torrents.length,
        download_speed: d.torrents.reduce((x, t) => x + t.rate_download, 0), upload_speed: d.torrents.reduce((x, t) => x + t.rate_upload, 0),
        'current_stats': { uploaded_bytes: 1.31e9, downloaded_bytes: 5.14e9, files_added: 3, session_count: 1, seconds_active: 570_000 },
        'cumulative_stats': { uploaded_bytes: 391e9, downloaded_bytes: 218e9, files_added: 412, session_count: 37, seconds_active: 12_300_000 },
      }
      case 'torrent_get': return { torrents: sel().map(t => pick(t, a.fields as string[])), ...(ids === 'recently_active' ? { removed: [] } : {}) }
      case 'torrent_start': case 'torrent_start_now': sel().forEach(t => { t.status = t.percent_done >= 1 ? Status.Seed : Status.Download; t.error = 0 }); return {}
      case 'torrent_stop': sel().forEach(t => { t.status = Status.Stopped }); return {}
      case 'torrent_verify': sel().forEach(t => { t.status = Status.Check }); return {}
      case 'torrent_reannounce': return {}
      case 'torrent_remove': d.torrents = d.torrents.filter(t => !(ids as number[]).includes(t.id)); return {}
      case 'torrent_set': sel().forEach(t => {
        const { ids: _i, ...rest } = a
        const idx = (k: string) => (rest[k] as number[] | undefined) ?? []
        idx('files_wanted').forEach(i => { t.file_stats[i].wanted = true }); idx('files_unwanted').forEach(i => { t.file_stats[i].wanted = false })
        idx('priority_high').forEach(i => { t.file_stats[i].priority = 1 }); idx('priority_normal').forEach(i => { t.file_stats[i].priority = 0 }); idx('priority_low').forEach(i => { t.file_stats[i].priority = -1 })
        for (const k of ['files_wanted', 'files_unwanted', 'priority_high', 'priority_normal', 'priority_low']) delete rest[k]
        Object.assign(t, rest)
      }); return {}
      case 'torrent_set_location': sel().forEach(t => { t.download_dir = a.location as string }); return {}
      case 'torrent_rename_path': sel().forEach(t => { t.name = a.name as string }); return {}
      case 'torrent_add': { const id = Math.max(0, ...d.torrents.map(t => t.id)) + 1; const name = String(a.filename ?? 'added.torrent').replace(/^.*dn=([^&]+).*$/, '$1'); d.torrents.push(torrent({ id, name, status: a.paused ? Status.Stopped : Status.Download, percent_done: 0, labels: (a.labels as string[]) ?? [], download_dir: (a.download_dir as string) ?? BASE })); return { 'torrent_added': { id, name, hash_string: 'x' } } }
      case 'free_space': return { path: a.path, 'size_bytes': 412e9, total_size: 1.8e12 }
      case 'port_test': return { 'port_is_open': d.portOpen, ip_protocol: a.ip_protocol }
      case 'blocklist_update': d.session.blocklist_size = 400_000; return { 'blocklist_size': 400_000 }
      default: if (method.startsWith('queue_move_')) return {}; throw new Error('unhandled ' + method)
    }
  }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (opts.unauthorized) return new Response('', { status: 401 })
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (!handshake && !headers['X-Transmission-Session-Id']) { handshake = true; return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': 'fake' } }) }
    const body = JSON.parse(String(init?.body)) as { jsonrpc: '2.0'; method: string; params: Record<string, unknown>; id: number }
    d.calls.push({ method: body.method, args: body.params })
    try { return Response.json({ jsonrpc: '2.0', id: body.id, result: handle(body.method, body.params) }) }
    catch (e) { return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: (e as Error).message } }) }
  })
  return d
}
