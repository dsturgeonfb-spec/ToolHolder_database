import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PYTHON, runPython } from '../openpyxl.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { startTestApp, type TestApp } from '../helpers.js'
import { today } from '../../src/server/domain.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

const db = () => t.app.ctx.db
/** Stock fingerprint: nothing on the want list may ever change stock. */
const stock = () => JSON.stringify([db().value('SELECT COUNT(*) FROM stock_transactions'), db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')])
const lines = (holderId: string) => db().all<any>(`SELECT * FROM wishlist WHERE holder_id = ? ORDER BY wish_id`, [holderId])
const csvLines = (text: string) => text.replace(/^﻿/, '').trimEnd().split('\r\n')

// Holders used below (seed data): H0060 MAPAL 31396171 (can buy), H0070 MAPAL 31229439 (can buy),
// H0018 MAPAL 30524702 (on site, open 'Purchasing' flag #28), H0006 HAIMER A63.020.16 (on site), H0062 MAPAL 31441122.

// ------------------------------------------------------------------ validation

test('want list starts empty', async () => {
  const r = await t.api('GET', '/api/wishlist')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, [])
})

test('POST /api/wishlist validates: person, holder, quantity, reason', async () => {
  const before = stock()
  const noUser = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 1 }, { user: null })
  assert.equal(noUser.status, 400)
  assert.match(noUser.body.error, /Enter your name/)
  const noHolder = await t.api('POST', '/api/wishlist', { qty_wanted: 1 })
  assert.equal(noHolder.status, 400)
  assert.match(noHolder.body.error, /Choose the holder/)
  const unknown = await t.api('POST', '/api/wishlist', { holder_id: 'H9999', qty_wanted: 1 })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /no holder H9999/)
  for (const qty of [0, -1, 1.5, 'abc', '', 1000]) {
    const r = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: qty })
    assert.equal(r.status, 400, `qty ${JSON.stringify(qty)} refused`)
    assert.match(r.body.error, /Quantity wanted must be a whole number from 1 to 999/)
  }
  const long = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 1, reason: 'x'.repeat(1001) })
  assert.equal(long.status, 400)
  assert.match(long.body.error, /Reason is too long/)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM wishlist')), 0, 'nothing written by refused requests')
  assert.equal(stock(), before)
})

// ------------------------------------------------------------------ add / merge

test('POST adds an OPEN line with the holder fields, the person and today', async () => {
  const before = stock()
  const r = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 2, reason: 'Job 4711 needs Ø32 at 110 GL' })
  assert.equal(r.status, 201)
  const w = r.body
  assert.equal(w.merged, false)
  assert.equal(w.holder_id, 'H0060')
  assert.equal(w.qty_wanted, 2)
  assert.equal(w.status, 'OPEN')
  assert.equal(w.reason, 'Job 4711 needs Ø32 at 110 GL')
  assert.equal(w.added_by, 'Test User')
  assert.equal(w.added_on, today())
  assert.equal(w.updated_on, null)
  // Holder fields for the list and the RFQ.
  assert.equal(w.manufacturer, 'MAPAL')
  assert.equal(w.order_no, '31396171')
  assert.equal(w.spec_code, 'MHC-HSK-A063-32-110-1-0-A')
  assert.equal(w.series, 'UNIQ Mill Chuck, HA')
  assert.equal(w.clamp_spec, 'Ø32 mm shank (h6)')
  assert.equal(w.gauge_length_mm, 110)
  assert.equal(w.product_url, 'https://shop.mapal.com/en/p/000000000031396171')
  assert.equal(w.qty_on_site, 0)
  assert.deepEqual(w.purchasing_notes, [])
  assert.equal(stock(), before, 'adding to the want list never books stock')
})

