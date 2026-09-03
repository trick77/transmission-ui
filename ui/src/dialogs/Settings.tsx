import { useState } from 'react'
import { Icon } from '../icons/Icon'
import { bytes, duration } from '../lib/format'
import type { Session } from '../rpc/types'
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
  const all = stats?.['cumulative-stats']
  return (
    <div className="scrim">
      <div ref={ref} className="modal" style={{ width: 820, height: 640, flexDirection: 'row' }} role="dialog" aria-modal="true" aria-label="Preferences">
        <nav style={{ width: 190, borderRight: '1px solid var(--line)', padding: '14px 10px', background: 'var(--bg)', flex: 'none' }}>
          <div className="side-h">Preferences</div>
          {SECTIONS.map(k => <button key={k} className={'side-item' + (sec === k ? ' on' : '')} onClick={() => setSec(k)}><span className="lbl">{k}</span></button>)}
          <div className="side-h" style={{ marginTop: 22 }}>Session</div>
          <div className="hint" style={{ padding: '0 8px', lineHeight: 1.6 }}>transmission-daemon {s.version}<br />rpc-version {s['rpc-version']}<br />{all ? <>Uptime {duration(all.secondsActive)}<br /><span className="num">↓ {bytes(all.downloadedBytes)} · ↑ {bytes(all.uploadedBytes)}</span></> : null}</div>
        </nav>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <div className="modal-h"><span className="t">{sec}</span><div className="spacer" /><button className="btn ghost icon" onClick={onClose}><Icon name="x" /></button></div>
          <div className="modal-b" style={{ flex: 1 }}>
            {sec === 'Speed' ? <>
              <Sec first>Global limits</Sec>
              <Opt label="Download limit"><NumInput value={s['speed-limit-down']} unit="kB/s" disabled={!s['speed-limit-down-enabled']} onCommit={v => save({ 'speed-limit-down': v })} /><Toggle on={s['speed-limit-down-enabled']} onChange={v => save({ 'speed-limit-down-enabled': v })} /></Opt>
              <Opt label="Upload limit"><NumInput value={s['speed-limit-up']} unit="kB/s" disabled={!s['speed-limit-up-enabled']} onCommit={v => save({ 'speed-limit-up': v })} /><Toggle on={s['speed-limit-up-enabled']} onChange={v => save({ 'speed-limit-up-enabled': v })} /></Opt>
              <div className="sec" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="turtle" size={14} style={{ color: 'var(--ink-3)' }} />Alternative speed limits</div>
              <div className="hint" style={{ margin: '-4px 0 6px' }}>Temporary limits, toggled with the turtle in the toolbar or on a schedule.</div>
              <Opt label="Enabled now"><Toggle on={s['alt-speed-enabled']} onChange={v => save({ 'alt-speed-enabled': v })} /></Opt>
              <Opt label="Download limit"><NumInput value={s['alt-speed-down']} unit="kB/s" onCommit={v => save({ 'alt-speed-down': v })} /></Opt>
              <Opt label="Upload limit"><NumInput value={s['alt-speed-up']} unit="kB/s" onCommit={v => save({ 'alt-speed-up': v })} /></Opt>
              <Opt label="Scheduled" desc="Enable alternative limits automatically"><Toggle on={s['alt-speed-time-enabled']} onChange={v => save({ 'alt-speed-time-enabled': v })} /></Opt>
              <Opt label="Between"><TextInput value={hm(s['alt-speed-time-begin'])} mono width={84} onCommit={v => { const m = mins(v); if (m != null) save({ 'alt-speed-time-begin': m }) }} /><span className="faint">and</span><TextInput value={hm(s['alt-speed-time-end'])} mono width={84} onCommit={v => { const m = mins(v); if (m != null) save({ 'alt-speed-time-end': m }) }} /></Opt>
              <Opt label="On days"><div className="seg">{DAYS.map(d => <button key={d.v} className={(s['alt-speed-time-day'] & d.v) ? 'on' : ''} onClick={() => save({ 'alt-speed-time-day': s['alt-speed-time-day'] ^ d.v })}>{d.l}</button>)}</div></Opt>
            </> : sec === 'Downloads' ? <>
              <Sec first>Locations</Sec>
              <Opt label="Download to"><TextInput value={s['download-dir']} icon="folder" wide onCommit={v => save({ 'download-dir': v })} /></Opt>
              <Opt label="Keep incomplete files in"><TextInput value={s['incomplete-dir']} icon="folder" wide onCommit={v => save({ 'incomplete-dir': v })} /><Toggle on={s['incomplete-dir-enabled']} onChange={v => save({ 'incomplete-dir-enabled': v })} /></Opt>
              <Opt label="Append “.part” to incomplete files"><Toggle on={s['rename-partial-files']} onChange={v => save({ 'rename-partial-files': v })} /></Opt>
              <Sec>Adding</Sec>
              <Opt label="Start torrents when added"><Toggle on={s['start-added-torrents']} onChange={v => save({ 'start-added-torrents': v })} /></Opt>
              <Opt label="Delete .torrent file after adding"><Toggle on={s['trash-original-torrent-files']} onChange={v => save({ 'trash-original-torrent-files': v })} /></Opt>
              <Opt label="Run script when download completes"><TextInput value={s['script-torrent-done-filename']} placeholder="/path/to/script.sh" mono wide onCommit={v => save({ 'script-torrent-done-filename': v })} /><Toggle on={s['script-torrent-done-enabled']} onChange={v => save({ 'script-torrent-done-enabled': v })} /></Opt>
              <Sec>Storage</Sec>
              <Opt label="Cache size"><NumInput value={s['cache-size-mb']} unit="MB" onCommit={v => save({ 'cache-size-mb': v })} /></Opt>
              <div className="hint" style={{ marginTop: 10 }}>Watch folder and preallocation are daemon settings (settings.json), not changeable over RPC.</div>
            </> : sec === 'Seeding' ? <>
              <Sec first>Stop seeding</Sec>
              <Opt label="At ratio"><NumInput value={s.seedRatioLimit} disabled={!s.seedRatioLimited} onCommit={v => save({ seedRatioLimit: v })} /><Toggle on={s.seedRatioLimited} onChange={v => save({ seedRatioLimited: v })} /></Opt>
              <Opt label="When idle for"><NumInput value={s['idle-seeding-limit']} unit="min" disabled={!s['idle-seeding-limit-enabled']} onCommit={v => save({ 'idle-seeding-limit': v })} /><Toggle on={s['idle-seeding-limit-enabled']} onChange={v => save({ 'idle-seeding-limit-enabled': v })} /></Opt>
              <Sec>Finished torrents</Sec>
              <Opt label="Run script when seeding completes"><TextInput value={s['script-torrent-done-seeding-filename']} placeholder="/path/to/script.sh" mono wide onCommit={v => save({ 'script-torrent-done-seeding-filename': v })} /><Toggle on={s['script-torrent-done-seeding-enabled']} onChange={v => save({ 'script-torrent-done-seeding-enabled': v })} /></Opt>
            </> : sec === 'Queue' ? <>
              <Sec first>Queue sizes</Sec>
              <Opt label="Downloads active at once"><NumInput value={s['download-queue-size']} disabled={!s['download-queue-enabled']} onCommit={v => save({ 'download-queue-size': v })} /><Toggle on={s['download-queue-enabled']} onChange={v => save({ 'download-queue-enabled': v })} /></Opt>
              <Opt label="Seeds active at once"><NumInput value={s['seed-queue-size']} disabled={!s['seed-queue-enabled']} onCommit={v => save({ 'seed-queue-size': v })} /><Toggle on={s['seed-queue-enabled']} onChange={v => save({ 'seed-queue-enabled': v })} /></Opt>
              <Sec>Stalled</Sec>
              <Opt label="Treat as stalled after" desc="Stalled torrents don’t count against the queue"><NumInput value={s['queue-stalled-minutes']} unit="min" disabled={!s['queue-stalled-enabled']} onCommit={v => save({ 'queue-stalled-minutes': v })} /><Toggle on={s['queue-stalled-enabled']} onChange={v => save({ 'queue-stalled-enabled': v })} /></Opt>
            </> : sec === 'Network' ? <Network s={s} save={save} />
            : sec === 'Peers' ? <>
              <Sec first>Limits</Sec>
              <Opt label="Max peers per torrent"><NumInput value={s['peer-limit-per-torrent']} onCommit={v => save({ 'peer-limit-per-torrent': v })} /></Opt>
              <Opt label="Max peers overall"><NumInput value={s['peer-limit-global']} onCommit={v => save({ 'peer-limit-global': v })} /></Opt>
              <Sec>Encryption</Sec>
              <Opt label="Encrypted peers"><Seg value={s.encryption} options={[{ v: 'tolerated', l: 'Allow' }, { v: 'preferred', l: 'Prefer' }, { v: 'required', l: 'Require' }]} onChange={v => save({ encryption: v })} /></Opt>
              <Sec>Blocklist</Sec>
              <Opt label="Enable blocklist" desc={`${s['blocklist-size'].toLocaleString()} rules`}><button className="btn sm" onClick={() => void run('Blocklist', () => api.blocklistUpdate().then(r => { toast(`Blocklist updated: ${r['blocklist-size'].toLocaleString()} rules`); return refreshSession() }))}>Update</button><Toggle on={s['blocklist-enabled']} onChange={v => save({ 'blocklist-enabled': v })} /></Opt>
              <Opt label="Blocklist URL"><TextInput value={s['blocklist-url']} mono wide onCommit={v => save({ 'blocklist-url': v })} /></Opt>
            </> : <Interface />}
          </div>
          <div className="modal-f"><span className="hint">Changes apply immediately to the running session</span><div className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></div>
        </div>
      </div>
    </div>
  )
}

