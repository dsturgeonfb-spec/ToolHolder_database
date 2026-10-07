import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataFolderUnavailableError, isOneDrivePath, movedTo, resolveDataDir, retireOldCopy } from '../../src/main/data-folder.js'

const base = { env: {}, platform: 'linux' as NodeJS.Platform, home: tmpdir(), localAppData: tmpdir() }

test('a folder the app used before is never re-created when it has gone', () => {
  const gone = join(tmpdir(), `hc-gone-${process.pid}-${Date.now()}`)
  assert.throws(() => resolveDataDir({ ...base, pointer: { dataDir: gone, lastVersion: '0.1.0' } }), DataFolderUnavailableError)
  assert.equal(existsSync(gone), false, 'the missing folder was not created')
})

test('an existing pointer folder is used; the env override wins over everything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-df-'))
  try {
    assert.deepEqual(resolveDataDir({ ...base, pointer: { dataDir: dir } }), { dataDir: dir, source: 'pointer' })
    assert.equal(resolveDataDir({ ...base, env: { HOLDER_CATALOGUE_DATA: dir }, pointer: { dataDir: '/nope' } }).source, 'env')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('after a move the old copy is retired: database renamed (with its -wal) and a note points to the new folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-old-'))
  try {
    writeFileSync(join(dir, 'holder_catalogue.sqlite'), 'db')
    writeFileSync(join(dir, 'holder_catalogue.sqlite-wal'), 'wal')
    retireOldCopy(dir, 'D:\\Catalogue')
    const files = readdirSync(dir).sort()
    assert.ok(!files.includes('holder_catalogue.sqlite'))
    assert.ok(files.some((f) => /^holder_catalogue\.MOVED-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)))
    assert.ok(files.some((f) => /^holder_catalogue\.MOVED-\d{4}-\d{2}-\d{2}\.sqlite-wal$/.test(f)), 'the -wal travels with its database')
    assert.equal(movedTo(dir), 'D:\\Catalogue')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OneDrive folders are recognised (env roots and the usual folder names)', () => {
  const env = { OneDrive: 'C:\\Users\\dave\\OneDrive - Exact', OneDriveConsumer: 'C:\\Users\\dave\\OneDrive' }
  assert.ok(isOneDrivePath('C:\\Users\\dave\\OneDrive - Exact\\Catalogue', env))
  assert.ok(isOneDrivePath('C:\\Users\\dave\\OneDrive\\Docs', env))
  assert.ok(isOneDrivePath('E:\\Sync\\OneDrive - Contoso\\x', {}))
  assert.equal(isOneDrivePath('C:\\Holder Catalogue', env), false)
})
