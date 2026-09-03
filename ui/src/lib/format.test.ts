import { describe, expect, it } from 'vitest'
import { ago, bytes, compact, dateTime, daysSince, duration, eta, gb, inFuture, percent, rate, rateParts, ratio, ratioValue } from './format'

describe('bytes', () => {
  it('formats SI units with sensible digits', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(999)).toBe('999 B')
    expect(bytes(1000)).toBe('1.00 kB')
    expect(bytes(12_345)).toBe('12.3 kB')
    expect(bytes(123_456_789)).toBe('123 MB')
    expect(bytes(4.71e9)).toBe('4.71 GB')
    expect(bytes(1.3e12)).toBe('1.30 TB')
    expect(bytes(-1)).toBe('—')
    expect(bytes(NaN)).toBe('—')
  })
  it('honours explicit digits', () => { expect(bytes(1536, 0)).toBe('2 kB') })
  it('gb converts', () => { expect(gb(2e9)).toBe(2) })
})

describe('rates', () => {
  it('rate hides zero', () => { expect(rate(0)).toBe('—'); expect(rate(12_400_000)).toBe('12.4 MB/s') })
  it('rateParts splits number and unit', () => { expect(rateParts(1_210_000)).toEqual(['1.21', 'MB/s']) })
})

describe('ratio / eta / duration', () => {
  it('ratio handles the daemon sentinels: -1 n/a, -2 infinite', () => {
    expect(ratio(-1)).toBe('—'); expect(ratio(-2)).toBe('∞'); expect(ratio(3.4167)).toBe('3.42')
    expect(ratioValue(-1)).toBe(0); expect(ratioValue(-2)).toBe(Infinity); expect(ratioValue(1.5)).toBe(1.5)
  })
  it('eta', () => { expect(eta(-1)).toBe('—'); expect(eta(10, true)).toBe('∞'); expect(eta(192)).toBe('3m 12s') })
  it('duration', () => {
    expect(duration(5)).toBe('5 s')
    expect(duration(3600 * 2 + 60 * 5)).toBe('2h 5m')
    expect(duration(86400 * 2 + 3600 * 4)).toBe('2d 4h')
  })
  it('ago / inFuture', () => {
    const now = Date.now() / 1000
    expect(ago(0)).toBe('—')
    expect(ago(now - 120)).toMatch(/^2m/)
    expect(inFuture(now - 1)).toBe('now')
    expect(inFuture(now + 300)).toMatch(/^in 5m/)
  })
})

describe('misc', () => {
  it('percent', () => { expect(percent(0.632)).toBe('63%'); expect(percent(0.632, 1)).toBe('63.2%') })
  it('compact', () => { expect(compact(12)).toBe('12'); expect(compact(1204)).toBe('1.2k'); expect(compact(12_040)).toBe('12k'); expect(compact(2_500_000)).toBe('2.5M') })
  it('daysSince', () => { expect(daysSince(0)).toBe(Infinity); expect(daysSince(Date.now() / 1000 - 86400 * 3)).toBeCloseTo(3, 1) })
  it('dateTime', () => {
    expect(dateTime(0)).toBe('—')
    expect(dateTime(Date.now() / 1000)).toMatch(/^Today, /)
    expect(dateTime(1_600_000_000)).toMatch(/2020/)
  })
})
