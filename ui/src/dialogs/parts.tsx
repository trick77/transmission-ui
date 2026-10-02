// Pieces more than one dialog needs, and that the inspector shares with them.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { folderTree, relDir } from '../lib/model'
import * as api from '../rpc/methods'
import type { TorrentDetail } from '../rpc/types'
import { useStore } from '../state/store'
import { NumInput, Opt, Seg, Toggle } from '../app/ui'

/** A label-shaped button that can be picked. */
export function Chip({ on, onClick, style, children }: { on: boolean; onClick: () => void; style?: CSSProperties; children: ReactNode }) {
  return <button className={'chip lbl' + (on ? ' on' : '')} style={style} onClick={onClick}>{children}</button>
}

/** The session download dir and every folder a torrent already lives in, one click each. */
export function FolderChips({ value, onPick }: { value: string; onPick: (path: string) => void }) {
  const torrents = useStore(s => s.torrents)
  const base = useStore(s => s.session?.download_dir ?? '')
  const folders = useMemo(() => folderTree(torrents, base), [torrents, base])
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 2 }}>
      {[base, ...folders.map(f => f.path)].filter(Boolean).map(p => <Chip key={p} on={p === value} onClick={() => onPick(p)}>{relDir(p, base) || '/'}</Chip>)}
    </div>
  )
}

/** Free bytes on the filesystem behind `path`; null while unknown or when the path does not exist. */
export function useFreeSpace(path: string): number | null {
  const [free, setFree] = useState<number | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    api.freeSpace(path).then(r => { if (live) setFree(r.size_bytes) }, () => { if (live) setFree(null) })
    return () => { live = false }
  }, [path])
  return free
}

export const LIMIT_FIELDS = ['honors_session_limits', 'download_limit', 'download_limited', 'upload_limit', 'upload_limited', 'bandwidth_priority',
  'seed_ratio_mode', 'seed_ratio_limit', 'seed_idle_mode', 'seed_idle_limit', 'peer_limit'] as const
export type Limits = Pick<TorrentDetail, typeof LIMIT_FIELDS[number]>

const PRIORITIES = [{ v: '-1', l: 'Low' }, { v: '0', l: 'Normal' }, { v: '1', l: 'High' }]
const MODES = [{ v: '0', l: 'Global' }, { v: '1', l: 'Custom' }, { v: '2', l: 'Unlimited' }]

/** Per-torrent limits and priority. `idle` adds the idle-seeding row, which only the dialog shows. */
export function LimitRows({ d, setT, width, idle }: { d: Limits; setT: (label: string, args: api.TorrentSetArgs) => void; width?: number; idle?: boolean }) {
  return <>
    <Opt label="Honor global limits"><Toggle on={d.honors_session_limits} onChange={v => setT('Limits', { honors_session_limits: v })} /></Opt>
    <Opt label="Limit download"><NumInput value={d.download_limit} unit="kB/s" width={width} onCommit={v => setT('Limit', { download_limit: v })} disabled={!d.download_limited} /><Toggle on={d.download_limited} onChange={v => setT('Limit', { download_limited: v })} /></Opt>
    <Opt label="Limit upload"><NumInput value={d.upload_limit} unit="kB/s" width={width} onCommit={v => setT('Limit', { upload_limit: v })} disabled={!d.upload_limited} /><Toggle on={d.upload_limited} onChange={v => setT('Limit', { upload_limited: v })} /></Opt>
    <Opt label="Bandwidth priority"><Seg value={String(d.bandwidth_priority)} options={PRIORITIES} onChange={v => setT('Priority', { bandwidth_priority: Number(v) as -1 | 0 | 1 })} /></Opt>
    <Opt label="Seed ratio"><Seg value={String(d.seed_ratio_mode)} options={MODES} onChange={v => setT('Seed ratio', { seed_ratio_mode: Number(v) as 0 | 1 | 2 })} />{d.seed_ratio_mode === 1 ? <NumInput value={d.seed_ratio_limit} width={70} onCommit={v => setT('Seed ratio', { seed_ratio_limit: v })} /> : null}</Opt>
    {idle ? <Opt label="Idle seeding"><Seg value={String(d.seed_idle_mode)} options={MODES} onChange={v => setT('Idle', { seed_idle_mode: Number(v) as 0 | 1 | 2 })} />{d.seed_idle_mode === 1 ? <NumInput value={d.seed_idle_limit} unit="min" width={90} onCommit={v => setT('Idle', { seed_idle_limit: v })} /> : null}</Opt> : null}
    <Opt label="Peer limit"><NumInput value={d.peer_limit} width={80} onCommit={v => setT('Peer limit', { 'peer_limit': v })} /></Opt>
  </>
}
