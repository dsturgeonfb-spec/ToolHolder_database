import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FIXTURES, startTestApp, type TestApp } from '../helpers.js'

const HM = join(FIXTURES, 'hypermill')
const REPORT_54 = join(HM, 'report_54.html')
const REPORT_CHANGED = join(HM, 'report_changed.html')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Row counts that an import must (or must not) change. */
function counts(t: TestApp) {
  const n = (sql: string) => Number(t.app.ctx.db.value(sql))
  return {
    holders: n('SELECT COUNT(*) FROM holders'),
    txns: n('SELECT COUNT(*) FROM stock_transactions'),
    flags: n('SELECT COUNT(*) FROM data_flags'),
    changes: n('SELECT COUNT(*) FROM holder_changes'),
    makers: n('SELECT COUNT(*) FROM manufacturers'),
    onSite: n('SELECT SUM(qty_on_site) FROM v_stock_on_hand'),
    runs: n('SELECT COUNT(*) FROM import_runs'),
  }
}
const preview = (t: TestApp, path: string, extra: Record<string, unknown> = {}) => t.api('POST', '/api/import/hypermill/preview', { path, ...extra })
async function previewAndApply(t: TestApp, path: string) {
  const p = await preview(t, path)
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const a = await t.api('POST', '/api/import/hypermill/apply', { token: p.body.token })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  return { preview: p.body, result: a.body }
}

