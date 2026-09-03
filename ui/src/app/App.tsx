import { useEffect } from 'react'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { List } from '../list/List'
import { Inspector } from '../inspector/Inspector'
import { Dialogs } from '../dialogs/Dialogs'
import { get, set, useStore } from '../state/store'
import * as api from '../rpc/methods'
import { run } from '../state/store'

export function App() {
  const focusId = useStore(s => s.focusId)
  const connection = useStore(s => s.connection)
  const lastError = useStore(s => s.lastError)
  const toastMsg = useStore(s => s.toast)

  // global keys: ⌘F search, ⌘A select all, Space pause/resume, ⌫ remove, Esc clear
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = get()
      const inField = e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); document.querySelector<HTMLInputElement>('.search input')?.focus(); return }
      if (inField || s.dialog.kind !== 'none') return
      const ids = s.selected.size ? [...s.selected] : s.focusId != null ? [s.focusId] : []
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); document.dispatchEvent(new CustomEvent('tm:select-all')); return }
      if (e.key === 'Escape') { set({ selected: new Set() }); return }
      if (!ids.length) return
      if (e.key === ' ') { e.preventDefault(); const t = s.byId.get(ids[0]); if (!t) return; void run(t.status === 0 ? 'Resume' : 'Pause', () => t.status === 0 ? api.start(ids) : api.stop(ids)) }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); set({ dialog: { kind: 'confirm-remove', ids, deleteData: e.metaKey || e.ctrlKey } }) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // drop .torrent files anywhere → Add dialog; saved density
  useEffect(() => {
    try { const d = localStorage.getItem('tm.density'); if (d) document.documentElement.dataset.density = d } catch { /* ignore */ }
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length || get().dialog.kind === 'add') return
      e.preventDefault()
      const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.torrent'))
      if (files.length) set({ dialog: { kind: 'add', files } })
    }
    document.addEventListener('dragover', over); document.addEventListener('drop', drop)
    return () => { document.removeEventListener('dragover', over); document.removeEventListener('drop', drop) }
  }, [])

  return (
    <div className="app">
      <Header />
      <Sidebar />
      <div className={'main' + (focusId != null ? ' has-insp' : '')}>
        <List />
        {focusId != null ? <Inspector /> : null}
      </div>
      <Dialogs />
      {connection === 'unauthorized' || connection === 'error' ? (
        <div className="notice" style={{ position: 'fixed', left: 'calc(var(--sidebar-w) + 16px)', bottom: 14, zIndex: 50, background: 'var(--surface-3)' }}>
          <span className="st" />
          <span>{connection === 'unauthorized' ? <><b>Daemon needs credentials.</b> Sign in with the RPC username and password.</> : <><b>Can't reach the daemon.</b> {lastError} · retrying</>}</span>
          {connection === 'unauthorized' ? <button className="btn sm" onClick={() => location.reload()}>Reload</button> : null}
        </div>
      ) : null}
      {toastMsg ? <div className="notice" style={{ position: 'fixed', right: 16, bottom: 14, zIndex: 50, background: 'var(--surface-3)' }}>{toastMsg}</div> : null}
    </div>
  )
}
