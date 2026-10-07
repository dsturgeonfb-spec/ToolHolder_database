import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PYTHON, runPython } from '../openpyxl.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestApp } from '../helpers.js'
import { today } from '../../src/server/domain.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

const db = () => t.app.ctx.db
const list = async (qs = '') => {
  const r = await t.api('GET', '/api/holders' + (qs ? '?' + qs : ''))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body as { holders: any[]; total: number }
}
const stockTotal = () => Number(db().value('SELECT COALESCE(SUM(qty_delta),0) FROM stock_transactions'))
const txnCount = () => Number(db().value('SELECT COUNT(*) FROM stock_transactions'))

// ------------------------------------------------------------------ BUILD_SPEC §7 through the API
test('acceptance: scope=site → 54 articles, scope=cat → 34, all → 88 (total is the unfiltered count)', async () => {
  const site = await list('scope=site')
  assert.equal(site.holders.length, 54)
  assert.equal(site.total, 88)
  assert.ok(site.holders.every((h) => h.qty_on_site > 0))
  const cat = await list('scope=cat')
  assert.equal(cat.holders.length, 34)
  assert.ok(cat.holders.every((h) => h.qty_on_site === 0 && h.count_status === 'none'))
  assert.equal((await list()).holders.length, 88)
  assert.equal((await list('scope=all')).holders.length, 88)
})

test('acceptance: on-site holders that fit a Ø12 shank → 13 (clamp_min <= 12 <= clamp_max)', async () => {
  const r = await list('scope=site&fit=12')
  assert.equal(r.holders.length, 13)
  for (const h of r.holders) assert.ok(h.clamp_min_mm <= 12 && 12 <= h.clamp_max_mm, h.order_no)
  // Screw-in / tap chucks leave min and max null and must never match, even with clamp_dia 12.
  const all = await list('fit=12')
  assert.ok(!all.holders.some((h) => h.order_no === 'A63.06.12.3'))
  assert.ok(all.holders.every((h) => h.clamp_min_mm != null && h.clamp_max_mm != null))
  // Decimal comma is accepted (shop PCs are often set to a European locale).
  assert.equal((await list('scope=site&fit=12,0')).holders.length, 13)
})

test('acceptance: mk=HAIMER&scope=site → 37 (maker match is case-insensitive)', async () => {
  assert.equal((await list('mk=HAIMER&scope=site')).holders.length, 37)
  assert.equal((await list('mk=haimer&scope=site')).holders.length, 37)
  assert.equal((await list('mk=MAPAL&scope=cat')).holders.length, 34)
  assert.equal((await list('mk=NOBODY')).holders.length, 0)
})

test('acceptance: tally byMaker HAIMER 37 / MAPAL 9 / CERATIZIT 7 / KEMMLER 1; glCheck = 4 face mill arbors', async () => {
  const r = await t.api('GET', '/api/tally')
  assert.equal(r.status, 200)
  const m = Object.fromEntries(r.body.byMaker.map((x: any) => [x.manufacturer, x.holders_on_site]))
  assert.deepEqual({ HAIMER: m.HAIMER, MAPAL: m.MAPAL, CERATIZIT: m.CERATIZIT, KEMMLER: m.KEMMLER }, { HAIMER: 37, MAPAL: 9, CERATIZIT: 7, KEMMLER: 1 })
  const mapal = r.body.byMaker.find((x: any) => x.manufacturer === 'MAPAL')
  assert.deepEqual(mapal, { manufacturer: 'MAPAL', articles_on_site: 9, holders_on_site: 9, articles_in_catalogue: 43 })
  assert.equal(r.body.glCheck.length, 4)
  assert.deepEqual(r.body.glCheck.map((g: any) => g.delta_mm).sort((a: number, b: number) => a - b), [17, 19, 19, 21])
  assert.ok(r.body.glCheck.every((g: any) => g.type_code === 'FACE_MILL_ARBOR' && g.manufacturer === 'HAIMER'))
  const a16 = r.body.glCheck.find((g: any) => g.order_no === 'A63.050.16.KKB')
  assert.match(a16.note, /50 \+ 17 = 67 mm/)
})

// ------------------------------------------------------------------ Holder object
test('Holder object carries every documented field', async () => {
  const { holders } = await list('scope=site')
  const h = holders.find((x) => x.holder_id === 'H0001')
  for (const k of ['holder_id', 'manufacturer_id', 'order_no', 'spec_code', 'type_code', 'interface_code', 'clamp_dia_mm', 'gauge_length_mm',
    'cam_gl_mm', 'dims_json', 'cam_image', 'data_status', 'data_source', 'last_checked', 'manufacturer', 'is_distributor', 'type_name',
    'qty_on_site', 'count_status', 'last_count_date', 'open_flags', 'open_issues', 'worst_severity', 'on_want_list', 'dims', 'vendor_image'])
    assert.ok(k in h, `missing ${k}`)
  assert.equal(h.manufacturer, 'HAIMER')
  assert.equal(h.is_distributor, 0)
  assert.equal(h.type_name, 'Face / shell mill arbor')
  assert.equal(h.qty_on_site, 1)
  assert.equal(h.count_status, 'unverified')
  assert.equal(h.last_count_date, null)
  assert.equal(h.cam_image, 'images/cam/cam_01.png')
  assert.equal(h.vendor_image, null)
  assert.equal(h.dims['L length (spigot)'], 17)
  assert.equal(h.on_want_list, 0)
  // A63.050.16.KKB has one open MEDIUM (GL convention) flag.
  assert.equal(h.open_issues, 1)
  assert.equal(h.worst_severity, 'MEDIUM')
  // A catalogue-only article with no dims stays an object.
  const empty = holders.find((x) => x.dims_json == null || x.dims_json === '{}')
  if (empty) assert.deepEqual(empty.dims, {})
})

