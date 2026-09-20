import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { bytes, duration } from '../lib/format'
import { ADV_KEYS, ADV_LABEL, ADV_OPTIONS, advActive, advFn, filterFn, sortFn, trackerHealth, hostOf, type SortKey } from '../lib/model'
import { dismissNotice, dismissRemoval, focus, run, set, setViewOrder, stopRemoval, syncUrl, useStore, type Removing } from '../state/store'
import * as api from '../rpc/methods'
import { Menu, Seg, useDismiss } from '../app/ui'
import { Row, type RowRemoval } from './Row'
import { torrentMenu, viewMenu } from './actions'

/** Reserve on the header whatever the scrolling rows pane loses to its scrollbar:
 *  10px with classic scrollbars, 0 with overlay ones, so it cannot be hardcoded. */
export function publishScrollbarWidth(pane: { offsetWidth: number; clientWidth: number }) {
  const w = pane.offsetWidth - pane.clientWidth
  document.documentElement.style.setProperty('--sbw', `${w}px`)
  return w
}

const COLS: { key: SortKey; label: string; cls?: string }[] = [
  { key: 'name', label: 'Name' }, { key: 'size', label: 'Size', cls: 'r hl' }, { key: 'progress', label: 'Progress' },
  { key: 'down', label: 'Down', cls: 'r' }, { key: 'up', label: 'Up', cls: 'r' }, { key: 'ratio', label: 'Ratio', cls: 'r' }, { key: 'eta', label: 'ETA', cls: 'r' },
]

// One line per torrent: the second line carried the status text and the path, so the row
// gets those as columns of their own. Down, Up and ETA make way.
const COLS_ONE: { key: SortKey; label: string; cls?: string }[] = [
  { key: 'name', label: 'Name' }, { key: 'size', label: 'Size', cls: 'r hl' }, { key: 'progress', label: 'Progress' },
  { key: 'seeds', label: 'Seeds', cls: 'r' }, { key: 'ratio', label: 'Ratio', cls: 'r' }, { key: 'uploaded', label: 'Uploaded', cls: 'r' },
  { key: 'added', label: 'Added on', cls: 'r' }, { key: 'activity', label: 'Last active', cls: 'r' },
  { key: 'tracker', label: 'Tracker' }, { key: 'path', label: 'Path' },
]

// Text columns read A→Z on the first click; numbers and dates lead with the largest.
const TEXT_COLS: SortKey[] = ['name', 'tracker', 'path']