describe('report of the same 54 holders (BUILD_SPEC §7: re-import changes nothing)', () => {
  let t: TestApp
  before(async () => (t = await startTestApp()))
  after(async () => t.close())

  test('preview: 54 unchanged, nothing else, no warnings', async () => {
    const r = await preview(t, REPORT_54, { interface_code: 'HSK-A63' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.match(r.body.token, /^[0-9a-f]{32}$/)
    assert.equal(r.body.report.path, REPORT_54)
    assert.equal(r.body.report.holders, 54)
    assert.equal(r.body.report.images, 54)
    assert.equal(r.body.report.format, 'html')
    assert.deepEqual(r.body.counts, { new: 0, renamed: 0, changed: 0, removed: 0, unchanged: 54, unmatched: 0 })
    assert.deepEqual(
      { new: r.body.plan.new, renamed: r.body.plan.renamed, changed: r.body.plan.changed, removed: r.body.plan.removed, unmatched: r.body.plan.unmatched, unchanged: r.body.plan.unchanged },
      { new: [], renamed: [], changed: [], removed: [], unmatched: [], unchanged: 54 },
    )
    assert.equal(r.body.has_work, false)
    assert.deepEqual(r.body.warnings, [])
  })

  test('the interface defaults to the settings default', async () => {
    const r = await preview(t, REPORT_54)
    assert.equal(r.status, 200)
    assert.equal(r.body.plan.interface_code, 'HSK-A63')
  })

  test('apply twice: no new holders, transactions, flags or changes; each run is recorded with a copy of the report', async () => {
    const before0 = counts(t)
    for (let i = 1; i <= 2; i++) {
      const { result } = await previewAndApply(t, REPORT_54)
      assert.deepEqual(result.counts, { new: 0, renamed: 0, changed: 0, removed: 0, unchanged: 54, unmatched: 0 })
      assert.deepEqual(result.new_holders, [])
      assert.equal(result.transactions, 0)
      assert.equal(result.flags_raised, 0)
      assert.equal(result.changes_logged, 0)
      const now = counts(t)
      assert.deepEqual({ ...now, runs: 0 }, { ...before0, runs: 0 })
      assert.equal(now.runs, before0.runs + i)
      // Traceability copy: report + logo + 54 pictures, as the report references them.
      const folder = join(t.dataDir, result.folder)
      assert.ok(existsSync(join(folder, 'report_54.html')))
      assert.equal(readdirSync(join(folder, 'report_54_files')).length, 55)
      assert.ok(readFileSync(join(folder, 'report_54_files', 'holder 07.png')).equals(readFileSync(join(HM, 'report_54_files', 'holder 07.png'))))
      assert.ok(existsSync(join(folder, 'import-summary.json')))
    }
    assert.equal(counts(t).onSite, 54)
    const sum = await t.api('GET', '/api/summary')
    assert.equal(sum.body.holders_on_site, 54)
    assert.equal(sum.body.to_count, 54)
  })

  test('the text export gives the same answer (pictures left alone)', async () => {
    const r = await preview(t, join(HM, 'report_54.txt'))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.report.format, 'txt')
    assert.deepEqual(r.body.counts, { new: 0, renamed: 0, changed: 0, removed: 0, unchanged: 54, unmatched: 0 })
    assert.equal(r.body.warnings.length, 1)
    assert.match(r.body.warnings[0].message, /no pictures/)
  })

  test('the text export of the changed report plans the same changes, without pictures', async () => {
    const r = await preview(t, join(HM, 'report_changed.txt'))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.counts, { new: 2, renamed: 1, changed: 1, removed: 1, unchanged: 51, unmatched: 1 })
    assert.deepEqual(
      r.body.plan.new.map((n: any) => [n.manufacturer, n.order_no, n.type_code, n.cam_gl_mm, n.image_url]),
      [
        ['HAIMER', 'A63.140.14', 'SHRINK', 80, null],
        ['NIKKEN', '41234567', 'OTHER', 90, null],
      ],
    )
    assert.equal(r.body.plan.renamed[0].holder_id, 'H0046')
    assert.equal(r.body.plan.changed[0].holder_id, 'H0049')
    assert.equal(r.body.plan.removed[0].holder_id, 'H0037')
  })

  test('import history lists runs newest first with their summary', async () => {
    const r = await t.api('GET', '/api/import/runs?kind=hypermill')
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 2)
    assert.ok(r.body[0].run_id > r.body[1].run_id)
    assert.equal(r.body[0].kind, 'HYPERMILL')
    assert.equal(r.body[0].by_user, 'Test User')
    assert.equal(r.body[0].interface_code, 'HSK-A63')
    assert.equal(r.body[0].source, REPORT_54)
    assert.equal(r.body[0].summary.counts.unchanged, 54)
    assert.equal(r.body[0].summary.report.holders, 54)
    assert.equal(r.body[0].summary_json, undefined)
    assert.equal((await t.api('GET', '/api/import/runs')).body.length, 2)
    assert.equal((await t.api('GET', '/api/import/runs?limit=1')).body.length, 1)
    assert.equal((await t.api('GET', '/api/import/runs?kind=BOGUS')).status, 400)
    assert.equal((await t.api('GET', '/api/import/runs?limit=0')).status, 400)
  })

  test('preview validation: plain-English 400s', async () => {
    const msg = async (body: unknown) => {
      const r = await t.api('POST', '/api/import/hypermill/preview', body)
      assert.equal(r.status, 400, JSON.stringify(r.body))
      return r.body.error as string
    }
    assert.match(await msg({}), /Enter the path/)
    assert.match(await msg({ path: '   ' }), /Enter the path/)
    assert.match(await msg({ path: join(HM, 'nope.html') }), /No file at/)
    assert.match(await msg({ path: join(HM, 'images', 'alt_profile.png') }), /\.html file/)
    assert.match(await msg({ path: HM }), /holds 2 reports/)
    assert.match(await msg({ path: REPORT_54, interface_code: 'BT40' }), /Unknown interface "BT40"/)
    const dir = mkdtempSync(join(tmpdir(), 'hc-hm-'))
    try {
      writeFileSync(join(dir, 'other.html'), '<html><body><h1>Tool list</h1><p>Nothing here</p></body></html>')
      assert.match(await msg({ path: join(dir, 'other.html') }), /No holders found in other\.html/)
      // A folder with exactly one report is accepted, and quotes from "Copy as path" are stripped.
      cpSync(REPORT_54, join(dir, 'only', 'Holder_HSK63 HOLDERS.html'), { recursive: true })
      const ok = await preview(t, `"${join(dir, 'only')}"`)
      assert.equal(ok.status, 200)
      assert.equal(ok.body.report.file, 'Holder_HSK63 HOLDERS.html')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('apply needs a person and a live token; a token is used once', async () => {
    const p = await preview(t, REPORT_54)
    const before0 = counts(t)
    const noUser = await t.api('POST', '/api/import/hypermill/apply', { token: p.body.token }, { user: null })
    assert.equal(noUser.status, 400)
    assert.match(noUser.body.error, /Enter your name/)
    assert.equal((await t.api('POST', '/api/import/hypermill/apply', {})).status, 400)
    const bogus = await t.api('POST', '/api/import/hypermill/apply', { token: 'f'.repeat(32) })
    assert.equal(bogus.status, 404)
    assert.match(bogus.body.error, /preview the report again/)
    assert.deepEqual(counts(t), before0)
    assert.equal((await t.api('POST', '/api/import/hypermill/apply', { token: p.body.token })).status, 200)
    assert.equal((await t.api('POST', '/api/import/hypermill/apply', { token: p.body.token })).status, 404)
  })

  test('preview, apply and preview images are host-only; history is not', () => {
    const routes = t.app.router.list()
    const hostOnly = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)?.hostOnly
    assert.equal(hostOnly('POST', '/api/import/hypermill/preview'), true)
    assert.equal(hostOnly('POST', '/api/import/hypermill/apply'), true)
    assert.equal(hostOnly('GET', '/api/import/hypermill/preview/:token/images/:n'), true)
    assert.equal(hostOnly('GET', '/api/import/runs'), false)
  })

  test('a network client cannot preview a path on the host', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const share = await t.api('PUT', '/api/system/share', { enabled: true, port })
    assert.equal(share.status, 200, JSON.stringify(share.body))
    try {
      const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'HolderCatalogue' }
      const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: h, body: JSON.stringify({ pin: share.body.pin, name: 'Tablet' }) })
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const r = await fetch(`http://127.0.0.1:${port}/api/import/hypermill/preview`, { method: 'POST', headers: { ...h, cookie }, body: JSON.stringify({ path: REPORT_54 }) })
      assert.equal(r.status, 403)
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/import/runs`, { headers: { cookie } })).status, 200)
    } finally {
      await t.api('PUT', '/api/system/share', { enabled: false })
    }
  })
})

describe('report with changes (rename, CAM GL, removed, new holders, unmatched)', () => {
  let t: TestApp
  let firstPreview: any
  before(async () => (t = await startTestApp()))
  after(async () => t.close())

  test('preview gives exactly the expected plan', async () => {
    const r = await preview(t, REPORT_CHANGED)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    firstPreview = r.body
    const p = r.body.plan
    assert.deepEqual(r.body.counts, { new: 2, renamed: 1, changed: 1, removed: 1, unchanged: 51, unmatched: 1 })
    assert.equal(r.body.has_work, true)

    const [haimer, nikken] = p.new
    assert.deepEqual(
      { ...haimer, image_url: undefined, image: undefined, image_sha: undefined },
      {
        seq: 49,
        cam_name: 'HAIMER 14mm STD SHRINK A63.140.14 80GL',
        cam_comment: 'HAIMER 14mm STD SHRINK A63-140-14',
        manufacturer: 'HAIMER',
        manufacturer_new: false,
        order_no: 'A63.140.14',
        order_from: 'name',
        type_code: 'SHRINK',
        type_name: 'Shrink fit chuck',
        series: 'Shrink Fit Chuck Standard – short',
        classified_by: 'order',
        cam_gl_mm: 80,
        coupling: [
          { type: 'unknown', pos: 'top', class: '' },
          { type: 'unknown', pos: 'bottom', class: '' },
        ],
        image_ext: '.png',
        image_url: undefined,
        image: undefined,
        image_sha: undefined,
      },
    )
    assert.match(haimer.image_url, new RegExp(`^/api/import/hypermill/preview/${r.body.token}/images/\\d+$`))
    assert.equal(haimer.image_sha, sha(readFileSync(join(HM, 'report_changed_files', 'holder 55.png'))))
    assert.equal(nikken.manufacturer, 'NIKKEN')
    assert.equal(nikken.manufacturer_new, true)
    assert.equal(nikken.order_no, '41234567')
    assert.equal(nikken.type_code, 'OTHER')
    assert.equal(nikken.classified_by, 'none')
    assert.equal(nikken.series, null)
    assert.equal(nikken.cam_gl_mm, 90)

    assert.equal(p.renamed.length, 1)
    assert.equal(p.renamed[0].holder_id, 'H0046')
    assert.equal(p.renamed[0].old_name, 'HAIMER 6mm STD SHRINK A63.140.06 80GL')
    assert.equal(p.renamed[0].cam_name, 'HAIMER 6mm STD SHRINK FIT CHUCK A63.140.06 80GL')
    assert.deepEqual(p.renamed[0].changes, [{ field: 'cam_name', old: 'HAIMER 6mm STD SHRINK A63.140.06 80GL', new: 'HAIMER 6mm STD SHRINK FIT CHUCK A63.140.06 80GL' }])
    assert.equal(p.renamed[0].opening_balance, false)

    assert.equal(p.changed.length, 1)
    assert.equal(p.changed[0].holder_id, 'H0049')
    assert.deepEqual(p.changed[0].changes, [
      { field: 'cam_name', old: 'HAIMER 12mm STD SHRINK A63.140.12 90GL', new: 'HAIMER 12mm STD SHRINK A63.140.12 95GL' },
      { field: 'cam_gl_mm', old: 90, new: 95 },
    ])
    assert.equal(p.changed[0].image_change, null)

    assert.deepEqual(p.removed, [
      { holder_id: 'H0037', manufacturer: 'HAIMER', order_no: 'A63.144.08', cam_name: 'HAIMER 8mm LNG SHRINK A63.144.08 130GL', qty_on_site: 1, already_flagged: false, flag_status: null },
    ])
    assert.equal(p.unchanged, 51)
    assert.equal(p.unmatched.length, 1)
    assert.equal(p.unmatched[0].seq, 56)
    assert.equal(p.unmatched[0].cam_name, 'SPARE HOLDER CELL 3 75GL')
    assert.match(p.unmatched[0].reason, /No order no\./)
    assert.equal(r.body.warnings.length, 1)
    assert.equal(r.body.warnings[0].seq, 56)
    assert.match(r.body.warnings[0].message, /No order no\. found/)
  })

  test('preview pictures are served only for a live token and only for holder pictures', async () => {
    const res = await fetch(t.base + firstPreview.plan.new[0].image_url)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(HM, 'report_changed_files', 'holder 55.png'))))
    assert.equal((await fetch(`${t.base}/api/import/hypermill/preview/${'0'.repeat(32)}/images/0`)).status, 404)
    // Image 0 is the logo repeated on every page: not a holder picture.
    assert.equal((await fetch(`${t.base}/api/import/hypermill/preview/${firstPreview.token}/images/0`)).status, 404)
    assert.equal((await fetch(`${t.base}/api/import/hypermill/preview/${firstPreview.token}/images/x`)).status, 400)
  })

  test('apply writes exactly the planned rows, flags and transactions', async () => {
    const before0 = counts(t)
    const a = await t.api('POST', '/api/import/hypermill/apply', { token: firstPreview.token }, { user: 'Dave S' })
    assert.equal(a.status, 200, JSON.stringify(a.body))
    const res = a.body
    assert.deepEqual(res.new_holders, [
      { holder_id: 'H0089', manufacturer: 'HAIMER', order_no: 'A63.140.14', type_code: 'SHRINK' },
      { holder_id: 'H0090', manufacturer: 'NIKKEN', order_no: '41234567', type_code: 'OTHER' },
    ])
    assert.deepEqual(res.new_manufacturers, ['NIKKEN'])
    assert.equal(res.transactions, 2)
    assert.equal(res.flags_raised, 7)
    const after0 = counts(t)
    assert.deepEqual(
      { holders: after0.holders - before0.holders, txns: after0.txns - before0.txns, flags: after0.flags - before0.flags, makers: after0.makers - before0.makers, onSite: after0.onSite, runs: after0.runs - before0.runs },
      { holders: 2, txns: 2, flags: 7, makers: 1, onSite: 56, runs: 1 },
    )
    const db = t.app.ctx.db
    const today = db.value<string>(`SELECT date('now','localtime')`)

    // New HAIMER shrink chuck: unverified, from the report, picture copied into images/cam.
    const h89 = db.get<any>(`SELECT h.*, m.name AS maker FROM holders h JOIN manufacturers m USING (manufacturer_id) WHERE holder_id = 'H0089'`)!
    assert.equal(h89.maker, 'HAIMER')
    assert.equal(h89.interface_code, 'HSK-A63')
    assert.equal(h89.type_code, 'SHRINK')
    assert.equal(h89.series, 'Shrink Fit Chuck Standard – short')
    assert.equal(h89.cam_name, 'HAIMER 14mm STD SHRINK A63.140.14 80GL')
    assert.equal(h89.cam_comment, 'HAIMER 14mm STD SHRINK A63-140-14')
    assert.equal(h89.cam_gl_mm, 80)
    assert.equal(h89.gauge_length_mm, null, 'maker values only come from maker data')
    assert.equal(h89.clamp_dia_mm, null)
    assert.equal(h89.data_status, 'unverified')
    assert.equal(h89.data_source, 'hyperMILL tool DB report')
    assert.equal(h89.last_checked, today)
    const pic = readFileSync(join(HM, 'report_changed_files', 'holder 55.png'))
    assert.equal(h89.cam_image, `images/cam/cam_H0089_${sha(pic).slice(0, 8)}.png`)
    assert.ok(readFileSync(join(t.dataDir, h89.cam_image)).equals(pic))
    const served = await fetch(`${t.base}/${h89.cam_image}`)
    assert.equal(served.status, 200)

    const h90 = db.get<any>(`SELECT h.*, m.name AS maker FROM holders h JOIN manufacturers m USING (manufacturer_id) WHERE holder_id = 'H0090'`)!
    assert.equal(h90.maker, 'NIKKEN')
    assert.equal(h90.type_code, 'OTHER')
    assert.equal(h90.series, null)

    // Opening balances: one each, unverified, at Unassigned, against the person who applied.
    const ob = db.all<any>(`SELECT * FROM stock_transactions WHERE holder_id IN ('H0089','H0090') ORDER BY holder_id`)
    assert.equal(ob.length, 2)
    for (const o of ob) {
      assert.equal(o.txn_type, 'OPENING_BALANCE')
      assert.equal(o.qty_delta, 1)
      assert.equal(o.location_id, 1)
      assert.equal(o.by_user, 'Dave S')
      assert.match(o.reference, /^hyperMILL tool DB report \d{2}\/\d{2}\/\d{4}$/)
      assert.equal(o.note, 'Unverified: holder exists in CAM DB; replace with physical count')
    }
    assert.equal(db.value(`SELECT count_status FROM v_count_status WHERE holder_id = 'H0089'`), 'unverified')

    // Flags: who/what/where.
    const flags = db.all<any>(`SELECT holder_id, severity, category, message, raised_by, source FROM data_flags WHERE flag_id > 31 ORDER BY flag_id`)
    assert.equal(flags.length, 7)
    assert.ok(flags.every((f) => f.raised_by === 'Dave S' && f.source === 'hyperMILL import'))
    const f = (id: string) => flags.filter((x) => x.holder_id === id).map((x) => `${x.severity}/${x.category}`).sort()
    assert.deepEqual(f('H0089'), ['INFO/Data source'])
    assert.deepEqual(f('H0090'), ['INFO/Data source', 'INFO/Data source', 'MEDIUM/hyperMILL'])
    assert.deepEqual(f('H0046'), ['LOW/hyperMILL'])
    assert.deepEqual(f('H0049'), ['MEDIUM/Gauge length'])
    assert.deepEqual(f('H0037'), ['LOW/hyperMILL'])
    assert.equal(flags.find((x) => x.holder_id === 'H0046')!.message, 'Renamed in hyperMILL: HAIMER 6mm STD SHRINK A63.140.06 80GL → HAIMER 6mm STD SHRINK FIT CHUCK A63.140.06 80GL')
    assert.match(flags.find((x) => x.holder_id === 'H0049')!.message, /90 → 95 mm \(maker gauge length 90 mm\)/)
    assert.match(flags.find((x) => x.holder_id === 'H0037')!.message, /^Not in the hyperMILL report of \d{2}\/\d{2}\/\d{4} — removed from the CAM DB\? Check stock and scrap\/transfer$/)
    assert.ok(flags.some((x) => x.holder_id === 'H0090' && /New maker NIKKEN/.test(x.message)))

    // Renamed / changed: CAM fields only, each change logged; removed holder untouched.
    assert.equal(db.value(`SELECT cam_name FROM holders WHERE holder_id = 'H0046'`), 'HAIMER 6mm STD SHRINK FIT CHUCK A63.140.06 80GL')
    assert.equal(db.value(`SELECT cam_gl_mm FROM holders WHERE holder_id = 'H0049'`), 95)
    assert.equal(db.value(`SELECT cam_name FROM holders WHERE holder_id = 'H0049'`), 'HAIMER 12mm STD SHRINK A63.140.12 95GL')
    assert.equal(db.value(`SELECT gauge_length_mm FROM holders WHERE holder_id = 'H0049'`), 90, 'maker GL untouched')
    assert.equal(db.value(`SELECT data_source FROM holders WHERE holder_id = 'H0049'`), 'shop.haimer.com', 'provenance of maker data untouched')
    assert.equal(db.value(`SELECT cam_name FROM holders WHERE holder_id = 'H0037'`), 'HAIMER 8mm LNG SHRINK A63.144.08 130GL')
    assert.equal(Number(db.value(`SELECT SUM(qty_delta) FROM stock_transactions WHERE holder_id = 'H0037'`)), 1, 'stock of a removed holder untouched')
    const changes = db.all<any>(`SELECT holder_id, field, old_value, new_value, source, by_user, reference FROM holder_changes ORDER BY change_id`)
    assert.deepEqual(
      changes.map((c) => `${c.holder_id}:${c.field}`),
      ['H0089:*', 'H0090:*', 'H0046:cam_name', 'H0049:cam_name', 'H0049:cam_gl_mm'],
    )
    assert.ok(changes.every((c) => c.source === 'hyperMILL import' && c.by_user === 'Dave S' && c.reference === REPORT_CHANGED))
    assert.equal(changes[4].old_value, '90')
    assert.equal(changes[4].new_value, '95')
    assert.equal(JSON.parse(changes[0].new_value).data_source, 'hyperMILL tool DB report')

    // The run record.
    const run = (await t.api('GET', '/api/import/runs')).body[0]
    assert.equal(run.run_id, res.run_id)
    assert.equal(run.by_user, 'Dave S')
    assert.deepEqual(run.summary.counts, { new: 2, renamed: 1, changed: 1, removed: 1, unchanged: 51, unmatched: 1 })
    assert.deepEqual(run.summary.new_holders, ['H0089', 'H0090'])
    assert.ok(existsSync(join(t.dataDir, res.folder, 'report_changed.html')))
    assert.ok(existsSync(join(t.dataDir, res.folder, 'report_changed_files', 'holder 55.png')))
    assert.ok(existsSync(join(t.dataDir, res.folder, 'report_54_files', 'holder 01.png')))

    // The holder API sees the new holders like any other.
    const h = await t.api('GET', '/api/holders/H0089')
    assert.equal(h.status, 200)
    assert.equal(h.body.qty_on_site, 1)
    assert.equal(h.body.count_status, 'unverified')
  })

  test('the same report again is a no-op: nothing new, the removed holder is already flagged', async () => {
    const before0 = counts(t)
    const { preview: p, result } = await previewAndApply(t, REPORT_CHANGED)
    // 51 untouched + the renamed and the changed holder + the 2 new ones are all in step now.
    assert.deepEqual(p.counts, { new: 0, renamed: 0, changed: 0, removed: 1, unchanged: 55, unmatched: 1 })
    assert.equal(p.plan.removed[0].already_flagged, true)
    assert.equal(p.has_work, false)
    assert.equal(result.transactions, 0)
    assert.equal(result.flags_raised, 0)
    assert.equal(result.changes_logged, 0)
    const after0 = counts(t)
    assert.deepEqual({ ...after0, runs: 0 }, { ...before0, runs: 0 })
    assert.equal(after0.runs, before0.runs + 1)
  })

  test('apply refuses (409) when the catalogue changed after the preview', async () => {
    const p = await preview(t, REPORT_54)
    assert.equal(p.status, 200)
    // Going back to the 54 report: H0046/H0049 change back, the two new holders are now "removed".
    assert.deepEqual(p.body.counts, { new: 0, renamed: 1, changed: 1, removed: 2, unchanged: 52, unmatched: 0 })
    t.app.ctx.db.run(`UPDATE holders SET cam_comment = 'edited elsewhere' WHERE holder_id = 'H0010'`)
    const before0 = counts(t)
    const a = await t.api('POST', '/api/import/hypermill/apply', { token: p.body.token })
    assert.equal(a.status, 409)
    assert.equal(a.body.error, 'The catalogue changed since the preview — preview again.')
    assert.deepEqual(counts(t), before0)
    // The stale token is gone; a fresh preview shows the edit and applies.
    assert.equal((await t.api('POST', '/api/import/hypermill/apply', { token: p.body.token })).status, 404)
    const { preview: p2 } = await previewAndApply(t, REPORT_54)
    assert.equal(p2.counts.changed, 2)
    assert.equal(t.app.ctx.db.value(`SELECT cam_comment FROM holders WHERE holder_id = 'H0010'`), 'CERATIZIT ER11 SLIM PRECISON COLLET CHUCK 84719607')
  })

  test('missing holders: one issue while open; raised again after closing only while stock is still on site', async () => {
    const db = t.app.ctx.db
    const removed = async () => {
      const r = await preview(t, REPORT_54)
      assert.equal(r.status, 200)
      return { body: r.body, byId: Object.fromEntries(r.body.plan.removed.map((x: any) => [x.holder_id, x])) }
    }
    // The two holders the 54 report doesn't have are flagged once; H0037 is back, and its open issue is pointed out.
    let { body, byId } = await removed()
    assert.deepEqual(Object.keys(byId), ['H0089', 'H0090'])
    assert.equal(byId.H0089.already_flagged, true)
    assert.equal(byId.H0089.flag_status, 'OPEN')
    assert.ok(body.warnings.some((w: any) => /H0037 is back in the report/.test(w.message)))
    // Someone closes H0089's issue but the holder is still on site: the next import asks again.
    db.run(
      `UPDATE data_flags SET status = 'CLOSED', closed_on = date('now'), closed_by = 'Dave S', close_note = 'checking'
       WHERE holder_id = 'H0089' AND message LIKE 'Not in the hyperMILL report%'`,
    )
    ;({ byId } = await removed())
    assert.equal(byId.H0089.flag_status, 'CLOSED')
    assert.equal(byId.H0089.already_flagged, false)
    // Once it is scrapped (nothing on site), a closed issue is the end of it.
    db.run(`INSERT INTO stock_transactions(holder_id, location_id, qty_delta, txn_type, reference, txn_date, by_user) VALUES ('H0089', 1, -1, 'SCRAP', 'NCR 1', date('now'), 'Dave S')`)
    ;({ body, byId } = await removed())
    assert.equal(byId.H0089.qty_on_site, 0)
    assert.equal(byId.H0089.already_flagged, true)
    const before0 = counts(t)
    const a = await t.api('POST', '/api/import/hypermill/apply', { token: body.token })
    assert.equal(a.status, 200)
    assert.equal(a.body.flags_raised, 0)
    assert.equal(counts(t).flags, before0.flags)
  })
})

describe('pictures, comments and holders linked to hyperMILL later', () => {
  let t: TestApp
  let dir: string
  before(async () => {
    t = await startTestApp()
    dir = mkdtempSync(join(tmpdir(), 'hc-hm-api-'))
    cpSync(HM, dir, { recursive: true })
  })
  after(async () => {
    await t.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('changed picture → new file (old one kept), missing picture → added, comment change logged; no issues for these', async () => {
    const alt = readFileSync(join(HM, 'images', 'alt_profile.png'))
    writeFileSync(join(dir, 'report_54_files', 'holder 49.png'), alt)
    let html = readFileSync(join(dir, 'report_54.html'), 'utf8')
    html = html.replace('<td class="value">HAIMER SPIGOT ARBOR 16mm A63-050-16-KKB</td>', '<td class="value">HAIMER SPIGOT ARBOR 16mm A63.050.16.KKB</td>')
    writeFileSync(join(dir, 'report_54.html'), html)
    unlinkSync(join(t.dataDir, 'images', 'cam', 'cam_50.png'))
    const before0 = counts(t)

    const { preview: p, result } = await previewAndApply(t, join(dir, 'report_54.html'))
    assert.deepEqual(p.counts, { new: 0, renamed: 0, changed: 3, removed: 0, unchanged: 51, unmatched: 0 })
    const byId = Object.fromEntries(p.plan.changed.map((c: any) => [c.holder_id, c]))
    assert.deepEqual(byId.H0001.changes, [{ field: 'cam_comment', old: 'HAIMER SPIGOT ARBOR 16mm A63-050-16-KKB', new: 'HAIMER SPIGOT ARBOR 16mm A63.050.16.KKB' }])
    assert.equal(byId.H0049.image_change, 'replaced')
    assert.match(byId.H0049.image_url, /\/images\/\d+$/)
    const newName = `images/cam/cam_H0049_${sha(alt).slice(0, 8)}.png`
    assert.deepEqual(byId.H0049.changes, [{ field: 'cam_image', old: 'images/cam/cam_49.png', new: newName }])
    assert.equal(byId.H0050.image_change, 'added')

    assert.equal(result.flags_raised, 0, 'picture and comment changes raise no issue')
    assert.equal(result.transactions, 0)
    const db = t.app.ctx.db
    assert.equal(db.value(`SELECT cam_image FROM holders WHERE holder_id = 'H0049'`), newName)
    assert.ok(readFileSync(join(t.dataDir, newName)).equals(alt))
    assert.ok(existsSync(join(t.dataDir, 'images', 'cam', 'cam_49.png')), 'the old picture is kept')
    assert.equal(db.value(`SELECT cam_comment FROM holders WHERE holder_id = 'H0001'`), 'HAIMER SPIGOT ARBOR 16mm A63.050.16.KKB')
    const h50 = db.value<string>(`SELECT cam_image FROM holders WHERE holder_id = 'H0050'`)!
    assert.ok(readFileSync(join(t.dataDir, h50)).equals(readFileSync(join(HM, 'report_54_files', 'holder 50.png'))))
    const after0 = counts(t)
    assert.equal(after0.changes - before0.changes, 3)
    assert.equal(after0.flags, before0.flags)

    // And again: nothing to do.
    const again = await preview(t, join(dir, 'report_54.html'))
    assert.equal(again.body.counts.unchanged, 54)
  })

  test('a catalogue-only holder that appears in hyperMILL is linked and gets its unverified opening balance once', async () => {
    const db = t.app.ctx.db
    const cat = db.get<{ holder_id: string; order_no: string }>(
      `SELECT holder_id, order_no FROM holders WHERE cam_name IS NULL AND holder_id NOT IN (SELECT holder_id FROM stock_transactions) ORDER BY holder_id LIMIT 1`,
    )!
    const block = `<table class="data"><tr><td class="label">Holder:</td><td class="value">(HSK63) MAPAL 14MM HYDRAULIC CHUCK ${cat.order_no} 80GL</td></tr>
      <tr><td class="label">Holder comment</td><td class="value"></td></tr></table>`
    const html = readFileSync(join(dir, 'report_54.html'), 'utf8').replace('</body>', `${block}\n</body>`)
    writeFileSync(join(dir, 'linked.html'), html)
    const before0 = counts(t)
    const { preview: p, result } = await previewAndApply(t, join(dir, 'linked.html'))
    assert.equal(p.counts.new, 0)
    assert.equal(p.counts.changed, 1)
    const c = p.plan.changed[0]
    assert.equal(c.holder_id, cat.holder_id)
    assert.equal(c.opening_balance, true)
    assert.deepEqual(c.changes, [
      { field: 'cam_name', old: null, new: `MAPAL 14MM HYDRAULIC CHUCK ${cat.order_no} 80GL` },
      { field: 'cam_gl_mm', old: null, new: 80 },
    ])
    assert.equal(p.plan.renamed.length, 0, 'getting a name is not a rename')
    assert.equal(result.transactions, 1)
    assert.equal(counts(t).txns, before0.txns + 1)
    assert.equal(db.value(`SELECT txn_type FROM stock_transactions WHERE holder_id = ?`, [cat.holder_id]), 'OPENING_BALANCE')
    // Again: it has stock history now, so no second opening balance.
    const { preview: p2, result: r2 } = await previewAndApply(t, join(dir, 'linked.html'))
    assert.equal(p2.counts.changed, 0)
    assert.equal(r2.transactions, 0)
    assert.equal(Number(db.value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = ?`, [cat.holder_id])), 1)
  })

  test('duplicates in the report are listed once as unmatched; a wrong interface is warned about', async () => {
    t.app.ctx.db.run(`INSERT OR IGNORE INTO interfaces(interface_code, standard, flange_dia_mm) VALUES ('HSK-A100', 'DIN 69893-1 form A, size 100', 100)`)
    const html = readFileSync(join(dir, 'report_54.html'), 'utf8')
    const first = html.indexOf('<div class="item">')
    const second = html.indexOf('<div class="item">', first + 1)
    writeFileSync(join(dir, 'dup.html'), html.replace('</body>', `${html.slice(first, second)}</body>`))
    const r = await preview(t, join(dir, 'dup.html'))
    assert.equal(r.body.counts.unmatched, 1)
    assert.match(r.body.plan.unmatched[0].reason, /Same maker and order no\. as holder 1/)
    const wrong = await preview(t, join(dir, 'report_54.html'), { interface_code: 'HSK-A100' })
    assert.equal(wrong.status, 200)
    assert.ok(wrong.body.warnings.some((w: any) => /tagged "\(HSK63\)" but the import is set to HSK-A100/.test(w.message)))
    assert.ok(wrong.body.warnings.some((w: any) => /H0001 is an HSK-A63 holder/.test(w.message)))
  })

  test('picture links to a network share are not opened: the preview finds them in the report folder and warns', async () => {
    const html = readFileSync(join(dir, 'report_54.html'), 'utf8')
      .replace('src="report_54_files/holder%2001.png"', 'src="\\\\cam-pc\\share\\report_54_files\\holder 01.png"')
      .replace('src="report_54_files/holder%2002.png"', 'src="file://cam-pc/share/report_54_files/holder%2002.png"')
      .replace('src="report_54_files/holder%2003.png"', 'src="C:\\Users\\Someone\\report_54_files\\holder 03.png"')
    assert.equal((html.match(/cam-pc|Someone/g) ?? []).length, 3)
    writeFileSync(join(dir, 'unc.html'), html)
    const r = await preview(t, join(dir, 'unc.html'))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.report.images, 54, 'all three are found by file name next to the report')
    const msgs = r.body.warnings.map((w: any) => w.message)
    assert.ok(msgs.some((m: string) => /2 picture links in the report point at a network location .*cam-pc.* never opened.*2 of 2 found/.test(m)), msgs.join('\n'))
    assert.ok(msgs.some((m: string) => /1 picture link in the report points outside its folder .*1 of 1 found/.test(m)), msgs.join('\n'))
  })

  test('most linked holders missing from a report is warned about before anything is written', async () => {
    const html = readFileSync(join(dir, 'report_54.html'), 'utf8')
    const items = html.split('<div class="item">')
    writeFileSync(join(dir, 'short.html'), items.slice(0, 6).join('<div class="item">') + '</body></html>')
    const r = await preview(t, join(dir, 'short.html'))
    assert.equal(r.status, 200)
    assert.ok(r.body.counts.removed >= 49)
    assert.ok(r.body.warnings.some((w: any) => /are missing from this report\. Check it is the right report/.test(w.message)))
  })
})