test('open_flags counts INFO, open_issues and worst_severity ignore it', async () => {
  const { holders } = await list()
  const by = (o: string) => holders.find((h) => h.order_no === o)
  assert.equal(by('84719607').worst_severity, 'HIGH')
  assert.equal(by('84719607').open_issues, 1)
  assert.equal(by('84719607').open_flags, 2) // HIGH + the INFO distributor note
  assert.equal(by('A63.050.22.KKB').open_issues, 2) // MEDIUM + LOW
  assert.equal(by('A63.050.22.KKB').worst_severity, 'MEDIUM')
  assert.equal(by('A63.140.04').open_issues, 0) // INFO only
  assert.equal(by('A63.140.04').open_flags, 1)
  assert.equal(by('A63.140.04').worst_severity, null)
})

test('list is sorted by type order, then clamp Ø (open ranges last), GL, order no.', async () => {
  const { holders } = await list()
  const meta = (await t.api('GET', '/api/meta')).body
  const sortOf = Object.fromEntries(meta.types.map((x: any) => [x.type_code, x.sort_order]))
  for (let i = 1; i < holders.length; i++) {
    const a = holders[i - 1]
    const b = holders[i]
    assert.ok(sortOf[a.type_code] <= sortOf[b.type_code], `${a.order_no} before ${b.order_no}`)
    if (a.type_code === b.type_code && a.clamp_min_mm != null && b.clamp_min_mm != null) assert.ok(a.clamp_min_mm <= b.clamp_min_mm)
  }
  assert.equal(holders[0].type_code, 'SHRINK')
  assert.equal(holders[0].clamp_min_mm, 3)
})

// ------------------------------------------------------------------ filters
test('search: one term matches maker/order/spec/series/clamp/CAM fields; gl<value> and d<value> work', async () => {
  const a = await list('q=A63.140')
  assert.equal(a.holders.length, 9)
  assert.ok(a.holders.every((h) => h.order_no.startsWith('A63.140')))
  const gl = await list('q=gl80')
  assert.ok(gl.holders.length >= 8)
  assert.ok(gl.holders.every((h) => String(h.gauge_length_mm).startsWith('80')))
  const d = await list('q=d12&scope=site')
  assert.ok(d.holders.length > 0 && d.holders.every((h) => String(h.clamp_dia_mm).startsWith('12')))
  // Case-insensitive, and matched against the hyperMILL name too.
  const cam = await list('q=spigot')
  assert.equal(cam.holders.length, 4)
  assert.equal((await list('q=SPIGOT')).holders.length, 4)
  // Spec code (MAPAL designation)
  assert.equal((await list('q=MHC-HSK-A063-06-065')).holders[0].order_no, '31270591')
})

test('search: several terms must all match (AND)', async () => {
  const both = await list('q=' + encodeURIComponent('haimer gl80'))
  assert.equal(both.holders.length, 4)
  assert.ok(both.holders.every((h) => h.manufacturer === 'HAIMER' && h.gauge_length_mm === 80))
  const t1 = new Set((await list('q=mapal')).holders.map((h) => h.holder_id))
  const t2 = new Set((await list('q=d12')).holders.map((h) => h.holder_id))
  const and = (await list('q=' + encodeURIComponent('  mapal   d12 '))).holders.map((h) => h.holder_id)
  assert.deepEqual(and.sort(), [...t1].filter((x) => t2.has(x)).sort())
  assert.equal((await list('q=' + encodeURIComponent('haimer zzzz'))).holders.length, 0)
})

test('filters: type, flag, status, iface — combine with AND', async () => {
  const shrink = await list('type=SHRINK&scope=site')
  assert.equal(shrink.holders.length, 27)
  assert.ok(shrink.holders.every((h) => h.type_code === 'SHRINK'))
  const fl = await list('flag=1')
  assert.equal(fl.holders.length, 18)
  assert.ok(fl.holders.every((h) => h.open_issues > 0))
  assert.equal((await list('status=unverified')).holders.length, 54)
  assert.equal((await list('status=counted')).holders.length, 0)
  assert.equal((await list('status=none')).holders.length, 34)
  assert.equal((await list('iface=HSK-A63')).holders.length, 88)
  assert.equal((await list('iface=BT40')).holders.length, 0)
  const combo = await list('scope=site&type=SHRINK&fit=12&mk=HAIMER')
  assert.equal(combo.holders.length, 5)
})

