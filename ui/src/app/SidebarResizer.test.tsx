import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SidebarResizer } from './SidebarResizer'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebar, displayedSidebarW, get, set } from '../state/store'

const handle = () => document.querySelector('.side-resizer') as HTMLElement
/** Press on the handle at the current border, so a move to x yields a width of x. */
const grab = (h: HTMLElement, pointerId = 1, pointerType = 'mouse') =>
  fireEvent.pointerDown(h, { pointerId, pointerType, button: 0, clientX: get().sidebarW })
const pref = () => document.documentElement.style.getPropertyValue('--sidebar-pref')
const stored = () => JSON.parse(localStorage.getItem('tm.sidebar-w') || 'null')

/** jsdom reports 1024 by default; the clamp keys on 40vw, so tests set it. */
function withViewport(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width })
}

beforeEach(() => {
  localStorage.clear()
  withViewport(1600)   // 40vw = 640, so the 420 max is the binding cap
  document.documentElement.style.removeProperty('--sidebar-pref')
  set({ sidebarW: SIDEBAR_DEFAULT })
})
afterEach(() => { cleanup(); document.body.classList.remove('resizing'); vi.restoreAllMocks() })

describe('clampSidebar', () => {
  it('holds the bounds and rounds', () => {
    expect(clampSidebar(300)).toBe(300)
    expect(clampSidebar(20)).toBe(SIDEBAR_MIN)
    expect(clampSidebar(9999)).toBe(SIDEBAR_MAX)
    expect(clampSidebar(240.6)).toBe(241)
  })

  // The viewport cap is the CSS clamp on --sidebar-w, deliberately not here: clamping
  // to the window and storing the result would lose the preference on an iPad rotation.
  it('ignores the viewport', () => {
    expect(clampSidebar(SIDEBAR_MAX)).toBe(SIDEBAR_MAX)
  })
})

describe('displayedSidebarW', () => {
  // Mirrors the CSS clamp in app.css, so the two must not be able to disagree.
  it('mirrors the clamp it stands in for', () => {
    withViewport(1600)              // 40vw = 640, so the 420 max wins
    expect(displayedSidebarW(420)).toBe(420)
    expect(displayedSidebarW(100)).toBe(SIDEBAR_MIN)
    withViewport(1024)              // iPad portrait: 40vw = 409.6 wins over the max
    expect(displayedSidebarW(420)).toBe(410)
    withViewport(400)               // 40vw = 160, below the min, so the min wins
    expect(displayedSidebarW(300)).toBe(SIDEBAR_MIN)
  })
})

