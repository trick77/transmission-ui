import { useCallback, useState } from 'react'
import { Icon } from '../icons/Icon'
import { bytes, duration, rateParts } from '../lib/format'
import { refreshSession, run, set, useStore } from '../state/store'
import * as api from '../rpc/methods'
import { useDismiss } from './ui'

function Sparkline({ history }: { history: { down: number; up: number }[] }) {
  const max = Math.max(1, ...history.map(h => Math.max(h.down, h.up)))
  const pts = (k: 'down' | 'up') => history.map((h, i) => `${(i / Math.max(1, history.length - 1)) * 96},${21 - (h[k] / max) * 19}`).join(' ')
  return (
    <svg className="spark" viewBox="0 0 96 22" preserveAspectRatio="none" aria-label="Speed, last 2 min">
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" points={pts('down')} />
      <polyline fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeLinejoin="round" points={pts('up')} />
    </svg>
  )
}

export function Header() {
  const stats = useStore(s => s.stats)
  const session = useStore(s => s.session)
  const history = useStore(s => s.history)
  const search = useStore(s => s.search)
  const [pop, setPop] = useState(false)
  const close = useCallback(() => setPop(false), [])
  const popRef = useDismiss(close, pop)

  const [dn, du] = rateParts(stats?.downloadSpeed ?? 0)
  const [un, uu] = rateParts(stats?.uploadSpeed ?? 0)
  const cur = stats?.['current-stats'], all = stats?.['cumulative-stats']
  const alt = session?.['alt-speed-enabled'] ?? false

  return (
    <header className="header">
      <div className="brand"><span className="logo"><Icon name="down" style={{ width: 14, height: 14, strokeWidth: 2.5 }} /></span>Transmission</div>
      <div className="search">
        <Icon name="search" />
        <input placeholder="Search torrents" value={search} onChange={e => set({ search: e.target.value })} />
        {search ? <button className="btn ghost icon" style={{ width: 22, height: 22 }} onClick={() => set({ search: '' })}><Icon name="x" size={12} /></button> : <kbd>⌘F</kbd>}
      </div>
      <div className="spacer" />
      <div className="speeds" title="Session totals · click for statistics" onClick={e => { if (!(e.target as HTMLElement).closest('#turtle, .pop')) setPop(p => !p) }}>
        <Sparkline history={history} />
        <span className="s dl"><span className="top"><Icon name="down" className="arrow" /><span className="num">{dn}</span><span className="faint" style={{ fontSize: 11 }}>{du}</span></span><span className="tot">{cur ? bytes(cur.downloadedBytes) : '—'} this session</span></span>
        <span className="s ul"><span className="top"><Icon name="up" className="arrow" /><span className="num">{un}</span><span className="faint" style={{ fontSize: 11 }}>{uu}</span></span><span className="tot">{cur ? bytes(cur.uploadedBytes) : '—'} this session</span></span>
        {alt && session ? <span className="lim">alt {session['alt-speed-down']}/{session['alt-speed-up']}</span> : null}
        <button id="turtle" className={'turtle' + (alt ? ' on' : '')} title={alt ? 'Alternative speed limits on' : 'Alternative speed limits off'}
          onClick={() => void run('Alt speed', () => api.setSession({ 'alt-speed-enabled': !alt }).then(refreshSession))}>
          <Icon name="turtle" />
        </button>
        {pop ? (
          <div ref={popRef} className="pop">
            <h4>Statistics</h4>
            <table>
              <thead><tr><th></th><th>This session</th><th>All time</th></tr></thead>
              <tbody>
                <tr><td>Downloaded</td><td className="num">{cur ? bytes(cur.downloadedBytes) : '—'}</td><td className="num">{all ? bytes(all.downloadedBytes) : '—'}</td></tr>
                <tr><td>Uploaded</td><td className="num">{cur ? bytes(cur.uploadedBytes) : '—'}</td><td className="num">{all ? bytes(all.uploadedBytes) : '—'}</td></tr>
                <tr><td>Ratio</td><td className="num">{cur && cur.downloadedBytes ? (cur.uploadedBytes / cur.downloadedBytes).toFixed(2) : '—'}</td><td className="num">{all && all.downloadedBytes ? (all.uploadedBytes / all.downloadedBytes).toFixed(2) : '—'}</td></tr>
                <tr><td>Files added</td><td className="num">{cur?.filesAdded ?? '—'}</td><td className="num">{all?.filesAdded ?? '—'}</td></tr>
                <tr><td>Running</td><td className="num">{cur ? duration(cur.secondsActive) : '—'}</td><td className="num">{all ? duration(all.secondsActive) : '—'}</td></tr>
                <tr><td>Sessions</td><td className="num">—</td><td className="num">{all?.sessionCount ?? '—'}</td></tr>
              </tbody>
            </table>
            <div className="foot">transmission-daemon {session?.version ?? '?'} · rpc {session?.['rpc-version'] ?? '?'} · port {session?.['peer-port'] ?? '?'}</div>
          </div>
        ) : null}
      </div>
      <button className="btn ghost icon" title="Preferences" onClick={() => set({ dialog: { kind: 'settings' } })}><Icon name="gear" /></button>
      <button className="btn primary" onClick={() => set({ dialog: { kind: 'add' } })}><Icon name="plus" />Add</button>
    </header>
  )
}
