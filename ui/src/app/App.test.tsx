import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { get, refreshNow, set, startPolling, type Density } from '../state/store'
import type { SortKey } from '../lib/model'
import { installFakeDaemon, torrent, type FakeDaemon } from '../test/fakeDaemon'
import { Status } from '../rpc/types'

let daemon: FakeDaemon

// The two-line row is the comfortable layout now, so the assertions that read the status
// chip and the peer line mount in it; the compact one-liner has tests of its own below.
function resetStore(density: Density = 'comfortable', sort: SortKey = 'state') {
  set({ torrents: [], byId: new Map(), detail: null, session: null, stats: null, history: [], freeSpace: new Map(), connection: 'connecting', lastError: '',
    filter: 'all', adv: {}, search: '', sort, sortDir: 1, selected: new Set(), focusId: null, inspectorTab: 'overview', dialog: { kind: 'none' }, dismissed: new Set(), toast: '', density, sidebarW: 224 })
}

async function mount(opts: Parameters<typeof installFakeDaemon>[0] & { density?: Density; sort?: SortKey } = {}) {
  daemon = installFakeDaemon(opts)
  resetStore(opts.density, opts.sort)
  const r = render(<App />)
  startPolling()
  refreshNow()
  if (!opts.unauthorized) await waitFor(() => expect(document.querySelectorAll('.row').length).toBeGreaterThan(0), { timeout: 4000 })
  return r
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/') })
afterEach(() => { daemon?.restore(); vi.restoreAllMocks() })

const row = (name: string) => screen.getByText(name).closest('.row') as HTMLElement
const closeDialog = async () => { fireEvent.click(document.querySelector('.modal-h button')!); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()) }
const selbar = () => document.getElementById('selbar') as HTMLElement
const rows = () => [...document.querySelectorAll<HTMLElement>('.row')]

