// localStorage as JSON, tolerant of private mode and of values somebody edited by hand.

export function readLocal<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d }
}

export function writeLocal(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ }
}
