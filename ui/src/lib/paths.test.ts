import { describe, expect, it } from 'vitest'
import { mountOf } from './paths'

describe('mountOf', () => {
  it('is the base for the base itself and anything under it', () => {
    expect(mountOf('/data/torrents', '/data/torrents')).toBe('/data/torrents')
    expect(mountOf('/data/torrents/iso/x', '/data/torrents')).toBe('/data/torrents')
  })
  it('does not treat a sibling with the same prefix as under the base', () => {
    expect(mountOf('/data/torrents2/iso', '/data/torrents')).toBe('/data/torrents2')
  })
  it('falls back to the first two components', () => {
    expect(mountOf('/mnt/disk2/films/x', '/data/torrents')).toBe('/mnt/disk2')
    expect(mountOf('/mnt', '')).toBe('/mnt')
  })
})