describe('shell', () => {
  it('renders every daemon torrent with the right chips, problems first', async () => {
    await mount()
    expect(rows()).toHaveLength(8)
    expect(rows()[0]).toHaveTextContent('Apollo 11')          // error first
    expect(within(rows()[0]).getByText('Error')).toBeInTheDocument()
    expect(rows()[1]).toHaveTextContent('Cosmos Laundromat')  // tracker issue second
    expect(within(row('debian-13.1.0-amd64-DVD-1.iso')).getByText('Downloading')).toBeInTheDocument()
    expect(row('debian-13.1.0-amd64-DVD-1.iso')).toHaveTextContent('25 of 42 peers')
    expect(row('debian-13.1.0-amd64-DVD-1.iso')).toHaveTextContent('1.5k in swarm')
    expect(row('debian-13.1.0-amd64-DVD-1.iso')).toHaveTextContent('iso/')
    expect(within(row('Tears of Steel (2012) 4K')).getByText('Queued to seed')).toBeInTheDocument()
    expect(within(row('ubuntu-26.04.1-desktop-amd64.iso')).getByText('Verifying')).toBeInTheDocument()
    expect(row('ubuntu-26.04.1-desktop-amd64.iso')).toHaveTextContent('Verifying local data · 41%')
    expect(within(row('Pride and Prejudice — LibriVox')).getByText('Stopped')).toBeInTheDocument()
    expect(row('Pride and Prejudice — LibriVox')).toHaveTextContent('No peers')
  })

  it('compact density puts every torrent on one line, sorted by name', async () => {
    await mount({ density: 'compact', sort: 'name' })
    expect(rows()).toHaveLength(8)
    expect(rows().every(r => r.classList.contains('one'))).toBe(true)
    // name ascending, not the error torrent first
    expect(rows().map(r => r.querySelector('.name .t')!.textContent)).toEqual([
      'Apollo 11 Flight Journal', 'archlinux-2026.08.01-x86_64.iso', 'Big Buck Bunny (2008) 4K 60fps', 'Cosmos Laundromat (2015)',
      'debian-13.1.0-amd64-DVD-1.iso', 'Pride and Prejudice — LibriVox', 'Tears of Steel (2012) 4K', 'ubuntu-26.04.1-desktop-amd64.iso',
    ])


    const cols = document.querySelector('.cols') as HTMLElement
    for (const h of ['Name', 'Size', 'Progress', 'Seeds', 'Ratio', 'Uploaded', 'Added on', 'Last active', 'Tracker', 'Path']) {
      expect(within(cols).getByText(h)).toBeInTheDocument()
    }
    for (const gone of ['Down', 'Up', 'ETA']) expect(within(cols).queryByText(gone)).toBeNull()

    const deb = row('debian-13.1.0-amd64-DVD-1.iso')
    expect(deb).toHaveTextContent('5.2 GB')                 // uploaded, fixed to one decimal
    // the tracker cell shows the name; the announce host stays in the tooltip
    expect(deb.querySelector('.tcell')).toHaveTextContent('Debian')
    expect(deb.querySelector('.tcell')).toHaveAttribute('title', 'bttracker.debian.org')
    // Added on reads relative like Last active; the exact date is the cell's tooltip,
    // numeric because a localised month name is wider and would wrap the row.
    expect(deb).toHaveTextContent('3 days ago')
    const added = [...deb.querySelectorAll('span.num.r')].find(s => s.getAttribute('title'))!
    expect(added.getAttribute('title')).toMatch(/\d{2}[./-]\d{2}[./-]\d{4}|\d{4}-\d{2}-\d{2}/)
    expect(deb).toHaveTextContent('iso/')
    expect(deb.querySelector('.sdot.dl')).toBeInTheDocument()
    // the status word survives as a tooltip, since the second line is gone
    expect(deb.querySelector('.sdot')!.getAttribute('title')).toMatch(/^Downloading/)
    expect(row('Apollo 11 Flight Journal').querySelector('.sdot.err')).toHaveAttribute('title', 'No data found! Ensure your drives are connected')
    expect(row('Big Buck Bunny (2008) 4K 60fps').querySelector('.sdot.seed')).toBeInTheDocument()

    // the header must carry the same layout class as the rows, or the two grids drift apart
    expect(document.querySelector('.cols')!.classList.contains('one')).toBe(true)

    // labels read as names on one line too, not as a bare count
    const chips = [...deb.querySelectorAll('.chip.lbl')].map(c => c.textContent)
    expect(chips).toEqual(['linux'])
    expect(deb.querySelector('.lbl-n')).toBeNull()
    // and the peer counts the dropped line carried are on the status dot
    expect(deb.querySelector('.sdot')!.getAttribute('title')).toMatch(/of 42 peers/)
  })

  it('the dot and action tracks are headerless cells, and the open menu lights its row', async () => {
    await mount({ density: 'compact', sort: 'name' })
    const cols = document.querySelector('.cols') as HTMLElement
    // chk, dot, Name, actions, then the 9 labelled columns: the two extra cells carry no
    // label, and must not be sort triggers.
    expect(cols.children).toHaveLength(13)
    expect(cols.children[1]).toBeEmptyDOMElement()
    expect(cols.children[3]).toBeEmptyDOMElement()
    // Grid children and cells line up, or the tail auto-places into a second row.
    const r = row('Big Buck Bunny (2008) 4K 60fps')
    expect(r.children).toHaveLength(13)
    expect(r.children[1]).toHaveClass('sdot')
    expect(r.children[3]).toHaveClass('acts')
    // Hover ends when the pointer moves onto the menu, so the lit state is a class.
    expect(r).not.toHaveClass('menu-open')
    fireEvent.click(within(r).getByTitle('More'))
    expect(row('Big Buck Bunny (2008) 4K 60fps')).toHaveClass('menu-open')
    // useDismiss attaches its listeners in a timeout, so the opening click cannot close it.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(row('Big Buck Bunny (2008) 4K 60fps')).not.toHaveClass('menu-open'))
  })

  it('the action trigger is reachable by keyboard', async () => {
    await mount({ density: 'compact', sort: 'name' })
    const r = row('Big Buck Bunny (2008) 4K 60fps')
    const btn = within(r).getByTitle('More')
    btn.focus()
    expect(document.activeElement).toBe(btn)
    // opacity composes: the gate must lift on .acts, not on the button, or a focused
    // button at opacity 1 inside a parent at 0 still renders invisible.
    expect(r.matches(':focus-within')).toBe(true)
  })

  it('two-line rows get the action column but no dot track', async () => {
    await mount()
    const cols = document.querySelector('.cols') as HTMLElement
    // chk, Name, actions, then 6 labelled columns -- one fewer than compact: no dot.
    expect(cols.children).toHaveLength(9)
    expect(cols.children[2]).toBeEmptyDOMElement()
    const r = row('Big Buck Bunny (2008) 4K 60fps')
    expect(r.children).toHaveLength(9)
    expect(r.children[2]).toHaveClass('acts')
    expect(r.querySelector('.sdot')).toBeNull()
  })

  it('compact headers sort by the columns the one-liner adds', async () => {
    await mount({ density: 'compact', sort: 'name' })
    const cols = document.querySelector('.cols') as HTMLElement
    fireEvent.click(within(cols).getByText('Path'))
    expect(rows()[0]).toHaveTextContent('Pride and Prejudice')  // audiobooks/ first, text sorts A→Z
    fireEvent.click(within(cols).getByText('Path'))
    expect(rows()[0]).toHaveTextContent('Apollo 11')            // sonarr/docs/ last, so first descending
    fireEvent.click(within(cols).getByText('Ratio'))
    expect(rows()[0]).toHaveTextContent('Big Buck Bunny')       // 3.42, the highest
    fireEvent.click(within(cols).getByText('Seeds'))
    expect(rows()[0].querySelector('.sdot')).toBeInTheDocument()
  })

  it('header shows live speeds, session totals, and the stats popover', async () => {
    await mount()
    const speeds = document.querySelector('.speeds')!
    expect(speeds).toHaveTextContent('12.4')
    expect(speeds).toHaveTextContent('5.14 GB this session')
    fireEvent.click(speeds)
    expect(screen.getByText('Statistics')).toBeInTheDocument()
    expect(document.querySelector('.pop')).toHaveTextContent('218 GB')
    expect(document.querySelector('.pop')).toHaveTextContent('1.79')
    expect(document.querySelector('.pop')).toHaveTextContent('4.1.3')
    expect(document.querySelector('.pop')).toHaveTextContent('rpc 6.0.1')
    await new Promise(r => setTimeout(r, 0))   // useDismiss attaches its listeners on the next tick
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.pop')).toBeNull())
    fireEvent.click(speeds)
    await new Promise(r => setTimeout(r, 0))
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(document.querySelector('.pop')).toBeNull())
  })

  it('turtle toggles alt speed via session-set and shows the badge', async () => {
    await mount()
    fireEvent.click(document.getElementById('turtle')!)
    await waitFor(() => expect(daemon.of('session_set')[0]).toEqual({ 'alt_speed_enabled': true }))
    await waitFor(() => expect(document.querySelector('.speeds .lim')).toHaveTextContent('alt 2000/250'))
  })

  it('search narrows the list; ⌘F focuses the box; Escape clears selection', async () => {
    await mount()
    const input = screen.getByPlaceholderText('Search torrents') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'debian' } })
    expect(rows()).toHaveLength(1)
    fireEvent.click(input.parentElement!.querySelector('button')!)
    expect(rows()).toHaveLength(8)
    fireEvent.keyDown(document, { key: 'f', metaKey: true })
    expect(document.activeElement).toBe(input)
  })

  it('shows a sign-in screen when there is no session', async () => {
    await mount({ unauthorized: true })
    await screen.findByText(/Your session has ended/, {}, { timeout: 4000 })
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('shows the retry banner when the daemon is unreachable', async () => {
    await mount()
    // Drop the connection after the first successful poll: the banner switches
    // to the error wording and the list stays put.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'))
    await screen.findByText(/Can't reach the daemon/, {}, { timeout: 4000 })
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    // A daemon that is down is not an auth problem: the app stays on screen.
    expect(document.querySelector('.signin')).toBeNull()
    expect(document.querySelector('.sidebar')).toBeInTheDocument()
  })

  it('replaces the shell with a sign-in screen when the session is gone', async () => {
    await mount({ unauthorized: true })
    await screen.findByRole('button', { name: 'Sign in' }, { timeout: 4000 })
    // The point of the screen is that none of the app is behind it.
    expect(document.querySelector('.signin')).toBeInTheDocument()
    expect(document.querySelector('.sidebar')).toBeNull()
    expect(document.querySelector('.app')).toBeNull()
    expect(document.querySelectorAll('.row').length).toBe(0)
  })

  it('sends the sign-in button to the login endpoint', async () => {
    await mount({ unauthorized: true })
    const btn = await screen.findByRole('button', { name: 'Sign in' }, { timeout: 4000 })
    // jsdom will not navigate, and location.href has no spy-able setter, so
    // swap the whole object for the duration of the click.
    const real = window.location
    let target = ''
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...real, get href() { return target }, set href(v: string) { target = v } },
    })
    fireEvent.click(btn)
    Object.defineProperty(window, 'location', { configurable: true, value: real })
    expect(target).toBe('/api/auth/login')
  })
})

