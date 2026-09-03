// Runs against the local compose daemon seeded by hack/fixtures.sh, through the Vite dev server (npm run dev).
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const RPC = process.env.TM_RPC || 'http://localhost:9091/transmission/rpc'
const AUTH = 'Basic ' + Buffer.from(process.env.TM_AUTH || 'dev:devpass').toString('base64')
let sid = ''
async function rpc<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const call = () => fetch(RPC, { method: 'POST', headers: { Authorization: AUTH, 'X-Transmission-Session-Id': sid, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, arguments: args }) })
  let r = await call()
  if (r.status === 409) { sid = r.headers.get('x-transmission-session-id') || ''; r = await call() }
  const j = await r.json() as { result: string; arguments: T }
  if (j.result !== 'success') throw new Error(j.result)
  return j.arguments
}
const torrents = () => rpc<{ torrents: { id: number; name: string; status: number; labels: string[] }[] }>('torrent-get', { fields: ['id', 'name', 'status', 'labels'] }).then(r => r.torrents)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/${name}.png` })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 })
})

test('list renders every daemon torrent and the sidebar counts match', async ({ page }) => {
  const list = await torrents()
  await expect(page.locator('.row')).toHaveCount(list.length)
  const stopped = list.filter(t => t.status === 0).length
  await expect(page.locator('.sidebar [data-f="all"] .cnt')).toHaveText(String(list.length))
  const errCount = Number(await page.locator('.sidebar [data-f="error"] .cnt').textContent())
  const stoppedUi = Number(await page.locator('.sidebar [data-f="stopped"] .cnt').textContent())
  expect(errCount + stoppedUi).toBe(stopped)  // fixtures: one stopped, one errored (status 0 + error)
  await shot(page, 'list')
})

test('problem torrents sort first by default', async ({ page }) => {
  const first = page.locator('.row').first()
  await expect(first.locator('.chip.err')).toBeVisible()
})

test('sidebar filter narrows the list and updates the title', async ({ page }) => {
  await page.locator('.sidebar [data-f="seed"]').click()
  await expect(page.locator('#ftitle')).toHaveText('Seeding')
  const n = Number(await page.locator('.sidebar [data-f="seed"] .cnt').textContent())
  await expect(page.locator('.row')).toHaveCount(n)
  await expect(page).toHaveURL(/filter=seed/)
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
  await row.hover()
  await row.locator('.acts button').first().click()
  await expect.poll(async () => (await torrents()).find(t => t.id === seeding.id)!.status, { timeout: 8000 }).toBe(0)
  await expect(row.locator('.chip.stop')).toBeVisible({ timeout: 8000 })
  await row.hover()
  await row.locator('.acts button').first().click()
  await expect.poll(async () => (await torrents()).find(t => t.id === seeding.id)!.status, { timeout: 8000 }).not.toBe(0)
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
  await rpc('torrent-set', { ids: [t.id], labels: t.labels })
})

test('inspector tabs show real detail data', async ({ page }) => {
  const t = (await torrents()).find(x => x.status === 6)!
  await page.locator(`.row[data-id="${t.id}"] .name .t span`).first().click()
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
  await expect(page.locator('.notice')).toContainText('127.0.0.1', { timeout: 15000 })
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
  const all = await rpc<{ torrents: { id: number; error: number; status: number }[] }>('torrent-get', { fields: ['id', 'error', 'status'] })
  const bad = all.torrents.find(t => t.error !== 0)!
  const row = page.locator(`.row[data-id="${bad.id}"]`)
  await row.click({ button: 'right' })
  await page.locator('.cmenu .it', { hasText: 'Verify local data' }).click()
  // status 2 (check) is brief on a 16 MB file; accept either seeing it or the end state
  await expect.poll(async () => {
    const t = (await rpc<{ torrents: { id: number; error: number; status: number }[] }>('torrent-get', { fields: ['id', 'error', 'status'], ids: [bad.id] })).torrents[0]
    return t.status === 2 || t.status === 1 ? 'checking' : t.error !== 0 ? 'error' : 'other'
  }, { timeout: 10000 }).not.toBe('other')
  await expect(row.locator('.chip.err')).toBeVisible({ timeout: 15000 })
})

test('settings round-trip through session-set', async ({ page }) => {
  await page.getByTitle('Preferences').click()
  await expect(page.locator('.modal-h .t')).toHaveText('Speed')
  await shot(page, 'settings-speed')
  const before = await rpc<{ 'alt-speed-up': number }>('session-get', { fields: ['alt-speed-up'] })
  const inp = page.locator('.opt', { hasText: 'Upload limit' }).nth(1).locator('input')
  await inp.fill(String(before['alt-speed-up'] + 7))
  await inp.press('Enter')
  await expect.poll(async () => (await rpc<{ 'alt-speed-up': number }>('session-get', { fields: ['alt-speed-up'] }))['alt-speed-up'], { timeout: 8000 }).toBe(before['alt-speed-up'] + 7)
  await rpc('session-set', { 'alt-speed-up': before['alt-speed-up'] })
  await page.locator('.side-item', { hasText: 'Network' }).click()
  await shot(page, 'settings-network')
})

test('stats popover and turtle toggle', async ({ page }) => {
  await page.locator('.speeds').click()
  await expect(page.locator('.pop')).toContainText('All time')
  await shot(page, 'stats')
  await page.keyboard.press('Escape')
  const before = await rpc<{ 'alt-speed-enabled': boolean }>('session-get', { fields: ['alt-speed-enabled'] })
  await page.locator('#turtle').click()
  await expect.poll(async () => (await rpc<{ 'alt-speed-enabled': boolean }>('session-get', { fields: ['alt-speed-enabled'] }))['alt-speed-enabled'], { timeout: 8000 }).toBe(!before['alt-speed-enabled'])
  await expect(page.locator('.speeds .lim')).toHaveCount(before['alt-speed-enabled'] ? 0 : 1)
  await page.locator('#turtle').click()
  await expect.poll(async () => (await rpc<{ 'alt-speed-enabled': boolean }>('session-get', { fields: ['alt-speed-enabled'] }))['alt-speed-enabled'], { timeout: 8000 }).toBe(before['alt-speed-enabled'])
})
