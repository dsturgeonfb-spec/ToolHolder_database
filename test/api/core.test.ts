import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestApp } from '../helpers.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

// BUILD_SPEC §7 acceptance checks, straight against the views, after the app's migration ran.
test('acceptance: 54 holders on site before any count', () => {
  assert.equal(Number(t.app.ctx.db.value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')), 54)
})

test('acceptance: tally by manufacturer HAIMER 37, MAPAL 9, CERATIZIT 7, KEMMLER 1', () => {
  const rows = t.app.ctx.db.all<{ manufacturer: string; holders_on_site: number }>('SELECT manufacturer, holders_on_site FROM v_tally_by_manufacturer')
  const m = Object.fromEntries(rows.map((r) => [r.manufacturer, Number(r.holders_on_site)]))
  assert.deepEqual({ HAIMER: m.HAIMER, MAPAL: m.MAPAL, CERATIZIT: m.CERATIZIT, KEMMLER: m.KEMMLER }, { HAIMER: 37, MAPAL: 9, CERATIZIT: 7, KEMMLER: 1 })
})

test('acceptance: v_gl_check is exactly the 4 Haimer face mill arbors (17, 19, 19, 21)', () => {
  const rows = t.app.ctx.db.all<{ order_no: string; delta_mm: number }>('SELECT order_no, delta_mm FROM v_gl_check ORDER BY order_no')
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => Number(r.delta_mm)).sort((a, b) => a - b), [17, 19, 19, 21])
  assert.ok(rows.every((r) => r.order_no.startsWith('A63.05')))
})

test('acceptance: 13 on-site holders fit a Ø12 shank', () => {
  const n = t.app.ctx.db.value('SELECT COUNT(*) FROM v_catalogue WHERE qty_on_site > 0 AND clamp_min_mm <= 12 AND 12 <= clamp_max_mm')
  assert.equal(Number(n), 13)
})

test('acceptance: 31 data flags (1 HIGH, 9 MEDIUM, 9 LOW, 12 INFO)', () => {
  const rows = t.app.ctx.db.all<{ severity: string; n: number }>('SELECT severity, COUNT(*) AS n FROM data_flags GROUP BY severity')
  const m = Object.fromEntries(rows.map((r) => [r.severity, Number(r.n)]))
  assert.deepEqual(m, { HIGH: 1, MEDIUM: 9, LOW: 9, INFO: 12 })
})

test('migration is idempotent and keeps the data', async () => {
  const { migrate } = await import('../../src/server/db.js')
  const { readFileSync } = await import('node:fs')
  migrate(t.app.ctx.db, readFileSync(t.app.ctx.paths.schemaPath, 'utf8'))
  migrate(t.app.ctx.db, readFileSync(t.app.ctx.paths.schemaPath, 'utf8'))
  assert.equal(Number(t.app.ctx.db.value('SELECT COUNT(*) FROM holders')), 88)
  assert.equal(Number(t.app.ctx.db.value('PRAGMA user_version')), 2)
  assert.ok(t.app.ctx.db.value(`SELECT 1 FROM holder_types WHERE type_code='OTHER'`))
})

test('summary endpoint', async () => {
  const r = await t.api('GET', '/api/summary')
  assert.equal(r.status, 200)
  assert.equal(r.body.holders_on_site, 54)
  assert.equal(r.body.articles_on_site, 54)
  assert.equal(r.body.articles_in_catalogue, 88)
  assert.equal(r.body.counted, 0)
  assert.equal(r.body.to_count, 54)
  assert.equal(r.body.open_flags, 19)
  assert.equal(r.body.open_high, 1)
})

test('meta endpoint lists reference data', async () => {
  const r = await t.api('GET', '/api/meta')
  assert.equal(r.status, 200)
  assert.equal(r.body.interfaces[0].interface_code, 'HSK-A63')
  assert.ok(r.body.types.length >= 9)
  assert.equal(r.body.locations.length, 3)
})