export function List() {
  const torrents = useStore(s => s.torrents)
  const filter = useStore(s => s.filter)
  const adv = useStore(s => s.adv)
  const search = useStore(s => s.search)
  const sort = useStore(s => s.sort)
  const sortDir = useStore(s => s.sortDir)
  const selected = useStore(s => s.selected)
  const focusId = useStore(s => s.focusId)
  const session = useStore(s => s.session)
  const dismissed = useStore(s => s.dismissed)
  const removing = useStore(s => s.removing)
  const connection = useStore(s => s.connection)
  const density = useStore(s => s.density)
  const one = density === 'compact'
  const cols = one ? COLS_ONE : COLS
  const base = session?.download_dir ?? ''

  const F = useMemo(() => filterFn(filter, base), [filter, base])
  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    return torrents.filter(F.f).filter(advFn(adv)).filter(t => !q || t.name.toLowerCase().includes(q)).sort(sortFn(sort, sortDir, base))
  }, [torrents, F, adv, search, sort, sortDir, base])
  const ids = useMemo(() => list.map(t => t.id), [list])
  // A removal walks the batch in the order the rows are on screen, and the store cannot
  // work that out: the sorting and filtering live here.
  useEffect(() => { setViewOrder(ids) }, [ids])
  const total = list.reduce((a, t) => a + t.size_when_done, 0)
  const on = advActive(adv)

  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'row' | 'view' | 'sel'; ids: number[] } | null>(null)
  const [fpop, setFpop] = useState(false)
  const closeF = useCallback(() => setFpop(false), [])
  const fref = useDismiss(closeF, fpop)

  const selectAll = useCallback(() => {
    set(s => ({ selected: ids.every(id => s.selected.has(id)) && ids.length ? new Set() : new Set(ids) }))
  }, [ids])
  useEffect(() => { document.addEventListener('tm:select-all', selectAll); return () => document.removeEventListener('tm:select-all', selectAll) }, [selectAll])

  // The header is not a scroll container, so scrollbar-gutter cannot align it
  // with the rows. Publish the pane's real scrollbar width instead. The observer
  // watches the content box, which shrinks the moment a scrollbar appears, so
  // gaining or losing one re-fires it. Layout effect, or the header paints one
  // frame at the old width.
  const rowsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = rowsRef.current
    if (!el) return
    const sync = () => publishScrollbarWidth(el)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onRowClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.row')
    if (!el || (e.target as HTMLElement).closest('.acts')) return
    const id = Number(el.dataset.id)
    if ((e.target as HTMLElement).closest('.chk') || e.metaKey || e.ctrlKey) {
      set(s => { const n = new Set(s.selected); n.has(id) ? n.delete(id) : n.add(id); return { selected: n } })
    } else if (e.shiftKey && (focusId != null || selected.size)) {
      const anchor = focusId ?? [...selected][0]
      const a = ids.indexOf(anchor), b = ids.indexOf(id)
      set(s => ({ selected: new Set([...s.selected, ...ids.slice(Math.min(a, b), Math.max(a, b) + 1)]) }))
    } else {
      focus(focusId === id ? null : id)
    }
  }
  const onContext = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.row')
    if (!el) return
    e.preventDefault()
    const id = Number(el.dataset.id)
    const target = selected.has(id) ? [...selected] : [id]
    setMenu({ x: e.clientX, y: e.clientY, kind: 'row', ids: target })
  }

  // tracker-down notices
  const health = useMemo(() => trackerHealth(torrents).filter(h => (h.state === 'down' || h.state === 'rejected') && !dismissed.has(`${h.host}@${Math.floor(h.since)}`)), [torrents, dismissed])
  const affected = (host: string) => torrents.filter(t => t.tracker_stats.some(ts => hostOf(ts.announce) === host)).map(t => t.id)

  const allSel = ids.length > 0 && ids.every(id => selected.has(id))
  const someSel = !allSel && ids.some(id => selected.has(id))
  const selIds = [...selected].filter(id => ids.includes(id))

  return (
    <section className="list">
      <div className="toolbar">
        <span className="title" id="ftitle">{F.label}</span>
        <span className="count">{list.length === torrents.length ? torrents.length : `${list.length} of ${torrents.length}`} · {bytes(total)}</span>
        {on.length ? (
          <span style={{ display: 'flex', gap: 6, marginLeft: 6 }}>
            {on.map(k => (
              <span key={k} className="fchip"><b>{ADV_LABEL[k][adv[k]!]}</b>
                <button title="Remove" onClick={() => { set(s => { const a = { ...s.adv }; delete a[k]; return { adv: a } }); syncUrl() }}><Icon name="x" size={11} /></button>
              </span>
            ))}
          </span>
        ) : null}
        <div className="spacer" />
        {removing ? <RemoveBar /> : null}
        {selIds.length && !removing ? (
          <div className="sel-bar" id="selbar">
            <span className="v">{selIds.length} selected</span>
            <button className="btn sm ghost" onClick={() => void run('Resume', () => api.start(selIds))}><Icon name="play" />Resume</button>
            <button className="btn sm ghost" onClick={() => void run('Pause', () => api.stop(selIds))}><Icon name="pause" />Pause</button>
            <button className="btn sm ghost" onClick={() => set({ dialog: { kind: 'labels', ids: selIds } })}><Icon name="tag" />Labels</button>
            <button className="btn sm ghost" onClick={() => set({ dialog: { kind: 'location', ids: selIds } })}><Icon name="folder" />Move</button>
            <button className="btn sm ghost danger" onClick={() => set({ dialog: { kind: 'confirm-remove', ids: selIds, deleteData: true } })}><Icon name="trash" />Remove</button>
            <button className="btn sm ghost icon" title="More" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom + 6, kind: 'sel', ids: selIds }) }}><Icon name="more" /></button>
            <button className="x" title="Clear selection" onClick={() => set({ selected: new Set() })}><Icon name="x" size={13} /></button>
          </div>
        ) : null}
        <button className="btn ghost sm" id="fbtn" onClick={() => setFpop(p => !p)}>
          <Icon name="search" size={14} />Filter{on.length ? <span className="badge">{on.length}</span> : null}
        </button>
        <button className="btn ghost sm" title="Sort" onClick={() => { set({ sort: 'name', sortDir: 1 }); syncUrl() }}>
          <Icon name="sort" size={14} />{sort === 'state' ? 'State' : [...COLS, ...COLS_ONE].find(c => c.key === sort)?.label ?? sort}
        </button>
        <button className="btn ghost icon" id="tmenu" title="More" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom + 6, kind: 'view', ids }) }}><Icon name="more" /></button>
        {fpop ? (
          <div ref={fref} className="fpop">
            <h4>Filter</h4>
            {ADV_KEYS.map(k => (
              <div key={k} className="frow"><span>{{ size: 'Size', age: 'Added', ratio: 'Ratio', idle: 'Activity' }[k]}</span>
                <Seg value={adv[k] ?? 'any'} options={ADV_OPTIONS[k]} onChange={v => { set(s => ({ adv: { ...s.adv, [k]: v } })); syncUrl() }} />
              </div>
            ))}
            <div className="foot"><span className="hint">Combines with the sidebar filter</span>
              <button className="btn sm ghost" onClick={() => { set({ adv: {} }); syncUrl() }}>Clear</button>
              <button className="btn sm" onClick={closeF}>Done</button>
            </div>
          </div>
        ) : null}
      </div>

      {health.map(h => (
        <div key={h.host} className="notice">
          <span className="st" />
          <span>
            <b>{h.host}</b> {h.state === 'rejected' ? <>rejects this client ({h.result}) · {h.count} torrents affected</> : <>has been unreachable for {duration(Date.now() / 1000 - h.since)} · {h.count} torrents affected{session?.dht_enabled ? ', DHT and PEX still finding peers' : ''}</>}
          </span>
          <button className="btn sm ghost" onClick={() => void run('Re-announce', () => api.reannounce(affected(h.host)))}>Re-announce all</button>
          <button className="btn sm ghost icon" title="Dismiss" onClick={() => dismissNotice(`${h.host}@${Math.floor(h.since)}`)}><Icon name="x" size={14} /></button>
        </div>
      ))}

      <div className={'cols' + (one ? ' one' : '')}>
        <span className={'chk' + (allSel ? ' on' : someSel ? ' some' : '')} id="selall" title="Select all" onClick={selectAll} />
        {cols.map(c => (
          <span key={c.key} className={(c.cls ?? '') + (sort === c.key ? ' sort' : '')} style={{ cursor: 'pointer' }}
            onClick={() => { set(s => ({ sort: c.key, sortDir: s.sort === c.key ? (s.sortDir === 1 ? -1 : 1) : (TEXT_COLS.includes(c.key) ? 1 : -1) })); syncUrl() }}>
            {c.label}{sort === c.key ? <Icon name={sortDir === -1 ? 'chevd' : 'up'} size={12} /> : null}
          </span>
        ))}
      </div>

      <div className="rows" id="rows" ref={rowsRef} onClick={onRowClick} onContextMenu={onContext}>
        {list.length ? list.map(t => (
          <Row key={t.id} t={t} base={base} compactRow={one} selected={selected.has(t.id)} focused={focusId === t.id}
            removal={removalOf(removing, t.id)}
            onMore={e => { const target = selected.has(t.id) ? [...selected] : [t.id]; setMenu({ x: e.clientX, y: e.clientY, kind: 'row', ids: target }) }} />
        )) : (
          <div className="empty">
            <div className="t">{connection === 'connecting' ? 'Connecting…' : torrents.length ? 'Nothing matches' : 'No torrents yet'}</div>
            {on.length ? <>Try loosening a filter · <a href="#" style={{ color: 'var(--accent)' }} onClick={e => { e.preventDefault(); set({ adv: {} }); syncUrl() }}>clear all</a></>
              : torrents.length ? 'No torrents in this view' : connection === 'ok' ? 'Drop a .torrent file anywhere or press Add' : ''}
          </div>
        )}
      </div>

      {menu ? (
        <Menu x={menu.x} y={menu.y} alignRight={menu.kind !== 'row'} onClose={() => setMenu(null)}
          items={menu.kind === 'view' ? viewMenu(menu.ids, selectAll) : torrentMenu(menu.ids)} />
      ) : null}
    </section>
  )
}

