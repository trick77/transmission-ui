import { rpc } from './client'
import {
  DETAIL_FIELDS, SUMMARY_FIELDS,
  type FreeSpace, type Session, type SessionStats, type TorrentDetail, type TorrentSummary,
} from './types'

type Ids = number[] | 'recently-active'

export const getTorrents = (ids?: Ids) =>
  rpc<{ torrents: TorrentSummary[]; removed?: number[] }>('torrent-get', { fields: SUMMARY_FIELDS, ...(ids ? { ids } : {}) })

export const getTorrentDetail = (id: number) =>
  rpc<{ torrents: TorrentDetail[] }>('torrent-get', { fields: DETAIL_FIELDS, ids: [id] }).then(r => r.torrents[0])

export const getSession = () => rpc<Session>('session-get')
export const setSession = (args: Partial<Session>) => rpc('session-set', args)
export const getStats = () => rpc<SessionStats>('session-stats')
export const freeSpace = (path: string) => rpc<FreeSpace>('free-space', { path })
export const portTest = () => rpc<{ 'port-is-open': boolean }>('port-test')
export const blocklistUpdate = () => rpc<{ 'blocklist-size': number }>('blocklist-update')

export const start = (ids: number[]) => rpc('torrent-start', { ids })
export const startNow = (ids: number[]) => rpc('torrent-start-now', { ids })
export const stop = (ids: number[]) => rpc('torrent-stop', { ids })
export const verify = (ids: number[]) => rpc('torrent-verify', { ids })
export const reannounce = (ids: number[]) => rpc('torrent-reannounce', { ids })
export const remove = (ids: number[], deleteData: boolean) => rpc('torrent-remove', { ids, 'delete-local-data': deleteData })
export const queueMove = (where: 'top' | 'up' | 'down' | 'bottom', ids: number[]) => rpc(`queue-move-${where}`, { ids })
export const setLocation = (ids: number[], location: string, move = true) => rpc('torrent-set-location', { ids, location, move })
export const renamePath = (id: number, path: string, name: string) => rpc('torrent-rename-path', { ids: [id], path, name })

export interface TorrentSetArgs {
  labels?: string[]
  bandwidthPriority?: -1 | 0 | 1
  downloadLimit?: number
  downloadLimited?: boolean
  uploadLimit?: number
  uploadLimited?: boolean
  honorsSessionLimits?: boolean
  'peer-limit'?: number
  seedRatioLimit?: number
  seedRatioMode?: 0 | 1 | 2
  seedIdleLimit?: number
  seedIdleMode?: 0 | 1 | 2
  'files-wanted'?: number[]
  'files-unwanted'?: number[]
  'priority-high'?: number[]
  'priority-normal'?: number[]
  'priority-low'?: number[]
  trackerList?: string
  sequentialDownload?: boolean
}
export const setTorrent = (ids: number[], args: TorrentSetArgs) => rpc('torrent-set', { ids, ...args } as Record<string, unknown>)

export interface AddArgs {
  metainfo?: string
  filename?: string
  'download-dir'?: string
  paused?: boolean
  labels?: string[]
  bandwidthPriority?: -1 | 0 | 1
  'files-unwanted'?: number[]
  'priority-high'?: number[]
  'priority-low'?: number[]
  sequential_download?: boolean
}
export interface AddResult {
  'torrent-added'?: { id: number; name: string; hashString: string }
  'torrent-duplicate'?: { id: number; name: string; hashString: string }
}
export const addTorrent = (args: AddArgs) => rpc<AddResult>('torrent-add', { ...args })
