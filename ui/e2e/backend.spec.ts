// The shipped path: the Go backend serves the bundle, owns the session, and
// proxies RPC to the daemon with the daemon's credentials attached. Run in form
// mode, which needs no identity provider.
//
// Needs the backend running against the compose daemon; hack/backend.sh starts
// it. TM_APP points at it.
import { test, expect } from '@playwright/test'

const APP = process.env.TM_APP || 'http://127.0.0.1:8127'
const USER = process.env.TM_USER || 'dev'
const PASS = process.env.TM_PASS || 'devpass'

test('an unauthenticated visit lands on the login form', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(APP)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('input[name="password"]')).toBeVisible()
  await ctx.close()
})

test('the RPC endpoint refuses an unauthenticated POST', async ({ request }) => {
  const res = await request.post(`${APP}/transmission/rpc`, {
    data: { jsonrpc: '2.0', method: 'session_get', id: 1 },
  })
  expect(res.status()).toBe(401)
})

test('wrong credentials are rejected and say so', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(`${APP}/login`)
  await page.fill('input[name="username"]', USER)
  await page.fill('input[name="password"]', 'definitely-not-the-password')
  await page.click('button[type="submit"]')
  await expect(page.locator('.err')).toContainText(/wrong username or password/i)
  await ctx.close()
})

test('signing in renders live data, and no browser auth dialog appears', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  // A native basic-auth prompt would mean the daemon's 401 reached the browser,
  // which is the failure this backend exists to prevent. Playwright surfaces it
  // as an unhandled dialog; fail loudly rather than time out.
  let prompted = false
  page.on('dialog', d => { prompted = true; void d.dismiss() })

  await page.goto(`${APP}/login`)
  await page.fill('input[name="username"]', USER)
  await page.fill('input[name="password"]', PASS)
  await page.click('button[type="submit"]')

  await expect(page).toHaveURL(new RegExp(`${APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`))
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.speeds .tot').first()).toContainText('this session')
  expect(prompted, 'a browser auth dialog appeared').toBe(false)

  await page.screenshot({ path: 'test-results/backend-form-signed-in.png' })
  await ctx.close()
})

test('a signed-in session survives a reload', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(`${APP}/login`)
  await page.fill('input[name="username"]', USER)
  await page.fill('input[name="password"]', PASS)
  await page.click('button[type="submit"]')
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 })

  await page.reload()
  await expect(page).not.toHaveURL(/\/login$/)
  await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 })
  await ctx.close()
})

test('a missing asset 404s instead of returning the app shell', async ({ request }) => {
  // Serving index.html here would hand the browser HTML where it expects a
  // module, and the app would die on a MIME error after a redeploy.
  const res = await request.get(`${APP}/assets/index-doesnotexist.js`)
  expect(res.status()).toBe(404)
})