test('adding the same holder again tops up its OPEN line (qty added, reason appended, both people recorded)', async () => {
  const r = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 3, reason: 'Spare for DMG cell 2' }, { user: 'Sam Turner' })
  assert.equal(r.status, 200)
  assert.equal(r.body.merged, true)
  assert.equal(r.body.added_qty, 3)
  assert.equal(r.body.qty_wanted, 5)
  assert.equal(r.body.reason, 'Job 4711 needs Ø32 at 110 GL; Spare for DMG cell 2')
  assert.equal(r.body.added_by, 'Test User; Sam Turner')
  assert.equal(r.body.updated_on, today())
  // The same reason again is not repeated; no qty given means one.
  const again = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', reason: 'spare for DMG cell 2' })
  assert.equal(again.body.qty_wanted, 6)
  assert.equal(again.body.reason, 'Job 4711 needs Ø32 at 110 GL; Spare for DMG cell 2')
  assert.equal(again.body.added_by, 'Test User; Sam Turner')
  // A name with a comma in it is still recognised as one person.
  const comma = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 1 }, { user: 'Sturgeon, D.' })
  assert.equal(comma.body.added_by, 'Test User; Sam Turner; Sturgeon, D.')
  const comma2 = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 1 }, { user: 'Sturgeon, D.' })
  assert.equal(comma2.body.added_by, 'Test User; Sam Turner; Sturgeon, D.')
  assert.equal(comma2.body.qty_wanted, 8)
  assert.equal(lines('H0060').length, 1, 'still one line')
  // The catalogue's Holder object reports it.
  const h = await t.api('GET', '/api/holders/H0060')
  assert.equal(h.body.on_want_list, 8)
  // Topping up past the per-line limit is refused and changes nothing.
  const tooMany = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 999 })
  assert.equal(tooMany.status, 400)
  assert.equal(lines('H0060')[0].qty_wanted, 8)
})

// ------------------------------------------------------------------ patch / status workflow

test('PATCH validates and changes qty, reason and status (updated_on set)', async () => {
  const id = lines('H0060')[0].wish_id
  assert.equal((await t.api('PATCH', `/api/wishlist/${id}`, { qty_wanted: 4 }, { user: null })).status, 400)
  assert.equal((await t.api('PATCH', `/api/wishlist/${id}`, {})).status, 400)
  assert.match((await t.api('PATCH', `/api/wishlist/${id}`, {})).body.error, /Nothing to change/)
  assert.equal((await t.api('PATCH', `/api/wishlist/${id}`, { qty_wanted: 0 })).status, 400)
  const badStatus = await t.api('PATCH', `/api/wishlist/${id}`, { status: 'SHIPPED' })
  assert.equal(badStatus.status, 400)
  assert.match(badStatus.body.error, /OPEN, QUOTED, ORDERED, RECEIVED, CANCELLED/)
  assert.equal((await t.api('PATCH', '/api/wishlist/99999', { qty_wanted: 1 })).status, 404)
  assert.equal((await t.api('PATCH', '/api/wishlist/abc', { qty_wanted: 1 })).status, 400)

  db().run(`UPDATE wishlist SET updated_on = NULL WHERE wish_id = ?`, [id])
  const r = await t.api('PATCH', `/api/wishlist/${id}`, { qty_wanted: 4, reason: 'Job 4711' })
  assert.equal(r.status, 200)
  assert.equal(r.body.qty_wanted, 4)
  assert.equal(r.body.reason, 'Job 4711')
  assert.equal(r.body.updated_on, today())
  const s = await t.api('PATCH', `/api/wishlist/${id}`, { status: 'quoted' })
  assert.equal(s.body.status, 'QUOTED')
})

test('only one OPEN line per holder: a new add after QUOTED starts a new line; reopening the old one is refused', async () => {
  const [quoted] = lines('H0060')
  const r = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 1, reason: 'Another job' })
  assert.equal(r.status, 201, 'QUOTED lines are not topped up — the RFQ has gone')
  assert.equal(lines('H0060').length, 2)
  const back = await t.api('PATCH', `/api/wishlist/${quoted.wish_id}`, { status: 'OPEN' })
  assert.equal(back.status, 409)
  assert.match(back.body.error, /already has an open want-list line/)
  // on_want_list counts OPEN + QUOTED + ORDERED.
  assert.equal((await t.api('GET', '/api/holders/H0060')).body.on_want_list, 5)
})

