import { afterEach, describe, expect, it } from 'vitest'
import { publishScrollbarWidth } from './List'

// The header is not a scroll container, so it cannot use scrollbar-gutter to line
// up with the scrolling rows pane; List publishes the pane's real scrollbar width
// as --sbw and the header reserves it.
//
// This drives the measurement against known dimensions instead of through a
// mounted <List>: jsdom has no layout, so there offsetWidth and clientWidth are
// both 0 and any formula, inverted included, would look correct. The suite's
// ResizeObserver is a no-op stub (test-setup.ts), so a mount-only test would
// also pass with this logic deleted outright.

const sbw = () => document.documentElement.style.getPropertyValue('--sbw')

afterEach(() => document.documentElement.style.removeProperty('--sbw'))

describe('publishScrollbarWidth', () => {
  it('reserves the width a classic scrollbar takes from the rows pane', () => {
    expect(publishScrollbarWidth({ offsetWidth: 1476, clientWidth: 1466 })).toBe(10)
    expect(sbw()).toBe('10px')
  })

  it('reserves nothing on overlay scrollbars, where the pane loses no width', () => {
    // macOS trackpad scrollbars overlay the content, so a hardcoded 10px would
    // push the header out of line in the other direction.
    expect(publishScrollbarWidth({ offsetWidth: 1476, clientWidth: 1476 })).toBe(0)
    expect(sbw()).toBe('0px')
  })

  it('subtracts in the right order, so the gutter is never negative', () => {
    expect(publishScrollbarWidth({ offsetWidth: 1000, clientWidth: 980 })).toBe(20)
    expect(sbw()).toBe('20px')
  })
})
