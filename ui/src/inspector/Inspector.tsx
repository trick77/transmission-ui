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
  const base = useStore(s => s.session?.['download-dir'] ?? '')
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
          <span>·</span><span>Priority <b className="muted">{['Low', 'Normal', 'High'][t.bandwidthPriority + 1]}</b></span>
          <button className="btn ghost icon" style={{ marginLeft: 'auto', width: 26, height: 26 }} title="Close" onClick={() => focus(null)}><Icon name="x" size={14} /></button>
        </div>
      </div>
      <div className="tabs" id="tabs">
        {(['overview', 'files', 'peers', 'trackers'] as const).map(k => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => set({ inspectorTab: k })}>
            {k[0].toUpperCase() + k.slice(1)} {k !== 'overview' && d ? <span className="faint">{k === 'files' ? d.files.length : k === 'peers' ? d.peers.length : d.trackerStats.length}</span> : null}
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
    const n = d.pieceCount || 0
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
  }, [d.pieces, d.pieceCount])
  return <div className="pieces" aria-label="Pieces">{cells.map((c, i) => <i key={i} className={c} />)}</div>
}

function Overview({ d, base }: { d: TorrentDetail; base: string }) {
  const [dn, du] = rateParts(d.rateDownload), [un, uu] = rateParts(d.rateUpload)
  const avail = d.availability?.length ? d.availability : []
  const availPct = avail.length ? avail.filter(a => a !== 0).length / avail.length : d.percentDone
  const copies = avail.length ? avail.reduce((a, v) => a + (v < 0 ? 1 : v), 0) / avail.length : 0
  const sw = swarmOf(d)
  const next = d.trackerStats.filter(ts => ts.nextAnnounceTime > 0).sort((a, b) => a.nextAnnounceTime - b.nextAnnounceTime)[0]
  const pf = d.peersFrom
  const setT = (label: string, args: api.TorrentSetArgs) => void run(label, () => api.setTorrent([d.id], args))
  return (
    <div className="insp-body">
      <div className="stat-row">
        <div className="stat"><div className="l">Download</div><div className="v" style={{ color: 'var(--accent)' }}>{d.rateDownload > 0 ? <>{dn} <small>{du}</small></> : '—'}</div></div>
        <div className="stat"><div className="l">Upload</div><div className="v">{d.rateUpload > 0 ? <>{un} <small>{uu}</small></> : '—'}</div></div>
        <div className="stat"><div className="l">ETA</div><div className="v">{d.percentDone >= 1 ? '∞' : d.eta < 0 ? '—' : duration(d.eta)}</div></div>
      </div>
      <Sec>Progress · {percent(d.percentDone, 1)}</Sec>
      <div className="bar" style={{ ['--p' as string]: percent(d.percentDone, 1), height: 7 }}><i /></div>
      <Pieces d={d} />
      <div className="avail"><span>Availability</span><div className="bar" style={{ ['--p' as string]: percent(availPct, 1) }}><i /></div><span className="num">{copies ? `${copies.toFixed(1)}× · ` : ''}{percent(availPct)}</span></div>
      <div className="hint">{bytes(d.haveValid + d.haveUnchecked)} of {bytes(d.sizeWhenDone)} · {d.pieceCount.toLocaleString()} pieces ({bytes(d.pieceSize)} each)</div>

      <Sec>Transfer</Sec>
      <dl className="kv">
        <dt>Downloaded</dt><dd className="num">{bytes(d.downloadedEver)} {d.corruptEver ? <span className="faint">· wasted {bytes(d.corruptEver)}</span> : null}</dd>
        <dt>Uploaded</dt><dd className="num">{bytes(d.uploadedEver)} · ratio {ratio(d.uploadRatio)}</dd>
        <dt>Peers</dt><dd className="num">{d.peersConnected} connected · {d.peersSendingToUs} sending · {d.peersGettingFromUs} getting
          {pf ? <><br /><span className="faint">from tracker {pf.fromTracker} · DHT {pf.fromDht} · PEX {pf.fromPex} · LPD {pf.fromLpd} · incoming {pf.fromIncoming}</span></> : null}</dd>
        <dt>Swarm</dt><dd className="num">{sw.seeds.toLocaleString()} seeds · {sw.leechers.toLocaleString()} leechers</dd>
        {next ? <><dt>Next announce</dt><dd className="num">{inFuture(next.nextAnnounceTime)} <span className="faint">· {hostOf(next.announce)}</span></dd></> : null}
        <dt>Running time</dt><dd className="num">{d.percentDone >= 1 ? duration(d.secondsSeeding) + ' seeding' : duration(d.secondsDownloading)}</dd>
        <dt>Last activity</dt><dd className="num">{ago(d.activityDate)}</dd>
        <dt>Seed limit</dt><dd>{d.seedRatioMode === 2 ? 'Unlimited' : <>Stop at ratio <span className="num">{(d.seedRatioMode === 1 ? d.seedRatioLimit : d.seedRatioLimit).toFixed(2)}</span> <span className="faint">({d.seedRatioMode === 0 ? 'global' : 'this torrent'})</span></>}</dd>
      </dl>

      <Sec>Details</Sec>
      <dl className="kv">
        <dt>Location</dt><dd>{relDir(d.downloadDir, base) ? `${relDir(d.downloadDir, base)}/` : d.downloadDir}<div className="faint" style={{ fontSize: 11 }}>{d.downloadDir}</div></dd>
        <dt>Hash</dt><dd className="num" style={{ fontSize: 11 }}>{d.hashString}</dd>
        <dt>Added</dt><dd className="num">{dateTime(d.addedDate)}</dd>
        {d.doneDate ? <><dt>Finished</dt><dd className="num">{dateTime(d.doneDate)}</dd></> : null}
        {d.dateCreated ? <><dt>Created</dt><dd>{dateTime(d.dateCreated)}{d.creator ? ` by ${d.creator}` : ''}</dd></> : null}
        <dt>Privacy</dt><dd>{d.isPrivate ? 'Private torrent' : 'Public torrent'}</dd>
        {d.comment ? <><dt>Comment</dt><dd>{d.comment}</dd></> : null}
        {d.torrentFile ? <><dt>Origin</dt><dd className="num" style={{ fontSize: 11 }}>{d.torrentFile}</dd></> : null}
      </dl>

      <Sec>Options</Sec>
      <Opt label="Honor global limits"><Toggle on={d.honorsSessionLimits} onChange={v => setT('Limits', { honorsSessionLimits: v })} /></Opt>
      <Opt label="Limit download"><NumInput value={d.downloadLimit} unit="kB/s" width={110} onCommit={v => setT('Limit', { downloadLimit: v })} disabled={!d.downloadLimited} /><Toggle on={d.downloadLimited} onChange={v => setT('Limit', { downloadLimited: v })} /></Opt>
      <Opt label="Limit upload"><NumInput value={d.uploadLimit} unit="kB/s" width={110} onCommit={v => setT('Limit', { uploadLimit: v })} disabled={!d.uploadLimited} /><Toggle on={d.uploadLimited} onChange={v => setT('Limit', { uploadLimited: v })} /></Opt>
      <Opt label="Bandwidth priority"><Seg value={String(d.bandwidthPriority)} options={[{ v: '-1', l: 'Low' }, { v: '0', l: 'Normal' }, { v: '1', l: 'High' }]} onChange={v => setT('Priority', { bandwidthPriority: Number(v) as -1 | 0 | 1 })} /></Opt>
      <Opt label="Seed ratio"><Seg value={String(d.seedRatioMode)} options={[{ v: '0', l: 'Global' }, { v: '1', l: 'Custom' }, { v: '2', l: 'Unlimited' }]} onChange={v => setT('Seed ratio', { seedRatioMode: Number(v) as 0 | 1 | 2 })} />{d.seedRatioMode === 1 ? <NumInput value={d.seedRatioLimit} width={70} onCommit={v => setT('Seed ratio', { seedRatioLimit: v })} /> : null}</Opt>
      <Opt label="Peer limit"><NumInput value={d['peer-limit']} width={80} onCommit={v => setT('Peer limit', { 'peer-limit': v })} /></Opt>
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
      cur.idx.push(i); cur.length += f.length; cur.done += f.bytesCompleted
      const path = parts.slice(0, j + 1).join('/')
      if (j === parts.length - 1) { cur.children.push({ name: p, path, idx: [i], length: f.length, done: f.bytesCompleted, children: [], depth: j }); return }
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
    const wanted = n.idx.map(i => d.fileStats[i]?.wanted ?? true)
    const allW = wanted.every(Boolean), anyW = wanted.some(Boolean)
    const prios = new Set(n.idx.map(i => d.fileStats[i]?.priority ?? 0))
    const prio = prios.size === 1 ? [...prios][0] : null
    const pct = n.length ? n.done / n.length : 1
    rows.push(
      <div key={n.path} className={'f' + (n.depth > 0 ? ` d${Math.min(2, n.depth)}` : '')} style={n.depth > 2 ? { paddingLeft: 18 * n.depth } : undefined}>
        <span className={'chk' + (allW ? ' on' : anyW ? ' mixed' : '')} onClick={() => setF('Files', allW ? { 'files-unwanted': n.idx } : { 'files-wanted': n.idx })} />
        <Icon name={isDir ? 'chevd' : 'file'} size={14} style={isDir ? undefined : { color: 'var(--ink-3)' }} />
        <span className={'n' + (isDir ? ' dir' : '') + (!anyW ? ' faint' : '')} title={n.path}>{n.name}</span>
        <span className={'num r' + (!anyW ? ' faint' : '')}>{bytes(n.length)}</span>
        <span className={'num r' + (!anyW ? ' faint' : '')}>{anyW ? percent(pct) : '—'}</span>
        <span className="r">
          <button className={'pri ' + (!anyW ? 'low' : prio === 1 ? 'high' : prio === -1 ? 'low' : 'norm')} title="Cycle priority"
            onClick={() => { const nextP = prio === 1 ? -1 : prio === -1 ? 0 : 1; setF('Priority', nextP === 1 ? { 'priority-high': n.idx } : nextP === -1 ? { 'priority-low': n.idx } : { 'priority-normal': n.idx }) }}>
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
  const peers = [...d.peers].sort((a, b) => (b.rateToClient + b.rateToPeer) - (a.rateToClient + a.rateToPeer))
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
                <td title={p.clientName}>{p.clientName}</td>
                <td className="r"><div className="mini" style={{ ['--p' as string]: percent(p.progress) }}><i /></div></td>
                <td className="r num" style={p.rateToClient ? { color: 'var(--accent)' } : undefined}>{p.rateToClient ? rateParts(p.rateToClient).join(' ').replace('B/s', '') : '—'}</td>
                <td className="r num">{p.rateToPeer ? rateParts(p.rateToPeer).join(' ').replace('B/s', '') : '—'}</td>
                <td className="flags" title={p.flagStr}>{p.flagStr}</td>
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
  const tiers = new Map<number, typeof d.trackerStats>()
  for (const ts of d.trackerStats) tiers.set(ts.tier, [...(tiers.get(ts.tier) ?? []), ts])
  const pf = d.peersFrom
  return (
    <div className="insp-body">
      {[...tiers.entries()].sort((a, b) => a[0] - b[0]).map(([tier, list]) => list.map(ts => {
        const c = classifyAnnounce(ts)
        const ok = ts.hasAnnounced && ts.lastAnnounceSucceeded
        return (
          <div key={ts.id} className="tracker">
            <div className="h"><span className="tier">Tier {tier + 1}</span><span style={{ overflowWrap: 'anywhere' }}>{ts.announce}</span><span className="spacer" />
              <span className={'chip ' + (ok ? 'seed' : c === 'ok' ? 'wait' : 'err')}>{ok ? <Icon name="check" size={12} /> : <span className="dot" />}{ok ? 'Working' : c === 'ok' ? 'Not announced' : c === 'rejected' ? 'Client rejected' : c === 'torrent' ? 'Torrent rejected' : 'Unreachable'}</span>
            </div>
            <dl className="kv">
              <dt>Last announce</dt><dd className="num">{ts.hasAnnounced ? <>{ago(ts.lastAnnounceTime)} · <span className={ok ? 'ok' : 'bad'}>{ok ? `got ${ts.lastAnnouncePeerCount} peers` : ts.lastAnnounceResult}</span></> : '—'}</dd>
              <dt>Next announce</dt><dd className="num">{ts.nextAnnounceTime ? inFuture(ts.nextAnnounceTime) : '—'}</dd>
              <dt>Last scrape</dt><dd className="num">{ts.hasScraped && ts.lastScrapeSucceeded ? `${ago(ts.lastScrapeTime)} · ${ts.seederCount} seeders · ${ts.leecherCount} leechers · ${ts.downloadCount} downloads` : '—'}</dd>
            </dl>
          </div>
        )
      }))}
      {!d.trackerStats.length ? <div className="hint">No trackers. Peers come from DHT, PEX and LPD only.</div> : null}
      <Sec>Other sources</Sec>
      <dl className="kv"><dt>DHT</dt><dd className={pf?.fromDht ? 'ok' : 'faint'}>{pf?.fromDht ?? 0} peers</dd><dt>PEX</dt><dd className={pf?.fromPex ? 'ok' : 'faint'}>{pf?.fromPex ?? 0} peers</dd><dt>LPD</dt><dd className={pf?.fromLpd ? 'ok' : 'faint'}>{pf?.fromLpd ? `${pf.fromLpd} peers` : 'none'}</dd></dl>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button className="btn sm" onClick={() => set({ dialog: { kind: 'trackers', id: d.id } })}>Edit trackers</button>
        <button className="btn sm ghost" onClick={() => void run('Re-announce', () => api.reannounce([d.id]))}>Re-announce</button>
      </div>
    </div>
  )
}
