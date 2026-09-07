import { useState } from 'react'
import { Icon } from '../icons/Icon'
import { bytes, duration } from '../lib/format'
import type { Session, Transport } from '../rpc/types'
import * as api from '../rpc/methods'
import { refreshSession, run, toast, useStore, writeLocal } from '../state/store'
import { NumInput, Opt, Seg, Sec, TextInput, Toggle, useDismiss } from '../app/ui'

const SECTIONS = ['Speed', 'Downloads', 'Seeding', 'Queue', 'Network', 'Peers', 'Interface'] as const
type Section = typeof SECTIONS[number]
const DAYS = [{ v: 1, l: 'Su' }, { v: 2, l: 'Mo' }, { v: 4, l: 'Tu' }, { v: 8, l: 'We' }, { v: 16, l: 'Th' }, { v: 32, l: 'Fr' }, { v: 64, l: 'Sa' }]
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null }

export function Settings({ onClose, section }: { onClose: () => void; section?: string }) {
  const s = useStore(x => x.session)
  const stats = useStore(x => x.stats)
  const [sec, setSec] = useState<Section>((SECTIONS.find(x => x.toLowerCase() === section) ?? 'Speed'))
  const ref = useDismiss(onClose)
  const save = (patch: Partial<Session>) => void run('Settings', () => api.setSession(patch).then(refreshSession))
  if (!s) return null
  const all = stats?.cumulative_stats
  return (
    <div className="scrim">
      <div ref={ref} className="modal" style={{ width: 820, height: 640, flexDirection: 'row' }} role="dialog" aria-modal="true" aria-label="Preferences">
        <nav style={{ width: 190, borderRight: '1px solid var(--line)', padding: '14px 10px', background: 'var(--bg)', flex: 'none' }}>
          <div className="side-h">Preferences</div>
          {SECTIONS.map(k => <button key={k} className={'side-item' + (sec === k ? ' on' : '')} onClick={() => setSec(k)}><span className="lbl">{k}</span></button>)}
          <div className="side-h" style={{ marginTop: 22 }}>Session</div>
          <div className="hint" style={{ padding: '0 8px', lineHeight: 1.6 }}>transmission-daemon {s.version}<br />rpc {s.rpc_version_semver}<br />{all ? <>Uptime {duration(all.seconds_active)}<br /><span className="num">↓ {bytes(all.downloaded_bytes)} · ↑ {bytes(all.uploaded_bytes)}</span></> : null}</div>
        </nav>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <div className="modal-h"><span className="t">{sec}</span><div className="spacer" /><button className="btn ghost icon" onClick={onClose}><Icon name="x" /></button></div>
          <div className="modal-b" style={{ flex: 1 }}>
            {sec === 'Speed' ? <>
              <Sec first>Global limits</Sec>
              <Opt label="Download limit"><NumInput value={s.speed_limit_down} unit="kB/s" disabled={!s.speed_limit_down_enabled} onCommit={v => save({ 'speed_limit_down': v })} /><Toggle on={s.speed_limit_down_enabled} onChange={v => save({ 'speed_limit_down_enabled': v })} /></Opt>
              <Opt label="Upload limit"><NumInput value={s.speed_limit_up} unit="kB/s" disabled={!s.speed_limit_up_enabled} onCommit={v => save({ 'speed_limit_up': v })} /><Toggle on={s.speed_limit_up_enabled} onChange={v => save({ 'speed_limit_up_enabled': v })} /></Opt>
              <div className="sec" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="turtle" size={14} style={{ color: 'var(--ink-3)' }} />Alternative speed limits</div>
              <div className="hint" style={{ margin: '-4px 0 6px' }}>Temporary limits, toggled with the turtle in the toolbar or on a schedule.</div>
              <Opt label="Enabled now"><Toggle on={s.alt_speed_enabled} onChange={v => save({ 'alt_speed_enabled': v })} /></Opt>
              <Opt label="Download limit"><NumInput value={s.alt_speed_down} unit="kB/s" onCommit={v => save({ 'alt_speed_down': v })} /></Opt>
              <Opt label="Upload limit"><NumInput value={s.alt_speed_up} unit="kB/s" onCommit={v => save({ 'alt_speed_up': v })} /></Opt>
              <Opt label="Scheduled" desc="Enable alternative limits automatically"><Toggle on={s.alt_speed_time_enabled} onChange={v => save({ 'alt_speed_time_enabled': v })} /></Opt>
              <Opt label="Between"><TextInput value={hm(s.alt_speed_time_begin)} mono width={84} onCommit={v => { const m = mins(v); if (m != null) save({ 'alt_speed_time_begin': m }) }} /><span className="faint">and</span><TextInput value={hm(s.alt_speed_time_end)} mono width={84} onCommit={v => { const m = mins(v); if (m != null) save({ 'alt_speed_time_end': m }) }} /></Opt>
              <Opt label="On days"><div className="seg">{DAYS.map(d => <button key={d.v} className={(s.alt_speed_time_day & d.v) ? 'on' : ''} onClick={() => save({ 'alt_speed_time_day': s.alt_speed_time_day ^ d.v })}>{d.l}</button>)}</div></Opt>
            </> : sec === 'Downloads' ? <>
              <Sec first>Locations</Sec>
              <Opt label="Download to"><TextInput value={s.download_dir} icon="folder" wide onCommit={v => save({ 'download_dir': v })} /></Opt>
              <Opt label="Keep incomplete files in"><TextInput value={s.incomplete_dir} icon="folder" wide onCommit={v => save({ 'incomplete_dir': v })} /><Toggle on={s.incomplete_dir_enabled} onChange={v => save({ 'incomplete_dir_enabled': v })} /></Opt>
              <Opt label="Append “.part” to incomplete files"><Toggle on={s.rename_partial_files} onChange={v => save({ 'rename_partial_files': v })} /></Opt>
              <Sec>Adding</Sec>
              <Opt label="Start torrents when added"><Toggle on={s.start_added_torrents} onChange={v => save({ 'start_added_torrents': v })} /></Opt>
              <Opt label="Delete .torrent file after adding"><Toggle on={s.trash_original_torrent_files} onChange={v => save({ 'trash_original_torrent_files': v })} /></Opt>
              <Opt label="Sequential download by default" desc="New torrents fetch their pieces in order"><Toggle on={s.sequential_download} onChange={v => save({ sequential_download: v })} /></Opt>
              <Opt label="Run script when download completes"><TextInput value={s.script_torrent_done_filename} placeholder="/path/to/script.sh" mono wide onCommit={v => save({ 'script_torrent_done_filename': v })} /><Toggle on={s.script_torrent_done_enabled} onChange={v => save({ 'script_torrent_done_enabled': v })} /></Opt>
              <Sec>Storage</Sec>
              <Opt label="Cache size"><NumInput value={s.cache_size_mib} unit="MiB" onCommit={v => save({ 'cache_size_mib': v })} /></Opt>
              <div className="hint" style={{ marginTop: 10 }}>Watch folder and preallocation are daemon settings (settings.json), not changeable over RPC.</div>
            </> : sec === 'Seeding' ? <>
              <Sec first>Stop seeding</Sec>
              <Opt label="At ratio"><NumInput value={s.seed_ratio_limit} disabled={!s.seed_ratio_limited} onCommit={v => save({ seed_ratio_limit: v })} /><Toggle on={s.seed_ratio_limited} onChange={v => save({ seed_ratio_limited: v })} /></Opt>
              <Opt label="When idle for"><NumInput value={s.idle_seeding_limit} unit="min" disabled={!s.idle_seeding_limit_enabled} onCommit={v => save({ 'idle_seeding_limit': v })} /><Toggle on={s.idle_seeding_limit_enabled} onChange={v => save({ 'idle_seeding_limit_enabled': v })} /></Opt>
              <Sec>Finished torrents</Sec>
              <Opt label="Run script when seeding completes"><TextInput value={s.script_torrent_done_seeding_filename} placeholder="/path/to/script.sh" mono wide onCommit={v => save({ 'script_torrent_done_seeding_filename': v })} /><Toggle on={s.script_torrent_done_seeding_enabled} onChange={v => save({ 'script_torrent_done_seeding_enabled': v })} /></Opt>
            </> : sec === 'Queue' ? <>
              <Sec first>Queue sizes</Sec>
              <Opt label="Downloads active at once"><NumInput value={s.download_queue_size} disabled={!s.download_queue_enabled} onCommit={v => save({ 'download_queue_size': v })} /><Toggle on={s.download_queue_enabled} onChange={v => save({ 'download_queue_enabled': v })} /></Opt>
              <Opt label="Seeds active at once"><NumInput value={s.seed_queue_size} disabled={!s.seed_queue_enabled} onCommit={v => save({ 'seed_queue_size': v })} /><Toggle on={s.seed_queue_enabled} onChange={v => save({ 'seed_queue_enabled': v })} /></Opt>
              <Sec>Stalled</Sec>
              <Opt label="Treat as stalled after" desc="Stalled torrents don’t count against the queue"><NumInput value={s.queue_stalled_minutes} unit="min" disabled={!s.queue_stalled_enabled} onCommit={v => save({ 'queue_stalled_minutes': v })} /><Toggle on={s.queue_stalled_enabled} onChange={v => save({ 'queue_stalled_enabled': v })} /></Opt>
            </> : sec === 'Network' ? <Network s={s} save={save} />
            : sec === 'Peers' ? <>
              <Sec first>Limits</Sec>
              <Opt label="Max peers per torrent"><NumInput value={s.peer_limit_per_torrent} onCommit={v => save({ 'peer_limit_per_torrent': v })} /></Opt>
              <Opt label="Max peers overall"><NumInput value={s.peer_limit_global} onCommit={v => save({ 'peer_limit_global': v })} /></Opt>
              <Sec>Encryption</Sec>
              <Opt label="Encrypted peers"><Seg value={s.encryption} options={[{ v: 'allowed', l: 'Allow' }, { v: 'preferred', l: 'Prefer' }, { v: 'required', l: 'Require' }]} onChange={v => save({ encryption: v })} /></Opt>
              <Sec>Blocklist</Sec>
              <Opt label="Enable blocklist" desc={`${s.blocklist_size.toLocaleString()} rules`}><button className="btn sm" onClick={() => void run('Blocklist', () => api.blocklistUpdate().then(r => { toast(`Blocklist updated: ${r.blocklist_size.toLocaleString()} rules`); return refreshSession() }))}>Update</button><Toggle on={s.blocklist_enabled} onChange={v => save({ 'blocklist_enabled': v })} /></Opt>
              <Opt label="Blocklist URL"><TextInput value={s.blocklist_url} mono wide onCommit={v => save({ 'blocklist_url': v })} /></Opt>
            </> : <Interface />}
          </div>
          <div className="modal-f"><span className="hint">Changes apply immediately to the running session</span><div className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></div>
        </div>
      </div>
    </div>
  )
}

