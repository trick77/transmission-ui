import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandMark } from './BrandMark'

describe('BrandMark', () => {
  it('draws a filled chip with the glyph painted through it', () => {
    const { container } = render(<BrandMark />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // The chip's true bbox, not the nominal 24x24 box: the mark fills whatever
    // box it is given.
    expect(svg!.getAttribute('viewBox')).toBe('3 3 18 18')

    // The chip is the ink. If this rect ever loses its gradient fill the mark
    // becomes a dark square on a dark header and silently disappears.
    const chip = container.querySelector('rect')
    expect(chip?.getAttribute('fill')).toBe('url(#brand-grad)')

    // Three filled paths -- stem, chevron, tray -- painted the app ground
    // rather than stroked. A stroked glyph is what vanishes at favicon size,
    // and this component shares its geometry with ui/icons/icon.svg.
    const marks = container.querySelectorAll('g[fill="#1f1f1e"] path')
    expect(marks).toHaveLength(3)
    expect(container.querySelector('g[fill="#1f1f1e"]')?.getAttribute('transform'))
      .toBe('translate(4.1238 3.8284) scale(0.65635)')
  })

  it('is decorative, so screen readers skip it', () => {
    const { container } = render(<BrandMark />)
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})
