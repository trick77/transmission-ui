import { useMemo } from 'react'
import { Icon } from '../icons/Icon'
import { ago, bytes, dateTime, duration, inFuture, percent, rateParts, ratio, KB } from '../lib/format'
import { classifyAnnounce, hostOf, statusView, swarmOf, relDir } from '../lib/model'
import type { TorrentDetail } from '../rpc/types'
import * as api from '../rpc/methods'
import { focus, run, set, useStore } from '../state/store'
import { NumInput, Seg, Toggle, Opt, Sec } from '../app/ui'

export function Inspector() {
  const detail = useStore(s => s.detail)
  const summary = useStore(s => s.focusId != null ? s.byId.get(s.focusId) : undefined)
  const tab = useStore(s => s.inspectorTab)
  const base = useStore(s => s.session?.download_dir ?? '')
  const t = detail ?? summary
  if (!t) return null
  const sv = statusView(t)
  const d = detail && detail.id === t.id ? detail : null
  return (
    <aside className="inspector">
      <div className="insp-head">
        <div className="t">{t.name}</div>
        <div className="m">
          <span className={'chip ' + sv.kind}><span className="dot" />{sv.label}</span>
          {t.labels.map(l => <span key={l} className="chip lbl">{l}</span>)}
          <span>·</span><span>Priority <b className="muted">{['Low', 'Normal', 'High'][t.bandwidth_priority + 1]}</b></span>
          <button className="btn ghost icon" style={{ marginLeft: 'auto', width: 26, height: 26 }} title="Close" onClick={() => focus(null)}><Icon name="x" size={14} /></button>
        </div>
      </div>
      <div className="tabs" id="tabs">
        {(['overview', 'files', 'peers', 'trackers'] as const).map(k => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => set({ inspectorTab: k })}>
            {k[0].toUpperCase() + k.slice(1)} {k !== 'overview' && d ? <span className="faint">{k === 'files' ? d.files.length : k === 'peers' ? d.peers.length : d.tracker_stats.length}</span> : null}
          </button>
        ))}
      </div>
      {!d ? <div className="insp-body"><div className="hint">Loading…</div></div>
        : tab === 'overview' ? <Overview d={d} base={base} />
        : tab === 'files' ? <Files d={d} />
        : tab === 'peers' ? <Peers d={d} />
        : <Trackers d={d} />}
    </aside>
  )
}

function Pieces({ d }: { d: TorrentDetail }) {
  const cells = useMemo(() => {
    const n = d.piece_count || 0
    if (!n || !d.pieces) return []
    const bin = atob(d.pieces)
    const have = (i: number) => ((bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1) === 1
    const buckets = Math.min(192, n)
    const out: ('d' | 'p' | '')[] = []
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor((b * n) / buckets), to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets))
      let got = 0
      for (let i = from; i < to; i++) if (have(i)) got++
      out.push(got === to - from ? 'd' : got > 0 ? 'p' : '')
    }
    return out
  }, [d.pieces, d.piece_count])
  return <div className="pieces" aria-label="Pieces">{cells.map((c, i) => <i key={i} className={c} />)}</div>
}

