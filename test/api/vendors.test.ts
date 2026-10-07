import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { FIXTURES, startTestApp, type TestApp } from '../helpers.js'
import { today } from '../../src/server/domain.js'
import { HostGates, type FetchFn } from '../../src/server/vendors/fetcher.js'
import { fixtureFetch, type FixtureFetch } from '../../src/server/vendors/fixtures.js'
import { setVendorHooks } from '../../src/server/vendors/hooks.js'

let t: TestApp
let net: FixtureFetch
const DIR = join(FIXTURES, 'vendors')
before(async () => {
  t = await startTestApp()
  net = fixtureFetch(DIR)
  setVendorHooks(t.app.ctx, { fetch: net, sleep: async () => {}, gates: new HostGates() })
})
after(async () => t.close())

const db = () => t.app.ctx.db
const onSite = () => Number(db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand'))
const holderCount = () => Number(db().value('SELECT COUNT(*) FROM holders'))
const holderBy = (order: string) => db().get<any>('SELECT * FROM holders WHERE order_no = ?', [order])!
async function scan(maker: string, body: unknown) {
  const r = await t.api('POST', `/api/vendors/${maker}/scan`, body)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.match(r.body.job_id, /^job-/)
  const job = await t.app.ctx.jobs.wait(r.body.job_id)
  assert.equal(job.status, 'done', job.error)
  return { job_id: r.body.job_id as string, job, result: job.result as any }
}
const actions = (result: any) => Object.fromEntries(result.proposals.map((p: any) => [p.order_no, p.action]))

const HAIMER_ORDERS = ['A63.182.03.8', 'A63.182.04.8', 'A63.140.03', 'A63.140.04', 'A63.147.05.1', 'A63.1H10.10', 'A63.050.16.KKB']

test('GET /api/vendors: one card per maker with method, automated flag, robots notes, live counts, and the prototype source cards', async () => {
  const r = await t.api('GET', '/api/vendors')
  assert.equal(r.status, 200)
  const v = r.body
  assert.deepEqual(v.vendors.map((x: any) => x.maker), ['HAIMER', 'MAPAL', 'KEMMLER', 'CERATIZIT', 'SANDVIK COROMANT', 'CUTWEL'])
  const by = Object.fromEntries(v.vendors.map((x: any) => [x.maker, x]))
  assert.deepEqual([by.HAIMER.automated, by.MAPAL.automated, by.KEMMLER.automated, by.CERATIZIT.automated, by['SANDVIK COROMANT'].automated, by.CUTWEL.automated], [true, true, true, false, false, false])
  assert.deepEqual([by.HAIMER.articles_on_site, by.MAPAL.articles_on_site, by.CERATIZIT.articles_on_site, by.KEMMLER.articles_on_site], [37, 9, 7, 1])
  assert.equal(by.MAPAL.articles_in_catalogue, 43)
  assert.equal(by.CUTWEL.is_distributor, 1)
  assert.match(by.HAIMER.robots, /Crawl-delay 10 s/)
  assert.equal(by.HAIMER.delay_s, 10)
  assert.match(by.CERATIZIT.robots, /403/)
  for (const k of ['maker', 'method', 'automated', 'notes', 'robots', 'source_url', 'articles_on_site', 'articles_in_catalogue']) assert.ok(k in by.HAIMER, k)
  assert.equal(v.sources.length, 6)
  assert.equal(v.sources[0].vendor, 'HAIMER · 37 on site')
  assert.equal(v.sources.find((s: any) => s.maker === 'SANDVIK COROMANT').vendor, 'SANDVIK COROMANT · none on site')
  assert.equal(v.user_agent, 'HolderCatalogue/0.1.0 (+contact not set)')
  assert.equal(v.vendor_contact_set, false)
  // 17 photo addresses; the 7 Ceratizit ones are on the distributor's CDN (no adapter), so 10 can be downloaded.
  assert.deepEqual(v.images, { with_url: 17, downloadable: 10, cached: 0 })
  // The CERATIZIT card counts live, not a fixed "7 holders".
  assert.match(by.CERATIZIT.why, /All 7 Ceratizit holders in the catalogue carry data from the distributor Zedaro/)
  // CUTWEL / SANDVIK: the decision to stay on the manual file-import route is stated on the cards and the notes.
  for (const m of ['CUTWEL', 'SANDVIK COROMANT']) {
    for (const text of [by[m].notes, by[m].why])
      assert.match(text, /stays on the manual file-import route .*browser engine \(Playwright\) that is not bundled with the app, and the site could not be tested from the build environment/, m)
    assert.match(by[m].method, /^File import/, m)
    assert.doesNotMatch(v.sources.find((s: any) => s.maker === m).method, /Playwright/, m)
  }
  // The contact e-mail set in Settings goes into the user agent.
  assert.equal((await t.api('PUT', '/api/settings', { vendor_contact: 'tooling@example.com' })).status, 200)
  const r2 = await t.api('GET', '/api/vendors')
  assert.equal(r2.body.user_agent, 'HolderCatalogue/0.1.0 (+tooling@example.com)')
  assert.equal(r2.body.vendor_contact_set, true)
})

test('scan validation: a person, a known automated maker, a known interface and real order nos are required', async () => {
  const noUser = await t.api('POST', '/api/vendors/HAIMER/scan', {}, { user: null })
  assert.equal(noUser.status, 400)
  assert.match(noUser.body.error, /Enter your name/)
  assert.equal((await t.api('POST', '/api/vendors/WALTER/scan', {})).status, 404)
  const cer = await t.api('POST', '/api/vendors/CERATIZIT/scan', {})
  assert.equal(cer.status, 400)
  assert.match(cer.body.error, /not scanned automatically: 403.*File import/)
  const cut = await t.api('POST', '/api/vendors/CUTWEL/scan', {})
  assert.equal(cut.status, 400)
  assert.match(cut.body.error, /CUTWEL is not scanned automatically: .*manual file-import route.*File import/)
  const iface = await t.api('POST', '/api/vendors/HAIMER/scan', { interface_code: 'BT40' })
  assert.equal(iface.status, 400)
  assert.match(iface.body.error, /Unknown interface "BT40"/)
  const bad = await t.api('POST', '/api/vendors/HAIMER/scan', { order_nos: ['A63.182.03.8', '<script>alert(1)</script>'] })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /don't look like order numbers/)
  assert.equal((await t.api('GET', '/api/vendors/HAIMER/scan')).status, 405)
  assert.equal(net.requested.length, 0, 'nothing was fetched for refused scans')
})

let haimerScan: { job_id: string; result: any }
test('HAIMER scan (fixtures): robots.txt first, sitemap for unknown pages, honest UA, never /search — proposals insert/update/same/error', async () => {
  const s = await scan('haimer', { interface_code: 'HSK-A63', order_nos: HAIMER_ORDERS.join('\n') })
  haimerScan = s
  assert.equal(s.result.maker, 'HAIMER')
  assert.equal(s.result.interface_code, 'HSK-A63')
  assert.deepEqual(actions(s.result), {
    'A63.182.03.8': 'same',
    'A63.182.04.8': 'update',
    'A63.140.03': 'update',
    'A63.140.04': 'error',
    'A63.147.05.1': 'insert',
    'A63.1H10.10': 'insert',
    'A63.050.16.KKB': 'same',
  })
  assert.deepEqual(s.result.counts, { insert: 2, update: 2, same: 2, error: 1 })
  const p04 = s.result.proposals.find((p: any) => p.order_no === 'A63.182.04.8')
  assert.equal(p04.holder_id, 'H0026')
  assert.deepEqual(Object.keys(p04.fields).sort(), ['dims', 'drawing_url', 'image_url'])
  assert.deepEqual(p04.fields.dims.keys, ['A4 Flange diameter', 'C71 Connection diameter min'])
  assert.equal(p04.source_url, 'https://shop.haimer.com/en/Power-Mini-Shrink-Chuck-DIN-69893-1-HSK-A63/A63.182.04.8')
  const p140 = s.result.proposals.find((p: any) => p.order_no === 'A63.140.03')
  assert.deepEqual(Object.keys(p140.fields), ['product_url'], 'the stored variant-selector link is replaced by the product page')
  assert.match(s.result.proposals.find((p: any) => p.order_no === 'A63.140.04').error, /Page not found \(404\)/)
  const urls = net.requested.map((r) => r.url)
  assert.equal(urls[0], 'https://shop.haimer.com/robots.txt')
  assert.ok(urls.includes('https://shop.haimer.com/sitemap.xml'))
  assert.ok(!urls.some((u) => /\/search|\/printpage\/|\/downloadfile\//.test(u)), 'disallowed paths never requested')
  assert.ok(net.requested.every((r) => r.userAgent === 'HolderCatalogue/0.1.0 (+tooling@example.com)'))
  assert.match(s.job.log.join('\n'), /robots\.txt read — crawl-delay 10 s/)
  // A scan writes nothing.
  assert.equal(holderCount(), 88)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_changes')), 0)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM import_runs')), 0)
})

