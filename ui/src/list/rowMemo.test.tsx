import { memo, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { App } from '../app/App'
import { set, startPolling } from '../state/store'
import { installFakeDaemon, type FakeDaemon } from '../test/fakeDaemon'

// Counts how often List's props get past memo. The real Row is memo too, so whatever
// re-renders this stand-in re-renders the real thing.
const renders: number[] = []
vi.mock('./Row', async importOriginal => {
  const real = await importOriginal<typeof import('./Row')>()
  type Props = ComponentProps<typeof real.Row>
  return { ...real, Row: memo(function Counted(p: Props) { renders.push(p.t.id); return <real.Row {...p} /> }) }
})

let daemon: FakeDaemon
afterEach(() => { daemon?.restore() })

it('a poll re-renders only the rows whose torrent changed', async () => {
  daemon = installFakeDaemon()
  set({ density: 'comfortable' })
  render(<App />)
  startPolling()
  await waitFor(() => expect(document.querySelectorAll('.row')).toHaveLength(8))
  renders.length = 0
  daemon.torrents[1].peers_connected = 77   // id 2
  await waitFor(() => expect(document.querySelector('.row[data-id="2"]')).toHaveTextContent('of 77 peers'), { timeout: 4000 })
  expect(new Set(renders)).toEqual(new Set([2]))
  // and a tick that brings nothing re-renders none
  renders.length = 0
  await new Promise(r => setTimeout(r, 2200))
  expect(renders).toEqual([])
}, 10000)
