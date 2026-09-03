import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { get, refreshNow, set, startPolling } from '../state/store'
import { installFakeDaemon, type FakeDaemon } from '../test/fakeDaemon'

let daemon: FakeDaemon

function resetStore() {
  set({ torrents: [], byId: new Map(), detail: null, session: null, stats: null, history: [], freeSpace: new Map(), connection: 'connecting', lastError: '',
    filter: 'all', adv: {}, search: '', sort: 'state', sortDir: 1, selected: new Set(), focusId: null, inspectorTab: 'overview', dialog: { kind: 'none' }, dismissed: new Set(), toast: '' })
}

async function mount(opts: Parameters<typeof installFakeDaemon>[0] = {}) {
  daemon = installFakeDaemon(opts)
  resetStore()
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

  it('header shows live speeds, session totals, and the stats popover', async () => {
    await mount()
    const speeds = document.querySelector('.speeds')!
    expect(speeds).toHaveTextContent('12.4')
    expect(speeds).toHaveTextContent('5.14 GB this session')
    fireEvent.click(speeds)
    expect(screen.getByText('Statistics')).toBeInTheDocument()
    expect(document.querySelector('.pop')).toHaveTextContent('218 GB')
    expect(document.querySelector('.pop')).toHaveTextContent('1.79')
    expect(document.querySelector('.pop')).toHaveTextContent('4.0.5')
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
    await waitFor(() => expect(daemon.of('session-set')[0]).toEqual({ 'alt-speed-enabled': true }))
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

  it('shows a connection banner when the daemon needs credentials, with a reload button', async () => {
    await mount({ unauthorized: true })
    await screen.findByText(/Daemon needs credentials/, {}, { timeout: 4000 })
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })
})

describe('sidebar', () => {
  it('status counts, labels, folders, disk and tracker health', async () => {
    await mount()
    const side = document.querySelector('.sidebar')!
    const cnt = (f: string) => side.querySelector(`[data-f="${f}"] .cnt`)!.textContent
    expect(cnt('all')).toBe('8'); expect(cnt('download')).toBe('1'); expect(cnt('seed')).toBe('2'); expect(cnt('active')).toBe('2')
    expect(cnt('finished')).toBe('4'); expect(cnt('queued')).toBe('3'); expect(cnt('stopped')).toBe('1'); expect(cnt('error')).toBe('1'); expect(cnt('trackererr')).toBe('2')
    expect(within(side as HTMLElement).getByText('blender')).toBeInTheDocument()
    expect(within(side as HTMLElement).getByText('radarr')).toBeInTheDocument()
    expect(within(side as HTMLElement).getByText('docs')).toBeInTheDocument()
    await waitFor(() => expect(side.querySelector('.disk')).toHaveTextContent('412 GB free'))
    expect(side).toHaveTextContent('tracker.opentrackr.org')
    expect(side.querySelector('.side-item.two .sub.down')).toHaveTextContent(/down · .* · Connection timed out/)
    expect(side).toHaveTextContent('1 of 1 failing · HTTP response code 404')
  })

  it('filters: status, label, folder, tracker; title and count follow; URL syncs', async () => {
    await mount()
    const side = document.querySelector('.sidebar') as HTMLElement
    fireEvent.click(side.querySelector('[data-f="seed"]')!)
    expect(screen.getByText('Seeding', { selector: '#ftitle' })).toBeInTheDocument()
    expect(rows()).toHaveLength(2)
    expect(location.search).toContain('filter=seed')
    fireEvent.click(within(side).getByText('linux'))
    expect(rows()).toHaveLength(3)
    fireEvent.click(within(side).getByText('radarr'))
    expect(document.getElementById('ftitle')).toHaveTextContent('radarr')
    expect(rows()).toHaveLength(2)
    expect(document.querySelector('.toolbar .count')).toHaveTextContent('2 of 8')
    fireEvent.click(within(side).getByText('archive.org'))
    expect(rows()).toHaveLength(1)
    fireEvent.click(side.querySelector('[data-f="all"]')!)
    expect(rows()).toHaveLength(8)
  })

  it('tracker-down notice offers re-announce and can be dismissed for the outage', async () => {
    await mount()
    const notice = await screen.findByText(/has been unreachable/)
    expect(notice).toHaveTextContent('tracker.opentrackr.org')
    fireEvent.click(screen.getByRole('button', { name: 'Re-announce all' }))
    await waitFor(() => expect(daemon.of('torrent-reannounce')[0]).toEqual({ ids: [8] }))
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
    await waitFor(() => expect(daemon.of('torrent-stop')[0]).toEqual({ ids: expect.arrayContaining([Number(rows()[1].dataset.id)]) }))
    fireEvent.click(within(selbar()).getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(daemon.of('torrent-start')).toHaveLength(1))
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
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove from list')
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
    await waitFor(() => expect(daemon.of('torrent-start')[0]).toEqual({ ids: [7, 8, 5, 4, 1, 3, 2, 6] }))
    fireEvent.click(document.getElementById('tmenu')!)
    fireEvent.click(within(document.querySelector('.cmenu') as HTMLElement).getByText('Select all'))
    expect(document.getElementById('selbar')).toHaveTextContent('8 selected')
  })

  it('row hover actions pause/resume; context menu items dispatch RPCs and open dialogs', async () => {
    await mount()
    const r = row('Big Buck Bunny (2008) 4K 60fps')
    fireEvent.click(within(r).getByTitle('Pause'))
    await waitFor(() => expect(daemon.of('torrent-stop')[0]).toEqual({ ids: [2] }))
    await waitFor(() => expect(within(row('Big Buck Bunny (2008) 4K 60fps')).getByTitle('Resume')).toBeInTheDocument())
    fireEvent.contextMenu(row('Big Buck Bunny (2008) 4K 60fps'))
    let menu = document.querySelector('.cmenu') as HTMLElement
    fireEvent.click(within(menu).getByText('Resume'))
    await waitFor(() => expect(daemon.of('torrent-start')[0]).toEqual({ ids: [2] }))
    const open = (label: string) => { fireEvent.click(within(row('Big Buck Bunny (2008) 4K 60fps')).getByTitle('More')); menu = document.querySelector('.cmenu') as HTMLElement; fireEvent.click(within(menu).getByText(label)) }
    open('Re-announce'); await waitFor(() => expect(daemon.of('torrent-reannounce')).toHaveLength(1))
    open('Verify local data'); await waitFor(() => expect(daemon.of('torrent-verify')).toHaveLength(1))
    fireEvent.click(within(row('Big Buck Bunny (2008) 4K 60fps')).getByTitle('More'))
    menu = document.querySelector('.cmenu') as HTMLElement
    fireEvent.mouseEnter(within(menu).getByText('Queue position'))
    fireEvent.click(within(menu).getByText('Move to top'))
    await waitFor(() => expect(daemon.calls.some(c => c.method === 'queue-move-top')).toBe(true))
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
    await waitFor(() => expect(daemon.of('torrent-remove')[0]).toEqual({ ids: [2], 'delete-local-data': true }))
    await waitFor(() => expect(screen.queryByText('Big Buck Bunny (2008) 4K 60fps')).toBeNull())
  })

  it('keyboard: Space pauses the focused torrent, Backspace opens remove', async () => {
    await mount()
    fireEvent.click(within(row('Big Buck Bunny (2008) 4K 60fps')).getByText('Big Buck Bunny (2008) 4K 60fps'))
    expect(get().focusId).toBe(2)
    fireEvent.keyDown(document, { key: ' ' })
    await waitFor(() => expect(daemon.of('torrent-stop')[0]).toEqual({ ids: [2] }))
    fireEvent.keyDown(document, { key: 'Backspace' })
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove from list')
    fireEvent.click(screen.getByRole('button', { name: /^Remove torrent/ }))
    await waitFor(() => expect(daemon.of('torrent-remove')[0]).toEqual({ ids: [2], 'delete-local-data': false }))
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
    await waitFor(() => expect(daemon.of('torrent-set')[0]).toEqual({ ids: [1], honorsSessionLimits: false }))
    fireEvent.click(within(insp).getByRole('button', { name: 'High' }))
    await waitFor(() => expect(daemon.of('torrent-set')[1]).toEqual({ ids: [1], bandwidthPriority: 1 }))
    fireEvent.click(within(insp).getByRole('button', { name: 'Custom' }))
    await waitFor(() => expect(daemon.of('torrent-set')[2]).toEqual({ ids: [1], seedRatioMode: 1 }))
    const peerLimit = [...insp.querySelectorAll<HTMLInputElement>('.opt input')].at(-1)!
    fireEvent.change(peerLimit, { target: { value: '80' } }); fireEvent.blur(peerLimit)
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [1], 'peer-limit': 80 }))
    fireEvent.click(within(insp).getByTitle('Close'))
    expect(document.querySelector('.inspector')).toBeNull()
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
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [8], 'files-unwanted': [1] }))
    await waitFor(() => expect(tree.querySelectorAll('.f .chk')[0]).toHaveClass('mixed'))
    fireEvent.click(tree.querySelectorAll('.f .chk')[0])
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [8], 'files-wanted': [0, 1] }))
    fireEvent.click(within(tree).getAllByTitle('Cycle priority')[2])
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [8], 'priority-high': [0] }))
    fireEvent.click(screen.getByRole('button', { name: /^Peers/ }))
    expect(document.querySelector('.tbl')).toHaveTextContent('Transmission 4.0.5')
    fireEvent.click(screen.getByRole('button', { name: /^Trackers/ }))
    expect(document.querySelectorAll('.tracker')).toHaveLength(2)
    expect(document.querySelector('.inspector')).toHaveTextContent('Unreachable')
    expect(document.querySelector('.inspector')).toHaveTextContent('Working')
    fireEvent.click(screen.getByRole('button', { name: 'Re-announce' }))
    await waitFor(() => expect(daemon.of('torrent-reannounce')[0]).toEqual({ ids: [8] }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit trackers' }))
    const ta = await within(await screen.findByRole('dialog')).findByRole('textbox')
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain('bttracker'))
    fireEvent.change(ta, { target: { value: 'http://a/announce\n\nhttp://b/announce' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [8], trackerList: 'http://a/announce\n\nhttp://b/announce' }))
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
    fireEvent.click(within(dlg).getByRole('switch'))            // start when added → off
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add torrent' }))
    await waitFor(() => expect(daemon.of('torrent-add')[0]).toEqual({ filename: 'magnet:?xt=urn:btih:abc&dn=new-thing', 'download-dir': '/data/torrents/radarr', paused: true, labels: ['blender'], bandwidthPriority: 1 }))
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
    await waitFor(() => expect(daemon.of('torrent-add')[0]).toMatchObject({ 'files-unwanted': [1], paused: false }))
    expect(daemon.of('torrent-add')[0].metainfo).toBe(btoa(bencoded))
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
    await waitFor(() => expect(daemon.of('torrent-set')[0]).toEqual({ ids: [1], labels: ['archive', 'fresh'] }))
  })

  it('Set location moves data, Rename renames, Limits writes through', async () => {
    await mount()
    set({ dialog: { kind: 'location', ids: [1] } })
    let dlg = await screen.findByRole('dialog')
    await waitFor(() => expect(dlg).toHaveTextContent('412 GB free'))
    fireEvent.click(within(dlg).getByRole('button', { name: 'buffer' }))
    fireEvent.click(within(dlg).getByRole('switch'))  // move off → "Set location"
    fireEvent.click(within(dlg).getByRole('button', { name: 'Set location' }))
    await waitFor(() => expect(daemon.of('torrent-set-location')[0]).toEqual({ ids: [1], location: '/data/torrents/buffer', move: false }))

    set({ dialog: { kind: 'rename', id: 1 } })
    dlg = await screen.findByRole('dialog')
    const name = within(dlg).getByRole('textbox') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'renamed.iso' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(daemon.of('torrent-rename-path')[0]).toEqual({ ids: [1], path: 'debian-13.1.0-amd64-DVD-1.iso', name: 'renamed.iso' }))

    set({ dialog: { kind: 'limits', ids: [1, 2] } })
    dlg = await screen.findByRole('dialog')
    await waitFor(() => expect(dlg).toHaveTextContent('Applies to 2 torrents'))
    await waitFor(() => expect(within(dlg).getAllByRole('switch').length).toBeGreaterThan(0))
    fireEvent.click(within(dlg).getAllByRole('switch')[1])
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [1, 2], downloadLimited: true }))
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'Unlimited' })[0])
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [1, 2], seedRatioMode: 2 }))
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'Custom' })[1])
    await waitFor(() => expect(daemon.of('torrent-set').at(-1)).toEqual({ ids: [1, 2], seedIdleMode: 1 }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Done' }))
  })

  it('Settings: every section renders and writes session-set; port test and blocklist update', async () => {
    await mount()
    fireEvent.click(screen.getByTitle('Preferences'))
    const dlg = await screen.findByRole('dialog')
    expect(dlg).toHaveTextContent('Speed')
    fireEvent.click(within(dlg).getAllByRole('switch')[0])
    await waitFor(() => expect(daemon.of('session-set')[0]).toEqual({ 'speed-limit-down-enabled': false }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Sa' }))
    await waitFor(() => expect(daemon.of('session-set').at(-1)).toEqual({ 'alt-speed-time-day': 62 ^ 64 }))
    const between = within(dlg).getAllByDisplayValue('08:00')[0]
    fireEvent.change(between, { target: { value: '07:30' } }); fireEvent.blur(between)
    await waitFor(() => expect(daemon.of('session-set').at(-1)).toEqual({ 'alt-speed-time-begin': 450 }))

    for (const sec of ['Downloads', 'Seeding', 'Queue', 'Network', 'Peers', 'Interface']) {
      fireEvent.click(within(dlg).getByRole('button', { name: sec }))
      expect(dlg.querySelector('.modal-h .t')).toHaveTextContent(sec)
    }
    fireEvent.click(within(dlg).getByRole('button', { name: 'Downloads' }))
    const dd = within(dlg).getByDisplayValue('/data/torrents') as HTMLInputElement
    fireEvent.change(dd, { target: { value: '/data/new' } }); fireEvent.blur(dd)
    await waitFor(() => expect(daemon.of('session-set').at(-1)).toEqual({ 'download-dir': '/data/new' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Network' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(dlg).toHaveTextContent('Port is open'))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Peers' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Require' }))
    await waitFor(() => expect(daemon.of('session-set').at(-1)).toEqual({ encryption: 'required' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(daemon.of('blocklist-update')).toHaveLength(1))
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
