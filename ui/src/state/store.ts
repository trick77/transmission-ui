// One store, one snapshot, useSyncExternalStore. Polling lives here too so components stay dumb.

import { useSyncExternalStore } from 'react'
import * as api from '../rpc/methods'
import { EXTRA_FIELDS, type FreeSpace, type Session, type SessionStats, type TorrentExtra, type TorrentSummary } from '../rpc/types'
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
  // The focused torrent's inspector-only fields. Its summary half lives in byId.
  detail: TorrentExtra | null
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
  inspectorTab: InspectorTab
  dialog: Dialog
  dismissed: Set<string>   // tracker-down notices dismissed, "host@since"
  toast: string
  removing: Removing | null   // bulk removal in flight, see removeSequence()
  density: Density
  sidebarW: number         // the user's preferred sidebar width in px, before the CSS clamp
}

/**
 * A bulk remove+delete in progress. The daemon gives us nothing to render: torrent-remove
 * is a sync handler on the session thread, so it answers no other request while it unlinks
 * and its 200 is a completion signal rather than an ack. So the client makes the progress
 * itself, one torrent-remove per torrent, and this is the tally.
 *
 * `failed` outlives the run: a removal that did not happen has to stay on screen, or the
 * silence this feature exists to fix comes back in a worse form.
 */
export interface Removing {
  token: number                              // identifies this run; see removeSequence()
  ids: number[]                              // the whole batch, in visible list order
  done: number                               // responses received, successes and failures
  active: number | null                      // the id the daemon is deleting right now
  failed: { id: number; msg: string }[]
  deleteData: boolean
  stopped: boolean
}

export type InspectorTab = 'overview' | 'files' | 'peers' | 'trackers'

export type Density = 'compact' | 'comfortable'

export const SIDEBAR_MIN = 180, SIDEBAR_MAX = 420, SIDEBAR_DEFAULT = 224

/**
 * Bounds only. The viewport cap lives in the CSS clamp on --sidebar-w, so that a
 * narrow window never rewrites the stored preference: clamping here and writing the
 * result back would lose the user's number the first time an iPad rotates.
 */
export function clampSidebar(w: number): number {
  return Math.min(Math.max(Math.round(w), SIDEBAR_MIN), SIDEBAR_MAX)
}

/**
 * What the CSS clamp on --sidebar-w resolves the preference to, computed rather than
 * measured. Mirrors `clamp(180px, pref, min(420px, 40vw))` in app.css: measuring the
 * .sidebar box instead reads a width that is still settling right after a change,
 * and the two must not be able to disagree.
 */
export function displayedSidebarW(preference: number): number {
  const vw = document.documentElement.clientWidth || 0
  const cap = vw > 0 ? Math.min(SIDEBAR_MAX, 0.4 * vw) : SIDEBAR_MAX
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(preference, cap)))
}

function initialSidebarW(): number {
  const v = readLocal<number>('tm.sidebar-w', SIDEBAR_DEFAULT)
  return typeof v === 'number' && Number.isFinite(v) ? clampSidebar(v) : SIDEBAR_DEFAULT
}

/** Row density drives the column set, so it is store state and not only a CSS attribute. */
function initialDensity(): Density {
  return readLocal<string>('tm.density', 'compact') === 'comfortable' ? 'comfortable' : 'compact'
}

const params = new URLSearchParams(location.search)
let snap: Snapshot = {
  torrents: [], byId: new Map(), detail: null, session: null, stats: null, history: [], freeSpace: new Map(),
  connection: 'connecting', lastError: '',
  filter: params.get('filter') || 'all',
  adv: Object.fromEntries(['size', 'age', 'ratio', 'idle'].filter(k => params.get(k)).map(k => [k, params.get(k)!])),
  search: '',
  sort: (params.get('sort') as SortKey) || 'name', sortDir: 1,
  selected: new Set(), focusId: params.get('sel') ? Number(params.get('sel')) : null, inspectorTab: 'overview',
  dialog: { kind: 'none' },
  dismissed: new Set(readLocal<string[]>('tm.dismissed', [])),
  toast: '',
  removing: null,
  density: initialDensity(),
  sidebarW: initialSidebarW(),
}
const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }
export function set(patch: Partial<Snapshot> | ((s: Snapshot) => Partial<Snapshot>)) {
  const p = typeof patch === 'function' ? patch(snap) : patch
  snap = { ...snap, ...p }
  emit()
}
export function get() { return snap }
// Module-level, so its identity is stable: an inline subscribe makes React drop and
// re-add the listener on every render of every hook.
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
export function useStore<T>(sel: (s: Snapshot) => T): T {
  return useSyncExternalStore(subscribe, () => sel(snap))
}

