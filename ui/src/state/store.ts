// One store, one snapshot, useSyncExternalStore. Polling lives here too so components stay dumb.

import { useSyncExternalStore } from 'react'
import * as api from '../rpc/methods'
import type { FreeSpace, Session, SessionStats, TorrentDetail, TorrentSummary } from '../rpc/types'
import type { Adv, SortKey } from '../lib/model'

export type Dialog =
  | { kind: 'none' }
  | { kind: 'add'; magnet?: string; files?: File[] }
  | { kind: 'settings'; section?: string }
  | { kind: 'confirm-remove'; ids: number[]; deleteData: boolean }
  | { kind: 'labels'; ids: number[] }
  | { kind: 'location'; ids: number[] }
  | { kind: 'rename'; id: number }
  | { kind: 'limits'; ids: number[] }
  | { kind: 'trackers'; id: number }

export interface Snapshot {
  torrents: TorrentSummary[]
  byId: Map<number, TorrentSummary>
  detail: TorrentDetail | null
  session: Session | null
  stats: SessionStats | null
  history: { down: number; up: number }[]
  freeSpace: Map<string, FreeSpace>
  connection: 'connecting' | 'ok' | 'unauthorized' | 'error'
  lastError: string
  // view state
  filter: string
  adv: Adv
  search: string
  sort: SortKey
  sortDir: 1 | -1
  selected: Set<number>
  focusId: number | null   // the torrent shown in the inspector
  inspectorTab: 'overview' | 'files' | 'peers' | 'trackers'
  dialog: Dialog
  dismissed: Set<string>   // tracker-down notices dismissed, "host@since"
  toast: string
}

const params = new URLSearchParams(location.search)
let snap: Snapshot = {
  torrents: [], byId: new Map(), detail: null, session: null, stats: null, history: [], freeSpace: new Map(),
  connection: 'connecting', lastError: '',
  filter: params.get('filter') || 'all',
  adv: Object.fromEntries(['size', 'age', 'ratio', 'idle'].filter(k => params.get(k)).map(k => [k, params.get(k)!])),
  search: '',
  sort: (params.get('sort') as SortKey) || 'state', sortDir: 1,
  selected: new Set(), focusId: params.get('sel') ? Number(params.get('sel')) : null, inspectorTab: 'overview',
  dialog: { kind: 'none' },
  dismissed: new Set(readLocal<string[]>('tm.dismissed', [])),
  toast: '',
}
const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }
export function set(patch: Partial<Snapshot> | ((s: Snapshot) => Partial<Snapshot>)) {
  const p = typeof patch === 'function' ? patch(snap) : patch
  snap = { ...snap, ...p }
  emit()
}
export function get() { return snap }
export function useStore<T>(sel: (s: Snapshot) => T): T {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => sel(snap))
}
export const useSnap = () => useStore(s => s)

function readLocal<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }
export function writeLocal(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }

// ─── URL sync (deep links like the mocks) ───
export function syncUrl() {
  const u = new URL(location.href)
  const q = u.searchParams
  for (const k of ['filter', 'size', 'age', 'ratio', 'idle', 'sort', 'sel']) q.delete(k)
  if (snap.filter !== 'all') q.set('filter', snap.filter)
  for (const [k, v] of Object.entries(snap.adv)) if (v && v !== 'any') q.set(k, v)
  if (snap.sort !== 'state') q.set('sort', snap.sort)
  if (snap.focusId) q.set('sel', String(snap.focusId))
  history.replaceState(null, '', u.pathname + (q.toString() ? '?' + q.toString() : ''))
}

// ─── polling ───
const LIST_MS = 2000, HIDDEN_MS = 5000, FULL_EVERY = 30, SPACE_MS = 30000
let timer: ReturnType<typeof setTimeout> | null = null
let ticks = 0
let haveFull = false
let inFlight = false
let pollAgain = false