describe('sidebar', () => {
  it('hides status filters that match nothing, keeping All, Active, Error and the active one', async () => {
    // One seeding torrent: Downloading, Stopped, Error and friends all match zero.
    await mount({ torrents: [torrent({ id: 1, name: 'Solo', status: Status.Seed, percent_done: 1 })] })
    const side = document.querySelector('.sidebar')!
    const shown = () => [...side.querySelectorAll('[data-f]')].map(b => b.getAttribute('data-f'))
    expect(shown()).toContain('all')
    // Seeding has no entry of its own: a finished, seeding torrent reads as Completed.
    expect(shown()).not.toContain('seed')
    expect(shown()).toContain('finished')
    expect(shown()).not.toContain('download')
    // Checking only appears while something is actually checking.
    expect(shown()).not.toContain('queued')
    // Active and Error are pinned: the sidebar keeps a stable shape, and an
    // empty Error is itself the answer to "is anything broken?".
    expect(shown()).toContain('active')
    expect(shown()).toContain('error')
    expect(side.querySelector('[data-f="error"] .cnt')).toHaveTextContent('0')

    // The active filter stays visible even once it matches nothing, or picking it
    // would remove it from the sidebar and strand the user on an empty list.
    act(() => { set({ filter: 'stopped' }) })
    expect(shown()).toContain('stopped')
  })

  it('status counts, labels, folders, disk and tracker health', async () => {
    await mount()
    const side = document.querySelector('.sidebar')!
    const cnt = (f: string) => side.querySelector(`[data-f="${f}"] .cnt`)!.textContent
    expect(cnt('all')).toBe('8'); expect(cnt('download')).toBe('1'); expect(cnt('active')).toBe('2')
    expect(side.querySelector('[data-f="seed"]')).toBeNull()   // Seeding is off the list
    expect(cnt('finished')).toBe('4'); expect(cnt('queued')).toBe('1');   // Check only; the SeedWait/DownloadWait pair counts as Inactive expect(cnt('stopped')).toBe('1'); expect(cnt('error')).toBe('2')   // one daemon error plus the failing-tracker torrents, deduped
    expect(within(side as HTMLElement).getByText('blender')).toBeInTheDocument()
    expect(within(side as HTMLElement).getByText('radarr')).toBeInTheDocument()
    expect(within(side as HTMLElement).getByText('docs')).toBeInTheDocument()
    await waitFor(() => expect(side.querySelector('.disk')).toHaveTextContent('412 GB free'))
    // The bar fills with the USED share, not the free one: 412 GB of 1.8 TB is 77% used.
    // Plenty of headroom here, so it stays neutral — .hot is the near-full warning.
    const bar = side.querySelector('.disk .bar') as HTMLElement
    expect(bar.style.getPropertyValue('--p')).toBe('77%')
    expect(bar).not.toHaveClass('hot')
    expect(side.lastElementChild).toHaveClass('disk')   // Disk closes the sidebar, after Trackers
    expect(side).toHaveTextContent('OpenTrackr')
    expect(side.querySelector('.side-item.two .sub.down')).toHaveTextContent(/down · .* · Connection timed out/)
    expect(side).toHaveTextContent('1 of 1 failing · HTTP response code 404')
  })

  it('a nearly full disk turns the bar hot', async () => {
    await mount()
    const side = document.querySelector('.sidebar')!
    await waitFor(() => expect(side.querySelector('.disk')).toBeInTheDocument())
    // 40 GB left of 1 TB: under the 10% mark, so the bar goes hot at 96% used.
    act(() => { set({ freeSpace: new Map([['/data', { path: '/data', size_bytes: 40e9, total_size: 1e12 }]]) }) })
    const bar = side.querySelector('.disk .bar') as HTMLElement
    expect(bar).toHaveClass('hot')
    expect(bar.style.getPropertyValue('--p')).toBe('96%')
    expect(side.querySelector('.disk')).toHaveTextContent('40.0 GB free')
  })

  it('a ratio under 1.0 keeps the ink, a settled one fades', async () => {
    await mount({ density: 'compact', sort: 'name' })
    // Ratio is the 5th .num.r cell of a compact row; read it by value instead.
    const cell = (name: string, value: string) =>
      [...row(name).querySelectorAll('span.num.r')].find(s => s.textContent === value)!
    // 0.98 still owes the swarm: full ink, no .muted.
    expect(cell('Tears of Steel (2012) 4K', '0.98')).not.toHaveClass('muted')
    // 3.42 has paid its way back: muted.
    expect(cell('Big Buck Bunny (2008) 4K 60fps', '3.42')).toHaveClass('muted')
  })

  it('both row layouts ink the ratio the same way', async () => {
    // The two-line row has a ratio column of its own; it drifted from the compact
    // one once already, so pin the pair together.
    await mount()
    const cell = (name: string, value: string) =>
      [...row(name).querySelectorAll('span.num.r')].find(s => s.textContent === value)!
    expect(cell('Tears of Steel (2012) 4K', '0.98')).not.toHaveClass('muted')
    expect(cell('Big Buck Bunny (2008) 4K 60fps', '3.42')).toHaveClass('muted')
  })

  it('an unknown ratio stays quiet: "—" is not a debt', async () => {
    // ratioValue flattens the -1 sentinel to 0, so a naive "< 1" would render the
    // torrent that has transferred nothing as loudly as one that owes the swarm.
    await mount({ torrents: [torrent({ id: 1, name: 'Fresh', upload_ratio: -1 })] })
    const na = [...row('Fresh').querySelectorAll('span.num.r')].find(s => s.textContent === '—')!
    expect(na).toBeInTheDocument()
    expect(na).toHaveClass('muted')
  })

  it('filters: status, label, folder, tracker; title and count follow; URL syncs', async () => {
    await mount()
    const side = document.querySelector('.sidebar') as HTMLElement
    fireEvent.click(side.querySelector('[data-f="download"]')!)
    expect(screen.getByText('Downloading', { selector: '#ftitle' })).toBeInTheDocument()
    expect(rows()).toHaveLength(1)
    expect(location.search).toContain('filter=download')
    fireEvent.click(within(side).getByText('linux'))
    expect(rows()).toHaveLength(3)
    fireEvent.click(within(side).getByText('radarr'))
    expect(document.getElementById('ftitle')).toHaveTextContent('radarr')
    expect(rows()).toHaveLength(2)
    expect(document.querySelector('.toolbar .count')).toHaveTextContent('2 of 8')
    fireEvent.click(within(side).getByText('Archive.org'))
    expect(rows()).toHaveLength(1)
    fireEvent.click(side.querySelector('[data-f="all"]')!)
    expect(rows()).toHaveLength(8)
  })

  it('tracker-down notice offers re-announce and can be dismissed for the outage', async () => {
    await mount()
    const notice = await screen.findByText(/has been unreachable/)
    expect(notice).toHaveTextContent('OpenTrackr')                       // name, matching the sidebar
    expect(notice.querySelector('b')).toHaveAttribute('title', 'tracker.opentrackr.org')
    fireEvent.click(screen.getByRole('button', { name: 'Re-announce all' }))
    await waitFor(() => expect(daemon.of('torrent_reannounce')[0]).toEqual({ ids: [8] }))
    fireEvent.click(screen.getByTitle('Dismiss'))
    expect(screen.queryByText(/has been unreachable/)).toBeNull()
    expect(JSON.parse(localStorage.getItem('tm.dismissed')!)).toHaveLength(1)
  })
})