test('RECEIVED does not book stock; a received line keeps its quantity; DELETE cancels and keeps the row', async () => {
  const before = stock()
  const [quoted, open] = lines('H0060')
  const ordered = await t.api('PATCH', `/api/wishlist/${quoted.wish_id}`, { status: 'ORDERED' })
  assert.equal(ordered.body.status, 'ORDERED')
  const received = await t.api('PATCH', `/api/wishlist/${quoted.wish_id}`, { status: 'RECEIVED' })
  assert.equal(received.status, 200)
  assert.equal(received.body.status, 'RECEIVED')
  assert.equal(stock(), before, 'marking RECEIVED leaves the stock ledger alone')
  assert.equal((await t.api('GET', '/api/holders/H0060')).body.qty_on_site, 0)
  const qty = await t.api('PATCH', `/api/wishlist/${quoted.wish_id}`, { qty_wanted: 9 })
  assert.equal(qty.status, 409)
  assert.match(qty.body.error, /RECEIVED/)
  // A note on a closed line is still allowed.
  assert.equal((await t.api('PATCH', `/api/wishlist/${quoted.wish_id}`, { reason: 'Job 4711 — delivered on PO 4500123' })).status, 200)
  assert.equal((await t.api('DELETE', `/api/wishlist/${quoted.wish_id}`)).status, 409, 'received lines cannot be cancelled')

  assert.equal((await t.api('DELETE', `/api/wishlist/${open.wish_id}`, undefined, { user: null })).status, 400)
  const del = await t.api('DELETE', `/api/wishlist/${open.wish_id}`)
  assert.equal(del.status, 200)
  assert.equal(del.body.status, 'CANCELLED')
  assert.equal(del.body.updated_on, today())
  const again = await t.api('DELETE', `/api/wishlist/${open.wish_id}`)
  assert.equal(again.status, 200, 'cancelling twice is harmless')
  assert.equal(lines('H0060').length, 2, 'rows are kept for the purchasing record')
  assert.equal((await t.api('GET', '/api/holders/H0060')).body.on_want_list, 0)
  assert.equal((await t.api('DELETE', '/api/wishlist/424242')).status, 404)
  // A cancelled line can be reopened when no other line is open, and then takes quantity again.
  const reopened = await t.api('PATCH', `/api/wishlist/${open.wish_id}`, { status: 'OPEN' })
  assert.equal(reopened.body.status, 'OPEN')
  assert.equal((await t.api('DELETE', `/api/wishlist/${open.wish_id}`)).body.status, 'CANCELLED')
  assert.equal(stock(), before)
})

test('GET /api/wishlist filters by status (list, active, all) and holder; bad status is a 400', async () => {
  const all = (await t.api('GET', '/api/wishlist?status=all')).body as any[]
  assert.equal(all.length, 2)
  assert.deepEqual((await t.api('GET', '/api/wishlist?status=RECEIVED')).body.map((w: any) => w.status), ['RECEIVED'])
  assert.deepEqual((await t.api('GET', '/api/wishlist?status=active')).body, [])
  assert.equal((await t.api('GET', '/api/wishlist?status=received,cancelled')).body.length, 2)
  assert.equal((await t.api('GET', '/api/wishlist?holder_id=H0070')).body.length, 0)
  const bad = await t.api('GET', '/api/wishlist?status=LOST')
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /Unknown want-list status LOST/)
})

// ------------------------------------------------------------------ RFQ exports

async function rfqSetup() {
  for (const [holder_id, qty_wanted, reason] of [
    ['H0018', 2, 'Second HTC for the Ø12 roughers'],
    ['H0070', 1, 'Job 5120'],
    ['H0006', 3, 'ER16 for <deburr> & chamfer'],
    ['H0062', 1, 'Long reach Ø6'],
  ] as const) {
    const r = await t.api('POST', '/api/wishlist', { holder_id, qty_wanted, reason })
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body))
  }
  // A QUOTED line is not asked for again.
  const q = lines('H0062')[0]
  await t.api('PATCH', `/api/wishlist/${q.wish_id}`, { status: 'QUOTED' })
}

test('wishlist rows carry the open Purchasing flags for their holder', async () => {
  await rfqSetup()
  const row = (await t.api('GET', '/api/wishlist?holder_id=H0018')).body[0]
  assert.equal(row.order_no, '30524702')
  assert.equal(row.qty_on_site, 1)
  assert.equal(row.purchasing_notes.length, 1)
  assert.equal(row.purchasing_notes[0].flag_id, 28)
  assert.match(row.purchasing_notes[0].message, /MAPAL shop also lists 30655666/)
  assert.match(row.purchasing_notes[0].action, /Confirm current order no/)
})