test('apply validation: person, job or token (not both), a non-empty approve list of rows from this scan', async () => {
  const body = { job_id: haimerScan.job_id, approve: [{ order_no: 'A63.147.05.1' }] }
  assert.equal((await t.api('POST', '/api/vendors/apply', body, { user: null })).status, 400)
  assert.match((await t.api('POST', '/api/vendors/apply', { approve: [{ order_no: 'x' }] })).body.error, /either job_id .* or token/)
  assert.match((await t.api('POST', '/api/vendors/apply', { job_id: haimerScan.job_id, token: 'x', approve: [{ order_no: 'x' }] })).body.error, /not both/)
  assert.match((await t.api('POST', '/api/vendors/apply', { job_id: haimerScan.job_id, approve: [] })).body.error, /Tick at least one row/)
  assert.match((await t.api('POST', '/api/vendors/apply', { job_id: haimerScan.job_id, approve: [{ order_no: 'A63.999.1' }] })).body.error, /Not in this scan\/import: A63\.999\.1/)
  assert.match((await t.api('POST', '/api/vendors/apply', { job_id: haimerScan.job_id, approve: [{ order_no: 'A63.147.05.1', fields: 'all' }] })).body.error, /must be a list of field names/)
  assert.equal((await t.api('POST', '/api/vendors/apply', { job_id: 'job-nope', approve: [{ order_no: 'x' }] })).status, 404)
  assert.equal(holderCount(), 88)
})

