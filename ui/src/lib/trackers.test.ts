import { describe, expect, it } from 'vitest'
import { TRACKER_NAMES, trackerName } from './trackers'

describe('trackerName', () => {
  it('matches any announce subdomain of a mapped domain', () => {
    expect(trackerName('t.myanonamouse.net')).toBe('MyAnonamouse')
    expect(trackerName('tracker.myanonamouse.net')).toBe('MyAnonamouse')
    expect(trackerName('myanonamouse.net')).toBe('MyAnonamouse')
  })

  it('walks past IP-looking labels', () => {
    // A real IPTorrents announce host.
    expect(trackerName('127.0.0.1.stackoverflow.tech')).toBe('IPTorrents')
  })

  it('gives one tracker the same name across unrelated announce domains', () => {
    const hosts = ['127.0.0.1.stackoverflow.tech', 'async.empirehost.me', 'routing.bgp.technology']
    expect(new Set(hosts.map(trackerName))).toEqual(new Set(['IPTorrents']))
  })

  it('returns an unmapped host unchanged, case intact', () => {
    expect(trackerName('tracker.dusty-attic.invalid')).toBe('tracker.dusty-attic.invalid')
    expect(trackerName('Tracker.Example.ORG')).toBe('Tracker.Example.ORG')
  })

  it('ignores case and a trailing dot', () => {
    expect(trackerName('T.MyAnonamouse.NET')).toBe('MyAnonamouse')
    expect(trackerName('myanonamouse.net.')).toBe('MyAnonamouse')
  })

  it('returns a single-label host unchanged', () => {
    expect(trackerName('localhost')).toBe('localhost')
    expect(trackerName('')).toBe('')
  })

  // The suffix walk would hand every .org tracker the same name if a bare
  // public suffix ever became a key.
  it('has no key that is a bare TLD or public suffix', () => {
    for (const key of Object.keys(TRACKER_NAMES)) {
      expect(key.split('.').length, key).toBeGreaterThanOrEqual(2)
      expect(key, key).toBe(key.toLowerCase())
      expect(key.startsWith('.') || key.endsWith('.'), key).toBe(false)
    }
  })
})
