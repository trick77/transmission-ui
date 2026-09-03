// Menu item lists shared by the row context menu, the selection bar's ⋮ and the toolbar's view menu.
import * as api from '../rpc/methods'
import { Status } from '../rpc/types'
import { get, run, set, toast } from '../state/store'
import type { MenuItem } from '../app/ui'

export function torrentMenu(ids: number[]): MenuItem[] {
  const s = get()
  const one = ids.length === 1 ? s.byId.get(ids[0]) : undefined
  const anyStopped = ids.some(id => s.byId.get(id)?.status === Status.Stopped)
  const q = (where: 'top' | 'up' | 'down' | 'bottom') => () => void run('Queue', () => api.queueMove(where, ids))
  return [
    anyStopped ? { icon: 'play', label: ids.length > 1 ? 'Resume' : 'Resume', k: '␣', onClick: () => void run('Resume', () => api.start(ids)) }
      : { icon: 'pause', label: 'Pause', k: '␣', onClick: () => void run('Pause', () => api.stop(ids)) },
    { icon: 'globe', label: 'Re-announce', onClick: () => void run('Re-announce', () => api.reannounce(ids)) },
    { icon: 'check', label: 'Verify local data', onClick: () => void run('Verify', () => api.verify(ids)) },
    { sep: true, label: '' },
    { icon: 'sort', label: 'Queue position', sub: [
      { icon: 'up', label: 'Move to top', onClick: q('top') }, { icon: 'up', label: 'Move up', onClick: q('up') },
      { icon: 'down', label: 'Move down', onClick: q('down') }, { icon: 'down', label: 'Move to bottom', onClick: q('bottom') },
    ] },
    { icon: 'tag', label: 'Labels…', onClick: () => set({ dialog: { kind: 'labels', ids } }) },
    { icon: 'folder', label: 'Set location…', onClick: () => set({ dialog: { kind: 'location', ids } }) },
    ...(one ? [{ icon: 'file' as const, label: 'Rename…', onClick: () => set({ dialog: { kind: 'rename', id: one.id } }) }] : []),
    { icon: 'gear', label: 'Limits & priority…', onClick: () => set({ dialog: { kind: 'limits', ids } }) },
    { sep: true, label: '' },
    ...(one ? [
      { icon: 'magnet' as const, label: 'Copy magnet link', k: '⌘C', onClick: () => copyText(one.magnetLink, 'Magnet link copied') },
      { icon: 'link' as const, label: 'Copy hash', onClick: () => copyText(one.hashString, 'Hash copied') },
      { sep: true, label: '' },
    ] : []),
    { icon: 'x', label: ids.length > 1 ? `Remove ${ids.length} from list` : 'Remove from list', k: '⌫', danger: true, onClick: () => set({ dialog: { kind: 'confirm-remove', ids, deleteData: false } }) },
    { icon: 'trash', label: 'Remove and delete data…', k: '⌘⌫', danger: true, onClick: () => set({ dialog: { kind: 'confirm-remove', ids, deleteData: true } }) },
  ]
}

export function viewMenu(ids: number[], selectAll: () => void): MenuItem[] {
  return [
    { header: true, label: `Everything in this view · ${ids.length}` },
    { icon: 'play', label: 'Resume all', onClick: () => void run('Resume all', () => api.start(ids)) },
    { icon: 'pause', label: 'Pause all', onClick: () => void run('Pause all', () => api.stop(ids)) },
    { icon: 'globe', label: 'Re-announce all', onClick: () => void run('Re-announce all', () => api.reannounce(ids)) },
    { icon: 'check', label: 'Verify all', onClick: () => void run('Verify all', () => api.verify(ids)) },
    { sep: true, label: '' },
    { icon: 'check', label: 'Select all', k: '⌘A', onClick: selectAll },
  ]
}

// Synchronous in the click handler: Safari only allows clipboard writes inside user activation.
function copyText(text: string, done: string) {
  navigator.clipboard.writeText(text).then(() => toast(done), () => toast('Copy failed'))
}