describe('list interactions', () => {
  it('attribute filter popover adds chips, empties the list, and clears', async () => {
    await mount()
    fireEvent.click(document.getElementById('fbtn')!)
    const pop = document.querySelector('.fpop') as HTMLElement
    fireEvent.click(within(pop).getByRole('button', { name: '> 10 GB' }))
    expect(document.querySelector('.fchip')).toHaveTextContent('> 10 GB')
    expect(document.querySelector('#fbtn .badge')).toHaveTextContent('1')
    expect(screen.getByText('Nothing matches')).toBeInTheDocument()
    expect(location.search).toContain('size=gt10')
    fireEvent.click(within(pop).getByRole('button', { name: 'Older' }))
    expect(document.querySelectorAll('.fchip')).toHaveLength(2)
    fireEvent.click(document.querySelector('.fchip button')!)
    expect(document.querySelectorAll('.fchip')).toHaveLength(1)
    fireEvent.click(screen.getByText('clear all'))
    expect(rows()).toHaveLength(8)
    fireEvent.click(within(pop).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(document.querySelector('.fpop')).toBeNull())
  })

  it('column headers sort and the sort button returns to State', async () => {
    await mount()
    const cols = document.querySelector('.cols') as HTMLElement
    fireEvent.click(within(cols).getByText('Size'))
    expect(rows()[0]).toHaveTextContent('Big Buck Bunny')
    fireEvent.click(within(cols).getByText('Size'))
    expect(rows()[0]).toHaveTextContent('Pride and Prejudice')
    fireEvent.click(within(cols).getByText('Name'))
    expect(rows()[0]).toHaveTextContent('Apollo 11')
    fireEvent.click(within(cols).getByText('Down'))
    expect(rows()[0]).toHaveTextContent('debian')
    fireEvent.click(within(cols).getByText('Up')); fireEvent.click(within(cols).getByText('Ratio')); fireEvent.click(within(cols).getByText('ETA')); fireEvent.click(within(cols).getByText('Progress'))
    fireEvent.click(screen.getByTitle('Sort'))
    expect(rows()[0]).toHaveTextContent('Apollo 11')
  })

  it('checkbox / ⌘ / shift selection, select-all, selection bar actions, ⌘A and Escape', async () => {
    await mount()
    fireEvent.click(rows()[1].querySelector('.chk')!)
    fireEvent.click(rows()[2], { metaKey: true })
    expect(document.getElementById('selbar')).toHaveTextContent('2 selected')
    fireEvent.click(rows()[4], { shiftKey: true })
    expect(document.getElementById('selbar')).toHaveTextContent('4 selected')
    fireEvent.click(within(selbar()).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(daemon.of('torrent_stop')[0]).toEqual({ ids: expect.arrayContaining([Number(rows()[1].dataset.id)]) }))
    fireEvent.click(within(selbar()).getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(daemon.of('torrent_start')).toHaveLength(1))
    fireEvent.click(document.querySelector('#selbar .x')!)
    expect(document.getElementById('selbar')).toBeNull()
    fireEvent.click(document.getElementById('selall')!)
    expect(document.getElementById('selbar')).toHaveTextContent('8 selected')
    expect(document.getElementById('selall')).toHaveClass('on')
    fireEvent.click(document.getElementById('selall')!)
    expect(document.getElementById('selbar')).toBeNull()
    fireEvent.keyDown(document, { key: 'a', metaKey: true })
    expect(document.getElementById('selbar')).toHaveTextContent('8 selected')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.getElementById('selbar')).toBeNull()
  })

  it('selection bar opens Labels, Move and Remove dialogs and the ⋮ menu', async () => {
    await mount()
    fireEvent.click(rows()[2].querySelector('.chk')!)
    fireEvent.click(within(selbar()).getByRole('button', { name: 'Labels' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Labels')
    await closeDialog()
    fireEvent.click(within(selbar()).getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Set location')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(selbar()).getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove and delete data')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(document.querySelector('#selbar [title="More"]')!)
    expect(document.querySelector('.cmenu')).toHaveTextContent('Verify local data')
  })

  it('view menu acts on everything in view', async () => {
    await mount()
    fireEvent.click(document.getElementById('tmenu')!)
    const menu = document.querySelector('.cmenu') as HTMLElement
    expect(menu).toHaveTextContent('Everything in this view · 8')
    fireEvent.click(within(menu).getByText('Resume all'))
    await waitFor(() => expect(daemon.of('torrent_start')[0]).toEqual({ ids: [7, 8, 5, 4, 1, 3, 2, 6] }))
    fireEvent.click(document.getElementById('tmenu')!)
    fireEvent.click(within(document.querySelector('.cmenu') as HTMLElement).getByText('Select all'))
    expect(document.getElementById('selbar')).toHaveTextContent('8 selected')
  })

  it('row menu pauses and resumes; its items dispatch RPCs and open dialogs', async () => {
    await mount()
    const r = row('Big Buck Bunny (2008) 4K 60fps')
    // Pause lives in the menu now, not on the row: the column holds only the trigger.
    expect(within(r).queryByTitle('Pause')).toBeNull()
    fireEvent.click(within(r).getByTitle('More'))
    fireEvent.click(within(document.querySelector('.cmenu') as HTMLElement).getByText('Pause'))
    await waitFor(() => expect(daemon.of('torrent_stop')[0]).toEqual({ ids: [2] }))
    fireEvent.contextMenu(row('Big Buck Bunny (2008) 4K 60fps'))
    let menu = document.querySelector('.cmenu') as HTMLElement
    fireEvent.click(within(menu).getByText('Resume'))
    await waitFor(() => expect(daemon.of('torrent_start')[0]).toEqual({ ids: [2] }))
    const open = (label: string) => { fireEvent.click(within(row('Big Buck Bunny (2008) 4K 60fps')).getByTitle('More')); menu = document.querySelector('.cmenu') as HTMLElement; fireEvent.click(within(menu).getByText(label)) }
    open('Re-announce'); await waitFor(() => expect(daemon.of('torrent_reannounce')).toHaveLength(1))
    open('Verify local data'); await waitFor(() => expect(daemon.of('torrent_verify')).toHaveLength(1))
    fireEvent.click(within(row('Big Buck Bunny (2008) 4K 60fps')).getByTitle('More'))
    menu = document.querySelector('.cmenu') as HTMLElement
    fireEvent.mouseEnter(within(menu).getByText('Queue position'))
    fireEvent.click(within(menu).getByText('Move to top'))
    await waitFor(() => expect(daemon.calls.some(c => c.method === 'queue_move_top')).toBe(true))
    open('Labels…'); expect(screen.getByRole('dialog')).toHaveTextContent('Labels'); await closeDialog()
    open('Rename…'); expect(screen.getByRole('dialog')).toHaveTextContent('Rename'); await closeDialog()
    open('Limits & priority…'); expect(screen.getByRole('dialog')).toHaveTextContent('Limits & priority'); await closeDialog()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    open('Copy magnet link'); await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('magnet:?xt=urn:btih:6b7a2c1f'))
    open('Copy hash'); await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2))
    open('Remove and delete data…')
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove and delete data')
    expect(screen.getByRole('dialog')).toHaveTextContent('cannot be undone')
    fireEvent.click(screen.getByRole('button', { name: /Delete torrent and data/ }))
    await waitFor(() => expect(daemon.of('torrent_remove')[0]).toEqual({ ids: [2], 'delete_local_data': true }))
    await waitFor(() => expect(screen.queryByText('Big Buck Bunny (2008) 4K 60fps')).toBeNull())
  })

  it('keyboard: Space pauses the focused torrent, Backspace opens remove', async () => {
    await mount()
    fireEvent.click(within(row('Big Buck Bunny (2008) 4K 60fps')).getByText('Big Buck Bunny (2008) 4K 60fps'))
    expect(get().focusId).toBe(2)
    fireEvent.keyDown(document, { key: ' ' })
    await waitFor(() => expect(daemon.of('torrent_stop')[0]).toEqual({ ids: [2] }))
    fireEvent.keyDown(document, { key: 'Backspace' })
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove and delete data')
    fireEvent.click(screen.getByRole('button', { name: /and data$/ }))
    await waitFor(() => expect(daemon.of('torrent_remove')[0]).toEqual({ ids: [2], 'delete_local_data': true }))
  })

  it('keyboard: \u2318\u232b opts out of deleting the data', async () => {
    await mount()
    fireEvent.click(within(row('Big Buck Bunny (2008) 4K 60fps')).getByText('Big Buck Bunny (2008) 4K 60fps'))
    fireEvent.keyDown(document, { key: 'Backspace', metaKey: true })
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove from list')
    fireEvent.click(screen.getByRole('button', { name: /^Remove torrent/ }))
    await waitFor(() => expect(daemon.of('torrent_remove')[0]).toEqual({ ids: [2], 'delete_local_data': false }))
  })

  it('dropping a .torrent file on the window opens Add with the file', async () => {
    await mount()
    const file = new File([new Uint8Array([100, 101])], 'x.torrent')
    fireEvent.drop(document, { dataTransfer: { files: [file], types: ['Files'] } })
    expect(screen.getByRole('dialog')).toHaveTextContent('Add torrent')
    await screen.findByText(/not a valid \.torrent/)
  })
})