function Overview({ d, base }: { d: TorrentDetail; base: string }) {
  const [dn, du] = rateParts(d.rate_download), [un, uu] = rateParts(d.rate_upload)
  const avail = d.availability?.length ? d.availability : []
  const availPct = avail.length ? avail.filter(a => a !== 0).length / avail.length : d.percent_done
  const copies = avail.length ? avail.reduce((a, v) => a + (v < 0 ? 1 : v), 0) / avail.length : 0
  const sw = swarmOf(d)
  const next = d.tracker_stats.filter(ts => ts.next_announce_time > 0).sort((a, b) => a.next_announce_time - b.next_announce_time)[0]
  const pf = d.peers_from
  const setT = (label: string, args: api.TorrentSetArgs) => void run(label, () => api.setTorrent([d.id], args))
  return (
    <div className="insp-body">
      <div className="stat-row">
        <div className="stat"><div className="l">Download</div><div className="v" style={{ color: 'var(--accent)' }}>{d.rate_download > 0 ? <>{dn} <small>{du}</small></> : '—'}</div></div>
        <div className="stat"><div className="l">Upload</div><div className="v">{d.rate_upload > 0 ? <>{un} <small>{uu}</small></> : '—'}</div></div>
        <div className="stat"><div className="l">ETA</div><div className="v">{d.percent_done >= 1 ? '∞' : d.eta < 0 ? '—' : duration(d.eta)}</div></div>
      </div>
      <Sec>Progress · {percent(d.percent_done, 1)}</Sec>
      <div className="bar" style={{ ['--p' as string]: percent(d.percent_done, 1), height: 7 }}><i /></div>
      <Pieces d={d} />
      <div className="avail"><span>Availability</span><div className="bar" style={{ ['--p' as string]: percent(availPct, 1) }}><i /></div><span className="num">{copies ? `${copies.toFixed(1)}× · ` : ''}{percent(availPct)}</span></div>
      <div className="hint">{bytes(d.have_valid + d.have_unchecked)} of {bytes(d.size_when_done)} · {d.piece_count.toLocaleString()} pieces ({bytes(d.piece_size)} each)</div>

      <Sec>Transfer</Sec>
      <dl className="kv">
        <dt>Downloaded</dt><dd className="num">{bytes(d.downloaded_ever)} {d.corrupt_ever ? <span className="faint">· wasted {bytes(d.corrupt_ever)}</span> : null}</dd>
        <dt>Uploaded</dt><dd className="num">{bytes(d.uploaded_ever)} · ratio {ratio(d.upload_ratio)}</dd>
        <dt>Peers</dt><dd className="num">{d.peers_connected} connected · {d.peers_sending_to_us} sending · {d.peers_getting_from_us} getting
          {pf ? <><br /><span className="faint">from tracker {pf.from_tracker} · DHT {pf.from_dht} · PEX {pf.from_pex} · LPD {pf.from_lpd} · incoming {pf.from_incoming}</span></> : null}</dd>
        <dt>Swarm</dt><dd className="num">{sw.seeds.toLocaleString()} seeds · {sw.leechers.toLocaleString()} leechers</dd>
        {next ? <><dt>Next announce</dt><dd className="num">{inFuture(next.next_announce_time)} <span className="faint">· {hostOf(next.announce)}</span></dd></> : null}
        <dt>Running time</dt><dd className="num">{d.percent_done >= 1 ? duration(d.seconds_seeding) + ' seeding' : duration(d.seconds_downloading)}</dd>
        <dt>Last activity</dt><dd className="num">{ago(d.activity_date)}</dd>
        <dt>Seed limit</dt><dd>{d.seed_ratio_mode === 2 ? 'Unlimited' : <>Stop at ratio <span className="num">{(d.seed_ratio_mode === 1 ? d.seed_ratio_limit : d.seed_ratio_limit).toFixed(2)}</span> <span className="faint">({d.seed_ratio_mode === 0 ? 'global' : 'this torrent'})</span></>}</dd>
      </dl>

      <Sec>Details</Sec>
      <dl className="kv">
        <dt>Location</dt><dd>{relDir(d.download_dir, base) ? `${relDir(d.download_dir, base)}/` : d.download_dir}<div className="faint" style={{ fontSize: 11 }}>{d.download_dir}</div></dd>
        <dt>Hash</dt><dd className="num" style={{ fontSize: 11 }}>{d.hash_string}</dd>
        <dt>Added</dt><dd className="num">{dateTime(d.added_date)}</dd>
        {d.done_date ? <><dt>Finished</dt><dd className="num">{dateTime(d.done_date)}</dd></> : null}
        {d.date_created ? <><dt>Created</dt><dd>{dateTime(d.date_created)}{d.creator ? ` by ${d.creator}` : ''}</dd></> : null}
        <dt>Privacy</dt><dd>{d.is_private ? 'Private torrent' : 'Public torrent'}</dd>
        {d.comment ? <><dt>Comment</dt><dd>{d.comment}</dd></> : null}
        {d.torrent_file ? <><dt>Origin</dt><dd className="num" style={{ fontSize: 11 }}>{d.torrent_file}</dd></> : null}
      </dl>

      <Sec>Options</Sec>
      <Opt label="Honor global limits"><Toggle on={d.honors_session_limits} onChange={v => setT('Limits', { honors_session_limits: v })} /></Opt>
      <Opt label="Limit download"><NumInput value={d.download_limit} unit="kB/s" width={110} onCommit={v => setT('Limit', { download_limit: v })} disabled={!d.download_limited} /><Toggle on={d.download_limited} onChange={v => setT('Limit', { download_limited: v })} /></Opt>
      <Opt label="Limit upload"><NumInput value={d.upload_limit} unit="kB/s" width={110} onCommit={v => setT('Limit', { upload_limit: v })} disabled={!d.upload_limited} /><Toggle on={d.upload_limited} onChange={v => setT('Limit', { upload_limited: v })} /></Opt>
      <Opt label="Bandwidth priority"><Seg value={String(d.bandwidth_priority)} options={[{ v: '-1', l: 'Low' }, { v: '0', l: 'Normal' }, { v: '1', l: 'High' }]} onChange={v => setT('Priority', { bandwidth_priority: Number(v) as -1 | 0 | 1 })} /></Opt>
      <Opt label="Seed ratio"><Seg value={String(d.seed_ratio_mode)} options={[{ v: '0', l: 'Global' }, { v: '1', l: 'Custom' }, { v: '2', l: 'Unlimited' }]} onChange={v => setT('Seed ratio', { seed_ratio_mode: Number(v) as 0 | 1 | 2 })} />{d.seed_ratio_mode === 1 ? <NumInput value={d.seed_ratio_limit} width={70} onCommit={v => setT('Seed ratio', { seed_ratio_limit: v })} /> : null}</Opt>
      <Opt label="Peer limit"><NumInput value={d.peer_limit} width={80} onCommit={v => setT('Peer limit', { 'peer_limit': v })} /></Opt>
      <Opt label="Sequential download" desc="Pieces in order, for previewing"><Toggle on={d.sequential_download} onChange={v => setT('Sequential', { sequential_download: v })} /></Opt>
      <div className="hint" style={{ marginTop: 10 }}>Limits are in kB/s ({KB} bytes).</div>
    </div>
  )
}