test('rfq.csv: OPEN lines only, grouped by maker, with the purchasing flag as a note', async () => {
  const r = await t.api('GET', '/api/export/rfq.csv')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type')!, /text\/csv/)
  assert.match(r.headers.get('content-disposition')!, new RegExp(`rfq_${today()}\\.csv`))
  // fetch's text() drops a BOM, so look at the bytes.
  const raw = Buffer.from(await (await fetch(t.base + '/api/export/rfq.csv')).arrayBuffer())
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel')
  assert.ok(raw.includes(Buffer.from('\r\n')), 'CRLF line ends')
  const rows = csvLines(r.text)
  assert.equal(
    rows[0],
    'maker,order_no,designation,description,interface,clamp,gauge_length_mm,qty,notes,maker_url,line_status,want_line,holder_id,added_on,added_by',
  )
  const body = rows.slice(1)
  assert.equal(body.length, 3, 'H0018, H0070, H0006 — not the QUOTED, RECEIVED or CANCELLED lines')
  const makers = body.map((l) => l.split(',')[0])
  assert.deepEqual(makers, ['HAIMER', 'MAPAL', 'MAPAL'], 'grouped by maker, A→Z')
  const haimer = body[0]!
  assert.match(haimer, /^HAIMER,A63\.020\.16,,Collet Chuck Type ER,HSK-A63,ER16 · 0\.5–10 mm,100,3,ER16 for <deburr> & chamfer,/)
  const htc = body.find((l) => l.includes(',30524702,'))!
  assert.match(htc, /,2,"?Second HTC for the Ø12 roughers \| MAPAL shop also lists 30655666/)
  assert.match(htc, /Confirm current order no\. with MAPAL before reordering/)
  assert.match(htc, /https:\/\/shop\.mapal\.com\/en\/p\/000000000030524702/)
  assert.ok(!r.text.includes('31441122'), 'QUOTED line not on the RFQ')
  assert.ok(!r.text.includes('31396171'), 'received/cancelled lines not on the RFQ')

  const haimerOnly = csvLines((await t.api('GET', '/api/export/rfq.csv?maker=haimer')).text)
  assert.equal(haimerOnly.length, 2)
  assert.ok(haimerOnly[1]!.startsWith('HAIMER,A63.020.16,'))
  const quoted = csvLines((await t.api('GET', '/api/export/rfq.csv?status=QUOTED')).text)
  assert.equal(quoted.length, 2)
  assert.ok(quoted[1]!.includes(',31441122,'))
  assert.equal((await t.api('GET', '/api/export/rfq.csv?status=nope')).status, 400)
})

/** Reads one file out of a ZIP (the XLSX package) without a dependency. */
function unzipEntry(buf: Buffer, name: string): string | null {
  let off = 0
  while (off < buf.length - 4 && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8)
    const compSize = buf.readUInt32LE(off + 18)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const entry = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8')
    const start = off + 30 + nameLen + extraLen
    const data = buf.subarray(start, start + compSize)
    if (entry === name) return (method === 8 ? inflateRawSync(data) : data).toString('utf8')
    off = start + compSize
  }
  return null
}

async function openpyxlSheets(buf: Buffer, file: string): Promise<Record<string, string[][]> | null> {
  if (!PYTHON) return null
  const path = join(t.dataDir, file)
  writeFileSync(path, buf)
  const py = [
    'import sys, json, openpyxl',
    'wb = openpyxl.load_workbook(sys.argv[1])',
    'print(json.dumps({ws.title: [[("" if c is None else str(c)) for c in row] for row in ws.iter_rows(values_only=True)] for ws in wb.worksheets}))',
  ].join('\n')
  return JSON.parse(await runPython(py, [path]))
}

