import { describe, expect, it } from 'vitest'
import { createOrphans, orphanRoute } from './orphans.ts'

const NOW = 1_760_000_000

describe('sim orphan routes', () => {
  it('answers 404 when the finder is off', () => {
    expect(orphanRoute(createOrphans(false, NOW), 'GET', '', '', NOW).status).toBe(404)
  })

  it('scans, keeps, deletes and refuses like the backend', () => {
    const s = createOrphans(true, NOW)
    expect(orphanRoute(s, 'GET', '', '', NOW).body).toMatchObject({ config: '/config', kept: [] })
    const scan = orphanRoute(s, 'POST', '/scan', '', NOW)
    const result = (scan.lines!.at(-1) as { result: { scan_id: string; entries: { id: string }[] } }).result
    expect(result.entries).toHaveLength(10)
    const ref = (id: string) => JSON.stringify({ scan_id: result.scan_id, id })

    expect(orphanRoute(s, 'POST', '/keep', ref('e1'), NOW).status).toBe(200)
    expect(s.kept).toHaveLength(1)
    expect(orphanRoute(s, 'POST', '/unkeep', ref('e1'), NOW).status).toBe(200)
    expect(s.kept).toHaveLength(0)
    orphanRoute(s, 'POST', '/keep', ref('e1'), NOW)
    expect(orphanRoute(s, 'POST', '/forget', '', NOW).status).toBe(200)
    expect(s.kept).toHaveLength(0)

    expect(orphanRoute(s, 'POST', '/delete', ref('e4'), NOW).status).toBe(200)
    expect(orphanRoute(s, 'POST', '/delete', ref('e3'), NOW).status).toBe(409)
    expect(orphanRoute(s, 'POST', '/delete', ref('e5'), NOW).status).toBe(500)
    expect(orphanRoute(s, 'POST', '/delete', JSON.stringify({ scan_id: 'old', id: 'e1' }), NOW).status).toBe(410)
    expect(orphanRoute(s, 'POST', '/delete', 'not json', NOW).status).toBe(400)
    expect(orphanRoute(s, 'GET', '/nope', '', NOW).status).toBe(404)

    // A kept path stays hidden from the next scan.
    orphanRoute(s, 'POST', '/keep', ref('e1'), NOW)
    const again = orphanRoute(s, 'POST', '/scan', '', NOW)
    const r2 = (again.lines!.at(-1) as { result: { hidden_kept: number; entries: unknown[] } }).result
    expect(r2.hidden_kept).toBe(1)
    expect(r2.entries).toHaveLength(8)
  })
})
