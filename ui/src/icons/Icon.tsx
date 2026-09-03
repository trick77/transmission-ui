// Generated from the <symbol> sprite in design/src/head.html.
import type { CSSProperties } from 'react'

export const ICON_PATHS = {
  search: "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/>",
  plus: "<path d=\"M12 5v14M5 12h14\"/>",
  down: "<path d=\"M12 5v14M6 13l6 6 6-6\"/>",
  up: "<path d=\"M12 19V5M6 11l6-6 6 6\"/>",
  play: "<path d=\"M7 5v14l11-7z\"/>",
  pause: "<path d=\"M8 5v14M16 5v14\"/>",
  trash: "<path d=\"M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3\"/>",
  gear: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z\"/>",
  turtle: "<path d=\"M3 14h2a7 7 0 0 1 14 0h2M5 14v3h2v-3M17 14v3h2v-3M8 14v2M12 14v2M16 14v2\"/><path d=\"M12 7V5\"/>",
  x: "<path d=\"M6 6l12 12M18 6 6 18\"/>",
  chev: "<path d=\"m9 6 6 6-6 6\"/>",
  chevd: "<path d=\"m6 9 6 6 6-6\"/>",
  folder: "<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>",
  file: "<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5\"/>",
  magnet: "<path d=\"M6 4v8a6 6 0 0 0 12 0V4M6 4h4v8a2 2 0 0 0 4 0V4h4\"/>",
  link: "<path d=\"M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1\"/><path d=\"M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1\"/>",
  sun: "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4\"/>",
  moon: "<path d=\"M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z\"/>",
  check: "<path d=\"m5 12 5 5 9-10\"/>",
  more: "<circle cx=\"12\" cy=\"5\" r=\"1.2\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\"/><circle cx=\"12\" cy=\"19\" r=\"1.2\"/>",
  tag: "<path d=\"M3 12V4h8l10 10-8 8z\"/><circle cx=\"7.5\" cy=\"8.5\" r=\"1.2\"/>",
  globe: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18\"/>",
  upload: "<path d=\"M12 16V4M6 10l6-6 6 6M4 20h16\"/>",
  sort: "<path d=\"M12 5v14M8 15l4 4 4-4\"/>",
} as const

export type IconName = keyof typeof ICON_PATHS

export function Icon({ name, size, className, style, title }: { name: IconName; size?: number; className?: string; style?: CSSProperties; title?: string }) {
  const s = size ? { width: size, height: size, ...style } : style
  return (
    <svg className={'i' + (className ? ' ' + className : '')} style={s} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <g dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }} />
    </svg>
  )
}