function Network({ s, save }: { s: Session; save: (p: Partial<Session>) => void }) {
  const [port, setPort] = useState<'unknown' | 'testing' | 'open' | 'closed'>('unknown')
  return <>
    <Sec first>Listening port</Sec>
    <Opt label="Peer port" desc={<span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{port === 'unknown' ? 'Not tested' : port === 'testing' ? 'Testing…' : <><span style={{ width: 7, height: 7, borderRadius: '50%', background: port === 'open' ? 'var(--accent)' : 'var(--err)' }} />{port === 'open' ? 'Port is open' : 'Port is closed'}</>}</span>}>
      <NumInput value={s['peer-port']} onCommit={v => save({ 'peer-port': v })} />
      <button className="btn sm" onClick={() => { setPort('testing'); api.portTest().then(r => setPort(r['port-is-open'] ? 'open' : 'closed')).catch(() => setPort('unknown')) }}>Test</button>
    </Opt>
    <Opt label="Randomize port on launch"><Toggle on={s['peer-port-random-on-start']} onChange={v => save({ 'peer-port-random-on-start': v })} /></Opt>
    <Opt label="Port forwarding (UPnP / NAT-PMP)"><Toggle on={s['port-forwarding-enabled']} onChange={v => save({ 'port-forwarding-enabled': v })} /></Opt>
    <Sec>Peer discovery</Sec>
    <Opt label="Distributed hash table (DHT)"><Toggle on={s['dht-enabled']} onChange={v => save({ 'dht-enabled': v })} /></Opt>
    <Opt label="Peer exchange (PEX)"><Toggle on={s['pex-enabled']} onChange={v => save({ 'pex-enabled': v })} /></Opt>
    <Opt label="Local peer discovery (LPD)"><Toggle on={s['lpd-enabled']} onChange={v => save({ 'lpd-enabled': v })} /></Opt>
    <Opt label="µTP" desc="Congestion-aware transport, reduces impact on other traffic"><Toggle on={s['utp-enabled']} onChange={v => save({ 'utp-enabled': v })} /></Opt>
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