describe('inspector', () => {
  it('overview shows detail data, pieces, availability, peers-from and writes options', async () => {
    await mount()
    fireEvent.click(within(row('debian-13.1.0-amd64-DVD-1.iso')).getByText('debian-13.1.0-amd64-DVD-1.iso'))
    const insp = await waitFor(() => { const el = document.querySelector('.inspector')!; expect(el.querySelector('.pieces i')).toBeTruthy(); return el as HTMLElement })
    expect(insp.querySelector('.insp-head .t')).toHaveTextContent('debian-13.1.0-amd64-DVD-1.iso')
    expect(insp).toHaveTextContent('3.0× · 100%')
    expect(insp).toHaveTextContent('from tracker 23 · DHT 12 · PEX 7')
    expect(insp).toHaveTextContent('1,204 seeds · 311 leechers')
    expect(insp).toHaveTextContent('Next announce')
    expect(insp).toHaveTextContent('Public torrent')
    expect(location.search).toContain('sel=1')
    // options write through torrent-set
    const toggles = insp.querySelectorAll('.opt .toggle')
    fireEvent.click(toggles[0])
    await waitFor(() => expect(daemon.of('torrent_set')[0]).toEqual({ ids: [1], honors_session_limits: false }))
    fireEvent.click(within(insp).getByRole('button', { name: 'High' }))
    await waitFor(() => expect(daemon.of('torrent_set')[1]).toEqual({ ids: [1], bandwidth_priority: 1 }))
    fireEvent.click(within(insp).getByRole('button', { name: 'Custom' }))
    await waitFor(() => expect(daemon.of('torrent_set')[2]).toEqual({ ids: [1], seed_ratio_mode: 1 }))
    const peerLimit = [...insp.querySelectorAll<HTMLInputElement>('.opt input')].at(-1)!
    fireEvent.change(peerLimit, { target: { value: '80' } }); fireEvent.blur(peerLimit)
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [1], 'peer_limit': 80 }))
    fireEvent.click([...insp.querySelectorAll('.opt .toggle')].at(-1)!)   // sequential download, rpc 18
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [1], sequential_download: true }))
    fireEvent.click(within(insp).getByTitle('Close'))
    expect(document.querySelector('.inspector')).toBeNull()
  })

  // One mount per test: RTL only unmounts between `it` blocks, so two mounts in one
  // test leave two Apps in the DOM and every getByText finds duplicates.
  const seedLimitRow = async (opts: Parameters<typeof mount>[0]) => {
    await mount(opts)
    fireEvent.click(within(row('ratio-fixture')).getByText('ratio-fixture'))
    const insp = await waitFor(() => { const el = document.querySelector('.inspector')!; expect(el.querySelector('.pieces i')).toBeTruthy(); return el as HTMLElement })
    return within(insp).getByText('Seed limit').nextElementSibling as HTMLElement
  }
  // seed_ratio_limit 9 on the torrent is the decoy: in global mode it is meaningless,
  // the session's 2 is what actually stops the torrent.
  const globalMode = () => [torrent({ id: 1, name: 'ratio-fixture', seed_ratio_mode: 0, seed_ratio_limit: 9 })]

  it('seed limit reads the session ratio in global mode', async () => {
    expect(await seedLimitRow({ torrents: globalMode(), session: { seed_ratio_limited: true, seed_ratio_limit: 2 } })).toHaveTextContent('Stop at ratio 2.00 (global)')
  })

  it('seed limit is unlimited in global mode when the global stopper is off', async () => {
    expect(await seedLimitRow({ torrents: globalMode(), session: { seed_ratio_limited: false, seed_ratio_limit: 2 } })).toHaveTextContent('Unlimited (global)')
  })

  it('seed limit says nothing in global mode until the session has loaded', async () => {
    await mount({ torrents: globalMode() })
    set({ session: null })   // session_get failed this pass; the retry is 15 ticks away
    fireEvent.click(within(row('ratio-fixture')).getByText('ratio-fixture'))
    const insp = await waitFor(() => { const el = document.querySelector('.inspector')!; expect(el.querySelector('.pieces i')).toBeTruthy(); return el as HTMLElement })
    const dd = within(insp).getByText('Seed limit').nextElementSibling as HTMLElement
    expect(dd).toHaveTextContent('—')
    expect(dd).not.toHaveTextContent('Unlimited')
  })

  it('seed limit shows the torrent ratio in custom mode', async () => {
    const torrents = [torrent({ id: 1, name: 'ratio-fixture', seed_ratio_mode: 1, seed_ratio_limit: 4.5 })]
    expect(await seedLimitRow({ torrents, session: { seed_ratio_limited: false } })).toHaveTextContent('Stop at ratio 4.50 (this torrent)')
  })

  it('seed limit is unlimited in unlimited mode, whatever the session says', async () => {
    const torrents = [torrent({ id: 1, name: 'ratio-fixture', seed_ratio_mode: 2, seed_ratio_limit: 4.5 })]
    const dd = await seedLimitRow({ torrents, session: { seed_ratio_limited: true, seed_ratio_limit: 2 } })
    expect(dd).toHaveTextContent('Unlimited')
    expect(dd).not.toHaveTextContent('Stop at ratio')
  })

  it('files tab toggles wanted and cycles priority; peers and trackers tabs render', async () => {
    await mount()
    fireEvent.click(within(row('Cosmos Laundromat (2015)')).getByText('Cosmos Laundromat (2015)'))
    await waitFor(() => expect(document.querySelector('.inspector .pieces i')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Files/ }))
    const tree = document.querySelector('.tree') as HTMLElement
    expect(within(tree).getByText('torrent-8')).toBeInTheDocument()
    expect(within(tree).getByText('SHA512SUMS')).toBeInTheDocument()
    // rows: dir torrent-8 (idx 0,1), then files sorted by name: SHA512SUMS (idx 1), torrent-8.iso (idx 0)
    fireEvent.click(tree.querySelectorAll('.f .chk')[1])
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [8], 'files_unwanted': [1] }))
    await waitFor(() => expect(tree.querySelectorAll('.f .chk')[0]).toHaveClass('mixed'))
    fireEvent.click(tree.querySelectorAll('.f .chk')[0])
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [8], 'files_wanted': [0, 1] }))
    fireEvent.click(within(tree).getAllByTitle('Cycle priority')[2])
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [8], 'priority_high': [0] }))
    fireEvent.click(screen.getByRole('button', { name: /^Peers/ }))
    expect(document.querySelector('.tbl')).toHaveTextContent('Transmission 4.1.3')
    fireEvent.click(screen.getByRole('button', { name: /^Trackers/ }))
    expect(document.querySelectorAll('.tracker')).toHaveLength(2)
    expect(document.querySelector('.inspector')).toHaveTextContent('Unreachable')
    expect(document.querySelector('.inspector')).toHaveTextContent('Working')
    fireEvent.click(screen.getByRole('button', { name: 'Re-announce' }))
    await waitFor(() => expect(daemon.of('torrent_reannounce')[0]).toEqual({ ids: [8] }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit trackers' }))
    const ta = await within(await screen.findByRole('dialog')).findByRole('textbox')
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain('bttracker'))
    fireEvent.change(ta, { target: { value: 'http://a/announce\n\nhttp://b/announce' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [8], tracker_list: 'http://a/announce\n\nhttp://b/announce' }))
  })
})