test('writes without the CSRF header are refused', async () => {
  const res = await fetch(t.base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(res.status, 403)
})

test('settings need a user and round-trip', async () => {
  assert.equal((await t.api('PUT', '/api/settings', { users: ['A'] }, { user: null })).status, 400)
  const r = await t.api('PUT', '/api/settings', { users: ['Dave', 'Dave', ' Sam '], unit_inspection_days: 90 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.users, ['Dave', 'Sam'])
  assert.equal(r.body.unit_inspection_days, 90)
})

test('static UI and images are served; path traversal is refused', async () => {
  assert.equal((await fetch(t.base + '/')).status, 200)
  assert.equal((await fetch(t.base + '/images/cam/cam_01.png')).status, 200)
  assert.equal((await fetch(t.base + '/ui/..%2f..%2fpackage.json')).status, 403)
  assert.equal((await fetch(t.base + '/images/..%2fholder_catalogue.sqlite')).status, 403)
})

test('network share: PIN login gates the API; host-only routes refused', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const share = await t.api('PUT', '/api/system/share', { enabled: true, port })
  assert.equal(share.status, 200, JSON.stringify(share.body))
  assert.match(share.body.pin, /^\d{6}$/)
  // The share listener treats everyone as a network client, even from this machine.
  const shareBase = `http://127.0.0.1:${port}`
  assert.equal((await fetch(shareBase + '/api/summary')).status, 401)
  const bad = await fetch(shareBase + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'HolderCatalogue' }, body: JSON.stringify({ pin: '000000x', name: 'Tab' }) })
  assert.equal(bad.status, 401)
  const ok = await fetch(shareBase + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'HolderCatalogue' }, body: JSON.stringify({ pin: share.body.pin, name: 'Tablet 1' }) })
  assert.equal(ok.status, 200)
  const cookie = ok.headers.get('set-cookie')!.split(';')[0]!
  const sum = await fetch(shareBase + '/api/summary', { headers: { cookie } })
  assert.equal(sum.status, 200)
  const sess = await (await fetch(shareBase + '/api/session', { headers: { cookie } })).json()
  assert.equal(sess.name, 'Tablet 1')
  assert.equal((await fetch(shareBase + '/api/system/share', { headers: { cookie } })).status, 403)
  const off = await t.api('PUT', '/api/system/share', { enabled: false })
  assert.equal(off.body.enabled, false)
})

test('loopback requests with a foreign Host header are refused (DNS rebinding)', async () => {
  const { request } = await import('node:http')
  const status = await new Promise<number>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: t.app.port, path: '/api/summary', headers: { Host: `evil.example:${t.app.port}` } }, (res) => {
      res.resume()
      ok(res.statusCode!)
    })
    req.on('error', fail)
    req.end()
  })
  assert.equal(status, 421)
  assert.equal((await t.api('GET', '/api/summary')).status, 200)
})

test('malformed % encoding in an API path is a 400, not a 500', async () => {
  assert.equal((await t.api('GET', '/api/holders/%E0%A4%A')).status, 400)
})

test('settings: a bad field changes nothing; changes are audited with old and new values', async () => {
  const before = (await t.api('GET', '/api/settings')).body
  const bad = await t.api('PUT', '/api/settings', { unit_inspection_days: 30, default_interface: 'NOPE' })
  assert.equal(bad.status, 400)
  assert.equal((await t.api('GET', '/api/settings')).body.unit_inspection_days, before.unit_inspection_days)
  await t.api('PUT', '/api/settings', { unit_inspection_days: 120 }, { user: 'QA Lead' })
  const ev = (await t.api('GET', '/api/audit?entity=setting&entity_id=unit_inspection_days')).body
  assert.equal(ev[0].by_user, 'QA Lead')
  assert.deepEqual(ev[0].detail, { from: before.unit_inspection_days, to: 120 })
})

test('Idempotency-Key: a resent write returns the first answer and books nothing more', async () => {
  const key = 'test-key-' + Date.now()
  const send = () =>
    fetch(t.base + '/api/flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'HolderCatalogue', 'X-User': 'Tester', 'Idempotency-Key': key },
      body: JSON.stringify({ severity: 'LOW', category: 'Test', message: 'retry-safe ' + key }),
    })
  const n0 = Number(t.app.ctx.db.value('SELECT COUNT(*) FROM data_flags'))
  const a = await send()
  const b = await send()
  assert.ok(a.status < 300)
  assert.equal(b.status, a.status)
  assert.equal(b.headers.get('idempotent-replay'), 'true')
  assert.deepEqual(await b.json(), await a.json())
  assert.equal(Number(t.app.ctx.db.value('SELECT COUNT(*) FROM data_flags')), n0 + 1)
})

test('the data folder is locked: a second server on the same folder is refused while the first runs', async () => {
  const { AppServer } = await import('../../src/server/app.js')
  const { REPO } = await import('../helpers.js')
  assert.throws(() => new AppServer({ dataDir: t.dataDir, appRoot: REPO, log: () => {}, autoBackup: false }), /already open/)
})

test('network PIN: a LAN-wide guessing run locks sign-in until a new PIN is made', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const share = (await t.api('PUT', '/api/system/share', { enabled: true, port })).body
  const login = (pin: string) =>
    fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'HolderCatalogue' },
      body: JSON.stringify({ pin, name: 'Tab' }),
    })
  ;(t.app as any).pinFailures = Array.from({ length: 50 }, () => Date.now())
  assert.equal((await login(share.pin)).status, 429, 'even the right PIN is refused while locked')
  const fresh = (await t.api('PUT', '/api/system/share', { enabled: true, port, regeneratePin: true })).body
  assert.equal((await login(fresh.pin)).status, 200)
  await t.api('PUT', '/api/system/share', { enabled: false })
})

test('maker + order no. is unique ignoring letter case, at database level too', () => {
  assert.ok(t.app.ctx.db.value(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_holders_identity_nocase'`))
  assert.throws(
    () => t.app.ctx.db.run(`INSERT INTO holders(holder_id, manufacturer_id, order_no, type_code, interface_code) SELECT 'HX999', manufacturer_id, lower(order_no), type_code, interface_code FROM holders WHERE holder_id = 'H0001'`),
    /UNIQUE/,
  )
})
