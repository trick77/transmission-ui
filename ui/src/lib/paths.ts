// Path arithmetic the app and the simulator have to agree on. No imports: ui/sim runs this
// file under Node's type stripping.

/** Base download dir if the path is under it, else the path's first two components. */
export function mountOf(dir: string, base: string): string {
  if (base && (dir === base || dir.startsWith(base + '/'))) return base
  const parts = dir.split('/').filter(Boolean)
  return '/' + parts.slice(0, Math.min(2, parts.length)).join('/')
}
