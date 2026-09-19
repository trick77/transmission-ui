// The app's mark: a filled gradient chip with an arrow-into-tray painted
// through it in the app's ground colour.
//
// This is NOT one of the sprite icons in Icon.tsx. Those are 1.75-unit stroked
// outlines on currentColor; this is filled geometry with its own gradient, and
// it is the same geometry the favicon ships — see ui/icons/icon.svg for why the
// glyph is filled rather than stroked (a 2-unit stroke vanishes at 16px), why
// the mark is painted #1f1f1e rather than knocked through, and where the
// transform numbers come from.
//
// Mirrored by hand in design/src/shell-top.html and in the login page's chip in
// backend/internal/httpapi/login.go. Change the shape in ui/icons/icon.svg
// first, then carry it into all three.
//
// viewBox is the chip's true bbox, so the mark fills the box it is given with
// no padding of its own.
export function BrandMark() {
  return (
    <svg className="logo" viewBox="3 3 18 18" aria-hidden="true">
      <linearGradient id="brand-grad" x1="0" y1="0" x2="0.72" y2="1">
        <stop offset="0" stopColor="#e08a68" />
        <stop offset="1" stopColor="#c25f34" />
      </linearGradient>
      <rect x="3" y="3" width="18" height="18" rx="4" fill="url(#brand-grad)" />
      <g transform="translate(4.1238 3.8284) scale(0.65635)" fill="#1f1f1e">
        <path d="M10.5 3.4h3v9.6h-3z" />
        <path d="M5.5 9.9 7.6 7.8 12 12.2l4.4-4.4 2.1 2.1-6.5 6.5z" />
        <path d="M3.2 14.9h3v3.6h11.6v-3.6h3v6.6H3.2z" />
      </g>
    </svg>
  )
}