/**
 * Bulk removal progress, in the sel-bar's slot.
 *
 * Neutral, not accent: this reports what the daemon is doing, it is not a control. Red
 * appears only once a torrent has actually failed to go. While a single torrent is being
 * unlinked the daemon answers nothing at all, so every other number on screen is frozen --
 * the step counter moving between torrents is the honest liveness cue, and the reason the
 * bar is stepped rather than animated.
 */
function RemoveBar() {
  const r = useStore(s => s.removing)
  const byId = useStore(s => s.byId)
  if (!r) return null
  const total = r.ids.length
  // Stop cannot abort the torrent already being unlinked, so a stopped run is only
  // finished once that one comes back. Otherwise the bar would claim "Removed 1 torrent"
  // while still naming the torrent it is deleting.
  const finished = (r.done >= total || r.stopped) && r.active == null
  const ok = r.done - r.failed.length
  const pct = total ? Math.round(r.done / total * 100) : 0
  const label = finished
    ? r.failed.length ? `Removed ${ok} of ${total}, ${r.failed.length} failed` : `Removed ${ok === 1 ? '1 torrent' : `${ok} torrents`}`
    : `${r.deleteData ? 'Deleting' : 'Removing'} ${Math.min(r.done + 1, total)} of ${total}`
  const who = r.active != null ? byId.get(r.active)?.name ?? '' : ''
  return (
    <div className={'rm-bar' + (finished ? ' done' : '') + (r.failed.length ? ' has-fail' : '')} id="rmbar" role="status" aria-live="polite">
      <span className="v">{label}</span>
      {who ? <span className="who" title={who}>{who}</span> : null}
      <span className="track"><i style={{ ['--p' as string]: `${pct}%` }} /></span>
      {finished
        ? r.failed.length ? <button className="btn sm ghost" onClick={dismissRemoval}>Dismiss</button> : null
        : <button className="btn sm ghost" onClick={stopRemoval} disabled={r.stopped}>Stop</button>}
    </div>
  )
}

/**
 * What a row should say about its own removal, or null when it is not in the batch.
 * The three states are the whole point: queued, being deleted right now, and failed --
 * a torrent that did not go stays on screen with the reason.
 */
export function removalOf(r: Removing | null, id: number): RowRemoval {
  if (!r) return null
  const failed = r.failed.find(f => f.id === id)
  if (failed) return { kind: 'failed', text: `Failed: ${failed.msg}` }
  if (!r.ids.includes(id)) return null
  if (r.active === id) return { kind: 'active', text: r.deleteData ? 'Deleting files…' : 'Removing…' }
  // A stopped run leaves the not-yet-attempted rows alone: they are still there and still live.
  if (r.stopped) return null
  return { kind: 'queued', text: 'Queued for removal' }
}
