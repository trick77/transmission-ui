// The ship path: the daemon itself serves ui/dist at /transmission/web/ behind its basic auth.
// Needs `npm run build` and the compose daemon (TRANSMISSION_WEB_HOME=/web mounts ui/dist).
import { test, expect } from '@playwright/test'

const WEB = process.env.TM_WEB || 'http://localhost:9091/transmission/web/'

test('without credentials the daemon challenges the navigation (browser prompt path)', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const res = await page.goto(WEB)
  expect(res?.status()).toBe(401)
  expect(res?.headers()['www-authenticate'] ?? '').toMatch(/basic/i)
  await ctx.close()
})

test('with credentials the served bundle polls the same-origin RPC and renders live data', async ({ browser }) => {
  const ctx = await browser.newContext({ httpCredentials: { username: 'dev', password: 'devpass' }, viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(WEB + '?sel=2')
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.inspector .pieces i').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.speeds .tot').first()).toContainText('this session')
  await page.screenshot({ path: 'test-results/served.png' })
  await ctx.close()
})

test('a session expiring mid-use shows the sign-in screen instead of a dead page', async ({ browser }) => {
  const ctx = await browser.newContext({ httpCredentials: { username: 'dev', password: 'devpass' }, viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(WEB)
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 })
  await page.route('**/transmission/rpc', r => r.fulfill({ status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Transmission"' }, body: '' }))
  // A dead session takes the whole screen: leaving the shell up behind a banner
  // reads as a working app whose every action silently fails.
  await expect(page.locator('.signin')).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.locator('.row')).toHaveCount(0)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/served-unauthorized.png' })
  await ctx.close()
})