test('apply: inserts catalogue-only holders (no stock), updates approved fields, confirms unchanged ones — with provenance, holder_changes and one import run', async () => {
  const r = await t.api('POST', '/api/vendors/apply', {
    job_id: haimerScan.job_id,
    approve: [{ order_no: 'A63.182.04.8' }, { order_no: 'A63.140.03' }, { order_no: 'A63.147.05.1' }, { order_no: 'A63.1H10.10' }, { order_no: 'A63.182.03.8' }, { order_no: 'A63.140.04' }],
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const res = r.body
  assert.deepEqual(res.inserted, [{ holder_id: 'H0089', order_no: 'A63.147.05.1' }, { holder_id: 'H0090', order_no: 'A63.1H10.10' }])
  assert.deepEqual(res.updated.map((u: any) => [u.holder_id, u.fields.sort()]), [['H0026', ['dims', 'drawing_url', 'image_url']], ['H0044', ['product_url']]])
  assert.deepEqual(res.confirmed, [{ holder_id: 'H0025', order_no: 'A63.182.03.8' }])
  assert.equal(res.skipped.length, 1)
  assert.match(res.skipped[0].reason, /Page not found/)
  assert.deepEqual(res.conflicts, [])

  // New holders: catalogue only ("can buy") — no stock transactions, provenance set.
  assert.equal(holderCount(), 90)
  const n = holderBy('A63.147.05.1')
  assert.equal(n.holder_id, 'H0089')
  assert.equal(n.interface_code, 'HSK-A63')
  assert.equal(n.type_code, 'SHRINK')
  assert.deepEqual([n.clamp_dia_mm, n.clamp_min_mm, n.clamp_max_mm, n.gauge_length_mm, n.gauge_length_ref, n.nose_dia_mm, n.mass_kg], [5, 5, 5, 120, 'A', 10, 0.957])
  assert.deepEqual([n.data_status, n.data_source, n.last_checked], ['verified', 'shop.haimer.com', today()])
  assert.equal(Number(db().value('SELECT COUNT(*) FROM stock_transactions WHERE holder_id IN (?, ?)', ['H0089', 'H0090'])), 0)
  const h = await t.api('GET', '/api/holders/H0090')
  assert.equal(h.body.qty_on_site, 0)
  assert.equal(h.body.count_status, 'none')
  assert.equal(h.body.type_code, 'HYDRAULIC')
  const created = h.body.changes.find((c: any) => c.field === '*')
  assert.equal(created.source, 'vendor sync HAIMER')
  assert.equal(created.reference, 'https://shop.haimer.com/en/Standard-Hydraulic-Chuck-DIN-69893-1-HSK-A63/A63.1H10.10')
  assert.equal(created.by_user, 'Test User')
  assert.equal(JSON.parse(created.new_value).gauge_length_mm, 80)

  // Updated holder: one holder_changes row per written field, merged dims, last_checked today.
  const u = holderBy('A63.182.04.8')
  assert.equal(u.image_url, 'https://shop.haimer.com/media/5e/0c/8a/1690201622/asset-113402-659.jpg')
  assert.deepEqual(JSON.parse(u.dims_json), { 'D2 Diameter 2': 10, 'L Length': 80, 'A-length version': 'oversize (160 mm)', 'Runout accuracy': '< 0.003 mm', 'A4 Flange diameter': 63, 'C71 Connection diameter min': 4 })
  assert.equal(u.last_checked, today())
  assert.equal(u.data_status, 'verified')
  const ch = db().all<any>('SELECT field, old_value, new_value, source, reference, by_user FROM holder_changes WHERE holder_id = ? ORDER BY change_id', ['H0026'])
  assert.deepEqual(ch.map((c) => c.field).sort(), ['dims_json', 'drawing_url', 'image_url'])
  assert.ok(ch.every((c) => c.source === 'vendor sync HAIMER' && c.by_user === 'Test User' && c.reference === 'https://shop.haimer.com/en/Power-Mini-Shrink-Chuck-DIN-69893-1-HSK-A63/A63.182.04.8'))
  assert.equal(ch.find((c) => c.field === 'image_url').old_value, null)
  // Confirmed unchanged: last_checked only, nothing logged.
  assert.equal(holderBy('A63.182.03.8').last_checked, today())
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_changes WHERE holder_id = ?', ['H0025'])), 0)

  const runs = db().all<any>('SELECT * FROM import_runs')
  assert.equal(runs.length, 1)
  assert.deepEqual([runs[0].kind, runs[0].source, runs[0].interface_code, runs[0].by_user], ['VENDOR', 'HAIMER', 'HSK-A63', 'Test User'])
  assert.equal(runs[0].run_id, res.run_id)
  assert.deepEqual(JSON.parse(runs[0].summary_json).inserted, 2)

  // Stock and the BUILD_SPEC §7 numbers are untouched.
  assert.equal(onSite(), 54)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM data_flags')), 31)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM v_gl_check')), 4)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM v_catalogue WHERE qty_on_site > 0 AND clamp_min_mm <= 12 AND 12 <= clamp_max_mm')), 13)
  const sum = await t.api('GET', '/api/summary')
  assert.deepEqual([sum.body.holders_on_site, sum.body.articles_on_site, sum.body.articles_in_catalogue], [54, 54, 90])

  assert.equal((t.app.ctx.jobs.get(haimerScan.job_id)!.result as any).applied_run_id, res.run_id, 'a reopened scan shows as approved')
  // The same proposals cannot be applied twice.
  const again = await t.api('POST', '/api/vendors/apply', { job_id: haimerScan.job_id, approve: [{ order_no: 'A63.147.05.1' }] })
  assert.equal(again.status, 409)
  assert.match(again.body.error, /already applied \(import run \d+\)/)
})

test('re-scan after apply → everything applied is now "same"', async () => {
  const s = await scan('HAIMER', { order_nos: HAIMER_ORDERS })
  const a = actions(s.result)
  for (const o of HAIMER_ORDERS.filter((x) => x !== 'A63.140.04')) assert.equal(a[o], 'same', o)
  assert.equal(a['A63.140.04'], 'error')
})