function mergeTorrents(list: TorrentSummary[], removed: number[] | undefined, full: boolean) {
  const byId = full ? new Map<number, TorrentSummary>() : new Map(snap.byId)
  for (const t of list) byId.set(t.id, t)
  for (const id of removed ?? []) byId.delete(id)
  set({ torrents: [...byId.values()], byId })
}

// Exactly one poll chain: a call while a poll is in flight only asks for one more pass
// right after it, instead of starting a second loop that would then re-arm forever.
async function pollOnce() {
  if (inFlight) { pollAgain = true; return }
  inFlight = true
  if (timer) { clearTimeout(timer); timer = null }
  try {
    const full = !haveFull || ticks % FULL_EVERY === 0
    const [tr, st] = await Promise.all([api.getTorrents(full ? undefined : 'recently-active'), api.getStats()])
    mergeTorrents(tr.torrents, tr.removed, full)
    haveFull = true
    const history = [...snap.history, { down: st.downloadSpeed, up: st.uploadSpeed }].slice(-60)
    set({ stats: st, history, connection: 'ok', lastError: '' })
    if (snap.focusId != null) {
      const d = await api.getTorrentDetail(snap.focusId).catch(() => null)
      if (d) set({ detail: d })
      else if (!snap.byId.has(snap.focusId)) set({ focusId: null, detail: null })
    }
    if (ticks % 15 === 0) await refreshSession()
    if (ticks % (SPACE_MS / LIST_MS) === 0) void refreshFreeSpace()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    set({ connection: msg === 'unauthorized' ? 'unauthorized' : 'error', lastError: msg })
  } finally {
    ticks++
    inFlight = false
    if (pollAgain) { pollAgain = false; void pollOnce() }
    else timer = setTimeout(pollOnce, document.hidden ? HIDDEN_MS : LIST_MS)
  }
}

export async function refreshSession() {
  try { set({ session: await api.getSession() }) } catch { /* handled by poll */ }
}

export async function refreshFreeSpace() {
  const dirs = new Set<string>(snap.torrents.map(t => t.downloadDir))
  if (snap.session) dirs.add(snap.session['download-dir'])
  // one query per top-level mount is enough: the daemon reports the filesystem, not the folder
  const roots = new Set([...dirs].map(d => mountOf(d, snap.session?.['download-dir'] ?? '')))
  const m = new Map(snap.freeSpace)
  await Promise.all([...roots].map(async r => { try { m.set(r, await api.freeSpace(r)) } catch { /* path may not exist */ } }))
  set({ freeSpace: m })
}

/** Base download dir if the path is under it, else the path's first two components. */
function mountOf(dir: string, base: string): string {
  if (base && (dir === base || dir.startsWith(base + '/'))) return base
  const parts = dir.split('/').filter(Boolean)
  return '/' + parts.slice(0, Math.min(2, parts.length)).join('/')
}

let started = false
export function startPolling() {
  if (started) return
  started = true
  void refreshSession().then(() => pollOnce())
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollOnce() })
}

/** Force the next poll to be a full refresh (after add/remove) and run it now. */
export function refreshNow() {
  haveFull = false
  ticks = 0   // also re-reads session and free space on this pass
  void pollOnce()
}

// ─── actions used across components ───
export function focus(id: number | null) {
  set({ focusId: id, detail: id === snap.detail?.id ? snap.detail : null })
  syncUrl()
  if (id != null) void api.getTorrentDetail(id).then(d => { if (get().focusId === id) set({ detail: d }) }).catch(() => {})
}

export function toast(msg: string) {
  set({ toast: msg })
  setTimeout(() => { if (get().toast === msg) set({ toast: '' }) }, 3500)
}

export async function run(label: string, fn: () => Promise<unknown>) {
  try { await fn(); refreshNow() } catch (e) { toast(`${label} failed: ${e instanceof Error ? e.message : e}`) }
}

export function dismissNotice(key: string) {
  const d = new Set(snap.dismissed); d.add(key)
  writeLocal('tm.dismissed', [...d]); set({ dismissed: d })
}
