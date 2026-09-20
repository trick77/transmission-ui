import { describe, expect, it } from 'vitest'
import { removalOf } from './List'
import type { Removing } from '../state/store'

const base: Removing = { ids: [1, 2, 3], done: 0, active: null, failed: [], deleteData: true, stopped: false }

describe('removalOf', () => {
  it('says nothing when no removal is running', () => {
    expect(removalOf(null, 1)).toBeNull()
  })

  it('leaves torrents outside the batch alone', () => {
    expect(removalOf(base, 99)).toBeNull()
  })

  it('queues the ones not started yet', () => {
    expect(removalOf(base, 2)).toEqual({ kind: 'queued', text: 'Queued for removal' })
  })

  it('names what is happening to the torrent being unlinked', () => {
    expect(removalOf({ ...base, active: 2 }, 2)).toEqual({ kind: 'active', text: 'Deleting files…' })
  })

  it('words remove-from-list differently from remove-and-delete', () => {
    expect(removalOf({ ...base, active: 2, deleteData: false }, 2)).toEqual({ kind: 'active', text: 'Removing…' })
  })

  it('keeps a failed torrent marked with its reason', () => {
    const r: Removing = { ...base, done: 3, failed: [{ id: 2, msg: 'permission denied' }] }
    expect(removalOf(r, 2)).toEqual({ kind: 'failed', text: 'Failed: permission denied' })
  })

  it('reports a failure even after the run stopped', () => {
    const r: Removing = { ...base, stopped: true, failed: [{ id: 2, msg: 'nope' }] }
    expect(removalOf(r, 2)?.kind).toBe('failed')
  })

  it('releases the untouched rows once the run is stopped', () => {
    expect(removalOf({ ...base, stopped: true }, 3)).toBeNull()
  })
})
