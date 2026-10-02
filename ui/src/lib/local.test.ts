import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readLocal, writeLocal } from './local'

beforeEach(() => { localStorage.clear() })

describe('readLocal / writeLocal', () => {
  it('round-trips JSON', () => {
    writeLocal('k', { a: [1, 2] })
    expect(readLocal('k', null)).toEqual({ a: [1, 2] })
  })
  it('answers the default for a missing or unreadable value', () => {
    expect(readLocal('missing', 7)).toBe(7)
    localStorage.setItem('k', 'not json')
    expect(readLocal('k', 7)).toBe(7)
  })
  it('swallows a storage that refuses writes', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => writeLocal('k', 1)).not.toThrow()
    spy.mockRestore()
  })
})
