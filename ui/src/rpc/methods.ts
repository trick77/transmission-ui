import { rpc } from './client'
import {
  DETAIL_FIELDS, SUMMARY_FIELDS,
  type FreeSpace, type Session, type SessionStats, type TorrentDetail, type TorrentSummary,
} from './types'

type Ids = number[] | 'recently_active'

export type IpProtocol = 'ipv4' | 'ipv6'

export const getTorrents = (ids?: Ids) =>
  rpc<{ torrents: TorrentSummary[]; removed?: number[] }>('torrent_get', { fields: SUMMARY_FIELDS, ...(ids ? { ids } : {}) })

export const getTorrentDetail = (id: number) =>
  rpc<{ torrents: TorrentDetail[] }>('torrent_get', { fields: DETAIL_FIELDS, ids: [id] }).then(r => r.torrents[0])

export const getSession = () => rpc<Session>('session_get')
export const setSession = (params: Partial<Session>) => rpc('session_set', params)
export const getStats = () => rpc<SessionStats>('session_stats')
export const freeSpace = (path: string) => rpc<FreeSpace>('free_space', { path })
/** rpc 18 tests one family at a time; without ip_protocol the daemon picks whichever it happens to use. */
export const portTest = (ip_protocol: IpProtocol) =>
  rpc<{ port_is_open: boolean; ip_protocol?: IpProtocol }>('port_test', { ip_protocol })
export const blocklistUpdate = () => rpc<{ blocklist_size: number }>('blocklist_update')

export const start = (ids: number[]) => rpc('torrent_start', { ids })
export const startNow = (ids: number[]) => rpc('torrent_start_now', { ids })
export const stop = (ids: number[]) => rpc('torrent_stop', { ids })
export const verify = (ids: number[]) => rpc('torrent_verify', { ids })
export const reannounce = (ids: number[]) => rpc('torrent_reannounce', { ids })
export const remove = (ids: number[], deleteData: boolean) => rpc('torrent_remove', { ids, delete_local_data: deleteData })
export const queueMove = (where: 'top' | 'up' | 'down' | 'bottom', ids: number[]) => rpc(`queue_move_${where}`, { ids })
export const setLocation = (ids: number[], location: string, move = true) => rpc('torrent_set_location', { ids, location, move })
export const renamePath = (id: number, path: string, name: string) => rpc('torrent_rename_path', { ids: [id], path, name })

export interface TorrentSetArgs {
  labels?: string[]
  bandwidth_priority?: -1 | 0 | 1
  download_limit?: number
  download_limited?: boolean
  upload_limit?: number
  upload_limited?: boolean
  honors_session_limits?: boolean
  peer_limit?: number
  seed_ratio_limit?: number
  seed_ratio_mode?: 0 | 1 | 2
  seed_idle_limit?: number
  seed_idle_mode?: 0 | 1 | 2
  files_wanted?: number[]
  files_unwanted?: number[]
  priority_high?: number[]
  priority_normal?: number[]
  priority_low?: number[]
  tracker_list?: string
  sequential_download?: boolean
  sequential_download_from_piece?: number
}
export const setTorrent = (ids: number[], args: TorrentSetArgs) => rpc('torrent_set', { ids, ...args } as Record<string, unknown>)

export interface AddArgs {
  metainfo?: string
  filename?: string
  download_dir?: string
  paused?: boolean
  labels?: string[]
  bandwidth_priority?: -1 | 0 | 1
  files_unwanted?: number[]
  priority_high?: number[]
  priority_low?: number[]
  sequential_download?: boolean
}
export interface AddResult {
  torrent_added?: { id: number; name: string; hash_string: string }
  torrent_duplicate?: { id: number; name: string; hash_string: string }
}
export const addTorrent = (args: AddArgs) => rpc<AddResult>('torrent_add', { ...args })