function readLocal<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }
export function writeLocal(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }

// ─── URL sync (deep links like the mocks) ───
export function syncUrl() {
  const u = new URL(location.href)
  const q = u.searchParams
  for (const k of ['filter', 'size', 'age', 'ratio', 'idle', 'sort', 'sel']) q.delete(k)
  if (snap.filter !== 'all') q.set('filter', snap.filter)
  for (const [k, v] of Object.entries(snap.adv)) if (v && v !== 'any') q.set(k, v)
  if (snap.sort !== 'name') q.set('sort', snap.sort)
  if (snap.focusId) q.set('sel', String(snap.focusId))
  history.replaceState(null, '', u.pathname + (q.toString() ? '?' + q.toString() : ''))
}

// ─── polling ───
const LIST_MS = 2000, HIDDEN_MS = 5000, FULL_EVERY = 30, SESSION_EVERY = 15, SPACE_MS = 30000
let timer: ReturnType<typeof setTimeout> | null = null
let ticks = 0
// The next pass fetches everything: every torrent, the session, free space, and the whole
// inspector payload. A flag rather than a reset of `ticks`, so a refreshNow() that lands
// while a poll is in flight still gets its full pass from the follow-up.
let forceFull = true
let inFlight = false
let pollAgain = false

/** Nothing in the delta leaves `torrents` and `byId` alone, so nothing derived from them reruns. */
function mergeTorrents(list: TorrentSummary[], removed: number[] | undefined, full: boolean): Partial<Snapshot> {
  if (!full && !list.length && !removed?.length) return {}
  const byId = full ? new Map<number, TorrentSummary>() : new Map(snap.byId)
  for (const t of list) byId.set(t.id, t)
  for (const id of removed ?? []) byId.delete(id)
  return { torrents: [...byId.values()], byId }
}

// What each inspector tab shows that changes between polls. Everything else in
// EXTRA_FIELDS (file names, limits, metadata) only moves on a user action, and every
// action ends in refreshNow(), which refetches the lot.
const EXTRA_LIVE: Record<InspectorTab, (keyof TorrentExtra)[]> = {
  overview: ['pieces', 'availability', 'have_valid', 'have_unchecked', 'corrupt_ever', 'downloaded_ever', 'seconds_downloading', 'seconds_seeding', 'peers_from'],
  files: ['file_stats'],
  peers: ['peers'],
  trackers: ['peers_from'],
}

async function refreshDetail(full: boolean) {
  const id = snap.focusId
  if (id == null) return
  // A magnet still fetching its metadata has no file list yet; keep asking until it does.
  const all = full || snap.detail?.id !== id || (snap.byId.get(id)?.metadata_percent_complete ?? 1) < 1
  const d = await api.getTorrentFields(id, all ? EXTRA_FIELDS : ['id', ...EXTRA_LIVE[snap.inspectorTab]]).catch(() => undefined)
  // The user may have focused another torrent while this was in flight.
  if (!d || snap.focusId !== id) return
  if (all) set({ detail: d as TorrentExtra })
  else if (snap.detail?.id === id) set({ detail: { ...snap.detail, ...d } })
}

