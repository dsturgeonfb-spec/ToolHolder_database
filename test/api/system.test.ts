import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startTestApp, type TestApp } from '../helpers.js'
import { backupIfDue, listBackups } from '../../src/server/modules/system.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

test('system info for the host', async () => {
  const r = await t.api('GET', '/api/system')
  assert.equal(r.status, 200)
  assert.equal(r.body.dataDir, t.dataDir)
  assert.equal(r.body.schemaVersion, 2)
  assert.ok(r.body.dbSizeBytes > 100_000)
  assert.equal(r.body.desktop, false)
})

test('backup now writes a consistent, openable copy', async () => {
  const r = await t.api('POST', '/api/system/backup')
  assert.equal(r.status, 200)
  assert.match(r.body.file, /^holder_catalogue-\d{8}-\d{6}-manual\.sqlite$/)
  const path = join(t.dataDir, 'backups', r.body.file)
  assert.ok(existsSync(path))
  const copy = new DatabaseSync(path, { readOnly: true })
  assert.equal(Number((copy.prepare('SELECT SUM(qty_on_site) n FROM v_stock_on_hand').get() as any).n), 54)
  copy.close()
  // A second backup in the same second gets its own file.
  const r2 = await t.api('POST', '/api/system/backup')
  assert.notEqual(r2.body.file, r.body.file)
})

test('daily backup only when due', () => {
  assert.equal(backupIfDue(t.app.ctx, 20), null, 'a backup was just made')
  const b = backupIfDue(t.app.ctx, 0)
  assert.ok(b && b.file.endsWith('-auto.sqlite'))
  assert.ok(listBackups(t.app.ctx).length >= 3)
})

test('backups keep the newest 30', async () => {
  for (let i = 0; i < 32; i++) await t.api('POST', '/api/system/backup')
  assert.equal(readdirSync(join(t.dataDir, 'backups')).filter((f) => f.endsWith('.sqlite')).length, 30)
})

test('open folder without the desktop shell just reports the path', async () => {
  const r = await t.api('POST', '/api/system/open', { what: 'backups' })
  assert.deepEqual(r.body, { opened: false, path: join(t.dataDir, 'backups') })
  assert.equal((await t.api('POST', '/api/system/open', { what: '../etc' })).status, 400)
})
