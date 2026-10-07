/**
 * Launches the real Electron app (built main process) against a temp data folder and checks the
 * desktop-only parts: the in-process server, the window, the preload bridge, first-run seeding and
 * the daily backup. On Linux run it under a display: `xvfb-run -a npm run test:electron`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { REPO } from '../helpers.js'

const noDisplay = process.platform === 'linux' && !process.env.DISPLAY

test('desktop app starts, seeds its data folder, shows the catalogue and backs up', { skip: noDisplay && 'no display (run under xvfb-run)', timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-electron-'))
  // HC_ELECTRON_EXECUTABLE = a packaged build (release/win-unpacked/Holder Catalogue.exe) — CI smoke-tests
  // the real installer contents with it; otherwise the repo is run through the dev Electron binary.
  const packaged = process.env.HC_ELECTRON_EXECUTABLE
  const sandboxArgs = process.platform === 'linux' ? ['--no-sandbox'] : []
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged, args: sandboxArgs } : { args: [...sandboxArgs, REPO], cwd: REPO }),
    env: { ...process.env, HOLDER_CATALOGUE_DATA: dataDir },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => document.getElementById('tTotal')?.textContent === '54', null, { timeout: 30_000 })
    assert.equal(await win.title(), 'Holder Catalogue')
    const bridge = await win.evaluate(() => ({ isDesktop: (window as any).desktop?.isDesktop, version: (window as any).desktop?.version }))
    assert.equal(bridge.isDesktop, true)
    assert.match(String(bridge.version), /^\d+\.\d+\.\d+/)
    // Node integration must be off in the page.
    assert.equal(await win.evaluate(() => typeof (window as any).require), 'undefined')
    assert.ok(existsSync(join(dataDir, 'holder_catalogue.sqlite')), 'database seeded into the data folder')
    assert.ok(readdirSync(join(dataDir, 'images', 'cam')).length >= 54, 'profile images copied')
    // The daily backup runs ~3 s after the window shows.
    const t0 = Date.now()
    while (Date.now() - t0 < 15_000 && !readdirSync(join(dataDir, 'backups')).some((f) => f.endsWith('.sqlite'))) await new Promise((r) => setTimeout(r, 250))
    assert.ok(readdirSync(join(dataDir, 'backups')).some((f) => /^holder_catalogue-\d{8}-\d{6}-auto\.sqlite$/.test(f)), 'daily backup written')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
