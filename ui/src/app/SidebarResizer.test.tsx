import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SidebarResizer } from './SidebarResizer'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebar, get, set } from '../state/store'

const handle = () => document.querySelector('.side-resizer') as HTMLElement
const pref = () => document.documentElement.style.getPropertyValue('--sidebar-pref')
const stored = () => JSON.parse(localStorage.getItem('tm.sidebar-w') || 'null')

beforeEach(() => {
  localStorage.clear()
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
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0, timeStamp: 1000 })
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
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0, timeStamp: 1000 })
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
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'touch' })
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
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0 })
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
    fireEvent.pointerDown(h, { pointerId: 1, pointerType: 'mouse', button: 0, timeStamp: 1000 })
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

  // The tablet's only way back to the default: no context menu, no dblclick to rely on.
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