type PortState = 'unknown' | 'testing' | 'open' | 'closed' | 'unavailable'

/** Fixed preference order, so toggling a transport off and on again cannot reorder the list. */
const TRANSPORTS: Transport[] = ['tcp', 'utp']

/** One dot per IP family. rpc 18 tests a single family per call, so IPv4 and IPv6 are separate results. */
function PortResult({ label, state }: { label: string; state: PortState }) {
  if (state === 'unknown') return <span className="faint">{label} not tested</span>
  if (state === 'testing') return <span className="faint">{label} testing…</span>
  // The daemon answers with a JSON-RPC error when it cannot reach the port-test service over
  // that family at all, which is not the same as the port being closed.
  if (state === 'unavailable') return <span className="faint">{label} unavailable</span>
  return <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: state === 'open' ? 'var(--accent)' : 'var(--err)' }} />
    {label} {state === 'open' ? 'open' : 'closed'}
  </span>
}

function Network({ s, save }: { s: Session; save: (p: Partial<Session>) => void }) {
  const [v4, setV4] = useState<PortState>('unknown')
  const [v6, setV6] = useState<PortState>('unknown')
  const test = () => {
    for (const [proto, set] of [['ipv4', setV4], ['ipv6', setV6]] as const) {
      set('testing')
      // A family the daemon cannot reach comes back as a JSON-RPC error, not as `port_is_open: false`.
      api.portTest(proto).then(r => set(r.port_is_open ? 'open' : 'closed')).catch(() => set('unavailable'))
    }
  }
  // A daemon that omits the key has every transport enabled; an empty list would mean the
  // opposite, so never let the last one be switched off.
  const transports = s.preferred_transports?.length ? s.preferred_transports : TRANSPORTS
  const setTransport = (proto: Transport, on: boolean) => {
    const enabled = new Set(transports)
    if (on) enabled.add(proto); else enabled.delete(proto)
    if (!enabled.size) return
    save({ preferred_transports: TRANSPORTS.filter(t => enabled.has(t)) })
  }
  const onlyTransport = (proto: Transport) => transports.length === 1 && transports[0] === proto
  return <>
    <Sec first>Listening port</Sec>
    <Opt label="Peer port" desc={<span style={{ display: 'flex', alignItems: 'center', gap: 14 }}><PortResult label="IPv4" state={v4} /><PortResult label="IPv6" state={v6} /></span>}>
      <NumInput value={s.peer_port} onCommit={v => save({ 'peer_port': v })} />
      <button className="btn sm" onClick={test}>Test</button>
    </Opt>
    <Opt label="Randomize port on launch"><Toggle on={s.peer_port_random_on_start} onChange={v => save({ 'peer_port_random_on_start': v })} /></Opt>
    <Opt label="Port forwarding (UPnP / NAT-PMP)"><Toggle on={s.port_forwarding_enabled} onChange={v => save({ 'port_forwarding_enabled': v })} /></Opt>
    <Sec>Peer discovery</Sec>
    <Opt label="Distributed hash table (DHT)"><Toggle on={s.dht_enabled} onChange={v => save({ 'dht_enabled': v })} /></Opt>
    <Opt label="Peer exchange (PEX)"><Toggle on={s.pex_enabled} onChange={v => save({ 'pex_enabled': v })} /></Opt>
    <Opt label="Local peer discovery (LPD)"><Toggle on={s.lpd_enabled} onChange={v => save({ 'lpd_enabled': v })} /></Opt>
    <Sec>Transports</Sec>
    <Opt label="TCP" desc="Plain TCP peer connections"><Toggle on={transports.includes('tcp')} disabled={onlyTransport('tcp')} onChange={v => setTransport('tcp', v)} /></Opt>
    <Opt label="µTP" desc="Congestion-aware transport, reduces impact on other traffic"><Toggle on={transports.includes('utp')} disabled={onlyTransport('utp')} onChange={v => setTransport('utp', v)} /></Opt>
    <div className="hint" style={{ marginTop: 6 }}>At least one transport stays enabled; without one the daemon can reach no peers.</div>
    <div className="hint" style={{ marginTop: 10 }}>RPC port and whitelist are daemon settings (settings.json), not changeable over RPC.</div>
  </>
}

function Interface() {
  const [density, setDensity] = useState<string>(() => { try { return localStorage.getItem('tm.density') ?? 'compact' } catch { return 'compact' } })
  const [notify, setNotify] = useState<boolean>(() => { try { return localStorage.getItem('tm.notify') === 'true' } catch { return false } })
  return <>
    <Sec first>Interface</Sec>
    <Opt label="Row density"><Seg value={density} options={[{ v: 'compact', l: 'Compact' }, { v: 'comfortable', l: 'Comfortable' }]} onChange={v => { setDensity(v); writeLocal('tm.density', v); document.documentElement.dataset.density = v }} /></Opt>
    <Sec>Notifications</Sec>
    <Opt label="Notify when a download completes" desc="Uses the browser's notifications; asks for permission once."><Toggle on={notify} onChange={async v => {
      if (v && 'Notification' in window && Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') return }
      setNotify(v); writeLocal('tm.notify', String(v))
    }} /></Opt>
  </>
}