describe('dialogs', () => {
  it('Add: magnet text, folder chips, labels, options → torrent-add', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const dlg = screen.getByRole('dialog')
    expect(dlg).toHaveTextContent('Add torrent')
    await waitFor(() => expect(dlg).toHaveTextContent('412 GB free'))
    const magnet = within(dlg).getByPlaceholderText(/^magnet:/) as HTMLInputElement
    fireEvent.change(magnet, { target: { value: 'magnet:?xt=urn:btih:abc&dn=new-thing' } })
    fireEvent.keyDown(magnet, { key: 'Enter' })
    expect(dlg).toHaveTextContent('new-thing')
    expect(dlg).toHaveTextContent('Metadata is fetched after adding')
    fireEvent.click(within(dlg).getByRole('button', { name: 'radarr' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'blender' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'High' }))
    const [startSw, seqSw] = within(dlg).getAllByRole('switch')  // start when added, sequential download
    fireEvent.click(startSw)                                    // start when added → off
    fireEvent.click(seqSw)                                      // sequential download → on
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add torrent' }))
    await waitFor(() => expect(daemon.of('torrent_add')[0]).toEqual({ filename: 'magnet:?xt=urn:btih:abc&dn=new-thing', 'download_dir': '/data/torrents/radarr', paused: true, labels: ['blender'], bandwidth_priority: 1, sequential_download: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByText('new-thing')
  })

  it('Add: a real .torrent file is parsed, files can be deselected, duplicates are reported', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const dlg = screen.getByRole('dialog')
    const bencoded = 'd8:announce12:http://a/ann4:infod5:filesld6:lengthi10e4:pathl1:aeed6:lengthi20e4:pathl1:beee4:name4:rootee'
    const file = new File([new TextEncoder().encode(bencoded)], 'root.torrent')
    const zone = dlg.querySelector('.drop')!
    fireEvent.dragOver(zone); expect(zone).toHaveClass('active'); fireEvent.dragLeave(zone)
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    await waitFor(() => expect(dlg).toHaveTextContent('30 B · 2 files'))
    expect(dlg).toHaveTextContent('Files · 30 B selected of 30 B')
    fireEvent.click(dlg.querySelectorAll('.tree .chk')[1])
    expect(dlg).toHaveTextContent('Files · 10 B selected of 30 B')
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add torrent' }))
    await waitFor(() => expect(daemon.of('torrent_add')[0]).toMatchObject({ 'files_unwanted': [1], paused: false }))
    expect(daemon.of('torrent_add')[0].metainfo).toBe(btoa(bencoded))
  })

  it('Labels dialog toggles existing and new labels and saves', async () => {
    await mount()
    set({ dialog: { kind: 'labels', ids: [1] } })
    const dlg = await screen.findByRole('dialog')
    fireEvent.click(within(dlg).getByRole('button', { name: 'linux' }))     // off
    fireEvent.click(within(dlg).getByRole('button', { name: 'archive' }))   // on
    const inp = within(dlg).getByPlaceholderText(/New label/)
    fireEvent.change(inp, { target: { value: 'fresh' } }); fireEvent.keyDown(inp, { key: 'Enter' })
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(daemon.of('torrent_set')[0]).toEqual({ ids: [1], labels: ['archive', 'fresh'] }))
  })

  it('Labels on a multi-select applies the diff per torrent instead of overwriting with the intersection', async () => {
    await mount()
    // 1: [linux], 2: [blender]  → shared set is empty; add "fresh" → each keeps its own label
    set({ dialog: { kind: 'labels', ids: [1, 2] } })
    const dlg = await screen.findByRole('dialog')
    const inp = within(dlg).getByPlaceholderText(/New label/)
    fireEvent.change(inp, { target: { value: 'fresh' } }); fireEvent.keyDown(inp, { key: 'Enter' })
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(daemon.of('torrent_set')).toHaveLength(2))
    expect(daemon.of('torrent_set')).toEqual(expect.arrayContaining([{ ids: [1], labels: ['linux', 'fresh'] }, { ids: [2], labels: ['blender', 'fresh'] }]))
    // removing a shared label leaves the others intact
    set({ dialog: { kind: 'labels', ids: [1, 2] } })
    const dlg2 = await screen.findByRole('dialog')
    fireEvent.click(within(dlg2).getByRole('button', { name: 'fresh' }))
    fireEvent.click(within(dlg2).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(daemon.of('torrent_set')).toHaveLength(4))
    expect(daemon.of('torrent_set').slice(2)).toEqual(expect.arrayContaining([{ ids: [1], labels: ['linux'] }, { ids: [2], labels: ['blender'] }]))
  })

  it('Edit trackers keeps Save disabled when the list could not be loaded', async () => {
    await mount()
    daemon.torrents = daemon.torrents.map(t => t.id === 8 ? { ...t, tracker_list: undefined as unknown as string } : t)
    const original = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; arguments: { ids?: number[]; fields?: string[] } }
      if (body.method === 'torrent_get' && body.arguments.fields?.includes('tracker_list')) return new Response('', { status: 500 })
      return original(url, init)
    })
    set({ dialog: { kind: 'trackers', id: 8 } })
    const dlg = await screen.findByRole('dialog')
    await screen.findByText(/Could not load the tracker list/)
    expect(within(dlg).getByRole('button', { name: 'Save' })).toBeDisabled()
    spy.mockRestore()
  })

  it('Set location moves data, Rename renames, Limits writes through', async () => {
    await mount()
    set({ dialog: { kind: 'location', ids: [1] } })
    let dlg = await screen.findByRole('dialog')
    await waitFor(() => expect(dlg).toHaveTextContent('412 GB free'))
    fireEvent.click(within(dlg).getByRole('button', { name: 'buffer' }))
    fireEvent.click(within(dlg).getByRole('switch'))  // move off → "Set location"
    fireEvent.click(within(dlg).getByRole('button', { name: 'Set location' }))
    await waitFor(() => expect(daemon.of('torrent_set_location')[0]).toEqual({ ids: [1], location: '/data/torrents/buffer', move: false }))

    set({ dialog: { kind: 'rename', id: 1 } })
    dlg = await screen.findByRole('dialog')
    const name = within(dlg).getByRole('textbox') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'renamed.iso' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(daemon.of('torrent_rename_path')[0]).toEqual({ ids: [1], path: 'debian-13.1.0-amd64-DVD-1.iso', name: 'renamed.iso' }))

    set({ dialog: { kind: 'limits', ids: [1, 2] } })
    dlg = await screen.findByRole('dialog')
    await waitFor(() => expect(dlg).toHaveTextContent('Applies to 2 torrents'))
    await waitFor(() => expect(within(dlg).getAllByRole('switch').length).toBeGreaterThan(0))
    fireEvent.click(within(dlg).getAllByRole('switch')[1])
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [1, 2], download_limited: true }))
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'Unlimited' })[0])
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [1, 2], seed_ratio_mode: 2 }))
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'Custom' })[1])
    await waitFor(() => expect(daemon.of('torrent_set').at(-1)).toEqual({ ids: [1, 2], seed_idle_mode: 1 }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Done' }))
  })

  it('Settings: every section renders and writes session-set; port test and blocklist update', async () => {
    await mount()
    fireEvent.click(screen.getByTitle('Preferences'))
    const dlg = await screen.findByRole('dialog')
    expect(dlg).toHaveTextContent('Speed')
    fireEvent.click(within(dlg).getAllByRole('switch')[0])
    await waitFor(() => expect(daemon.of('session_set')[0]).toEqual({ 'speed_limit_down_enabled': false }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Sa' }))
    await waitFor(() => expect(daemon.of('session_set').at(-1)).toEqual({ 'alt_speed_time_day': 62 ^ 64 }))
    const between = within(dlg).getAllByDisplayValue('08:00')[0]
    fireEvent.change(between, { target: { value: '07:30' } }); fireEvent.blur(between)
    await waitFor(() => expect(daemon.of('session_set').at(-1)).toEqual({ 'alt_speed_time_begin': 450 }))

    for (const sec of ['Downloads', 'Seeding', 'Queue', 'Network', 'Peers', 'Interface']) {
      fireEvent.click(within(dlg).getByRole('button', { name: sec }))
      expect(dlg.querySelector('.modal-h .t')).toHaveTextContent(sec)
    }
    fireEvent.click(within(dlg).getByRole('button', { name: 'Downloads' }))
    const dd = within(dlg).getByDisplayValue('/data/torrents') as HTMLInputElement
    fireEvent.change(dd, { target: { value: '/data/new' } }); fireEvent.blur(dd)
    await waitFor(() => expect(daemon.of('session_set').at(-1)).toEqual({ 'download_dir': '/data/new' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Network' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(dlg).toHaveTextContent('IPv4 open'))
    expect(dlg).toHaveTextContent('IPv6 open')
    expect(daemon.of('port_test').map(a => a.ip_protocol)).toEqual(['ipv4', 'ipv6'])
    // preferred_transports replaced the deprecated utp_enabled; the last one may not be switched off
    const toggleFor = (label: string) => within(dlg).getByText(label).closest('.opt')!.querySelector<HTMLButtonElement>('.toggle')!
    const tcp = toggleFor('TCP'), utp = toggleFor('µTP')
    fireEvent.click(tcp)
    await waitFor(() => expect(daemon.of('session_set').at(-1)).toEqual({ preferred_transports: ['utp'] }))
    expect(utp).toBeDisabled()
    fireEvent.click(utp)
    expect(daemon.of('session_set').at(-1)).toEqual({ preferred_transports: ['utp'] })
    fireEvent.click(tcp)
    await waitFor(() => expect(daemon.of('session_set').at(-1)).toEqual({ preferred_transports: ['tcp', 'utp'] }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Peers' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Require' }))
    await waitFor(() => expect(daemon.of('session_set').at(-1)).toEqual({ encryption: 'required' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(daemon.of('blocklist_update')).toHaveLength(1))
    await screen.findByText(/Blocklist updated: 400,000 rules/)
    fireEvent.click(within(dlg).getByRole('button', { name: 'Interface' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Comfortable' }))
    expect(document.documentElement.dataset.density).toBe('comfortable')
    fireEvent.click(within(dlg).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('polling', () => {
  it('drops torrents the daemon reports as removed and keeps the inspector in sync', async () => {
    await mount()
    daemon.torrents = daemon.torrents.filter(t => t.id !== 3)
    await act(async () => { refreshNow(); await new Promise(r => setTimeout(r, 50)) })
    await waitFor(() => expect(screen.queryByText('Tears of Steel (2012) 4K')).toBeNull())
    expect(rows()).toHaveLength(7)
  })
})