test('filters: bad values are a 400 with a plain message', async () => {
  for (const qs of ['scope=everything', 'fit=abc', 'fit=-3', 'status=lost']) {
    const r = await t.api('GET', '/api/holders?' + qs)
    assert.equal(r.status, 400, qs)
    assert.ok(r.body.error && r.body.error.length > 10, qs)
  }
})

// ------------------------------------------------------------------ detail
test('GET /api/holders/:id returns the holder with stock, transactions, flags, units, wishlist, changes, maker', async () => {
  const r = await t.api('GET', '/api/holders/H0001')
  assert.equal(r.status, 200)
  const h = r.body
  assert.equal(h.order_no, 'A63.050.16.KKB')
  assert.deepEqual(h.stock.map((s: any) => [s.location, s.qty, s.counts_as_on_site]), [['Unassigned – count required', 1, 1]])
  assert.ok('location_id' in h.stock[0] && 'kind' in h.stock[0])
  assert.equal(h.transactions.length, 1)
  assert.equal(h.transactions[0].txn_type, 'OPENING_BALANCE')
  assert.equal(h.transactions[0].location, 'Unassigned – count required')
  assert.equal(h.transactions_total, 1)
  assert.ok(Array.isArray(h.flags) && h.flags.length === 1 && h.flags[0].status === 'OPEN')
  assert.deepEqual(h.units, [])
  assert.deepEqual(h.wishlist, [])
  assert.deepEqual(h.changes, [])
  assert.equal(h.manufacturer_row.name, 'HAIMER')
})

test('detail: flags are OPEN first, then by severity; a missing holder is a friendly 404', async () => {
  db().run(`UPDATE data_flags SET status='CLOSED', closed_on='2026-01-01', closed_by='QA' WHERE holder_id='H0002' AND severity='MEDIUM'`)
  const r = await t.api('GET', '/api/holders/H0002')
  assert.deepEqual(r.body.flags.map((f: any) => f.status), ['OPEN', 'CLOSED'])
  assert.equal(r.body.open_flags, 1)
  assert.equal(r.body.worst_severity, 'LOW')
  db().run(`UPDATE data_flags SET status='OPEN', closed_on=NULL, closed_by=NULL WHERE holder_id='H0002'`)
  const nf = await t.api('GET', '/api/holders/H9999')
  assert.equal(nf.status, 404)
  assert.match(nf.body.error, /no holder H9999/i)
})

test('vendor_image points at a cached maker photo only when the file exists', async () => {
  const dir = join(t.dataDir, 'images', 'vendor')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'H0002.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  const h = (await t.api('GET', '/api/holders/H0002')).body
  assert.equal(h.vendor_image, '/images/vendor/H0002.jpg')
  assert.equal((await fetch(t.base + h.vendor_image)).status, 200)
  const others = (await list()).holders.filter((x) => x.holder_id !== 'H0002')
  assert.ok(others.every((x) => x.vendor_image === null))
})

test('on_want_list sums OPEN/QUOTED/ORDERED wishlist rows only', async () => {
  for (const [qty, status] of [[2, 'OPEN'], [1, 'QUOTED'], [3, 'ORDERED'], [5, 'CANCELLED'], [7, 'RECEIVED']] as const)
    db().run(`INSERT INTO wishlist(holder_id, qty_wanted, status, added_by) VALUES ('H0060', ?, ?, 'QA')`, [qty, status])
  const h = (await t.api('GET', '/api/holders/H0060')).body
  assert.equal(h.on_want_list, 6)
  assert.equal(h.wishlist.length, 5)
})

// ------------------------------------------------------------------ POST /api/holders
const NEW = {
  manufacturer: 'HAIMER',
  order_no: 'A63.140.25',
  type_code: 'SHRINK',
  interface_code: 'HSK-A63',
  clamp_dia_mm: 25,
  clamp_spec: 'Ø25 mm shank (h6)',
  gauge_length_mm: 100,
  gauge_length_ref: 'A',
  nose_dia_mm: 44,
  product_url: 'https://shop.haimer.com/en/shrink/A63.140.25',
  dims: { D1: 25, D2: 44, A: 100 },
  data_source: 'HAIMER catalogue 2025, p. 212',
}

