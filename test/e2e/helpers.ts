/**
 * Browser tests: the real UI in Chromium (playwright-core) against a test server with a fresh
 * copy of the seeded database. Locally PLAYWRIGHT_BROWSERS_PATH points at the preinstalled
 * Chromium; in CI the workflow installs it with `npx playwright-core install chromium`.
 */
import { chromium, type Browser, type Page } from 'playwright-core'
import { startTestApp, type TestApp } from '../helpers.js'

export interface E2E {
  t: TestApp
  browser: Browser
  page: Page
  /** Console errors and failed requests seen by the page (assert this stays empty). */
  errors: string[]
  goto(hash: string): Promise<void>
  close(): Promise<void>
}

export async function startE2E(opts: { user?: string | null; viewport?: { width: number; height: number } } = {}): Promise<E2E> {
  const t = await startTestApp()
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 }, acceptDownloads: true })
  const user = opts.user === undefined ? 'E2E Tester' : opts.user
  if (user) await context.addInitScript((u) => localStorage.setItem('hc.user', u), user)
  const page = await context.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return {
    t,
    browser,
    page,
    errors,
    async goto(hash) {
      await page.goto(`${t.base}/${hash.startsWith('#') ? hash : '#/' + hash}`)
      await page.waitForFunction(() => !document.querySelector('#view .loading'), null, { timeout: 15_000 })
    },
    async close() {
      await browser.close()
      await t.close()
    },
  }
}
