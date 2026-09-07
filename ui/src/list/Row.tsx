import { memo } from 'react'
import { Icon } from '../icons/Icon'
import { bytes, compact, eta, percent, rateParts, ratio, ratioValue } from '../lib/format'
import { relDir, statusView, swarmOf } from '../lib/model'
import { Status, type TorrentSummary } from '../rpc/types'
import * as api from '../rpc/methods'
import { run } from '../state/store'

function Speed({ bps, dir }: { bps: number; dir: 'dl' | 'ul' }) {
  if (bps <= 0) return <span className="spd zero num">—</span>
  const [n, u] = rateParts(bps)
  return <span className={'spd num ' + dir}><Icon name={dir === 'dl' ? 'down' : 'up'} className="arrow" />{n} {u}</span>
}

export const Row = memo(function Row({ t, selected, focused, base, onMore }: { t: TorrentSummary; selected: boolean; focused: boolean; base: string; onMore: (e: React.MouseEvent) => void }) {
  const s = statusView(t)
  const { seeds, leechers } = swarmOf(t)
  const swarm = seeds + leechers
  const sub = t.error !== 0 ? <span style={{ color: 'var(--err)' }}>{t.error_string || 'Error'}</span>
    : t.status === Status.Check ? `Verifying local data · ${percent(t.recheck_progress)}`
    : t.peers_connected === 0 ? (swarm ? `No peers · ${compact(swarm)} in swarm` : 'No peers')
    : `${t.peers_sending_to_us + t.peers_getting_from_us} of ${t.peers_connected} peers${swarm ? ` · ${compact(swarm)} in swarm` : ''}`
  const dir = relDir(t.download_dir, base)
  const stopped = t.status === Status.Stopped
  return (
    <div className={'row' + (selected ? ' sel' : '') + (focused ? ' focus' : '')} data-id={t.id}>
      <span className="chk" role="checkbox" aria-checked={selected} />
      <div className="name">
        <div className="t">
          <span>{t.name}</span>
          {t.labels.map(l => <span key={l} className="chip lbl">{l}</span>)}
          <span className="acts">
            <button title={stopped ? 'Resume' : 'Pause'} onClick={e => { e.stopPropagation(); void run(stopped ? 'Resume' : 'Pause', () => stopped ? api.start([t.id]) : api.stop([t.id])) }}>
              <Icon name={stopped ? 'play' : 'pause'} size={13} />
            </button>
            <button className="more" title="More" onClick={e => { e.stopPropagation(); onMore(e) }}><Icon name="more" size={13} /></button>
          </span>
        </div>
        <div className="m">
          <span className={'chip ' + s.kind}><span className="dot" />{s.label}</span>
          <span className="sep" /><span>{sub}</span>
          {dir ? <><span className="sep" /><span>{dir}/</span></> : null}
        </div>
      </div>
      <span className="num r muted">{bytes(t.size_when_done)}</span>
      <div className="prog">
        <div className={'bar ' + s.bar} style={{ ['--p' as string]: percent(t.percent_done, 1) }}><i /></div>
        <span className="num"><span>{percent(t.percent_done)}</span>{seeds ? <span className="av" title="Seeds in swarm">{compact(seeds)} seeds</span> : null}</span>
      </div>
      <Speed bps={t.rate_download} dir="dl" />
      <Speed bps={t.rate_upload} dir="ul" />
      <span className={'num r' + (ratioValue(t.upload_ratio) >= 1 ? '' : ' muted')}>{ratio(t.upload_ratio)}</span>
      <span className="num r muted">{eta(t.eta, t.status === Status.Seed || t.status === Status.SeedWait)}</span>
    </div>
  )
})