test('POST /api/holders validates: user, provenance, references, numbers, URLs, unknown fields', async () => {
  const cases: Array<[any, RegExp, string | null | undefined]> = [
    [NEW, /enter your name/i, null],
    [{ ...NEW, data_source: '' }, /data source is required/i, undefined],
    [{ ...NEW, data_source: undefined }, /data source is required/i, undefined],
    [{ ...NEW, manufacturer: 'ACME' }, /unknown maker/i, undefined],
    [{ ...NEW, type_code: 'BANANA' }, /unknown holder type/i, undefined],
    [{ ...NEW, interface_code: 'BT99' }, /unknown interface/i, undefined],
    [{ ...NEW, gauge_length_mm: 'long' }, /gauge length must be a number/i, undefined],
    [{ ...NEW, gauge_length_mm: -5 }, /greater than 0/i, undefined],
    [{ ...NEW, max_rpm: 1200.5 }, /whole number/i, undefined],
    [{ ...NEW, data_status: 'probably' }, /data status must be one of/i, undefined],
    [{ ...NEW, product_url: 'javascript:alert(1)' }, /http/i, undefined],
    [{ ...NEW, qty_on_site: 5 }, /cannot be set here/i, undefined],
    [{ ...NEW, cam_image: 'images/cam/x.png' }, /cannot be set here/i, undefined],
    [{ ...NEW, order_no: '  ' }, /order no\. cannot be empty/i, undefined],
    [{ ...NEW, type_code: 'ER_COLLET', clamp_dia_mm: null, clamp_min_mm: 2 }, /both clamp min and clamp max/i, undefined],
    [{ ...NEW, type_code: 'ER_COLLET', clamp_dia_mm: null, clamp_min_mm: 20, clamp_max_mm: 2 }, /larger than clamp max/i, undefined],
    [{ ...NEW, dims: [1, 2] }, /label: value/i, undefined],
  ]
  for (const [body, msg, user] of cases) {
    const r = await t.api('POST', '/api/holders', body, { user })
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${r.status} ${JSON.stringify(r.body)}`)
    assert.match(r.body.error, msg)
  }
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holders')), 88)
})

test('POST /api/holders refuses a duplicate maker + order no. with a pointer to the existing record', async () => {
  const r = await t.api('POST', '/api/holders', { ...NEW, order_no: 'A63.140.12' })
  assert.equal(r.status, 409)
  assert.match(r.body.error, /already in the catalogue \(H0049\)/)
  assert.equal(r.body.details.holder_id, 'H0049')
})

// Review finding: "a63.140.12" was accepted as a second article next to HAIMER A63.140.12 (H0049), although the
// hyperMILL import and vendor sync treat order nos. case-insensitively — stock and flags split over two records.
test('the duplicate check ignores letter case and outer spaces, on POST and on PATCH', async () => {
  const n0 = Number(db().value('SELECT COUNT(*) FROM holders'))
  for (const order_no of ['a63.140.12', '  A63.140.12 ', 'a63.140.12\t']) {
    const r = await t.api('POST', '/api/holders', { ...NEW, manufacturer: 'haimer', order_no })
    assert.equal(r.status, 409, `${JSON.stringify(order_no)} → ${r.status} ${JSON.stringify(r.body)}`)
    assert.equal(r.body.details.holder_id, 'H0049')
    // The message names the record as it is stored, so the person recognises it.
    assert.match(r.body.error, /HAIMER order no\. A63\.140\.12 is already in the catalogue \(H0049\)/)
    if (/a63/.test(order_no)) assert.match(r.body.error, /"a63\.140\.12" is the same order no\. in other capitals/)
  }
  // KEMMLER A63.06.12.3 (H0005) typed in lower case under another type is still the same article.
  const k = await t.api('POST', '/api/holders', { ...NEW, manufacturer: 'kemmler', order_no: 'a63.06.12.3', type_code: 'SCREW_IN', clamp_dia_mm: null })
  assert.equal(k.status, 409, JSON.stringify(k.body))
  assert.equal(k.body.details.holder_id, 'H0005')
  // PATCH: renaming one holder to a case variant of another is the same clash.
  const p = await t.api('PATCH', '/api/holders/H0050', { order_no: 'a63.140.12', data_source: 'typo fix' })
  assert.equal(p.status, 409, JSON.stringify(p.body))
  assert.equal(p.body.details.holder_id, 'H0049')
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holders')), n0, 'no holder created')
  // A holder may still correct the letter case of its own order no.
  const own = db().value<string>(`SELECT order_no FROM holders WHERE holder_id = 'H0050'`)!
  const lower = await t.api('PATCH', '/api/holders/H0050', { order_no: own.toLowerCase(), data_source: 'case check' })
  assert.equal(lower.status, 200, JSON.stringify(lower.body))
  const back = await t.api('PATCH', '/api/holders/H0050', { order_no: own, data_source: 'as the maker prints it' })
  assert.equal(back.status, 200, JSON.stringify(back.body))
  assert.equal(back.body.order_no, own)
})

test('POST /api/holders creates the holder: fixed-bore min=max, defaults, provenance, change log, no stock', async () => {
  const txBefore = txnCount()
  const r = await t.api('POST', '/api/holders', NEW, { user: 'Dave Sturgeon' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const h = r.body
  assert.equal(h.holder_id, 'H0089')
  assert.equal(h.manufacturer, 'HAIMER')
  assert.equal(h.clamp_min_mm, 25)
  assert.equal(h.clamp_max_mm, 25)
  assert.equal(h.data_status, 'unverified')
  assert.equal(h.data_source, NEW.data_source)
  assert.equal(h.last_checked, today())
  assert.deepEqual(h.dims, { D1: 25, D2: 44, A: 100 })
  assert.equal(h.qty_on_site, 0)
  assert.equal(h.count_status, 'none')
  assert.equal(txnCount(), txBefore, 'creating a catalogue entry must not book stock')
  const ch = db().all<any>(`SELECT * FROM holder_changes WHERE holder_id = 'H0089'`)
  assert.equal(ch.length, 1)
  assert.equal(ch[0].field, '*')
  assert.equal(ch[0].source, 'manual')
  assert.equal(ch[0].reference, NEW.data_source)
  assert.equal(ch[0].by_user, 'Dave Sturgeon')
  assert.equal(JSON.parse(ch[0].new_value).order_no, 'A63.140.25')
  // It shows up where it should: can-buy, fits Ø25, not on site.
  assert.ok((await list('scope=cat&fit=25')).holders.some((x) => x.holder_id === 'H0089'))
  assert.ok(!(await list('scope=site')).holders.some((x) => x.holder_id === 'H0089'))
  // An explicit range on a fixed-bore type is kept, and a non-fixed type is not given one.
  const er = await t.api('POST', '/api/holders', { ...NEW, order_no: 'A63.020.25', type_code: 'ER_COLLET', clamp_dia_mm: null, clamp_min_mm: 1, clamp_max_mm: 16, data_status: 'verified' })
  assert.equal(er.status, 200, JSON.stringify(er.body))
  assert.equal(er.body.clamp_min_mm, 1)
  assert.equal(er.body.data_status, 'verified')
  const tap = await t.api('POST', '/api/holders', { ...NEW, order_no: 'A63.TAP', type_code: 'TAP_CHUCK', clamp_dia_mm: null, clamp_spec: 'M3–M12' })
  assert.equal(tap.body.clamp_min_mm, null)
  assert.equal(tap.body.clamp_max_mm, null)
})

// ------------------------------------------------------------------ PATCH /api/holders/:id
test('PATCH requires a user and provenance for catalogue fields; notes alone need none', async () => {
  const noUser = await t.api('PATCH', '/api/holders/H0048', { gauge_length_mm: 81, data_source: 'x' }, { user: null })
  assert.equal(noUser.status, 400)
  const noSrc = await t.api('PATCH', '/api/holders/H0048', { gauge_length_mm: 81 })
  assert.equal(noSrc.status, 400)
  assert.match(noSrc.body.error, /data source is required/i)
  assert.equal(db().value(`SELECT gauge_length_mm FROM holders WHERE holder_id='H0048'`), 80)

  db().run(`UPDATE holders SET last_checked = '2026-01-01' WHERE holder_id = 'H0048'`)
  const notes = await t.api('PATCH', '/api/holders/H0048', { notes: 'Kept in drawer 3' }, { user: 'Sam' })
  assert.equal(notes.status, 200, JSON.stringify(notes.body))
  assert.equal(notes.body.notes, 'Kept in drawer 3')
  assert.equal(notes.body.last_checked, '2026-01-01', 'a note is not a check of the maker data')
  const ch = db().all<any>(`SELECT * FROM holder_changes WHERE holder_id='H0048'`)
  assert.equal(ch.length, 1)
  assert.equal(ch[0].field, 'notes')
  assert.equal(ch[0].by_user, 'Sam')
})

test('PATCH logs one holder_changes row per changed field, sets last_checked, never touches stock', async () => {
  const before = stockTotal()
  const txBefore = txnCount()
  const r = await t.api('PATCH', '/api/holders/H0048', {
    gauge_length_mm: '81', // numeric strings are accepted
    nose_dia_mm: 21, // unchanged → not logged
    data_status: 'verified', // unchanged
    data_source: 'shop.haimer.com/en/A63.140.08 (re-checked)',
    dims: { A: 81, D2: 21 },
  }, { user: 'Dave' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.gauge_length_mm, 81)
  assert.equal(r.body.last_checked, today())
  assert.equal(r.body.data_source, 'shop.haimer.com/en/A63.140.08 (re-checked)')
  assert.equal(r.body.qty_on_site, 1)
  assert.equal(stockTotal(), before)
  assert.equal(txnCount(), txBefore)
  const ch = db().all<any>(`SELECT field, old_value, new_value, source, reference, by_user FROM holder_changes WHERE holder_id='H0048' AND field <> 'notes' ORDER BY change_id`)
  assert.deepEqual(ch.map((c) => c.field).sort(), ['data_source', 'dims_json', 'gauge_length_mm'])
  const gl = ch.find((c) => c.field === 'gauge_length_mm')
  assert.deepEqual([gl.old_value, gl.new_value, gl.source, gl.reference, gl.by_user], ['80', '81', 'manual', 'shop.haimer.com/en/A63.140.08 (re-checked)', 'Dave'])
  // The detail endpoint shows the history newest first.
  const d = (await t.api('GET', '/api/holders/H0048')).body
  assert.equal(d.changes.length, 4)
  assert.ok(d.changes[0].change_id > d.changes[3].change_id)
})

test('PATCH with nothing changed writes nothing; same dims in another JSON format are not a change', async () => {
  const n0 = Number(db().value('SELECT COUNT(*) FROM holder_changes'))
  const h = (await t.api('GET', '/api/holders/H0020')).body
  const r = await t.api('PATCH', '/api/holders/H0020', { gauge_length_mm: 65, dims: h.dims, data_source: h.data_source, spec_code: h.spec_code })
  assert.equal(r.status, 200)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_changes')), n0)
  // The seed stored '{"d1": 6.0, ...}' (Python) — the parsed object is the same content.
  assert.match(String(h.dims_json), /"d1": 6\.0/)
})

test('PATCH on a fixed-bore holder moves min/max with the nominal Ø unless a range is given', async () => {
  const r = await t.api('PATCH', '/api/holders/H0046', { clamp_dia_mm: 6.35, data_source: 'Haimer inch range' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.clamp_dia_mm, r.body.clamp_min_mm, r.body.clamp_max_mm], [6.35, 6.35, 6.35])
  const fields = db().all<any>(`SELECT field FROM holder_changes WHERE holder_id='H0046'`).map((c) => c.field).sort()
  assert.deepEqual(fields, ['clamp_dia_mm', 'clamp_max_mm', 'clamp_min_mm', 'data_source'])
  const bad = await t.api('PATCH', '/api/holders/H0046', { clamp_min_mm: 10, clamp_max_mm: 8, data_source: 'x' })
  assert.equal(bad.status, 400)
})

test('PATCH validation: unknown holder, bad values, identity clash, read-only fields', async () => {
  assert.equal((await t.api('PATCH', '/api/holders/H9999', { notes: 'x' })).status, 404)
  const bad = await t.api('PATCH', '/api/holders/H0048', { max_rpm: 'fast', data_source: 'x' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /max rpm must be a number/i)
  const clash = await t.api('PATCH', '/api/holders/H0048', { order_no: 'A63.140.12', data_source: 'typo fix' })
  assert.equal(clash.status, 409)
  assert.equal(clash.body.details.holder_id, 'H0049')
  const ro =await t.api('PATCH', '/api/holders/H0048', { holder_id: 'H0001', data_source: 'x' })
  assert.equal(ro.status, 400)
  const st = await t.api('PATCH', '/api/holders/H0048', { data_status: '', data_source: 'x' })
  assert.equal(st.status, 400)
  const notObj = await t.api('PATCH', '/api/holders/H0048', [1, 2])
  assert.equal(notObj.status, 400)
})

// Review finding: "25,000" — the way the app itself shows max rpm — was stored as 25 (comma read as a decimal mark).
test('max rpm: thousands separators are read as thousands; anything ambiguous is refused, never stored as 25', async () => {
  const rpm = () => db().value<number>(`SELECT max_rpm FROM holders WHERE holder_id = 'H0010'`)
  const changes = () => Number(db().value(`SELECT COUNT(*) FROM holder_changes WHERE holder_id = 'H0010'`))
  assert.equal(rpm(), 25000)
  const src = db().value<string>(`SELECT data_source FROM holders WHERE holder_id = 'H0010'`)
  const n0 = changes()
  // Re-typing the value as shown (en-GB "25,000") or as a maker page prints it is the same value: nothing logged.
  for (const v of ['25,000', '25 000', '25.000', '25\u202F000', '25\u00A0000', "25'000", '25000', ' 25,000 ', '25,000 rpm', '25.000 1/min', 25000]) {
    const r = await t.api('PATCH', '/api/holders/H0010', { max_rpm: v, data_source: src })
    assert.equal(r.status, 200, `${JSON.stringify(v)} → ${JSON.stringify(r.body)}`)
    assert.equal(r.body.max_rpm, 25000, JSON.stringify(v))
  }
  assert.equal(changes(), n0, 'the same value in another format is not a change')
  const up = await t.api('PATCH', '/api/holders/H0010', { max_rpm: '30,000', data_source: 'MAPAL catalogue 2025 p. 9' })
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.equal(rpm(), 30000)
  assert.deepEqual(
    db().all<any>(`SELECT old_value, new_value FROM holder_changes WHERE holder_id = 'H0010' AND field = 'max_rpm'`).map((c) => [c.old_value, c.new_value]),
    [['25000', '30000']],
  )
  // A decimal mark, or groups that are not three digits, could be a typo of either reading: refused, value kept.
  for (const v of ['25,5', '25,00', '25,0', '1.5', '25.0000', '2,50,000', '25,000.5', '25.000,0', '25,000,00', ',500', '25,', '25 00', '1 000.000']) {
    const r = await t.api('PATCH', '/api/holders/H0010', { max_rpm: v, data_source: 'x' })
    assert.equal(r.status, 400, `${JSON.stringify(v)} → ${r.status} ${JSON.stringify(r.body)}`)
    assert.match(r.body.error, /max rpm/i)
    assert.match(r.body.error, /whole number/i, JSON.stringify(v))
  }
  assert.equal((await t.api('PATCH', '/api/holders/H0010', { max_rpm: '1,500,000', data_source: 'x' })).status, 400, 'too large')
  assert.equal(rpm(), 30000)
  // POST reads it the same way.
  const bad = await t.api('POST', '/api/holders', { ...NEW, order_no: 'RPM.TEST', max_rpm: '25,5' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /whole number/i)
  const back = await t.api('PATCH', '/api/holders/H0010', { max_rpm: 25000, data_source: 'MAPAL catalogue 2025 p. 9' })
  assert.equal(back.status, 200)
})

test('PATCH can change the maker (logged by name) and keeps holders when renaming', async () => {
  const r = await t.api('PATCH', '/api/holders/H0091', { manufacturer: 'KEMMLER', data_source: 'Entered under wrong maker' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.manufacturer, 'KEMMLER')
  const c = db().get<any>(`SELECT * FROM holder_changes WHERE holder_id='H0091' AND field='manufacturer'`)
  assert.deepEqual([c.old_value, c.new_value], ['HAIMER', 'KEMMLER'])
})

// ------------------------------------------------------------------ tally
test('GET /api/tally: summary, byType, byClamp, byLocation shapes and numbers', async () => {
  const r = await t.api('GET', '/api/tally')
  assert.equal(r.status, 200)
  const s = (await t.api('GET', '/api/summary')).body
  assert.deepEqual(r.body.summary, s)
  assert.equal(r.body.summary.holders_on_site, 54)
  const types = r.body.byType
  assert.deepEqual(Object.keys(types[0]).sort(), ['articles_on_site', 'holders_on_site', 'type_code', 'type_name'])
  assert.equal(types[0].type_code, 'SHRINK')
  assert.equal(types.find((x: any) => x.type_code === 'SHRINK').holders_on_site, 27)
  assert.ok(types.some((x: any) => x.type_code === 'OTHER' && x.holders_on_site === 0), 'all types are listed')
  assert.equal(types.reduce((a: number, x: any) => a + x.holders_on_site, 0), 54)
  // Fixed-bore only, grouped by Ø and type, with the gauge lengths on site.
  const clamp = r.body.byClamp
  assert.ok(clamp.length > 0)
  const s12 = clamp.find((x: any) => x.clamp_dia_mm === 12 && x.type_code === 'SHRINK')
  assert.equal(s12.holders_on_site, 5)
  assert.deepEqual(s12.gauge_lengths, [70, 90, 130])
  assert.ok(!clamp.some((x: any) => ['ER_COLLET', 'SCREW_IN', 'TAP_CHUCK', 'DRILL_CHUCK', 'PRECISION_COLLET'].includes(x.type_code)))
  const loc = r.body.byLocation
  const un = loc.find((x: any) => x.location === 'Unassigned – count required')
  assert.equal(un.holders, 54)
  assert.equal(un.counts_as_on_site, 1)
  assert.ok(loc.some((x: any) => x.counts_as_on_site === 0))
})

// ------------------------------------------------------------------ exports
test('catalogue.csv: same filters as the list, Excel-friendly, no user needed', async () => {
  const r = await t.api('GET', '/api/export/catalogue.csv?scope=site&fit=12', undefined, { user: null })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type')!, /text\/csv/)
  assert.match(r.headers.get('content-disposition')!, /attachment; filename="HSK-A63_holder_catalogue_\d{4}-\d{2}-\d{2}\.csv"/)
  // fetch's text() drops the BOM, so look at the bytes: Excel needs it to read UTF-8 (Ø, –).
  const raw = Buffer.from(await (await fetch(t.base + '/api/export/catalogue.csv?scope=site&fit=12')).arrayBuffer())
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const lines = r.text.replace(/^﻿/, '').trimEnd().split('\r\n')
  assert.equal(lines.length, 1 + 13)
  const head = lines[0]!.split(',')
  for (const c of ['holder_id', 'manufacturer', 'order_no', 'qty_on_site', 'count_status', 'gauge_length_mm', 'data_source'])
    assert.ok(head.includes(c), c)
  const all = await t.api('GET', '/api/export/catalogue.csv')
  assert.equal(all.text.trimEnd().split('\r\n').length, 1 + 91)
  assert.equal((await t.api('GET', '/api/export/catalogue.csv?fit=nope')).status, 400)
})

test('tally.csv: one row per article on site or counted, the prototype count columns', async () => {
  const r = await t.api('GET', '/api/export/tally.csv')
  assert.equal(r.status, 200)
  const lines = r.text.replace(/^﻿/, '').trimEnd().split('\r\n')
  assert.equal(lines[0], 'holder_id,manufacturer,order_no,series,clamp,gauge_length_mm,qty_on_site,count_status,last_count_date')
  assert.equal(lines.length, 1 + 54)
  assert.match(lines[1]!, /,1,unverified,$/)
  // A counted zero stays in the export (the count is the evidence).
  db().run(
    `INSERT INTO stock_transactions(holder_id, location_id, qty_delta, txn_type, reference, txn_date, by_user, note)
     VALUES ('H0025', 1, -1, 'COUNT_ADJUST', 'COUNT test', ?, 'QA', 'not found')`,
    [today()],
  )
  const after = (await t.api('GET', '/api/export/tally.csv')).text.replace(/^﻿/, '').trimEnd().split('\r\n')
  assert.equal(after.length, 1 + 54)
  assert.ok(after.some((l) => l.startsWith('H0025,') && l.endsWith(`,0,counted,${today()}`)))
  // Found it after all: the ledger is corrected by another transaction, never by deleting one.
  db().run(
    `INSERT INTO stock_transactions(holder_id, location_id, qty_delta, txn_type, reference, txn_date, by_user, note)
     VALUES ('H0025', 1, 1, 'COUNT_ADJUST', 'COUNT test', ?, 'QA', 'found')`,
    [today()],
  )
})

const isZip = (buf: Buffer) => buf.subarray(0, 2).toString('latin1') === 'PK'
async function download(path: string): Promise<{ buf: Buffer; res: Response }> {
  const res = await fetch(t.base + path)
  return { res, buf: Buffer.from(await res.arrayBuffer()) }
}

/** Opens an XLSX with openpyxl when available — proves Excel-compatible structure. Returns null if not available. */
async function openpyxlSummary(buf: Buffer, name: string): Promise<Record<string, number> | null> {
  if (!PYTHON) return null
  const file = join(t.dataDir, name)
  writeFileSync(file, buf)
  const py = 'import sys, json, openpyxl\nwb = openpyxl.load_workbook(sys.argv[1])\nprint(json.dumps({ws.title: ws.max_row for ws in wb.worksheets}))'
  return JSON.parse(await runPython(py, [file]))
}

test('catalogue.xlsx is a valid workbook (zip with xl/workbook.xml) honouring the filters', async (tc) => {
  const { res, buf } = await download('/api/export/catalogue.xlsx?scope=site&mk=HAIMER')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.ok(isZip(buf))
  assert.ok(buf.includes(Buffer.from('xl/workbook.xml')))
  const s = await openpyxlSummary(buf, 'catalogue.xlsx')
  if (!s) return tc.skip('python3 + openpyxl not available')
  assert.deepEqual(s, { Catalogue: 1 + 37 })
})

test('tally.xlsx has the six sheets and opens in openpyxl', async (tc) => {
  const { res, buf } = await download('/api/export/tally.xlsx')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition')!, /holder_tally_.*\.xlsx/)
  assert.ok(isZip(buf))
  assert.ok(buf.includes(Buffer.from('xl/workbook.xml')))
  const s = await openpyxlSummary(buf, 'tally.xlsx')
  if (!s) return tc.skip('python3 + openpyxl not available')
  assert.deepEqual(Object.keys(s), ['Articles', 'By type', 'By maker', 'By clamp Ø', 'By location', 'GL check'])
  assert.equal(s.Articles, 1 + 54)
  // The seed's 4 arbors, plus A63.140.08 whose maker GL an earlier test changed to 81 (hyperMILL still 80).
  const gl = (await t.api('GET', '/api/tally')).body.glCheck
  assert.equal(gl.length, 5)
  assert.ok(gl.some((g: any) => g.order_no === 'A63.140.08' && g.delta_mm === -1 && g.note === null))
  assert.equal(s['GL check'], 1 + gl.length)
})

// Review finding: a holder received and then scrapped showed "0 on site · Booked in" and was missing from the
// "Not on site" filter. With v_count_status, 'booked' means on site by receipt etc.; nothing on site is 'none'.
test('count status: received then scrapped is "none" (not on site), never "booked"; the filters agree', async () => {
  const has = async (qs: string) => (await list(qs)).holders.some((h) => h.holder_id === 'H0061')
  const rec = await t.api('POST', '/api/transactions', { holder_id: 'H0061', location_id: 2, txn_type: 'RECEIPT', qty: 1, reference: 'PO 2' })
  assert.ok(rec.status < 300, JSON.stringify(rec.body))
  let h = (await t.api('GET', '/api/holders/H0061')).body
  assert.deepEqual([h.qty_on_site, h.count_status], [1, 'booked'])
  assert.ok(await has('status=booked'))
  const scrap = await t.api('POST', '/api/transactions', { holder_id: 'H0061', location_id: 2, txn_type: 'SCRAP', qty: 1, reference: 'NCR-1' })
  assert.ok(scrap.status < 300, JSON.stringify(scrap.body))
  h = (await t.api('GET', '/api/holders/H0061')).body
  assert.deepEqual([h.qty_on_site, h.count_status], [0, 'none'])
  assert.ok(!(await has('status=booked')), 'nothing on site is never "booked"')
  assert.ok(await has('status=none'))
  assert.ok(await has('scope=cat&status=none'))
  // Every 'booked' holder has something on site; every 'none' holder has nothing.
  const all = (await list()).holders
  assert.ok(all.filter((x) => x.count_status === 'booked').every((x) => x.qty_on_site > 0))
  assert.ok(all.filter((x) => x.count_status === 'none').every((x) => x.qty_on_site <= 0))
})

test('data rules hold after all the writes above: 54 on site, nothing deleted, flags untouched', async () => {
  assert.equal(Number(db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')), 54)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM data_flags')), 31)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holders')), 91)
  assert.equal((await list('scope=site&fit=12')).holders.length, 13)
})
