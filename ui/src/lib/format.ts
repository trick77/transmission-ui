// Number formatting. Transmission reports bytes and B/s; the UI shows SI units like the daemon's own tools.

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']

export function bytes(n: number, digits?: number): string {
  if (!isFinite(n) || n < 0) return '—'
  let i = 0
  let v = n
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++ }
  const d = digits ?? (i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0)
  return `${v.toFixed(d)} ${UNITS[i]}`
}

export function gb(n: number): number { return n / 1e9 }

export function rate(bps: number): string { return bps > 0 ? `${bytes(bps)}/s` : '—' }

/** Split a rate into number and unit so the unit can be styled smaller. */
export function rateParts(bps: number): [string, string] {
  const s = bytes(bps)
  const [num, unit] = s.split(' ')
  return [num, `${unit}/s`]
}

// Transmission sentinels: -1 = not available (nothing downloaded and nothing uploaded), -2 = infinite.
export const RATIO_NA = -1, RATIO_INF = -2
export function ratioValue(r: number): number { return r === RATIO_INF ? Infinity : r < 0 ? 0 : r }
export function ratio(r: number): string { return r === RATIO_INF ? '∞' : r < 0 ? '—' : r.toFixed(2) }

export function eta(seconds: number, finished = false): string {
  if (finished) return '∞'
  if (seconds < 0 || !isFinite(seconds)) return '—'
  return duration(seconds)
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m ${s % 60}s`
}

export function ago(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  const s = Math.max(0, Date.now() / 1000 - unixSeconds)
  return `${duration(s)} ago`
}

export function inFuture(unixSeconds: number): string {
  const s = unixSeconds - Date.now() / 1000
  return s <= 0 ? 'now' : `in ${duration(s)}`
}

export function dateTime(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  const d = new Date(unixSeconds * 1000)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? `Today, ${time}` : d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function percent(p: number, digits = 0): string { return `${(p * 100).toFixed(digits)}%` }

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function daysSince(unixSeconds: number): number { return unixSeconds ? (Date.now() / 1000 - unixSeconds) / 86400 : Infinity }

/** kB/s → B/s and back, for the daemon's limit fields which are in kB/s. */
export const KB = 1000