// Exactly one poll chain: a call while a poll is in flight only asks for one more pass
// right after it, instead of starting a second loop that would then re-arm forever.
async function pollOnce() {
  if (inFlight) { pollAgain = true; return }
  inFlight = true
  if (timer) { clearTimeout(timer); timer = null }
  const forced = forceFull
  forceFull = false
  const full = forced || ticks % FULL_EVERY === 0
  let unauthorized = false
  try {
    const [tr, st] = await Promise.all([
      api.getTorrents(full ? undefined : 'recently_active'), api.getStats(),
      refreshDetail(full), forced || ticks % SESSION_EVERY === 0 ? refreshSession() : null,
    ])
    const history = [...snap.history, { down: st.download_speed, up: st.upload_speed }].slice(-60)
    set({ ...mergeTorrents(tr.torrents, tr.removed, full), stats: st, history, connection: 'ok', lastError: '' })
    if (snap.focusId != null && !snap.byId.has(snap.focusId)) { set({ focusId: null, detail: null }); syncUrl() }
    if (forced || ticks % (SPACE_MS / LIST_MS) === 0) void refreshFreeSpace()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    unauthorized = msg === 'unauthorized'
    // A failed full pass is still owed.
    if (forced) forceFull = true
    set({ connection: unauthorized ? 'unauthorized' : 'error', lastError: msg })
  } finally {
    ticks++
    inFlight = false
    if (pollAgain) { pollAgain = false; void pollOnce() }
    // Signed out, every poll is another 401 until the user signs in again, and that is a
    // page load. Coming back to the tab still retries once.
    else if (!unauthorized) timer = setTimeout(pollOnce, document.hidden ? HIDDEN_MS : LIST_MS)
  }
}

export async function refreshSession() {
  try { set({ session: await api.getSession() }) } catch { /* handled by poll */ }
}

export async function refreshFreeSpace() {
  const dirs = new Set<string>(snap.torrents.map(t => t.download_dir))
  if (snap.session) dirs.add(snap.session.download_dir)
  // one query per top-level mount is enough: the daemon reports the filesystem, not the folder
  const roots = new Set([...dirs].map(d => mountOf(d, snap.session?.download_dir ?? '')))
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
  void pollOnce()
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollOnce() })
}

/** Run a full pass now (after any write): torrents, session, free space, inspector. */
export function refreshNow() {
  forceFull = true
  void pollOnce()
}

// ─── actions used across components ───
export function focus(id: number | null) {
  set({ focusId: id, detail: id === snap.detail?.id ? snap.detail : null })
  syncUrl()
  void refreshDetail(true)
}

/** The tab being opened may hold data from the last time it was open, so refresh it now. */
export function setInspectorTab(tab: InspectorTab) {
  set({ inspectorTab: tab })
  void refreshDetail(false)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string) {
  set({ toast: msg })
  // One timer for the one slot: a repeat of the same text must get its own full 3.5 s.
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => set({ toast: '' }), 3500)
}

export async function run(label: string, fn: () => Promise<unknown>) {
  try { await fn(); refreshNow() } catch (e) { toast(`${label} failed: ${e instanceof Error ? e.message : e}`) }
}

const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e)

/**
 * Remove torrents with visible progress.
 *
 * Deleting the data is the slow case: the daemon unlinks file by file on its session
 * thread and answers nothing meanwhile, so one RPC carrying ten ids is a single opaque
 * stall with the rows still sitting there. We therefore send one torrent-remove per
 * torrent and count the replies -- each one means that torrent's files are really gone.
 * This is the documented exception to "bulk actions = one RPC with an id array"; the
 * price is that the loop lives in the browser, so closing the tab mid-run leaves the
 * rest of the batch in place.
 *
 * Remove-from-list does not touch the disk and returns immediately, so it stays one call.
 */
/**
 * The ids the list is currently showing, in the order it shows them. List.tsx owns the
 * sorting and filtering, so it publishes the result here rather than the store trying to
 * recompute a view it does not own.
 */
let viewOrder: number[] = []
export function setViewOrder(ids: number[]) { viewOrder = ids }

/** Select everything the list shows; a second time, with all of it selected, clears. */
export function selectAllVisible() {
  const ids = viewOrder
  set(s => ({ selected: ids.length && ids.every(id => s.selected.has(id)) ? new Set() : new Set(ids) }))
}

let removalToken = 0

