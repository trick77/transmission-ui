// Small form primitives that mirror the mock's CSS classes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons/Icon'

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button type="button" role="switch" aria-checked={on} title={title} className={'toggle' + (on ? ' on' : '')} onClick={() => onChange(!on)} />
}

export function Seg<T extends string>({ value, options, onChange, size }: { value: T; options: { v: T; l: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' }) {
  return (
    <div className="seg" data-size={size}>
      {options.map(o => <button key={o.v} type="button" className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)}>{o.l}</button>)}
    </div>
  )
}

export function NumInput({ value, onCommit, unit, width = 130, mono = true, min = 0, disabled }: { value: number; onCommit: (v: number) => void; unit?: string; width?: number; mono?: boolean; min?: number; disabled?: boolean }) {
  const [v, setV] = useState(String(value))
  useEffect(() => { setV(String(value)) }, [value])
  const commit = () => { const n = Number(v); if (!Number.isNaN(n) && n >= min && n !== value) onCommit(n); else setV(String(value)) }
  return (
    <div className={'input' + (mono ? ' mono' : '')} style={{ width, opacity: disabled ? .5 : 1 }}>
      <input value={v} disabled={disabled} inputMode="decimal" onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      {unit ? <span className="unit">{unit}</span> : null}
    </div>
  )
}

export function TextInput({ value, onCommit, placeholder, icon, mono, width, wide, unit, autoFocus }: { value: string; onCommit: (v: string) => void; placeholder?: string; icon?: IconName; mono?: boolean; width?: number; wide?: boolean; unit?: ReactNode; autoFocus?: boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])
  const commit = () => { if (v !== value) onCommit(v) }
  return (
    <div className={'input' + (mono ? ' mono' : '') + (wide ? ' wide' : '')} style={width ? { width } : undefined}>
      {icon ? <Icon name={icon} style={{ color: 'var(--ink-3)' }} /> : null}
      <input value={v} placeholder={placeholder} autoFocus={autoFocus} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      {unit ? <span className="unit">{unit}</span> : null}
    </div>
  )
}

export function Opt({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="opt">
      <div className="txt"><div className="l">{label}</div>{desc ? <div className="d">{desc}</div> : null}</div>
      <div className="ctl">{children}</div>
    </div>
  )
}

export function Sec({ children, first }: { children: ReactNode; first?: boolean }) {
  return <div className="sec" style={first ? { marginTop: 0 } : undefined}>{children}</div>
}

/** Closes on outside click or Escape. */
export function useDismiss(onClose: () => void, active = true) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // defer so the click that opened us doesn't close us
    const id = setTimeout(() => { document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey) }, 0)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose, active])
  return ref
}

export interface MenuItem { icon?: IconName; label: string; k?: string; danger?: boolean; onClick?: () => void; sub?: MenuItem[]; header?: boolean; sep?: boolean }

export function Menu({ x, y, items, onClose, width = 250, alignRight }: { x: number; y: number; items: MenuItem[]; onClose: () => void; width?: number; alignRight?: boolean }) {
  const ref = useDismiss(onClose)
  const [open, setOpen] = useState<number | null>(null)
  const left = alignRight ? Math.max(8, x - width) : Math.min(x, window.innerWidth - width - 8)
  const top = Math.min(y, window.innerHeight - 40 * items.length - 16)
  return (
    <div ref={ref} className="cmenu" style={{ left, top, width }} role="menu">
      {items.map((it, i) => it.sep ? <div key={i} className="sep" /> : it.header ? (
        <div key={i} className="it" style={{ color: 'var(--ink-3)', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', height: 24 }}>{it.label}</div>
      ) : (
        <div key={i} className={'it' + (it.danger ? ' danger' : '') + (it.sub ? ' qpos' : '') + (open === i ? ' hl' : '')} role="menuitem"
          onMouseEnter={() => setOpen(it.sub ? i : null)}
          onClick={it.sub ? undefined : () => { it.onClick?.(); onClose() }}>
          {it.icon ? <Icon name={it.icon} /> : <span style={{ width: 15 }} />}
          {it.label}
          {it.k ? <span className="k">{it.k}</span> : null}
          {it.sub ? <Icon name="chev" className="chev" /> : null}
          {it.sub && open === i ? (
            <div className="cmenu sub" style={{ left: left + width + 200 > window.innerWidth ? undefined : 'calc(100% + 4px)', right: left + width + 200 > window.innerWidth ? 'calc(100% + 4px)' : undefined }}>
              {it.sub.map((s, j) => <div key={j} className="it" role="menuitem" onClick={() => { s.onClick?.(); onClose() }}>{s.icon ? <Icon name={s.icon} /> : null}{s.label}</div>)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
