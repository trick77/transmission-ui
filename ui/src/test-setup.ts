// vitest setupFiles entry (see vite.config.ts `test.setupFiles`): jest-dom matchers on vitest's
// `expect`, DOM cleanup between tests, and the browser APIs jsdom lacks.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Node ≥ 22 exposes an experimental `localStorage` global (backed by --localstorage-file) that
// shadows jsdom's and has no clear(); replace it with a plain in-memory Storage for tests.
class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
}
for (const target of [globalThis, window] as unknown as Record<string, unknown>[]) {
  Object.defineProperty(target, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true })
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}

afterEach(() => {
  cleanup()
})
