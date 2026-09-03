import { defineConfig } from '@playwright/test'

// Behaviour tests against the running dev server + seeded local daemon. Coverage comes from Vitest.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.TM_UI_URL || 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  },
  reporter: 'list',
})
