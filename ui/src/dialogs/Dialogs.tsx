import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
import { get, refreshNow, run, set, useStore } from '../state/store'
import * as api from '../rpc/methods'
import { relDir, labelCounts, folderTree } from '../lib/model'
import { Add } from './Add'
import { Settings } from './Settings'
import { NumInput, Opt, Seg, TextInput, Toggle, useDismiss } from '../app/ui'

export function Modal({ title, width, children, footer, onClose, bodyStyle }: { title: ReactNode; width: number; children: ReactNode; footer?: ReactNode; onClose: () => void; bodyStyle?: React.CSSProperties }) {
  const ref = useDismiss(onClose)
  return (
    <div className="scrim">
      <div ref={ref} className="modal" style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-h"><span className="t">{title}</span><div className="spacer" /><button className="btn ghost icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-b" style={bodyStyle}>{children}</div>
        {footer ? <div className="modal-f">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Dialogs() {
  const dialog = useStore(s => s.dialog)
  const close = useCallback(() => set({ dialog: { kind: 'none' } }), [])
  switch (dialog.kind) {
    case 'add': return <Add onClose={close} initialMagnet={dialog.magnet} initialFiles={dialog.files} />
    case 'settings': return <Settings onClose={close} section={dialog.section} />
    case 'confirm-remove': return <ConfirmRemove ids={dialog.ids} deleteData={dialog.deleteData} onClose={close} />
    case 'labels': return <Labels ids={dialog.ids} onClose={close} />
    case 'location': return <Location ids={dialog.ids} onClose={close} />
    case 'rename': return <Rename id={dialog.id} onClose={close} />
    case 'limits': return <Limits ids={dialog.ids} onClose={close} />
    case 'trackers': return <TrackersEdit id={dialog.id} onClose={close} />
    default: return null
  }
}

function names(ids: number[]) { const s = get(); return ids.map(id => s.byId.get(id)?.name ?? `#${id}`) }

function ConfirmRemove({ ids, deleteData, onClose }: { ids: number[]; deleteData: boolean; onClose: () => void }) {
  const [del, setDel] = useState(deleteData)
  const n = names(ids)
  const dirs = [...new Set(ids.map(id => get().byId.get(id)?.downloadDir).filter(Boolean))]
  return (
    <Modal title={del ? 'Remove and delete data' : 'Remove from list'} width={520} onClose={onClose}
      footer={<><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className={'btn ' + (del ? 'primary' : '')} style={del ? { background: 'var(--err)' } : undefined} onClick={() => { onClose(); void run('Remove', () => api.remove(ids, del)) }}>{del ? `Delete ${ids.length > 1 ? ids.length + ' torrents' : 'torrent'} and data` : `Remove ${ids.length > 1 ? ids.length + ' torrents' : 'torrent'}`}</button></>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div>{n.length === 1 ? <b>{n[0]}</b> : <><b>{n.length} torrents</b><div className="hint" style={{ marginTop: 4 }}>{n.slice(0, 5).join(' · ')}{n.length > 5 ? ` · +${n.length - 5} more` : ''}</div></>}</div>
        <Opt label="Also delete downloaded data" desc={del ? <span style={{ color: 'var(--err)' }}>Files under {dirs.join(', ')} are deleted. This cannot be undone.</span> : 'The files stay on disk; only the torrent is forgotten.'}><Toggle on={del} onChange={setDel} /></Opt>
      </div>
    </Modal>
  )
}

function Labels({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const torrents = useStore(s => s.torrents)
  const existing = labelCounts(torrents).map(l => l.label)
  const initial = ids.length === 1 ? (get().byId.get(ids[0])?.labels ?? []) : existing.filter(l => ids.every(id => get().byId.get(id)?.labels.includes(l)))
  const [sel, setSel] = useState<string[]>(initial)
  const [draft, setDraft] = useState('')
  const toggle = (l: string) => setSel(s => s.includes(l) ? s.filter(x => x !== l) : [...s, l])
  const add = () => { const v = draft.trim(); if (v && !sel.includes(v)) setSel(s => [...s, v]); setDraft('') }
  return (
    <Modal title="Labels" width={440} onClose={onClose}
      footer={<><span className="hint">{ids.length > 1 ? `Applies to ${ids.length} torrents` : names(ids)[0]}</span><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => { onClose(); void run('Labels', () => api.setTorrent(ids, { labels: sel })) }}>Save</button></>}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {[...new Set([...existing, ...sel])].map(l => (
          <button key={l} className="chip lbl" style={sel.includes(l) ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent', height: 26, padding: '0 10px' } : { height: 26, padding: '0 10px' }} onClick={() => toggle(l)}>{l}</button>
        ))}
        {!existing.length && !sel.length ? <span className="hint">No labels yet.</span> : null}
      </div>
      <div className="input"><Icon name="tag" style={{ color: 'var(--ink-3)' }} /><input placeholder="New label, press Enter" value={draft} autoFocus onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} /></div>
    </Modal>
  )
}

function Location({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const session = useStore(s => s.session)
  const torrents = useStore(s => s.torrents)
  const base = session?.['download-dir'] ?? ''
  const [path, setPath] = useState(get().byId.get(ids[0])?.downloadDir ?? base)
  const [move, setMove] = useState(true)
  const [free, setFree] = useState<number | null>(null)
  useEffect(() => { let live = true; api.freeSpace(path).then(r => { if (live) setFree(r['size-bytes']) }).catch(() => setFree(null)); return () => { live = false } }, [path])
  const folders = folderTree(torrents, base)
  return (
    <Modal title="Set location" width={560} onClose={onClose}
      footer={<><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => { onClose(); void run('Move', () => api.setLocation(ids, path, move)) }}>{move ? 'Move' : 'Set location'}</button></>}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div className="field"><label>Folder</label>
          <TextInput value={path} onCommit={setPath} icon="folder" unit={free != null ? `${(free / 1e9).toFixed(0)} GB free` : undefined} autoFocus />
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 2 }}>
            {[base, ...folders.map(f => f.path)].filter(Boolean).map(p => <button key={p} className="chip lbl" style={p === path ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent' } : undefined} onClick={() => setPath(p)}>{relDir(p, base) || '/'}</button>)}
          </div>
        </div>
        <Opt label="Move data" desc={move ? 'Files are moved to the new folder.' : 'Only the path changes; use when the files are already there.'}><Toggle on={move} onChange={setMove} /></Opt>
      </div>
    </Modal>
  )
}

function Rename({ id, onClose }: { id: number; onClose: () => void }) {
  const t = get().byId.get(id)
  const [name, setName] = useState(t?.name ?? '')
  if (!t) return null
  return (
    <Modal title="Rename" width={520} onClose={onClose}
      footer={<><span className="hint">Renames the top-level file or folder on disk.</span><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim() || name === t.name} onClick={() => { onClose(); void run('Rename', () => api.renamePath(id, t.name, name.trim())) }}>Rename</button></>}>
      <div className="field"><label>Name</label><div className="input"><input value={name} autoFocus onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim() && name !== t.name) { onClose(); void run('Rename', () => api.renamePath(id, t.name, name.trim())) } }} /></div></div>
    </Modal>
  )
}

function Limits({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.getTorrentDetail>> | null>(null)
  useEffect(() => { api.getTorrentDetail(ids[0]).then(setD).catch(() => {}) }, [ids])
  const setT = (label: string, args: api.TorrentSetArgs) => void run(label, () => api.setTorrent(ids, args).then(() => api.getTorrentDetail(ids[0]).then(setD)))
  return (
    <Modal title="Limits & priority" width={520} onClose={onClose} footer={<><span className="hint">{ids.length > 1 ? `Applies to ${ids.length} torrents · values shown are from the first` : names(ids)[0]}</span><div className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></>}>
      {!d ? <div className="hint">Loading…</div> : <>
        <Opt label="Honor global limits"><Toggle on={d.honorsSessionLimits} onChange={v => setT('Limits', { honorsSessionLimits: v })} /></Opt>
        <Opt label="Limit download"><NumInput value={d.downloadLimit} unit="kB/s" onCommit={v => setT('Limit', { downloadLimit: v })} disabled={!d.downloadLimited} /><Toggle on={d.downloadLimited} onChange={v => setT('Limit', { downloadLimited: v })} /></Opt>
        <Opt label="Limit upload"><NumInput value={d.uploadLimit} unit="kB/s" onCommit={v => setT('Limit', { uploadLimit: v })} disabled={!d.uploadLimited} /><Toggle on={d.uploadLimited} onChange={v => setT('Limit', { uploadLimited: v })} /></Opt>
        <Opt label="Bandwidth priority"><Seg value={String(d.bandwidthPriority)} options={[{ v: '-1', l: 'Low' }, { v: '0', l: 'Normal' }, { v: '1', l: 'High' }]} onChange={v => setT('Priority', { bandwidthPriority: Number(v) as -1 | 0 | 1 })} /></Opt>
        <Opt label="Seed ratio"><Seg value={String(d.seedRatioMode)} options={[{ v: '0', l: 'Global' }, { v: '1', l: 'Custom' }, { v: '2', l: 'Unlimited' }]} onChange={v => setT('Seed ratio', { seedRatioMode: Number(v) as 0 | 1 | 2 })} />{d.seedRatioMode === 1 ? <NumInput value={d.seedRatioLimit} width={70} onCommit={v => setT('Seed ratio', { seedRatioLimit: v })} /> : null}</Opt>
        <Opt label="Idle seeding"><Seg value={String(d.seedIdleMode)} options={[{ v: '0', l: 'Global' }, { v: '1', l: 'Custom' }, { v: '2', l: 'Unlimited' }]} onChange={v => setT('Idle', { seedIdleMode: Number(v) as 0 | 1 | 2 })} />{d.seedIdleMode === 1 ? <NumInput value={d.seedIdleLimit} unit="min" width={90} onCommit={v => setT('Idle', { seedIdleLimit: v })} /> : null}</Opt>
        <Opt label="Peer limit"><NumInput value={d['peer-limit']} width={80} onCommit={v => setT('Peer limit', { 'peer-limit': v })} /></Opt>
      </>}
    </Modal>
  )
}

function TrackersEdit({ id, onClose }: { id: number; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => { api.getTorrentDetail(id).then(d => setText(d.trackerList)).catch(() => setText('')) }, [id])
  return (
    <Modal title="Trackers" width={560} onClose={onClose}
      footer={<><span className="hint">One announce URL per line; a blank line starts a new tier.</span><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={text == null} onClick={() => { onClose(); void run('Trackers', () => api.setTorrent([id], { trackerList: text ?? '' }).then(refreshNow)) }}>Save</button></>}>
      <textarea value={text ?? ''} onChange={e => setText(e.target.value)} spellCheck={false}
        style={{ width: '100%', minHeight: 220, resize: 'vertical', background: 'var(--surface-2)', color: 'var(--ink)', border: '1px solid transparent', borderRadius: 'var(--r)', padding: 10, font: '12px var(--mono)', outline: 'none' }} />
    </Modal>
  )
}
