import { useEffect, useRef, useState } from 'react'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebar, displayedSidebarW, get, set, writeLocal } from '../state/store'

const STEP = 16          // px per arrow key
const DOUBLE_TAP_MS = 350
const DRAG_SLOP = 3       // px of travel before a tap counts as a drag

/** Write the width to the DOM only. The CSS clamp on --sidebar-w does the viewport cap. */
function paint(w: number) {
  document.documentElement.style.setProperty('--sidebar-pref', w + 'px')
}

/**
 * Drag handle on the sidebar's right edge.
 *
 * Pointer Events throughout, so mouse, trackpad, Apple Pencil and finger all take one
 * code path. During a drag only the CSS variable and local state move: the store's
 * useSnap subscribers read the whole snapshot, so a set() per pointermove would
 * re-render the row list on every frame. The store and localStorage are written once,
 * on release.
 *
 * Reset is a double-tap, detected from pointer timestamps rather than onDoubleClick:
 * Safari only synthesises dblclick from a double-tap under conditions we would rather
 * not depend on, and on a tablet this is the only way back to the default width.
 */
export function SidebarResizer() {
  const [w, setW] = useState(() => get().sidebarW)
  const lastDown = useRef(-Infinity)
  // The live width during a drag. State alone is not enough: the pointerup handler
  // closes over the w of the render that ran when the drag began, so committing that
  // would snap the sidebar back to its pre-drag width.
  const live = useRef(w)
  const moved = useRef(false)
  const active = useRef<number | null>(null)   // the pointer that owns the drag
  // Grab point, so the edge does not jump to the finger. `w` is where the edge sits
  // on screen and `pref` the number behind it; under the 40vw cap they differ, and
  // the drag picks between them by direction.
  const start = useRef({ x: 0, w: 0, pref: 0 })

  // aria-valuenow reports the DISPLAYED width, which the 40vw cap moves with the
  // window. CSS repaints the edge on a resize but React does not re-render, so
  // without this the separator kept announcing the width from the last render:
  // wrong as the preference AND wrong as the edge. Only the rendered output
  // depends on this, so a bare re-render is the whole job.
  const [, bumpOnResize] = useState(0)
  useEffect(() => {
    const onResize = () => bumpOnResize(n => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  function commit(next: number) {
    live.current = next
    setW(next)
    paint(next)
    set({ sidebarW: next })
    writeLocal('tm.sidebar-w', next)
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (active.current !== null) return        // a drag is already running; ignore a second finger
    const now = performance.now()
    // Touch only, and literally so: pointerType === 'touch', not "anything but a
    // mouse". The reset exists because a finger has no other way back to the
    // default -- no arrow keys, no Home. A pen comes with a keyboard that has
    // both, so a stray double-tap with it would throw a stored width away for
    // nothing, which is the same accident this gate removes for the mouse.
    if (e.pointerType === 'touch' && now - lastDown.current < DOUBLE_TAP_MS) {
      lastDown.current = -Infinity
      commit(SIDEBAR_DEFAULT)
      return
    }
    lastDown.current = now
    active.current = e.pointerId
    // Seed from the RENDERED width, not the preference: --sidebar-w is clamped to
    // 40vw, so on any viewport under 1050px (every iPad) the two diverge and an
    // offset drag would spend that difference moving nothing.
    start.current = { x: e.clientX, w: displayedSidebarW(live.current), pref: live.current }
    moved.current = false
    e.preventDefault()
    // preventDefault suppresses the compatibility mousedown, and with it the focus it
    // would have given us. Focus explicitly, or the arrow keys do nothing until the
    // user tabs to the handle — and App's global keydown would claim them instead.
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture?.(e.pointerId)   // jsdom has no pointer capture
    document.body.classList.add('resizing')
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (active.current !== e.pointerId) return
    // Below the slop this is still a tap: iPad Safari emits a pixel of jitter during
    // one, and treating that as a drag both nudged the edge and disarmed the
    // double-tap reset — the only way a finger has back to the default width.
    const dx = e.clientX - start.current.x
    if (!moved.current && Math.abs(dx) < DRAG_SLOP) return
    moved.current = true
    // Offset from the grab point, not the raw clientX: grabbing the handle off-centre
    // would otherwise snap the border to the pointer by up to half the hit area.
    // Direction decides which number the travel applies to, because under the cap the
    // preference sits above the visible edge.
    //   widening: from the PREFERENCE, so a 5px nudge on an iPad does not write the
    //             capped 410 over the 420 a desktop session set.
    //   narrowing: from the EDGE, which is what the finger is actually on.
    const from = dx < 0 ? start.current.w : start.current.pref
    const next = clampSidebar(from + dx)
    live.current = next
    setW(next)
    paint(next)
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (active.current !== e.pointerId) return
    active.current = null
    document.body.classList.remove('resizing')
    // Commit before releasing capture: releasePointerCapture throws NotFoundError when
    // the pointer is already gone, which is exactly the pointercancel case, and the
    // throw would skip the commit and lose the drag.
    // A completed drag must not arm the double-tap window either: re-grabbing the
    // handle within 350ms to fine-tune would snap the width back to the default.
    if (moved.current) { lastDown.current = -Infinity; commit(live.current) }
    // The spec releases capture AFTER dispatching pointercancel, and NotFoundError
    // keys on whether the pointer is still active rather than on capture state, so
    // hasPointerCapture is not a reliable guard. Capture is released implicitly
    // anyway; this is belt and braces.
    try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* already gone */ }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Mirrors the drag: narrowing steps the edge the user can see, so the first press
    // always moves something; widening steps the preference, so travel above the cap
    // is kept for the window that can show it.
    if (e.key === 'ArrowLeft') commit(clampSidebar(displayedSidebarW(live.current) - STEP))
    else if (e.key === 'ArrowRight') commit(clampSidebar(live.current + STEP))
    else if (e.key === 'Home') commit(SIDEBAR_DEFAULT)
    else return
    e.preventDefault()
  }

  return (
    <div
      className="side-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      // The DISPLAYED width, not the preference: the separator is where the clamp puts
      // it, and announcing 420 while it sits at 410 describes a sidebar that is not
      // on screen. The max moves with the cap for the same reason.
      aria-valuenow={displayedSidebarW(w)}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={displayedSidebarW(SIDEBAR_MAX)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  )
}