test('rfq.xlsx: a valid workbook with one sheet per maker', async (tc) => {
  const res = await fetch(t.base + '/api/export/rfq.xlsx')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const buf = Buffer.from(await res.arrayBuffer())
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK')
  const wb = unzipEntry(buf, 'xl/workbook.xml')!
  assert.ok(wb, 'workbook part present')
  assert.deepEqual([...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]), ['HAIMER', 'MAPAL'])
  const mapal = unzipEntry(buf, 'xl/worksheets/sheet2.xml')!
  assert.match(mapal, /30524702/)
  assert.match(mapal, /31229439/)
  assert.ok(!mapal.includes('A63.020.16'))
  const sheets = await openpyxlSheets(buf, 'rfq.xlsx')
  if (!sheets) return tc.skip('python3 + openpyxl not available')
  assert.deepEqual(Object.keys(sheets), ['HAIMER', 'MAPAL'])
  assert.equal(sheets.HAIMER!.length, 2)
  assert.equal(sheets.MAPAL!.length, 3)
  assert.equal(sheets.MAPAL![0]![1], 'order_no')
  const htc = sheets.MAPAL!.find((row) => row[1] === '30524702')!
  assert.equal(htc[7], '2', 'qty is a number cell')
  assert.match(htc[8]!, /MAPAL shop also lists 30655666/)
})

test('rfq.xlsx with nothing to quote still opens (one empty RFQ sheet)', async (tc) => {
  const res = await fetch(t.base + '/api/export/rfq.xlsx?maker=KEMMLER')
  assert.equal(res.status, 200)
  const buf = Buffer.from(await res.arrayBuffer())
  assert.deepEqual([...unzipEntry(buf, 'xl/workbook.xml')!.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]), ['RFQ'])
  const sheets = await openpyxlSheets(buf, 'rfq-empty.xlsx')
  if (!sheets) return tc.skip('python3 + openpyxl not available')
  assert.equal(sheets.RFQ!.length, 1, 'header row only')
})

test('rfq.html?maker=MAPAL: printable RFQ with order nos, the purchasing-flag note and the reply request', async () => {
  const r = await t.api('GET', '/api/export/rfq.html?maker=MAPAL')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type')!, /text\/html/)
  assert.match(r.headers.get('content-disposition')!, /^inline/)
  const html = r.text
  assert.match(html, /<title>Request for quotation — MAPAL<\/title>/)
  assert.ok(html.includes('30524702') && html.includes('31229439'), 'order nos listed')
  assert.ok(html.includes('HTC-HSK-A063-12-080-1-0-A'), 'designation listed')
  assert.ok(html.includes('MAPAL shop also lists 30655666 with the same spec code HTC-HSK-A063-12-080'), 'purchasing flag note for 30524702')
  assert.ok(!html.includes('A63.020.16'), 'other makers are not on this RFQ')
  assert.ok(!html.includes('31441122'), 'QUOTED line not asked again')
  assert.match(html, new RegExp(`RFQ-${today().replace(/-/g, '')}-MAPAL`))
  assert.match(html, /unit price/i)
  assert.match(html, /lead time/i)
  assert.match(html, /confirm that the order no\. above is the\s+current one/)
  assert.match(html, /\(company name\)/, 'placeholder for the shop name/contact')
  assert.match(html, /https:\/\/shop\.mapal\.com\/en\/p\/000000000031229439/)
  assert.ok(!/<script/i.test(html), 'printable pages carry no scripts')
})

test('rfq.html escapes data, puts every maker on its own page, and says so when there is nothing to quote', async () => {
  const all = (await t.api('GET', '/api/export/rfq.html')).text
  assert.ok(all.includes('ER16 for &lt;deburr&gt; &amp; chamfer'), 'reason is HTML-escaped')
  assert.ok(!all.includes('<deburr>'))
  assert.equal((all.match(/<section class="rfq/g) ?? []).length, 2)
  assert.equal((all.match(/rfq-break/g) ?? []).length, 2, 'second maker starts a new page (class + its CSS rule)')
  assert.match(all, /<h2>HAIMER<\/h2>[\s\S]*<h2>MAPAL<\/h2>/)
  // vendor_contact from Settings fills the e-mail line when it is set.
  await t.api('PUT', '/api/settings', { vendor_contact: 'engineering@example.test' })
  assert.match((await t.api('GET', '/api/export/rfq.html?maker=HAIMER')).text, /engineering@example\.test/)
  const none = await t.api('GET', '/api/export/rfq.html?maker=KEMMLER')
  assert.equal(none.status, 200)
  assert.match(none.text, /no open lines for KEMMLER/)
})

test('the want list never touched stock or the catalogue', () => {
  // Opening balances only: 54 holders on site, and no transaction other than the seeded ones.
  assert.equal(Number(db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')), 54)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE txn_type <> 'OPENING_BALANCE'`)), 0)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_changes')), 0)
})