// ─── files ───
interface Node { name: string; path: string; idx: number[]; length: number; done: number; children: Node[]; depth: number }

function buildTree(d: TorrentDetail): Node {
  const root: Node = { name: '', path: '', idx: [], length: 0, done: 0, children: [], depth: -1 }
  const dirs = new Map<string, Node>()
  d.files.forEach((f, i) => {
    const parts = f.name.split('/')
    let cur = root
    parts.forEach((p, j) => {
      cur.idx.push(i); cur.length += f.length; cur.done += f.bytes_completed
      const path = parts.slice(0, j + 1).join('/')
      if (j === parts.length - 1) { cur.children.push({ name: p, path, idx: [i], length: f.length, done: f.bytes_completed, children: [], depth: j }); return }
      let n = dirs.get(path)
      if (!n) { n = { name: p, path, idx: [], length: 0, done: 0, children: [], depth: j }; dirs.set(path, n); cur.children.push(n) }
      cur = n
    })
  })
  return root
}

function Files({ d }: { d: TorrentDetail }) {
  const root = useMemo(() => buildTree(d), [d.files])
  const setF = (label: string, args: api.TorrentSetArgs) => void run(label, () => api.setTorrent([d.id], args))
  const rows: React.ReactElement[] = []
  const walk = (n: Node) => {
    const isDir = n.children.length > 0
    const wanted = n.idx.map(i => d.file_stats[i]?.wanted ?? true)
    const allW = wanted.every(Boolean), anyW = wanted.some(Boolean)
    const prios = new Set(n.idx.map(i => d.file_stats[i]?.priority ?? 0))
    const prio = prios.size === 1 ? [...prios][0] : null
    const pct = n.length ? n.done / n.length : 1
    rows.push(
      <div key={n.path} className={'f' + (n.depth > 0 ? ` d${Math.min(2, n.depth)}` : '')} style={n.depth > 2 ? { paddingLeft: 18 * n.depth } : undefined}>
        <span className={'chk' + (allW ? ' on' : anyW ? ' mixed' : '')} onClick={() => setF('Files', allW ? { 'files_unwanted': n.idx } : { 'files_wanted': n.idx })} />
        <Icon name={isDir ? 'chevd' : 'file'} size={14} style={isDir ? undefined : { color: 'var(--ink-3)' }} />
        <span className={'n' + (isDir ? ' dir' : '') + (!anyW ? ' faint' : '')} title={n.path}>{n.name}</span>
        <span className={'num r' + (!anyW ? ' faint' : '')}>{bytes(n.length)}</span>
        <span className={'num r' + (!anyW ? ' faint' : '')}>{anyW ? percent(pct) : '—'}</span>
        <span className="r">
          <button className={'pri ' + (!anyW ? 'low' : prio === 1 ? 'high' : prio === -1 ? 'low' : 'norm')} title="Cycle priority"
            onClick={() => { const nextP = prio === 1 ? -1 : prio === -1 ? 0 : 1; setF('Priority', nextP === 1 ? { 'priority_high': n.idx } : nextP === -1 ? { 'priority_low': n.idx } : { 'priority_normal': n.idx }) }}>
            {!anyW ? 'Skip' : prio === 1 ? 'High' : prio === -1 ? 'Low' : prio === null ? 'Mixed' : 'Normal'}
          </button>
        </span>
      </div>,
    )
    n.children.sort((a, b) => (b.children.length ? 1 : 0) - (a.children.length ? 1 : 0) || a.name.localeCompare(b.name)).forEach(walk)
  }
  root.children.forEach(walk)
  return (
    <div className="insp-body tree">
      <div className="f" style={{ color: 'var(--ink-3)', fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', height: 24 }}><span /><span /><span>Name</span><span className="r">Size</span><span className="r">Done</span><span className="r">Priority</span></div>
      {rows}
      <div className="hint" style={{ marginTop: 14 }}>Unchecked files are not downloaded. Click a priority to cycle High → Low → Normal.</div>
    </div>
  )
}

// ─── peers ───
function Peers({ d }: { d: TorrentDetail }) {
  const peers = [...d.peers].sort((a, b) => (b.rate_to_client + b.rate_to_peer) - (a.rate_to_client + a.rate_to_peer))
  return (
    <div className="insp-body">
      {peers.length ? (
        <table className="tbl">
          <colgroup><col style={{ width: 118 }} /><col /><col style={{ width: 40 }} /><col style={{ width: 62 }} /><col style={{ width: 58 }} /><col style={{ width: 40 }} /></colgroup>
          <thead><tr><th>Address</th><th>Client</th><th className="r">%</th><th className="r">Down</th><th className="r">Up</th><th>Flags</th></tr></thead>
          <tbody>
            {peers.map(p => (
              <tr key={p.address + p.port}>
                <td className="num" title={`${p.address}:${p.port}`}>{p.address}</td>
                <td title={p.client_name}>{p.client_name}</td>
                <td className="r"><div className="mini" style={{ ['--p' as string]: percent(p.progress) }}><i /></div></td>
                <td className="r num" style={p.rate_to_client ? { color: 'var(--accent)' } : undefined}>{p.rate_to_client ? rateParts(p.rate_to_client).join(' ').replace('B/s', '') : '—'}</td>
                <td className="r num">{p.rate_to_peer ? rateParts(p.rate_to_peer).join(' ').replace('B/s', '') : '—'}</td>
                <td className="flags" title={p.flag_str}>{p.flag_str}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="hint">No peers connected.</div>}
      <div className="hint" style={{ marginTop: 12 }}>D downloading · U uploading · E encrypted · H via DHT · X via PEX · I incoming · O optimistic · K/? choked · T µTP</div>
    </div>
  )
}

// ─── trackers ───
function Trackers({ d }: { d: TorrentDetail }) {
  const tiers = new Map<number, typeof d.tracker_stats>()
  for (const ts of d.tracker_stats) tiers.set(ts.tier, [...(tiers.get(ts.tier) ?? []), ts])
  const pf = d.peers_from
  return (
    <div className="insp-body">
      {[...tiers.entries()].sort((a, b) => a[0] - b[0]).map(([tier, list]) => list.map(ts => {
        const c = classifyAnnounce(ts)
        const ok = ts.has_announced && ts.last_announce_succeeded
        return (
          <div key={ts.id} className="tracker">
            <div className="h"><span className="tier">Tier {tier + 1}</span><span style={{ overflowWrap: 'anywhere' }}>{ts.announce}</span><span className="spacer" />
              <span className={'chip ' + (ok ? 'seed' : c === 'ok' ? 'wait' : 'err')}>{ok ? <Icon name="check" size={12} /> : <span className="dot" />}{ok ? 'Working' : c === 'ok' ? 'Not announced' : c === 'rejected' ? 'Client rejected' : c === 'torrent' ? 'Torrent rejected' : 'Unreachable'}</span>
            </div>
            <dl className="kv">
              <dt>Last announce</dt><dd className="num">{ts.has_announced ? <>{ago(ts.last_announce_time)} · <span className={ok ? 'ok' : 'bad'}>{ok ? `got ${ts.last_announce_peer_count} peers` : ts.last_announce_result}</span></> : '—'}</dd>
              <dt>Next announce</dt><dd className="num">{ts.next_announce_time ? inFuture(ts.next_announce_time) : '—'}</dd>
              <dt>Last scrape</dt><dd className="num">{ts.has_scraped && ts.last_scrape_succeeded ? `${ago(ts.last_scrape_time)} · ${ts.seeder_count} seeders · ${ts.leecher_count} leechers · ${ts.downloader_count} downloading · ${ts.download_count} downloads` : '—'}</dd>
            </dl>
          </div>
        )
      }))}
      {!d.tracker_stats.length ? <div className="hint">No trackers. Peers come from DHT, PEX and LPD only.</div> : null}
      <Sec>Other sources</Sec>
      <dl className="kv"><dt>DHT</dt><dd className={pf?.from_dht ? 'ok' : 'faint'}>{pf?.from_dht ?? 0} peers</dd><dt>PEX</dt><dd className={pf?.from_pex ? 'ok' : 'faint'}>{pf?.from_pex ?? 0} peers</dd><dt>LPD</dt><dd className={pf?.from_lpd ? 'ok' : 'faint'}>{pf?.from_lpd ? `${pf.from_lpd} peers` : 'none'}</dd></dl>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button className="btn sm" onClick={() => set({ dialog: { kind: 'trackers', id: d.id } })}>Edit trackers</button>
        <button className="btn sm ghost" onClick={() => void run('Re-announce', () => api.reannounce([d.id]))}>Re-announce</button>
      </div>
    </div>
  )
}
