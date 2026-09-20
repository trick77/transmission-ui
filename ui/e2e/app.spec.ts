// Runs against the local compose daemon seeded by hack/fixtures.sh, through the Vite dev server (npm run dev).
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const RPC = process.env.TM_RPC || 'http://localhost:9091/transmission/rpc'
const AUTH = 'Basic ' + Buffer.from(process.env.TM_AUTH || 'dev:devpass').toString('base64')
let sid = ''
let callId = 0
async function rpc<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const call = () => fetch(RPC, { method: 'POST', headers: { Authorization: AUTH, 'X-Transmission-Session-Id': sid, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params: args, id: ++callId }) })
  let r = await call()
  if (r.status === 409) { sid = r.headers.get('x-transmission-session-id') || ''; r = await call() }
  const j = await r.json() as { result?: T; error?: { message: string; data?: { error_string?: string } } }
  if (j.error) throw new Error(j.error.data?.error_string || j.error.message)
  return j.result as T
}
type E2ETorrent = { id: number; name: string; status: number; labels: string[]; error: number; tracker_stats: { has_announced: boolean; last_announce_succeeded: boolean }[] }
const torrents = () => rpc<{ torrents: E2ETorrent[] }>('torrent_get', { fields: ['id', 'name', 'status', 'labels', 'error', 'tracker_stats'] }).then(r => r.torrents)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/${name}.png` })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 })
})

test('list renders every daemon torrent and the sidebar counts match', async ({ page }) => {
  const list = await torrents()
  await expect(page.locator('.row')).toHaveCount(list.length)
  await expect(page.locator('.sidebar [data-f="all"] .cnt')).toHaveText(String(list.length))

  // Error covers a daemon error OR a failing tracker, counted once for a torrent
  // with both, so it is derived from the daemon rather than inferred from another
  // filter. A seeding torrent with a dead tracker is an error and is not stopped.
  const failing = (t: E2ETorrent) => t.error !== 0
    || t.tracker_stats.some(ts => ts.has_announced && !ts.last_announce_succeeded)
  const expectedErrors = list.filter(failing).length
  await expect(page.locator('.sidebar [data-f="error"] .cnt')).toHaveText(String(expectedErrors))
  // Stopped excludes errored torrents, so the two filters never double-count one.
  const stoppedUi = Number(await page.locator('.sidebar [data-f="stopped"] .cnt').textContent())
  expect(stoppedUi).toBe(list.filter(t => t.status === 0 && t.error === 0).length)
  await expect(page.locator('.sidebar [data-f="trackererr"]')).toHaveCount(0)
  await shot(page, 'list')
})

test('the list sorts by name by default, errors no longer jump the queue', async ({ page }) => {
  const names = (await torrents()).map(t => t.name).sort((a, b) => a.localeCompare(b))
  await expect(page.locator('.row').first().locator('.name .t')).toHaveText(names[0])
  await expect(page.locator('.cols .sort')).toHaveText(/Name/)
})

test('the Size head stays right-aligned whether or not it is the sort column', async ({ page }) => {
  // .sort makes the head inline-flex, which renders text-align inert, so the alignment
  // is stated as justify-content too. Only a real browser computes this, which is why
  // the check lives here and not in jsdom.
  const size = page.locator('.cols .r.hl')
  // Right-aligned means the label's right edge sits on the cell's, bar rounding.
  const rightGap = async () => size.evaluate(el => {
    const cell = el.getBoundingClientRect()
    const r = document.createRange(); r.selectNodeContents(el)
    return Math.round(cell.right - r.getBoundingClientRect().right)
  })
  expect(await rightGap()).toBeLessThanOrEqual(2)
  await size.click()
  await expect(size).toHaveClass(/sort/)
  expect(await rightGap()).toBeLessThanOrEqual(2)
})

test('the Progress head sits centred over its bar', async ({ page }) => {
  const head = page.locator('.cols .hc')
  const off = async () => head.evaluate(el => {
    const cell = el.getBoundingClientRect()
    const r = document.createRange(); r.selectNodeContents(el)
    const text = r.getBoundingClientRect()
    return Math.round(text.left - cell.left) - Math.round(cell.right - text.right)
  })
  expect(Math.abs(await off())).toBeLessThanOrEqual(2)
  await head.click()
  await expect(head).toHaveClass(/sort/)
  expect(Math.abs(await off())).toBeLessThanOrEqual(2)
})

test('the errored torrent still reads as an error, on the compact status dot', async ({ page }) => {
  // torrents() does not fetch `error`, so ask for it directly
  const all = await rpc<{ torrents: { id: number; error: number }[] }>('torrent_get', { fields: ['id', 'error'] })
  const err = all.torrents.find(t => t.error !== 0)
  test.skip(!err, 'no errored torrent in this dataset')
  await expect(page.locator(`.row[data-id="${err!.id}"] .sdot.err`)).toBeVisible()
})

test('sidebar filter narrows the list and updates the title', async ({ page }) => {
  await page.locator('.sidebar [data-f="download"]').click()
  await expect(page.locator('#ftitle')).toHaveText('Downloading')
  const n = Number(await page.locator('.sidebar [data-f="download"] .cnt').textContent())
  await expect(page.locator('.row')).toHaveCount(n)
  await expect(page).toHaveURL(/filter=download/)
})

test('the status list is the seven fixed entries, with Checking only while checking', async ({ page }) => {
  const labels = await page.locator('.sidebar [data-f] .lbl').allTextContents()
  // Checking is unpinned: present only when the daemon is actually checking something.
  const expected = ['All torrents', 'Downloading', 'Active', 'Completed', 'Inactive', 'Stopped', 'Error']
  expect(labels.filter(l => l !== 'Checking')).toEqual(expected)
  expect(await page.locator('.sidebar [data-f="seed"]').count()).toBe(0)
  if (await page.locator('.sidebar [data-f="queued"]').count()) {
    expect(Number(await page.locator('.sidebar [data-f="queued"] .cnt').textContent())).toBeGreaterThan(0)
  }
})

test('folder filter uses the download dir relative to the session dir', async ({ page }) => {
  await page.locator('.sidebar .side-item', { hasText: 'radarr' }).first().click()
  await expect(page.locator('#ftitle')).toHaveText('radarr')
  await expect(page.locator('.row')).toHaveCount(2)
})

test('attribute filter chips and empty state', async ({ page }) => {
  await page.locator('#fbtn').click()
  await page.locator('.fpop .frow', { hasText: 'Size' }).getByRole('button', { name: '> 10 GB' }).click()
  await expect(page.locator('.fchip')).toHaveCount(1)
  await expect(page.locator('.empty')).toContainText('Nothing matches')
  await shot(page, 'filter-empty')
  await page.locator('.fpop').getByRole('button', { name: 'Clear' }).click()
  await expect(page.locator('.fchip')).toHaveCount(0)
})

test('pause and resume flip the daemon status', async ({ page }) => {
  const seeding = (await torrents()).find(t => t.status === 6)!
  const row = page.locator(`.row[data-id="${seeding.id}"]`)
  // Pause lives in the row menu now; the trigger keeps its slot, so no hover first.
  // The entry carries its ␣ shortcut hint, so match the label, not the whole cell.
  await row.locator('.acts .more').click()
  await page.locator('.cmenu .it', { hasText: 'Pause' }).click()
  await expect.poll(async () => (await torrents()).find(t => t.id === seeding.id)!.status, { timeout: 8000 }).toBe(0)
  await expect(row.locator('.sdot.stop')).toBeVisible({ timeout: 8000 })
  await row.locator('.acts .more').click()
  await page.locator('.cmenu .it', { hasText: 'Resume' }).click()
  await expect.poll(async () => (await torrents()).find(t => t.id === seeding.id)!.status, { timeout: 8000 }).not.toBe(0)
})

// The reason the column exists: a touch screen never fires hover, so a hover-gated
// trigger is unreachable outright. Needs its own context -- hasTouch is per-context.
test('on a touch screen every row shows its action trigger without interaction', async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1194, height: 834 }, colorScheme: 'dark' })
  const page = await ctx.newPage()
  await page.goto('/')
  await page.locator('.row').first().waitFor()
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
  const acts = page.locator('.row .acts')
  const n = await acts.count()
  const opacities = await acts.evaluateAll(els => els.map(e => getComputedStyle(e).opacity))
  expect(opacities).toEqual(Array(n).fill('1'))
  // The bigger tap target is the other half of the media query, and it only holds
  // while the base .acts button rule stays above it: equal specificity, later wins.
  const box = (await page.locator('.row').first().locator('.acts .more').boundingBox())!
  expect({ w: Math.round(box.width), h: Math.round(box.height) }).toEqual({ w: 32, h: 32 })
  // Tap opens the menu with no hover anywhere in the sequence.
  await page.locator('.row').first().locator('.acts .more').tap()
  await expect(page.locator('.cmenu')).toBeVisible()
  await ctx.close()
})

test('multi-select, selection bar and view menu', async ({ page }) => {
  await page.locator('.row .chk').nth(1).click()
  await page.locator('.row .chk').nth(2).click()
  await expect(page.locator('#selbar .v')).toHaveText('2 selected')
  await shot(page, 'selection')
  await page.locator('#selbar .x').click()
  await expect(page.locator('#selbar')).toHaveCount(0)
  await page.locator('#tmenu').click()
  await expect(page.locator('.cmenu')).toContainText('Resume all')
  await shot(page, 'view-menu')
  await page.keyboard.press('Escape')
})

test('context menu and labels dialog write labels', async ({ page }) => {
  const t = (await torrents()).find(x => x.status === 6)!
  const row = page.locator(`.row[data-id="${t.id}"]`)
  await row.click({ button: 'right' })
  await shot(page, 'context-menu')
  await page.locator('.cmenu .it', { hasText: 'Labels…' }).click()
  await page.locator('.modal input').fill('e2e')
  await page.locator('.modal input').press('Enter')
  await page.locator('.modal').getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await torrents()).find(x => x.id === t.id)!.labels, { timeout: 8000 }).toContain('e2e')
  await rpc('torrent_set', { ids: [t.id], labels: t.labels })
})

test('inspector tabs show real detail data', async ({ page }) => {
  const t = (await torrents()).find(x => x.status === 6)!
  await page.locator(`.row[data-id="${t.id}"] .name .t`).first().click()
  await expect(page.locator('.inspector .insp-head .t')).toHaveText(t.name)
  await expect(page.locator('.pieces i').first()).toBeVisible()
  await shot(page, 'inspector-overview')
  await page.locator('#tabs button', { hasText: 'Files' }).click()
  await expect(page.locator('.tree .f .n').first()).toContainText(t.name)
  await shot(page, 'inspector-files')
  await page.locator('#tabs button', { hasText: 'Trackers' }).click()
  await expect(page.locator('.tracker')).toHaveCount(1)
  await shot(page, 'inspector-trackers')
})

test('dead fixture tracker: issues on a fresh daemon, down + notice once the outage is 10 min old', async ({ page }) => {
  // Every announced fixture torrent fails against 127.0.0.1:1, but "down" also needs the outage
  // to be ≥ 10 min old, which a daemon started seconds ago (CI) cannot provide. The UI remembers
  // when it first saw a host failing (localStorage tm.trkfail), so seed that with an old time
  // and reload: the state is then deterministically "down" and the notice must appear.
  const item = page.locator('.sidebar .side-item', { hasText: '127.0.0.1' })
  await expect(item.locator('.sub')).toHaveText(/down · |of \d+ failing/)
  await page.evaluate(() => localStorage.setItem('tm.trkfail', JSON.stringify([['127.0.0.1', Math.floor(Date.now() / 1000) - 700]])))
  await page.reload()
  await expect(page.locator('.list .notice', { hasText: 'unreachable' })).toContainText('127.0.0.1', { timeout: 15000 })
  await expect(item.locator('.sub.down')).toHaveText(/^down · /)
})

test('add by magnet then remove from list', async ({ page }) => {
  const magnet = 'magnet:?xt=urn:btih:00000000000000000000000000000000000000e2&dn=e2e-added&tr=http://127.0.0.1:1/announce'
  await page.getByRole('button', { name: 'Add' }).first().click()
  await page.locator('.modal input[placeholder^="magnet"]').fill(magnet)
  await page.locator('.modal input[placeholder^="magnet"]').press('Enter')
  await page.locator('.modal').getByRole('button', { name: /Add torrent/ }).click()
  await expect.poll(async () => (await torrents()).some(t => t.name === 'e2e-added'), { timeout: 8000 }).toBe(true)
  const row = page.locator('.row', { hasText: 'e2e-added' })
  await expect(row).toBeVisible({ timeout: 8000 })
  await row.click({ button: 'right' })
  await page.locator('.cmenu .it', { hasText: 'Remove from list' }).click()
  await shot(page, 'confirm-remove')
  await page.locator('.modal').getByRole('button', { name: /^Remove torrent/ }).click()
  await expect.poll(async () => (await torrents()).some(t => t.name === 'e2e-added'), { timeout: 8000 }).toBe(false)
})

test('verify local data on the errored torrent goes through Check and lands back in error', async ({ page }) => {
  const all = await rpc<{ torrents: { id: number; error: number; status: number }[] }>('torrent_get', { fields: ['id', 'error', 'status'] })
  const bad = all.torrents.find(t => t.error !== 0)!
  const row = page.locator(`.row[data-id="${bad.id}"]`)
  await row.click({ button: 'right' })
  await page.locator('.cmenu .it', { hasText: 'Verify local data' }).click()
  // status 2 (check) is brief on a 16 MB file; accept either seeing it or the end state
  await expect.poll(async () => {
    const t = (await rpc<{ torrents: { id: number; error: number; status: number }[] }>('torrent_get', { fields: ['id', 'error', 'status'], ids: [bad.id] })).torrents[0]
    return t.status === 2 || t.status === 1 ? 'checking' : t.error !== 0 ? 'error' : 'other'
  }, { timeout: 10000 }).not.toBe('other')
  await expect(row.locator('.sdot.err')).toBeVisible({ timeout: 15000 })
})

test('settings round-trip through session-set', async ({ page }) => {
  await page.getByTitle('Preferences').click()
  await expect(page.locator('.modal-h .t')).toHaveText('Speed')
  await shot(page, 'settings-speed')
  const before = await rpc<{ 'alt_speed_up': number }>('session_get', { fields: ['alt_speed_up'] })
  const inp = page.locator('.opt', { hasText: 'Upload limit' }).nth(1).locator('input')
  await inp.fill(String(before.alt_speed_up + 7))
  await inp.press('Enter')
  await expect.poll(async () => (await rpc<{ 'alt_speed_up': number }>('session_get', { fields: ['alt_speed_up'] })).alt_speed_up, { timeout: 8000 }).toBe(before.alt_speed_up + 7)
  await rpc('session_set', { 'alt_speed_up': before.alt_speed_up })
  await page.locator('.side-item', { hasText: 'Network' }).click()
  await shot(page, 'settings-network')
})

test('stats popover and turtle toggle', async ({ page }) => {
  await page.locator('.speeds').click()
  await expect(page.locator('.pop')).toContainText('All time')
  await shot(page, 'stats')
  await page.keyboard.press('Escape')
  const before = await rpc<{ 'alt_speed_enabled': boolean }>('session_get', { fields: ['alt_speed_enabled'] })
  await page.locator('#turtle').click()
  await expect.poll(async () => (await rpc<{ 'alt_speed_enabled': boolean }>('session_get', { fields: ['alt_speed_enabled'] })).alt_speed_enabled, { timeout: 8000 }).toBe(!before.alt_speed_enabled)
  await expect(page.locator('.speeds .lim')).toHaveCount(before.alt_speed_enabled ? 0 : 1)
  await page.locator('#turtle').click()
  await expect.poll(async () => (await rpc<{ 'alt_speed_enabled': boolean }>('session_get', { fields: ['alt_speed_enabled'] })).alt_speed_enabled, { timeout: 8000 }).toBe(before.alt_speed_enabled)
})