describe('SidebarResizer', () => {
  it('exposes the separator semantics screen readers need', () => {
    render(<SidebarResizer />)
    const h = handle()
    expect(h).toHaveAttribute('role', 'separator')
    expect(h).toHaveAttribute('aria-orientation', 'vertical')
    expect(h).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT))
    expect(h).toHaveAttribute('aria-valuemin', String(SIDEBAR_MIN))
    expect(h).toHaveAttribute('aria-valuemax', String(SIDEBAR_MAX))
    expect(h.tabIndex).toBe(0)
  })

  it('widens and narrows with the arrow keys, and persists', () => {
    render(<SidebarResizer />)
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(pref()).toBe('240px')
    expect(get().sidebarW).toBe(240)
    expect(stored()).toBe(240)

    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(pref()).toBe('224px')
    expect(stored()).toBe(224)
  })

  it('clamps at both ends instead of running away', () => {
    set({ sidebarW: SIDEBAR_MAX })
    render(<SidebarResizer />)
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(get().sidebarW).toBe(SIDEBAR_MAX)

    cleanup()
    set({ sidebarW: SIDEBAR_MIN })
    render(<SidebarResizer />)
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(get().sidebarW).toBe(SIDEBAR_MIN)
  })

  it('ignores keys it does not own', () => {
    render(<SidebarResizer />)
    fireEvent.keyDown(handle(), { key: 'a' })
    expect(pref()).toBe('')
    expect(localStorage.getItem('tm.sidebar-w')).toBeNull()
  })

  it('resets to the default on Home', () => {
    set({ sidebarW: 400 })
    render(<SidebarResizer />)
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(get().sidebarW).toBe(SIDEBAR_DEFAULT)
  })

  it('resizes on a pointer drag and stores once, on release', () => {
    render(<SidebarResizer />)
    const h = handle()
    grab(h)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 })
    expect(pref()).toBe('300px')
    expect(localStorage.getItem('tm.sidebar-w')).toBeNull()   // nothing written mid-drag

    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(300)
    expect(stored()).toBe(300)
    expect(document.body.classList.contains('resizing')).toBe(false)
  })

  it('clamps a drag past the edges', () => {
    render(<SidebarResizer />)
    const h = handle()
    grab(h)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 20 })
    expect(pref()).toBe(SIDEBAR_MIN + 'px')
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 5000 })
    expect(pref()).toBe(SIDEBAR_MAX + 'px')
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(stored()).toBe(SIDEBAR_MAX)
  })

  // Regression: the double-tap window compared against a 0 sentinel, and
  // performance.now() is milliseconds since page load — so the very first drag on a
  // freshly loaded page was swallowed as a double tap and never resized anything.
  it('drags on the first interaction after load', () => {
    vi.spyOn(performance, 'now').mockReturnValue(120)   // 120ms after load
    render(<SidebarResizer />)
    const h = handle()
    grab(h, 1, 'touch')
    expect(document.body.classList.contains('resizing')).toBe(true)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 })
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(300)
  })

  // Regression: pointerup used to commit the w captured when the drag began, so a real
  // browser (which batches the moves into one render) snapped back to the old width.
  it('commits the last dragged width, not the width at pointerdown', () => {
    render(<SidebarResizer />)
    const h = handle()
    grab(h)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 })
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 360 })
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(360)
    expect(stored()).toBe(360)
    expect(pref()).toBe('360px')
  })

  it('ignores a move that is not part of a drag', () => {
    render(<SidebarResizer />)
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 300 })
    expect(pref()).toBe('')
  })

  it('treats pointercancel like a release', () => {
    render(<SidebarResizer />)
    const h = handle()
    grab(h)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 320 })
    fireEvent.pointerCancel(h, { pointerId: 1 })
    expect(stored()).toBe(320)
    expect(document.body.classList.contains('resizing')).toBe(false)
  })

  it('ignores a non-primary mouse button', () => {
    render(<SidebarResizer />)
    const h = handle()
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 2, timeStamp: 1000 })
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 })
    expect(pref()).toBe('')
  })

  // Review finding: the drag used the raw clientX, so grabbing the handle off-centre
  // snapped the border to the pointer — up to 18px on the coarse hit area.
  it('moves by the grab offset, not to the pointer', () => {
    render(<SidebarResizer />)
    const h = handle()
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 230 })  // 6px right of the border
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 260 })   // travelled +30
    expect(pref()).toBe('254px')                                // 224 + 30, not 260
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(254)
  })

  // Review finding: iPad Safari emits a pixel of jitter during a plain tap. Treating
  // that as a drag nudged the edge and disarmed the double-tap reset, which is the
  // only way a finger has back to the default width.
  it('ignores tap jitter, so a jittery double tap still resets', () => {
    const clock = vi.spyOn(performance, 'now')
    set({ sidebarW: 400 })
    render(<SidebarResizer />)
    const h = handle()

    clock.mockReturnValue(1000)
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'touch', clientX: 400 })
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 401 })   // 1px of jitter
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(400)                            // the tap moved nothing
    expect(localStorage.getItem('tm.sidebar-w')).toBeNull()

    clock.mockReturnValue(1150)
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'touch', clientX: 400 })
    expect(get().sidebarW).toBe(SIDEBAR_DEFAULT)                // the reset still fires
  })

  // Review finding: releasePointerCapture throws NotFoundError once the pointer is
  // gone, which is the pointercancel case, and the throw skipped the commit.
  it('commits before it releases capture, and skips the release once it is gone', () => {
    render(<SidebarResizer />)
    const h = handle()
    const order: string[] = []
    // Chrome throws NotFoundError from releasePointerCapture once the pointer is gone,
    // which is the pointercancel case. Guarding on hasPointerCapture avoids the throw;
    // committing first means even a throw could not cost us the drag.
    // Chrome can throw NotFoundError here on pointercancel. The commit must already
    // have happened, and the throw must not escape.
    h.hasPointerCapture = () => true
    h.releasePointerCapture = () => { order.push('release'); throw new DOMException('gone', 'NotFoundError') }
    // test-setup.ts swaps in its own storage object, so spy on the instance.
    vi.spyOn(localStorage, 'setItem')
    const seen = vi.mocked(localStorage.setItem)

    grab(h)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 })
    fireEvent.pointerCancel(h, { pointerId: 1 })

    expect(get().sidebarW).toBe(300)
    expect(seen).toHaveBeenCalledWith('tm.sidebar-w', '300')   // committed despite the throw
    expect(order).toEqual(['release'])                          // and the throw was swallowed
  })

  // Review finding: a completed drag used to arm the double-tap window, so re-grabbing
  // the handle within 350ms to fine-tune snapped the sidebar back to the default.
  it('does not treat a re-grab right after a drag as a double tap', () => {
    const clock = vi.spyOn(performance, 'now')
    render(<SidebarResizer />)
    const h = handle()
    clock.mockReturnValue(1000)
    grab(h)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 })
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(300)

    clock.mockReturnValue(1100)                 // 100ms later: inside the tap window
    grab(h)
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 316 })
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(316)            // fine-tuned, not reset to 224
  })

  // Review finding: a second finger landing mid-drag used to hijack the drag state and
  // leave the painted width out of step with the store.
  it('ignores a second pointer during a drag', () => {
    render(<SidebarResizer />)
    const h = handle()
    grab(h, 1, 'touch')
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 320 })
    fireEvent.pointerDown(h, { pointerId: 2, pointerType: 'touch', clientX: 320 })
    fireEvent.pointerMove(h, { pointerId: 2, clientX: 200 })
    fireEvent.pointerUp(h, { pointerId: 2 })
    expect(pref()).toBe('320px')                // finger 2 moved nothing
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 340 })
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(340)
    expect(stored()).toBe(340)
    expect(pref()).toBe('340px')
  })

  // preventDefault on pointerdown kills the compatibility mousedown, and with it focus.
  it('focuses the handle on grab, so the arrow keys work straight after', () => {
    render(<SidebarResizer />)
    const h = handle()
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0 })
    expect(document.activeElement).toBe(h)
  })

  // The reset is a TOUCH gesture, and a mouse must not trigger it: the strip
  // straddles the border, so an ordinary double-click a couple of pixels into the
  // list used to throw a stored width away with nothing to undo it. A mouse has
  // the arrow keys and Home, which is the route back it is meant to use.
  it('does not reset on a mouse double-click', () => {
    const clock = vi.spyOn(performance, 'now')
    set({ sidebarW: 380 })
    render(<SidebarResizer />)
    const h = handle()

    clock.mockReturnValue(1000)
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0 })
    fireEvent.pointerUp(h, { pointerId: 1 })
    clock.mockReturnValue(1100)              // well inside the tap window
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0 })
    fireEvent.pointerUp(h, { pointerId: 1 })

    expect(get().sidebarW).toBe(380)         // the width survives the double-click
    expect(localStorage.getItem('tm.sidebar-w')).toBeNull()
  })

  // The tablet's only way back to the default: no context menu, no dblclick to rely on.
  // A widening drag under the cap used to land its travel on the RENDERED edge, so
  // a 5px nudge on an iPad wrote the capped 410 over the 420 a desktop session set.
  it('keeps a preference the cap is hiding when the drag widens', () => {
    withViewport(1024)              // 40vw = 410; the stored 420 shows as 410
    set({ sidebarW: SIDEBAR_MAX })
    render(<SidebarResizer />)
    const h = handle()
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 410 })
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 415 })
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(SIDEBAR_MAX)      // 420 survives, not cut to 415
    expect(stored()).toBe(SIDEBAR_MAX)
  })

  // Narrowing still works from the edge under the finger, so it tracks from the
  // first pixel rather than spending the gap between the two numbers.
  it('narrows from the edge the user can see', () => {
    withViewport(1024)
    set({ sidebarW: SIDEBAR_MAX })
    render(<SidebarResizer />)
    const h = handle()
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 410 })
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 370 })   // pull 40px left
    expect(pref()).toBe('370px')                                // tracked, no dead zone
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(370)
  })

  // aria-valuenow described a sidebar that is not on screen: it reported the
  // preference while the separator sat at the capped edge.
  it('announces where the separator actually is', () => {
    withViewport(1024)
    set({ sidebarW: SIDEBAR_MAX })
    render(<SidebarResizer />)
    expect(handle()).toHaveAttribute('aria-valuenow', '410')
    expect(handle()).toHaveAttribute('aria-valuemax', '410')
  })

  // CSS repaints the edge on a resize but React does not re-render, so the
  // separator went on announcing the width from the last render.
  it('re-announces the edge when the window changes size', async () => {
    withViewport(1600)
    set({ sidebarW: SIDEBAR_MAX })
    render(<SidebarResizer />)
    expect(handle()).toHaveAttribute('aria-valuenow', '420')

    withViewport(1024)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(handle()).toHaveAttribute('aria-valuenow', '410'))

    withViewport(1600)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(handle()).toHaveAttribute('aria-valuenow', '420'))
  })

  it('resets on a double tap', () => {
    const clock = vi.spyOn(performance, 'now')
    set({ sidebarW: 400 })
    render(<SidebarResizer />)
    const h = handle()
    clock.mockReturnValue(1000)
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(h, { pointerId: 1 })
    clock.mockReturnValue(1200)
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'touch' })
    expect(get().sidebarW).toBe(SIDEBAR_DEFAULT)
    expect(stored()).toBe(SIDEBAR_DEFAULT)
  })

  // Two deliberate taps are not a reset, and must not write the mount-time width back.
  it('does not reset two slow taps', () => {
    const clock = vi.spyOn(performance, 'now')
    set({ sidebarW: 400 })
    render(<SidebarResizer />)
    const h = handle()
    clock.mockReturnValue(1000)
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(h, { pointerId: 1 })
    clock.mockReturnValue(3000)
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(h, { pointerId: 1 })
    expect(get().sidebarW).toBe(400)
    expect(localStorage.getItem('tm.sidebar-w')).toBeNull()
  })
})