test('field-level approval: only ticked fields are written and the status stays as it was', async () => {
  // Drift in our copy of the face mill arbor: nose Ø wrong and mass missing.
  db().run(`UPDATE holders SET nose_dia_mm = 99, mass_kg = NULL WHERE holder_id = 'H0001'`)
  const s = await scan('HAIMER', { order_nos: ['A63.050.16.KKB'] })
  const p = s.result.proposals[0]
  assert.equal(p.action, 'update')
  assert.deepEqual(p.fields, { nose_dia_mm: { old: 99, new: 36 }, mass_kg: { old: null, new: 0.94 } })
  const r = await t.api('POST', '/api/vendors/apply', { job_id: s.job_id, approve: [{ order_no: 'A63.050.16.KKB', fields: ['mass_kg'] }] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.updated, [{ holder_id: 'H0001', order_no: 'A63.050.16.KKB', fields: ['mass_kg'] }])
  const h = holderBy('A63.050.16.KKB')
  assert.deepEqual([h.mass_kg, h.nose_dia_mm, h.data_status], [0.94, 99, 'verified'])
  assert.deepEqual(db().all<any>(`SELECT field FROM holder_changes WHERE holder_id = 'H0001'`).map((c) => c.field), ['mass_kg'])
})

test('a field edited in the catalogue after the scan is not overwritten (conflict reported)', async () => {
  const s = await scan('HAIMER', { order_nos: ['A63.050.16.KKB'] })
  assert.deepEqual(Object.keys(s.result.proposals[0].fields), ['nose_dia_mm'])
  db().run(`UPDATE holders SET nose_dia_mm = 40 WHERE holder_id = 'H0001'`)
  const r = await t.api('POST', '/api/vendors/apply', { job_id: s.job_id, approve: [{ order_no: 'A63.050.16.KKB' }] })
  assert.equal(r.status, 200)
  assert.equal(r.body.conflicts.length, 1)
  assert.equal(r.body.conflicts[0].field, 'nose_dia_mm')
  assert.equal(r.body.updated.length, 0)
  assert.equal(holderBy('A63.050.16.KKB').nose_dia_mm, 40)
  db().run(`UPDATE holders SET nose_dia_mm = 36 WHERE holder_id = 'H0001'`)

  // An "unchanged" row edited after the scan is not confirmed (its last-checked date would be a false claim).
  const same = await scan('HAIMER', { order_nos: ['A63.182.03.8'] })
  assert.equal(same.result.proposals[0].action, 'same')
  db().run(`UPDATE holders SET last_checked = '2026-01-01', gauge_length_mm = 161 WHERE holder_id = 'H0025'`)
  const c = await t.api('POST', '/api/vendors/apply', { job_id: same.job_id, approve: [{ order_no: 'A63.182.03.8' }] })
  assert.equal(c.status, 200)
  assert.deepEqual(c.body.confirmed, [])
  assert.match(c.body.skipped[0].reason, /Edited in the catalogue since the scan/)
  assert.equal(holderBy('A63.182.03.8').last_checked, '2026-01-01')
  db().run(`UPDATE holders SET last_checked = ?, gauge_length_mm = 160 WHERE holder_id = 'H0025'`, [today()])
})

test('MAPAL scan: redirects from /p/<order no.>, designation cross-check, insert of a new order no., UNIQ row confirmed against the web page', async () => {
  const s = await scan('MAPAL', { order_nos: ['30524702', '30655666', '31270591', '30259875', '12345678'] })
  assert.deepEqual(actions(s.result), { '30524702': 'update', '30655666': 'insert', '31270591': 'same', '30259875': 'same', '12345678': 'error' })
  assert.ok(net.requested.some((r) => r.url === 'https://shop.mapal.com/robots.txt'))
  const r = await t.api('POST', '/api/vendors/apply', { job_id: s.job_id, approve: ['30524702', '30655666', '31270591', '30259875'].map((order_no) => ({ order_no })) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const n = holderBy('30655666')
  assert.deepEqual([n.type_code, n.spec_code, n.clamp_dia_mm, n.gauge_length_mm, n.gauge_length_ref, n.product_url], ['HYDRAULIC', 'HTC-HSK-A063-12-080-1-0-A', 12, 80, 'l1', 'https://shop.mapal.com/en/p/000000000030655666'])
  // The UNIQ chuck came from the PDF; the maker page now confirms it → verified, source unchanged (already names shop.mapal.com).
  const uniq = holderBy('31270591')
  assert.equal(uniq.data_status, 'verified')
  assert.equal(uniq.data_source, 'MAPAL UNIQ 2025 catalogue (project PDF) + shop.mapal.com')
  assert.deepEqual(db().all<any>(`SELECT field, old_value, new_value FROM holder_changes WHERE holder_id = ?`, [uniq.holder_id]).map((c) => ({ ...c })), [{ field: 'data_status', old_value: 'catalogue_pdf', new_value: 'verified' }])
  assert.equal(onSite(), 54)
})

test('KEMMLER scan: search by order no.; LPR/title gauge length marked partial with a warning; a verified row is not downgraded', async () => {
  const s = await scan('KEMMLER', { order_nos: ['A63.06.12.3', 'A63.02.20.0'] })
  assert.deepEqual(actions(s.result), { 'A63.06.12.3': 'same', 'A63.02.20.0': 'insert' })
  const ins = s.result.proposals.find((p: any) => p.order_no === 'A63.02.20.0')
  assert.match(ins.warnings.join(' '), /Confirm once against the drawing that LPR/)
  const r = await t.api('POST', '/api/vendors/apply', { job_id: s.job_id, approve: [{ order_no: 'A63.06.12.3' }, { order_no: 'A63.02.20.0' }] })
  assert.equal(r.status, 200)
  const n = holderBy('A63.02.20.0')
  assert.deepEqual([n.type_code, n.clamp_min_mm, n.clamp_max_mm, n.gauge_length_mm, n.gauge_length_ref, n.nose_dia_mm, n.data_status], ['ER_COLLET', 2, 20, 75, 'LPR', 50, 'partial'])
  assert.equal(holderBy('A63.06.12.3').data_status, 'verified')
})

test('a site that answers 403 stops the scan: "blocked — not retried", later products never requested', async () => {
  const fx = fixtureFetch(DIR)
  const blocked: FetchFn = async (url, init) =>
    url.endsWith('/A63.182.04.8') ? new Response('Forbidden', { status: 403 }) : fx(url, init)
  setVendorHooks(t.app.ctx, { fetch: blocked, sleep: async () => {}, gates: new HostGates() })
  try {
    const s = await scan('HAIMER', { order_nos: ['A63.182.03.8', 'A63.182.04.8', 'A63.050.16.KKB'] })
    assert.match(s.result.blocked, /HTTP 403 .*blocked — not retried/)
    assert.deepEqual(actions(s.result), { 'A63.182.03.8': 'same', 'A63.182.04.8': 'error' })
    assert.ok(!fx.requested.some((r) => r.url.endsWith('A63.050.16.KKB')))
    const v = await t.api('GET', '/api/vendors')
    assert.match(v.body.vendors.find((x: any) => x.maker === 'HAIMER').blocked, /blocked — not retried/)
    // The block is remembered: a new scan does not contact the site at all.
    const before = fx.requested.length
    const s2 = await scan('HAIMER', { order_nos: ['A63.182.03.8'] })
    assert.match(s2.result.blocked, /blocked — not retried/)
    assert.equal(fx.requested.length, before)
  } finally {
    setVendorHooks(t.app.ctx, { fetch: net, sleep: async () => {}, gates: new HostGates() })
  }
})

test('a running scan cannot be approved; cancelling keeps what was read', async () => {
  // Real (short) waits so the job is still running when we act on it.
  setVendorHooks(t.app.ctx, { fetch: net, gates: new HostGates(), minDelayMs: 250 })
  try {
    const r = await t.api('POST', '/api/vendors/MAPAL/scan', { order_nos: ['30524702', '30655666', '31270591', '30259875'] })
    assert.equal(r.status, 200)
    const dup = await t.api('POST', '/api/vendors/MAPAL/scan', {})
    assert.equal(dup.status, 409)
    assert.equal(dup.body.details.job_id, r.body.job_id)
    const early = await t.api('POST', '/api/vendors/apply', { job_id: r.body.job_id, approve: [{ order_no: '30524702' }] })
    assert.equal(early.status, 409)
    assert.match(early.body.error, /still running/)
    await new Promise((ok) => setTimeout(ok, 700))
    assert.equal((await t.api('POST', `/api/jobs/${r.body.job_id}/cancel`)).status, 200)
    const job = await t.app.ctx.jobs.wait(r.body.job_id)
    assert.equal(job.status, 'cancelled')
    const res = job.result as any
    assert.equal(res.cancelled, true)
    assert.ok(res.scanned >= 1 && res.scanned < 4, `scanned ${res.scanned}`)
  } finally {
    setVendorHooks(t.app.ctx, { fetch: net, sleep: async () => {}, gates: new HostGates() })
  }
})

/** A stand-in for a service only reachable from the host PC: loopback only, records every request it gets. */
async function internalService() {
  const hits: string[] = []
  const srv = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h1>INTERNAL-ONLY ADMIN PAGE</h1><table><tr><td>admin_password</td><td>hunter2</td></tr></table>')
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  return { hits, base, close: () => new Promise<void>((ok) => srv.close(() => ok())) }
}
/** Maker sites answered from the fixtures; any other address goes to the real network (as the app would). */
const fixturesElseNetwork = (fx: FixtureFetch, extra: Record<string, () => Response> = {}): FetchFn => async (url, init) => {
  if (extra[url]) return extra[url]!()
  const host = new URL(url).host
  return ['shop.haimer.com', 'shop.mapal.com', 'www.kemmler-shop.de'].includes(host) ? fx(url, init) : fetch(url, init)
}

test('SSRF: stored links pointing at an internal address are never fetched — the scan reads the maker page instead', async () => {
  const svc = await internalService()
  const fx = fixtureFetch(DIR)
  const saved = db().all<any>(`SELECT holder_id, product_url FROM holders WHERE order_no IN ('31270591', 'A63.182.03.8', 'A63.06.12.3')`)
  const setUrl = (order: string, url: string) => db().run(`UPDATE holders SET product_url = ? WHERE order_no = ?`, [url, order])
  setVendorHooks(t.app.ctx, { fetch: fixturesElseNetwork(fx), sleep: async () => {}, gates: new HostGates() })
  try {
    // The review's reproduction: the MAPAL address hidden in a query string on a loopback-only service.
    setUrl('31270591', `${svc.base}/admin?ref=shop.mapal.com/en/p/31270591`)
    setUrl('A63.182.03.8', `${svc.base}/x/A63.182.03.8`)
    setUrl('A63.06.12.3', `${svc.base}/y/A63.06.12.3`)
    for (const [maker, order] of [['MAPAL', '31270591'], ['HAIMER', 'A63.182.03.8'], ['KEMMLER', 'A63.06.12.3']] as const) {
      const s = await scan(maker, { order_nos: [order] })
      const p = s.result.proposals[0]
      assert.notEqual(p.action, 'error', `${maker}: ${p.error}`)
      assert.ok(p.record.product_url.startsWith(maker === 'KEMMLER' ? 'https://www.kemmler-shop.de/' : `https://shop.${maker.toLowerCase()}.com/`), p.record.product_url)
      assert.deepEqual(p.fields.product_url?.old, `${svc.base}/${maker === 'MAPAL' ? 'admin?ref=shop.mapal.com/en/p/31270591' : maker === 'HAIMER' ? 'x/A63.182.03.8' : 'y/A63.06.12.3'}`, 'the bad link is proposed for replacement')
      assert.doesNotMatch(JSON.stringify(s.job), /INTERNAL-ONLY|hunter2|127\.0\.0\.1:\d+: no robots/)
      assert.match(s.job.log.join('\n'), new RegExp(`Only contacting ${maker === 'KEMMLER' ? 'www\\.kemmler-shop\\.de' : `shop\\.${maker.toLowerCase()}\\.com`}\\.`))
    }
    assert.deepEqual(svc.hits, [], 'the internal service was never contacted')
  } finally {
    for (const r of saved) db().run(`UPDATE holders SET product_url = ? WHERE holder_id = ?`, [r.product_url, r.holder_id])
    setVendorHooks(t.app.ctx, { fetch: net, sleep: async () => {}, gates: new HostGates() })
    await svc.close()
  }
})

test('SSRF: a maker page that redirects to an internal address is not followed (every hop is checked)', async () => {
  const svc = await internalService()
  const fx = fixtureFetch(DIR)
  const hop = () => new Response(null, { status: 302, headers: { location: `${svc.base}/admin-via-redirect` } })
  setVendorHooks(t.app.ctx, { fetch: fixturesElseNetwork(fx, { 'https://shop.mapal.com/en/p/000000000030524702': hop }), sleep: async () => {}, gates: new HostGates() })
  try {
    const s = await scan('MAPAL', { order_nos: ['30524702', '31270591'] })
    const p = s.result.proposals.find((x: any) => x.order_no === '30524702')
    assert.equal(p.action, 'error')
    assert.match(p.error, /shop\.mapal\.com redirected to http:\/\/127\.0\.0\.1:\d+ — not fetched\. This job only contacts shop\.mapal\.com\./)
    assert.equal(s.result.proposals.find((x: any) => x.order_no === '31270591').action, 'same', 'the rest of the scan carries on')
    assert.doesNotMatch(JSON.stringify(s.job), /INTERNAL-ONLY|hunter2/)
    assert.deepEqual(svc.hits, [])
  } finally {
    setVendorHooks(t.app.ctx, { fetch: net, sleep: async () => {}, gates: new HostGates() })
    await svc.close()
  }
})

const CSV = [
  'ORDER_NO;ADINTMS;DCONWS;LPR;DLN;BD;WT;RPMX;product_name;spec_code',
  '84719607;HSK-A63;1-7;100;16;16;0,62;25000;Ceratizit CP.ISO12164-A63.SF.ER11.16.100.F CoreLine Prec. Collet chuck, Slim Version Centro-P;CP.ISO12164-A63.SF.ER11.16.100.F',
  '84722615;HSK-A63;2-20;130;50;50;1,45;25000;CoreLine Prec. Collet Chucks Centro-P;CP.ISO12164-A63.SF.ER32.130.F',
  '84719999;HSK-A100;1-7;100;16;16;;;Wrong interface;CP.ISO12164-A100.SF.ER11.16.100.F',
  '84722615;HSK-A63;2-20;130;50;50;1,45;25000;Duplicate row;CP.ISO12164-A63.SF.ER32.130.F',
].join('\r\n')
const importUrl = (q: Record<string, string>) => '/api/vendors/import-file?' + new URLSearchParams(q)

test('file import validation: maker, source and a non-empty CSV are required', async () => {
  const q = { maker: 'CERATIZIT', interface_code: 'HSK-A63', source: 'ISO 13399 package from the Ceratizit rep', file: 'ceratizit_hsk63.csv' }
  const post = (qs: Record<string, string>, raw = CSV, user?: string | null) => t.api('POST', importUrl(qs), undefined, { raw, contentType: 'text/csv', user })
  assert.equal((await post(q, CSV, null)).status, 400)
  assert.match((await post({ ...q, maker: '' })).body.error, /Choose the maker/)
  assert.match((await post({ ...q, maker: 'WALTER' })).body.error, /Unknown maker "WALTER"/)
  assert.match((await post({ ...q, source: ' ' })).body.error, /Say where this file came from/)
  assert.match((await post(q, '')).body.error, /The file is empty/)
  assert.match((await post({ ...q, data_status: 'great' })).body.error, /data_status must be one of/)
  assert.match((await post(q, 'Item;LPR\nX;1\n')).body.proposals[0].error, /No order no\. column/)
})

test('file import (ISO 13399 codes) → proposals → apply with the token: FILE run, provenance, no stock', async () => {
  const r = await t.api('POST', importUrl({ maker: 'ceratizit', source: 'ISO 13399 package from the Ceratizit rep, 05/10/2026', file: 'ceratizit_hsk63.csv' }), undefined, { raw: CSV, contentType: 'text/csv' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const b = r.body
  assert.equal(b.maker, 'CERATIZIT')
  assert.equal(b.interface_code, 'HSK-A63')
  assert.equal(b.data_status, 'catalogue_pdf')
  assert.deepEqual(b.proposals.map((p: any) => [p.order_no, p.action]), [
    ['84719607', 'update'],
    ['84722615', 'insert'],
    ['84719999', 'error'],
    ['84722615 (line 5)', 'error'],
  ])
  const upd = b.proposals[0]
  // GL/clamp/nose already match the distributor data. DCONWS/DLN went into columns and BD matches the holder's
  // "BD (neck diameter)", so the maker dimensions do not change (they used to gain bare DCONWS/DLN/BD copies).
  assert.deepEqual(Object.keys(upd.fields).sort(), ['mass_kg'], 'GL/clamp/nose already match the distributor data')
  assert.doesNotMatch(upd.warnings.join(' '), /added as "Other"/, 'an existing holder keeps its type')
  assert.match(b.proposals[2].error, /ADINTMS "HSK-A100" is not HSK-A63/)
  assert.match(b.proposals[3].error, /appears twice in the file/)
  const ins = b.proposals[1]
  assert.equal(ins.fields.type_code.new, 'ER_COLLET')
  assert.equal(ins.fields.nose_dia_mm.new, 50)
  assert.equal(ins.source_url, null)

  const a = await t.api('POST', '/api/vendors/apply', { token: b.token, approve: [{ order_no: '84719607' }, { order_no: '84722615' }] })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  const n = holderBy('84722615')
  assert.deepEqual([n.type_code, n.series, n.clamp_min_mm, n.clamp_max_mm, n.gauge_length_mm, n.gauge_length_ref, n.data_status, n.data_source], [
    'ER_COLLET', 'Centro-P precision collet chuck', 2, 20, 130, 'LPR', 'catalogue_pdf', 'ISO 13399 package from the Ceratizit rep, 05/10/2026',
  ])
  const e = holderBy('84719607')
  assert.equal(e.mass_kg, 0.62)
  assert.equal(e.data_status, 'catalogue_pdf', 'the maker data confirmed the distributor values → upgraded from distributor_only')
  const ch = db().all<any>('SELECT field, source, reference FROM holder_changes WHERE holder_id = ?', [e.holder_id])
  assert.ok(ch.length >= 2)
  assert.ok(ch.every((c) => c.source === 'file import ceratizit_hsk63.csv' && c.reference === 'ceratizit_hsk63.csv: ISO 13399 package from the Ceratizit rep, 05/10/2026'))
  const run = db().get<any>(`SELECT * FROM import_runs WHERE kind = 'FILE'`)!
  assert.equal(run.source, 'ceratizit_hsk63.csv — ISO 13399 package from the Ceratizit rep, 05/10/2026')
  assert.equal(Number(db().value('SELECT COUNT(*) FROM stock_transactions WHERE holder_id = ?', [n.holder_id])), 0)
  assert.equal(onSite(), 54)
  assert.equal((await t.api('POST', '/api/vendors/apply', { token: b.token, approve: [{ order_no: '84722615' }] })).status, 409)
  assert.equal((await t.api('POST', '/api/vendors/apply', { token: 'made-up', approve: [{ order_no: '84722615' }] })).status, 404)
})

test('file import update: no "will be added as Other" note, and DLN updates "DLN (diameter lock nut)" instead of adding a second nose Ø', async () => {
  // The review's reproduction: an ER collet chuck already in the catalogue (H0010), type not stated in the file.
  const csv = 'Article,ADINTMS,DCONWS,LPR,DLN,WT\r\n84719607,HSK-A63,1-7,100,17,"0,9"\r\n'
  const r = await t.api('POST', importUrl({ maker: 'CERATIZIT', source: 'Ceratizit rep, corrected lock nut Ø', file: 'ceratizit_fix.csv' }), undefined, { raw: csv, contentType: 'text/csv' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const p = r.body.proposals[0]
  assert.equal(p.action, 'update')
  assert.equal(p.holder_id, 'H0010')
  assert.doesNotMatch(p.warnings.join(' '), /added as "Other"/)
  assert.deepEqual(p.fields.nose_dia_mm, { old: 16, new: 17 })
  assert.deepEqual(p.fields.dims.keys, ['DLN (diameter lock nut)'], 'only the existing labelled entry changes')
  assert.equal(p.fields.dims.new['DLN (diameter lock nut)'], 17)
  for (const code of ['DLN', 'DCONWS', 'LPR', 'WT']) assert.ok(!(code in p.fields.dims.new), `no bare ${code} entry`)
  const a = await t.api('POST', '/api/vendors/apply', { token: r.body.token, approve: [{ order_no: '84719607' }] })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  const h = await t.api('GET', '/api/holders/H0010')
  assert.equal(h.body.type_code, 'ER_COLLET', 'the type of an existing holder is not touched')
  assert.equal(h.body.nose_dia_mm, 17)
  const dims = JSON.parse(holderBy('84719607').dims_json)
  assert.deepEqual(dims, { 'DLN (diameter lock nut)': 17, 'BD (neck diameter)': 16, 'LSCX (clamping length maximum machine side)': 68, L2: '18 - 36 (12 - 26)' }, 'one nose Ø, no duplicates')
  // The CERATIZIT card counts live: 8 holders now (84722615 came from the rep's file) and H0010's geometry now
  // comes from the rep too (its source was replaced), so 6 still carry the distributor's data.
  assert.equal(holderBy('84719607').data_source, 'Ceratizit rep, corrected lock nut Ø')
  const v = await t.api('GET', '/api/vendors')
  const cer = v.body.vendors.find((x: any) => x.maker === 'CERATIZIT')
  assert.equal(cer.articles_in_catalogue, 8)
  assert.match(cer.why, /6 of the 8 Ceratizit holders in the catalogue carry data from the distributor Zedaro/)
  assert.doesNotMatch(cer.why, /your 7 holders/)
})

test('maker photo cache: real images saved as images/vendor/<id>.<ext>, non-images refused, existing ones skipped unless forced', async () => {
  const changesBefore = Number(db().value('SELECT COUNT(*) FROM holder_changes'))
  assert.equal((await t.api('POST', '/api/vendors/images', {}, { user: null })).status, 400)
  assert.match((await t.api('POST', '/api/vendors/images', { holder_ids: 'H0001' })).body.error, /holder_ids must be a list/)
  assert.match((await t.api('POST', '/api/vendors/images', { holder_ids: ['H0020'] })).body.error, /maker photo address/)
  const r = await t.api('POST', '/api/vendors/images', { holder_ids: ['H0001', 'H0005', 'H0010'] })
  assert.equal(r.status, 200)
  const job = await t.app.ctx.jobs.wait(r.body.job_id)
  const res = job.result as any
  assert.deepEqual(res.downloaded.map((d: any) => d.file).sort(), ['H0001.jpg', 'H0005.png'], 'format from the bytes (Kemmler served a PNG at a .jpg address)')
  // H0010 is a CERATIZIT holder whose photo is on the distributor's CDN: no adapter → skipped with the reason,
  // and the CDN is never contacted (it used to be requested and answer an HTML page).
  assert.deepEqual(res.failed, [])
  assert.deepEqual(res.skipped.map((s: any) => [s.holder_id, s.kind]), [['H0010', 'not_allowed']])
  assert.match(res.skipped[0].reason, /CERATIZIT has no automated reader.*no adapter for cdn\.shopify\.com/)
  assert.ok(!net.requested.some((x) => new URL(x.url).host === 'cdn.shopify.com'), 'the distributor CDN was not contacted')
  const dir = join(t.dataDir, 'images', 'vendor')
  assert.deepEqual(readdirSync(dir).sort(), ['H0001.jpg', 'H0005.png'])
  const h = await t.api('GET', '/api/holders/H0001')
  assert.equal(h.body.vendor_image, '/images/vendor/H0001.jpg')
  const img = await fetch(t.base + '/images/vendor/H0001.jpg')
  assert.equal(img.status, 200)
  assert.equal(img.headers.get('content-type'), 'image/jpeg')
  // Second run skips what is cached; force downloads again.
  const again = (await t.app.ctx.jobs.wait((await t.api('POST', '/api/vendors/images', { holder_ids: ['H0001', 'H0005'] })).body.job_id)).result as any
  assert.deepEqual([again.downloaded.length, again.skipped.length], [0, 2])
  const forced = (await t.app.ctx.jobs.wait((await t.api('POST', '/api/vendors/images', { holder_ids: ['H0001'], force: true })).body.job_id)).result as any
  assert.equal(forced.downloaded.length, 1)
  assert.ok(existsSync(join(dir, 'H0001.jpg')))
  // A photo job never writes catalogue data.
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_changes')), changesBefore)
  // 17 seeded photo addresses + 4 from approved scans (H0026, the new HAIMER hydraulic, MAPAL 30524702, Kemmler A63.02.20.0);
  // all but the 7 Ceratizit (distributor CDN) ones can be downloaded.
  assert.deepEqual((await t.api('GET', '/api/vendors')).body.images, { with_url: 21, downloadable: 14, cached: 2 })
})

test('maker photo cache: only from the maker site of an automated adapter — an internal or foreign address is skipped, never requested', async () => {
  const svc = await internalService()
  const saved = db().all<any>(`SELECT holder_id, image_url FROM holders WHERE holder_id IN ('H0025', 'H0026')`)
  setVendorHooks(t.app.ctx, { fetch: fixturesElseNetwork(fixtureFetch(DIR)), sleep: async () => {}, gates: new HostGates() })
  try {
    db().run(`UPDATE holders SET image_url = ? WHERE holder_id = 'H0025'`, [`${svc.base}/photo.jpg`]) // HAIMER holder, internal address
    db().run(`UPDATE holders SET image_url = 'https://shop.mapal.com/medias/x.jpg' WHERE holder_id = 'H0026'`) // HAIMER holder, another maker's site
    const r = await t.api('POST', '/api/vendors/images', { holder_ids: ['H0025', 'H0026', 'H0010'], force: true })
    assert.equal(r.status, 200)
    const res = (await t.app.ctx.jobs.wait(r.body.job_id)).result as any
    assert.deepEqual(res.downloaded, [])
    assert.deepEqual(res.failed, [])
    const why = Object.fromEntries(res.skipped.map((s: any) => [s.holder_id, s.reason]))
    assert.match(why.H0025, /^127\.0\.0\.1:\d+ is not HAIMER's own site \(shop\.haimer\.com\) — no adapter for this host, not downloaded\.$/)
    assert.match(why.H0026, /shop\.mapal\.com is not HAIMER's own site/)
    assert.match(why.H0010, /CERATIZIT has no automated reader/)
    assert.deepEqual(svc.hits, [], 'the internal address was never requested')
  } finally {
    for (const s of saved) db().run(`UPDATE holders SET image_url = ? WHERE holder_id = ?`, [s.image_url, s.holder_id])
    setVendorHooks(t.app.ctx, { fetch: net, sleep: async () => {}, gates: new HostGates() })
    await svc.close()
  }
})

test('GET /api/vendors/runs lists applied scans and imports, newest first', async () => {
  const r = await t.api('GET', '/api/vendors/runs?limit=50')
  assert.equal(r.status, 200)
  assert.equal(r.body[0].kind, 'FILE')
  assert.ok(r.body.some((x: any) => x.kind === 'VENDOR' && x.source === 'HAIMER' && x.summary.inserted === 2))
  assert.ok(r.body.every((x: any) => x.by_user === 'Test User'))
})

test('after every scan and import: stock and the §7 acceptance numbers are unchanged', () => {
  assert.equal(onSite(), 54)
  const m = Object.fromEntries(db().all<any>('SELECT manufacturer, holders_on_site FROM v_tally_by_manufacturer').map((r) => [r.manufacturer, Number(r.holders_on_site)]))
  assert.deepEqual([m.HAIMER, m.MAPAL, m.CERATIZIT, m.KEMMLER], [37, 9, 7, 1])
  assert.equal(Number(db().value('SELECT COUNT(*) FROM v_gl_check')), 4)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM data_flags')), 31)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE txn_type <> 'OPENING_BALANCE'`)), 0)
})
