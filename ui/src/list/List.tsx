import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../icons/Icon'
import { bytes, duration } from '../lib/format'
import { ADV_KEYS, ADV_LABEL, ADV_OPTIONS, advActive, advFn, filterFn, sortFn, trackerHealth, hostOf, type SortKey } from '../lib/model'
import { dismissNotice, focus, run, set, syncUrl, useStore } from '../state/store'
import * as api from '../rpc/methods'
import { Menu, Seg, useDismiss } from '../app/ui'
import { Row } from './Row'
import { torrentMenu, viewMenu } from './actions'

const COLS: { key: SortKey; label: string; cls?: string }[] = [
  { key: 'name', label: 'Name' }, { key: 'size', label: 'Size', cls: 'r' }, { key: 'progress', label: 'Progress' },
  { key: 'down', label: 'Down', cls: 'r' }, { key: 'up', label: 'Up', cls: 'r' }, { key: 'ratio', label: 'Ratio', cls: 'r' }, { key: 'eta', label: 'ETA', cls: 'r' },
]

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
  const connection = useStore(s => s.connection)
  const base = session?.['download-dir'] ?? ''

  const F = useMemo(() => filterFn(filter, base), [filter, base])
  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    return torrents.filter(F.f).filter(advFn(adv)).filter(t => !q || t.name.toLowerCase().includes(q)).sort(sortFn(sort, sortDir))
  }, [torrents, F, adv, search, sort, sortDir])
  const ids = useMemo(() => list.map(t => t.id), [list])
  const total = list.reduce((a, t) => a + t.sizeWhenDone, 0)
  const on = advActive(adv)

  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'row' | 'view' | 'sel'; ids: number[] } | null>(null)
  const [fpop, setFpop] = useState(false)
  const closeF = useCallback(() => setFpop(false), [])
  const fref = useDismiss(closeF, fpop)

  const selectAll = useCallback(() => {
    set(s => ({ selected: ids.every(id => s.selected.has(id)) && ids.length ? new Set() : new Set(ids) }))
  }, [ids])
  useEffect(() => { document.addEventListener('tm:select-all', selectAll); return () => document.removeEventListener('tm:select-all', selectAll) }, [selectAll])

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
  const affected = (host: string) => torrents.filter(t => t.trackerStats.some(ts => hostOf(ts.announce) === host)).map(t => t.id)

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
        {selIds.length ? (
          <div className="sel-bar" id="selbar">
            <span className="v">{selIds.length} selected</span>
            <button className="btn sm ghost" onClick={() => void run('Resume', () => api.start(selIds))}><Icon name="play" />Resume</button>
            <button className="btn sm ghost" onClick={() => void run('Pause', () => api.stop(selIds))}><Icon name="pause" />Pause</button>
            <button className="btn sm ghost" onClick={() => set({ dialog: { kind: 'labels', ids: selIds } })}><Icon name="tag" />Labels</button>
            <button className="btn sm ghost" onClick={() => set({ dialog: { kind: 'location', ids: selIds } })}><Icon name="folder" />Move</button>
            <button className="btn sm ghost danger" onClick={() => set({ dialog: { kind: 'confirm-remove', ids: selIds, deleteData: false } })}><Icon name="trash" />Remove</button>
            <button className="btn sm ghost icon" title="More" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom + 6, kind: 'sel', ids: selIds }) }}><Icon name="more" /></button>
            <button className="x" title="Clear selection" onClick={() => set({ selected: new Set() })}><Icon name="x" size={13} /></button>
          </div>
        ) : null}
        <button className="btn ghost sm" id="fbtn" onClick={() => setFpop(p => !p)}>
          <Icon name="search" size={14} />Filter{on.length ? <span className="badge">{on.length}</span> : null}
        </button>
        <button className="btn ghost sm" title="Sort" onClick={() => { set({ sort: 'state', sortDir: 1 }); syncUrl() }}>
          <Icon name="sort" size={14} />{sort === 'state' ? 'State' : COLS.find(c => c.key === sort)?.label ?? sort}
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
            <b>{h.host}</b> {h.state === 'rejected' ? <>rejects this client ({h.result}) · {h.count} torrents affected</> : <>has been unreachable for {duration(Date.now() / 1000 - h.since)} · {h.count} torrents affected{session?.['dht-enabled'] ? ', DHT and PEX still finding peers' : ''}</>}
          </span>
          <button className="btn sm ghost" onClick={() => void run('Re-announce', () => api.reannounce(affected(h.host)))}>Re-announce all</button>
          <button className="btn sm ghost icon" title="Dismiss" onClick={() => dismissNotice(`${h.host}@${Math.floor(h.since)}`)}><Icon name="x" size={14} /></button>
        </div>
      ))}

      <div className="cols">
        <span className={'chk' + (allSel ? ' on' : someSel ? ' some' : '')} id="selall" title="Select all" onClick={selectAll} />
        {COLS.map(c => (
          <span key={c.key} className={(c.cls ?? '') + (sort === c.key ? ' sort' : '')} style={{ cursor: 'pointer' }}
            onClick={() => { set(s => ({ sort: c.key, sortDir: s.sort === c.key ? (s.sortDir === 1 ? -1 : 1) : (c.key === 'name' ? 1 : -1) })); syncUrl() }}>
            {c.label}{sort === c.key ? <Icon name={sortDir === -1 ? 'chevd' : 'up'} size={12} /> : null}
          </span>
        ))}
      </div>

      <div className="rows" id="rows" onClick={onRowClick} onContextMenu={onContext}>
        {list.length ? list.map(t => (
          <Row key={t.id} t={t} base={base} selected={selected.has(t.id)} focused={focusId === t.id}
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
