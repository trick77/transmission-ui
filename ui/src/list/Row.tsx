import { memo } from 'react'
import { Icon } from '../icons/Icon'
import { ago, bytes, compact, date, eta, percent, rateParts, ratio, ratioOwed } from '../lib/format'
import { hostOf, relDir, statusView, swarmOf } from '../lib/model'
import { Status, type TorrentSummary } from '../rpc/types'
import * as api from '../rpc/methods'
import { run } from '../state/store'

function Speed({ bps, dir }: { bps: number; dir: 'dl' | 'ul' }) {
  if (bps <= 0) return <span className="spd zero num">—</span>
  const [n, u] = rateParts(bps)
  return <span className={'spd num ' + dir}><Icon name={dir === 'dl' ? 'down' : 'up'} className="arrow" />{n} {u}</span>
}

export const Row = memo(function Row({ t, selected, focused, base, compactRow, onMore }: { t: TorrentSummary; selected: boolean; focused: boolean; base: string; compactRow: boolean; onMore: (e: React.MouseEvent) => void }) {
  const s = statusView(t)
  const { seeds, leechers } = swarmOf(t)
  const swarm = seeds + leechers
  const peers = t.peers_connected === 0 ? (swarm ? `No peers · ${compact(swarm)} in swarm` : 'No peers')
    : `${t.peers_sending_to_us + t.peers_getting_from_us} of ${t.peers_connected} peers${swarm ? ` · ${compact(swarm)} in swarm` : ''}`
  const sub = t.error !== 0 ? <span style={{ color: 'var(--err)' }}>{t.error_string || 'Error'}</span>
    : t.status === Status.Check ? `Verifying local data · ${percent(t.recheck_progress)}`
    : peers
  const dir = relDir(t.download_dir, base)
  const stopped = t.status === Status.Stopped
  const acts = (
    <span className="acts">
      <button title={stopped ? 'Resume' : 'Pause'} onClick={e => { e.stopPropagation(); void run(stopped ? 'Resume' : 'Pause', () => stopped ? api.start([t.id]) : api.stop([t.id])) }}>
        <Icon name={stopped ? 'play' : 'pause'} size={13} />
      </button>
      <button className="more" title="More" onClick={e => { e.stopPropagation(); onMore(e) }}><Icon name="more" size={13} /></button>
    </span>
  )

  if (compactRow) {
    const host = t.tracker_stats.length ? hostOf(t.tracker_stats[0].announce) : ''
    // The second line is gone, so what it carried moves into tooltips: the status word and
    // the peer counts onto the dot. The labels stay on screen as chips.
    const why = t.error !== 0 ? (t.error_string || 'Error')
      : t.status === Status.Check ? `Verifying local data · ${percent(t.recheck_progress)}`
      : `${s.label} · ${peers}`
    const nameTitle = t.error !== 0 ? why : t.name
    return (
      <div className={'row one' + (selected ? ' sel' : '') + (focused ? ' focus' : '') + (t.error !== 0 ? ' is-err' : '')} data-id={t.id}>
        <span className="chk" role="checkbox" aria-checked={selected} />
        <div className="name">
          <span className={'sdot ' + s.kind} title={why} />
          <span className="t" title={nameTitle}>{t.name}</span>
          {t.labels.map(l => <span key={l} className="chip lbl">{l}</span>)}
          {acts}
        </div>
        <span className="num r muted">{bytes(t.size_when_done)}</span>
        <div className="prog">
          <div className={'bar ' + s.bar} style={{ ['--p' as string]: percent(t.percent_done, 1) }}><i /></div>
          <span className="num pv">{percent(t.percent_done)}</span>
        </div>
        <span className={'num r' + (seeds ? '' : ' faint')}>{seeds ? compact(seeds) : '—'}</span>
        {/* Below 1.0 is the interesting case — those still owe the swarm and need seeding —
            so they keep the full ink and the settled ones fade back. */}
        <span className={'num r' + (ratioOwed(t.upload_ratio) ? '' : ' muted')}>{ratio(t.upload_ratio)}</span>
        <span className="num r muted">{bytes(t.uploaded_ever, 1)}</span>
        {/* Relative like Last active; the exact date stays one hover away. */}
        <span className="num r muted" title={date(t.added_date)}>{ago(t.added_date)}</span>
        <span className="num r muted">{ago(t.activity_date)}</span>
        <span className={'tcell' + (host ? '' : ' faint')} title={host}>{host || '—'}</span>
        <span className={'tcell' + (dir ? '' : ' faint')} title={dir}>{dir ? dir + '/' : '—'}</span>
      </div>
    )
  }

  return (
    <div className={'row' + (selected ? ' sel' : '') + (focused ? ' focus' : '')} data-id={t.id}>
      <span className="chk" role="checkbox" aria-checked={selected} />
      <div className="name">
        <div className="t">
          <span>{t.name}</span>
          {t.labels.map(l => <span key={l} className="chip lbl">{l}</span>)}
          {acts}
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
      <span className={'num r' + (ratioOwed(t.upload_ratio) ? '' : ' muted')}>{ratio(t.upload_ratio)}</span>
      <span className="num r muted">{eta(t.eta, t.status === Status.Seed || t.status === Status.SeedWait)}</span>
    </div>
  )
})