export async function removeSequence(ids: number[], deleteData: boolean) {
  if (!ids.length) return
  // A finished run hangs around so its failures stay readable, so "already removing" has
  // to mean actually in flight. Otherwise retrying the torrent that just failed would be
  // dropped on the floor without a word -- the silence this whole feature exists to kill.
  const prev = snap.removing
  if (prev && !prev.stopped && prev.done < prev.ids.length) {
    toast('A removal is already running')
    return
  }
  // Progress should walk down the screen, so the batch follows the order the rows are
  // displayed in. The caller passes that order (it holds the sorted, filtered list);
  // store order is the fallback, since `selected` is a Set and carries no order at all.
  const wanted = new Set(ids)
  const order = (viewOrder.length ? viewOrder : snap.torrents.map(t => t.id)).filter(id => wanted.has(id))
  const batch = order.length === ids.length ? order : [...new Set([...order, ...ids])]
  // The rows are on their way out: drop them from the selection so the sel-bar cannot
  // fire a second remove at torrents that are already going.
  const sel = new Set(snap.selected)
  for (const id of batch) sel.delete(id)
  // A stopped or dismissed run can still have a request in flight, and it lands after the
  // next run has started. Every update is therefore stamped with this run's token and
  // dropped if the store has moved on -- otherwise a late reply would be counted against
  // somebody else's tally, and this loop would read the new run's stopped:false and carry
  // on deleting past the Stop the user pressed.
  const token = ++removalToken
  const mine = () => { const r = get().removing; return r && r.token === token ? r : null }
  const patch = (f: (r: Removing) => Partial<Removing>) => { const r = mine(); if (r) set({ removing: { ...r, ...f(r) } }) }
  set({ selected: sel, removing: { token, ids: batch, done: 0, active: null, failed: [], deleteData, stopped: false } })

  if (!deleteData) {
    try {
      await api.remove(batch, false)
      patch(() => ({ done: batch.length, active: null }))
    } catch (e) {
      // One call, one failure: the batch never reached the daemon, so this is reported as
      // a plain toast rather than marking every row as individually failed. The run ends
      // here, without the success toast finishRemoval would otherwise write over it.
      patch(() => ({ done: batch.length, active: null }))
      if (mine()) set({ removing: null })
      refreshNow()
      toast(`Remove failed: ${errMsg(e)}`)
      return
    }
    return finishRemoval(token)
  }

  for (const id of batch) {
    const cur = mine()
    if (!cur || cur.stopped) break
    patch(() => ({ active: id }))
    try {
      await api.remove([id], true)
      // The 200 means the files are gone, so drop the row now instead of waiting for the
      // next poll. mergeTorrents() deleting the same id later is a harmless no-op.
      const byId = new Map(get().byId)
      byId.delete(id)
      set({ torrents: [...byId.values()], byId })
      // The inspector cannot be left showing a torrent whose files are gone: the poll that
      // would normally notice cannot run until the whole batch is done.
      if (get().focusId === id) { set({ focusId: null, detail: null }); syncUrl() }
      patch(r => ({ done: r.done + 1, active: null }))
    } catch (e) {
      patch(r => ({ done: r.done + 1, active: null, failed: [...r.failed, { id, msg: errMsg(e) }] }))
    }
  }
  return finishRemoval(token)
}

/**
 * A clean run clears itself; a run with failures does not. Those rows stay marked until
 * the user dismisses them, because a removal that silently did not happen is exactly the
 * thing this feature exists to make impossible.
 */
function finishRemoval(token: number) {
  refreshNow()
  const r = get().removing
  // Somebody else's run is on screen now: leave it alone.
  if (!r || r.token !== token) return
  if (r.failed.length) return
  const n = r.done
  set({ removing: null })
  if (n) toast(r.deleteData ? `Removed ${n === 1 ? '1 torrent' : `${n} torrents`} and data` : `Removed ${n === 1 ? '1 torrent' : `${n} torrents`}`)
}

/** Stop issuing further removes. The one in flight cannot be aborted: the daemon is mid-unlink. */
export function stopRemoval() {
  set(s => s.removing ? { removing: { ...s.removing, stopped: true } } : {})
}

/** Clear a finished run's summary and its failed-row markers. */
export function dismissRemoval() {
  set({ removing: null })
}

export function dismissNotice(key: string) {
  const d = new Set(snap.dismissed); d.add(key)
  writeLocal('tm.dismissed', [...d]); set({ dismissed: d })
}
