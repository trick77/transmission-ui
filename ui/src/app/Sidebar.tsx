import { Icon } from '../icons/Icon'
import { bytes, duration } from '../lib/format'
import { FILTERS, FILTER_ORDER, folderTree, labelCounts, trackerHealth, relDir } from '../lib/model'
import { set, syncUrl, useStore } from '../state/store'

function pick(filter: string) { set({ filter, selected: new Set() }); syncUrl() }

export function Sidebar() {
  const torrents = useStore(s => s.torrents)
  const filter = useStore(s => s.filter)
  const session = useStore(s => s.session)
  const freeSpace = useStore(s => s.freeSpace)
  const base = session?.['download-dir'] ?? ''
  const folders = folderTree(torrents, base)
  const labels = labelCounts(torrents)
  const trackers = trackerHealth(torrents)
  const disks = [...freeSpace.values()]

  return (
    <nav className="sidebar">
      <div className="side-h">Status</div>
      {FILTER_ORDER.map(k => {
        const n = torrents.filter(FILTERS[k].f).length
        if (k === 'trackererr' && n === 0) return null
        return (
          <button key={k} className={'side-item' + (filter === k ? ' on' : '')} onClick={() => pick(k)} data-f={k}>
            <span className="lbl">{FILTERS[k].label}</span><span className="cnt">{n}</span>
          </button>
        )
      })}

      {labels.length ? <>
        <div className="side-h">Labels</div>
        {labels.map(l => (
          <button key={l.label} className={'side-item' + (filter === 'label:' + l.label ? ' on' : '')} onClick={() => pick('label:' + l.label)}>
            <Icon name="tag" size={14} /><span className="lbl">{l.label}</span><span className="cnt">{l.count}</span>
          </button>
        ))}
      </> : null}

      {folders.length ? <>
        <div className="side-h">Folders</div>
        {folders.map(f => (
          <button key={f.path} className={'side-item' + (filter === 'dir:' + f.path ? ' on' : '')} style={{ paddingLeft: 8 + f.depth * 14 }} onClick={() => pick('dir:' + f.path)} title={f.path}>
            <Icon name="folder" size={14} /><span className="lbl">{f.name}</span><span className="cnt">{f.count}</span>
          </button>
        ))}
      </> : null}

      {disks.length ? <>
        <div className="side-h">Disk</div>
        {disks.map(d => {
          const total = d.total_size ?? 0
          const used = total ? 1 - d['size-bytes'] / total : 0
          return (
            <div key={d.path} className="disk" title={d.path}>
              <div className="p"><span>{relDir(d.path, base) || d.path.split('/').filter(Boolean).pop() || d.path}</span><b>{bytes(d['size-bytes'])} free</b></div>
              <div className={'bar' + (total && d['size-bytes'] / total < 0.1 ? ' hot' : '')} style={{ ['--p' as string]: `${Math.round(used * 100)}%` }}><i /></div>
            </div>
          )
        })}
      </> : null}

      {trackers.length ? <>
        <div className="side-h">Trackers</div>
        {trackers.map(t => {
          const bad = t.state === 'down' || t.state === 'rejected'
          const sub = t.state === 'down' ? `down · ${duration(Date.now() / 1000 - t.since)} · ${t.result}`
            : t.state === 'rejected' ? `client rejected · ${t.result}`
            : t.state === 'issues' ? `${t.failing} of ${t.count} failing${t.result ? ' · ' + t.result : ''}` : ''
          return (
            <button key={t.host} className={'side-item' + (sub ? ' two' : '') + (filter === 'tracker:' + t.host ? ' on' : '')} onClick={() => pick('tracker:' + t.host)} title={t.host}>
              <Icon name="globe" size={14} style={sub ? { marginTop: 2 } : undefined} />
              {sub ? <span className="col"><span className="lbl">{t.host}</span><span className={'sub' + (bad ? ' down' : '')}>{sub}</span></span> : <span className="lbl">{t.host}</span>}
              {t.state !== 'ok' ? <span className={'st ' + (bad ? 'down' : 'issues')} style={sub ? { marginTop: 5 } : undefined} /> : null}
              <span className="cnt">{t.count}</span>
            </button>
          )
        })}
      </> : null}
    </nav>
  )
}
