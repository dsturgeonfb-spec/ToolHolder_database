import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestApp } from '../helpers.js'
import { today } from '../../src/server/domain.js'
import { addDays } from '../../src/server/modules/units.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

const db = () => t.app.ctx.db
const stock = () => JSON.stringify([db().value('SELECT COUNT(*) FROM stock_transactions'), db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')])
const daysAgo = (n: number) => addDays(today(), -n)!
const unit = (id: string) => db().get<any>(`SELECT * FROM holder_units WHERE unit_id = ?`, [id])
const enc = encodeURIComponent

// Holders used (seed data): H0033 HAIMER A63.144.12.3 (1 on site), H0038 HAIMER A63.144.12 (1 on site),
// H0060 MAPAL 31396171 (none on site). Location 2 = Tool crib.

test('no units to start with', async () => {
  const r = await t.api('GET', '/api/units')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, [])
})

test('POST /api/units validates every field and writes nothing when refused', async () => {
  const base = { unit_id: 'U-0001', holder_id: 'H0033' }
  const cases: Array<[Record<string, unknown>, number, RegExp, { user?: string | null }?]> = [
    [base, 400, /Enter your name/, { user: null }],
    [{ holder_id: 'H0033' }, 400, /Enter the unit id/],
    [{ ...base, unit_id: '   ' }, 400, /Enter the unit id/],
    [{ ...base, unit_id: 'U'.repeat(41) }, 400, /Unit id is too long/],
    [{ unit_id: 'U-0001' }, 400, /Choose the holder/],
    [{ ...base, holder_id: 'H9999' }, 404, /no holder H9999/],
    [{ ...base, runout_check_um: -1 }, 400, /can’t be negative/],
    [{ ...base, runout_check_um: 'abc' }, 400, /Runout must be a number/],
    [{ ...base, runout_check_um: 5000 }, 400, /looks wrong/],
    [{ ...base, last_inspected: '2026-02-31' }, 400, /must be a date/],
    [{ ...base, last_inspected: '07/10/2026' }, 400, /must be a date/],
    [{ ...base, last_inspected: addDays(today(), 1) }, 400, /can’t be in the future/],
    [{ ...base, location_id: 999 }, 404, /no location 999/],
    [{ ...base, location_id: 'crib' }, 400, /Location must be chosen/],
    [{ ...base, serial_no: 'S'.repeat(81) }, 400, /Maker's serial no\. is too long/],
    [{ ...base, note: 'n'.repeat(2001) }, 400, /Note is too long/],
  ]
  for (const [body, status, msg, opts] of cases) {
    const r = await t.api('POST', '/api/units', body, opts)
    assert.equal(r.status, status, `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body)}`)
    assert.match(r.body.error, msg)
  }
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_units')), 0)
})

test('POST adds a unit: id trimmed, holder/location joined, inspector recorded, next due from the interval, stock untouched', async () => {
  const before = stock()
  const last = daysAgo(10)
  const r = await t.api('POST', '/api/units', {
    unit_id: '  U-0001 ',
    holder_id: 'H0033',
    serial_no: 'HMR-77812',
    location_id: 2,
    runout_check_um: '2,5',
    last_inspected: last,
    note: 'Balanced G2.5 @ 25 000 rpm, cert 1234',
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const u = r.body
  assert.equal(u.unit_id, 'U-0001')
  assert.equal(u.holder_id, 'H0033')
  assert.equal(u.manufacturer, 'HAIMER')
  assert.equal(u.order_no, 'A63.144.12.3')
  assert.equal(u.location, 'Tool crib')
  assert.equal(u.serial_no, 'HMR-77812')
  assert.equal(u.runout_check_um, 2.5)
  assert.equal(u.last_inspected, last)
  assert.equal(u.inspected_by, 'Test User')
  assert.equal(u.status, 'IN_SERVICE')
  assert.equal(u.next_due, addDays(last, 180), 'default interval 180 days')
  assert.equal(u.days_to_due, 170)
  assert.equal(u.overdue, false)
  assert.equal(u.due_state, 'ok')
  assert.deepEqual(u.warnings, [], '1 unit, 1 on site — nothing to warn about')
  assert.match(u.note, new RegExp(`^${today()} Test User: Added \\(serial no\\. HMR-77812, runout 2\\.5 µm, last inspected ${last}\\)\\. Balanced G2\\.5`))
  assert.equal(stock(), before, 'a unit record never changes stock')
  // GET one, and it shows on the holder record.
  const one = await t.api('GET', '/api/units/U-0001')
  assert.equal(one.status, 200)
  assert.equal(one.body.unit_id, 'U-0001')
  assert.equal((await t.api('GET', '/api/units/U-404')).status, 404)
  const h = await t.api('GET', '/api/holders/H0033')
  assert.deepEqual(h.body.units.map((x: any) => x.unit_id), ['U-0001'])
})

test('duplicate unit id → 409 (also when only the case differs)', async () => {
  for (const id of ['U-0001', 'u-0001', ' U-0001']) {
    const r = await t.api('POST', '/api/units', { unit_id: id, holder_id: 'H0038' })
    assert.equal(r.status, 409, id)
    assert.match(r.body.error, /Unit id U-0001 is already used \(HAIMER A63\.144\.12\.3\)/)
  }
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_units')), 1)
})

test('more units than the ledger has on site → a warning (not a refusal)', async () => {
  const r = await t.api('POST', '/api/units', { unit_id: 'U-0002', holder_id: 'H0033' })
  assert.equal(r.status, 201)
  assert.equal(r.body.inspected_by, null, 'no inspection date given, no inspector')
  assert.equal(r.body.due_state, 'never')
  assert.equal(r.body.overdue, false)
  assert.equal(r.body.next_due, null)
  assert.equal(r.body.warnings.length, 1)
  assert.match(r.body.warnings[0], /2 units of HAIMER A63\.144\.12\.3 recorded, but the stock ledger has 1 on site/)
})

test('PATCH edits fields and appends to the log; unit id and status cannot be changed here', async () => {
  const r = await t.api('PATCH', '/api/units/U-0002', { serial_no: 'S-2', location_id: 3, note: 'Sent for re-balancing' }, { user: 'Sam Turner' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.serial_no, 'S-2')
  assert.equal(r.body.location, 'At vendor / repair')
  const log = r.body.note.split('\n')
  assert.equal(log.length, 2)
  assert.equal(log[1], `${today()} Sam Turner: Edited: serial no. — → "S-2"; location — → At vendor / repair. Note: Sent for re-balancing`)
  // Holder change re-checks the stock warning.
  const moved = await t.api('PATCH', '/api/units/U-0002', { holder_id: 'H0038' })
  assert.equal(moved.body.order_no, 'A63.144.12')
  assert.deepEqual(moved.body.warnings, [])
  // Nothing changed → nothing logged.
  const same = await t.api('PATCH', '/api/units/U-0002', { serial_no: 'S-2' })
  assert.equal(same.body.note.split('\n').length, 3)
  // A wrong inspection date is corrected by a person, who becomes the recorded inspector.
  const dated = await t.api('PATCH', '/api/units/U-0002', { last_inspected: daysAgo(3), runout_check_um: 4 })
  assert.equal(dated.body.last_inspected, daysAgo(3))
  assert.equal(dated.body.inspected_by, 'Test User')
  assert.equal(dated.body.runout_check_um, 4)

  const renamed = await t.api('PATCH', '/api/units/U-0002', { unit_id: 'U-0099' })
  assert.equal(renamed.status, 400)
  assert.match(renamed.body.error, /can’t be changed/)
  const status = await t.api('PATCH', '/api/units/U-0002', { status: 'SCRAPPED' })
  assert.equal(status.status, 400)
  assert.match(status.body.error, /needs a note/)
  assert.equal((await t.api('PATCH', '/api/units/U-0002', { serial_no: 'x' }, { user: null })).status, 400)
  assert.equal((await t.api('PATCH', '/api/units/NOPE', { serial_no: 'x' })).status, 404)
  assert.equal((await t.api('PATCH', '/api/units/U-0002', { runout_check_um: -2 })).status, 400)
  assert.equal(unit('U-0002').runout_check_um, 4, 'refused edit left the unit alone')
})

test('inspect: validation; pass records today + inspector; fail quarantines', async () => {
  const before = stock()
  const p = '/api/units/U-0001/inspect'
  assert.equal((await t.api('POST', p, { runout_check_um: 2, passed: true }, { user: null })).status, 400)
  assert.match((await t.api('POST', p, { passed: true })).body.error, /Enter the measured runout/)
  assert.match((await t.api('POST', p, { runout_check_um: 2 })).body.error, /passed: true or false/)
  assert.match((await t.api('POST', p, { runout_check_um: 2, passed: 'yes' })).body.error, /passed: true or false/)
  assert.match((await t.api('POST', p, { runout_check_um: 9, passed: false })).body.error, /Say what failed/)
  assert.equal((await t.api('POST', '/api/units/NOPE/inspect', { runout_check_um: 2, passed: true })).status, 404)

  const ok = await t.api('POST', p, { runout_check_um: 3, passed: true, note: 'Ø20 mandrel on the presetter' }, { user: 'Quality Inspector' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.passed, true)
  assert.equal(ok.body.status_changed, false)
  assert.equal(ok.body.status, 'IN_SERVICE')
  assert.equal(ok.body.last_inspected, today())
  assert.equal(ok.body.inspected_by, 'Quality Inspector')
  assert.equal(ok.body.runout_check_um, 3)
  assert.equal(ok.body.next_due, addDays(today(), 180))
  assert.match(ok.body.note.split('\n').pop(), /Quality Inspector: Inspected: runout 3 µm, passed\. Ø20 mandrel on the presetter$/)

  const fail = await t.api('POST', p, { runout_check_um: 12, passed: false, note: 'Taper fretting, runout 12 µm' })
  assert.equal(fail.status, 200)
  assert.equal(fail.body.status, 'QUARANTINE')
  assert.equal(fail.body.status_changed, true)
  assert.equal(fail.body.inspected_by, 'Test User')
  assert.match(fail.body.note.split('\n').pop(), /Inspected: runout 12 µm, FAILED — quarantined\. Taper fretting/)
  // Failing again keeps it in quarantine (no second status change).
  const again = await t.api('POST', p, { runout_check_um: 11, passed: false, note: 'Still out' })
  assert.equal(again.body.status_changed, false)
  assert.match(again.body.note.split('\n').pop(), /FAILED — stays in quarantine/)
  // Passing a quarantined unit does not release it by itself — that is a status change with a note.
  const passQ = await t.api('POST', p, { runout_check_um: 2, passed: true, note: 'After re-grind' })
  assert.equal(passQ.body.passed, true)
  assert.equal(passQ.body.status, 'QUARANTINE')
  assert.equal(stock(), before)
})

test('status change needs a valid status and a note; same status is a 409; scrapped units cannot be inspected', async () => {
  const p = '/api/units/U-0001/status'
  assert.equal((await t.api('POST', p, { status: 'IN_SERVICE', note: 'x' }, { user: null })).status, 400)
  assert.match((await t.api('POST', p, { status: 'IN_SERVICE' })).body.error, /needs a note/)
  assert.match((await t.api('POST', p, { status: 'IN_SERVICE', note: '   ' })).body.error, /needs a note/)
  assert.match((await t.api('POST', p, { status: 'BROKEN', note: 'x' })).body.error, /IN_SERVICE, QUARANTINE or SCRAPPED/)
  const same = await t.api('POST', p, { status: 'QUARANTINE', note: 'x' })
  assert.equal(same.status, 409)
  assert.match(same.body.error, /already quarantine/)

  const back = await t.api('POST', p, { status: 'in_service', note: 'Re-ground, runout 2 µm' })
  assert.equal(back.status, 200)
  assert.equal(back.body.status, 'IN_SERVICE')
  assert.match(back.body.note.split('\n').pop(), new RegExp(`^${today()} Test User: Status quarantine → in service: Re-ground, runout 2 µm$`))

  const before = stock()
  const scrap = await t.api('POST', '/api/units/U-0002/status', { status: 'SCRAPPED', note: 'NCR-2026-014 taper damaged' })
  assert.equal(scrap.body.status, 'SCRAPPED')
  assert.equal(scrap.body.due_state, null)
  assert.equal(scrap.body.overdue, false)
  assert.equal(stock(), before, 'scrapping a unit record does not book a stock scrap by itself')
  const insp = await t.api('POST', '/api/units/U-0002/inspect', { runout_check_um: 2, passed: true })
  assert.equal(insp.status, 409)
  assert.match(insp.body.error, /scrapped/)
  // The full log is kept, oldest first.
  const log = unit('U-0001').note.split('\n')
  assert.equal(log.length, 6)
  assert.match(log[0], /Added/)
})

test('next due / overdue / due filter follow the inspection interval setting', async () => {
  const put = await t.api('PUT', '/api/settings', { unit_inspection_days: 90 })
  assert.equal(put.body.unit_inspection_days, 90)
  const add = async (unit_id: string, last: string | null, holder_id = 'H0060') => {
    const r = await t.api('POST', '/api/units', { unit_id, holder_id, last_inspected: last })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r.body
  }
  const overdue = await add('U-0100', daysAgo(100))
  assert.equal(overdue.next_due, daysAgo(10))
  assert.equal(overdue.days_to_due, -10)
  assert.equal(overdue.overdue, true)
  assert.equal(overdue.due_state, 'overdue')
  const soon = await add('U-0101', daysAgo(70))
  assert.equal(soon.next_due, addDays(today(), 20))
  assert.equal(soon.overdue, false)
  assert.equal(soon.due_state, 'due_soon')
  const edge = await add('U-0102', daysAgo(60))
  assert.equal(edge.days_to_due, 30)
  assert.equal(edge.due_state, 'due_soon', 'due in exactly 30 days counts as due')
  const fine = await add('U-0103', daysAgo(59))
  assert.equal(fine.due_state, 'ok')
  const dueToday = await add('U-0104', daysAgo(90))
  assert.equal(dueToday.days_to_due, 0)
  assert.equal(dueToday.overdue, false, 'due today is not yet overdue')
  await add('U-0105', null)

  const ids = (rows: any[]) => rows.map((u) => u.unit_id)
  // U-0001: inspected today (ok), U-0002: scrapped.
  assert.deepEqual(ids((await t.api('GET', '/api/units?due=1')).body), ['U-0100', 'U-0101', 'U-0102', 'U-0104', 'U-0105'])
  assert.deepEqual(ids((await t.api('GET', '/api/units?due=overdue')).body), ['U-0100'])
  assert.deepEqual(ids((await t.api('GET', '/api/units?overdue=1')).body), ['U-0100'])
  // U-0001 was inspected today with a 90-day interval now.
  assert.equal((await t.api('GET', '/api/units/U-0001')).body.next_due, addDays(today(), 90))

  // A shorter interval makes more units overdue — nothing is stored, it is worked out on every read.
  await t.api('PUT', '/api/settings', { unit_inspection_days: 30 })
  assert.deepEqual(ids((await t.api('GET', '/api/units?overdue=1')).body), ['U-0100', 'U-0101', 'U-0102', 'U-0103', 'U-0104'])
  await t.api('PUT', '/api/settings', { unit_inspection_days: 180 })
})

test('GET /api/units filters: holder, status (list / active / all), location, search; natural sort; bad values → 400', async () => {
  const ids = async (q: string) => ((await t.api('GET', '/api/units' + q)).body as any[]).map((u) => u.unit_id)
  assert.deepEqual(await ids('?holder_id=H0033'), ['U-0001'])
  assert.deepEqual(await ids('?status=SCRAPPED'), ['U-0002'])
  assert.equal((await ids('?status=active')).length, 7)
  assert.equal((await ids('?status=all')).length, 8)
  assert.equal((await ids('')).length, 8)
  assert.deepEqual(await ids('?location_id=3'), ['U-0002'])
  assert.deepEqual(await ids('?q=hmr-778'), ['U-0001'], 'search matches the serial no.')
  assert.deepEqual(await ids('?q=a63.144.12%20u-000'), ['U-0001', 'U-0002'])
  assert.deepEqual(await ids('?q=mapal'), ['U-0100', 'U-0101', 'U-0102', 'U-0103', 'U-0104', 'U-0105'])
  assert.equal((await t.api('GET', '/api/units?status=LOST')).status, 400)
  assert.equal((await t.api('GET', '/api/units?location_id=x')).status, 400)
  // Natural order: U-9 before U-10.
  await t.api('POST', '/api/units', { unit_id: 'U-9', holder_id: 'H0060' })
  await t.api('POST', '/api/units', { unit_id: 'U-10', holder_id: 'H0060' })
  const order = await ids('?q=mapal')
  assert.ok(order.indexOf('U-9') < order.indexOf('U-10'))
})

test('unit ids with spaces or slashes work in the URL', async () => {
  const r = await t.api('POST', '/api/units', { unit_id: 'RFID 04/A7', holder_id: 'H0060' })
  assert.equal(r.status, 201)
  const got = await t.api('GET', `/api/units/${enc('RFID 04/A7')}`)
  assert.equal(got.status, 200)
  assert.equal(got.body.unit_id, 'RFID 04/A7')
  const insp = await t.api('POST', `/api/units/${enc('RFID 04/A7')}/inspect`, { runout_check_um: 1, passed: true })
  assert.equal(insp.body.last_inspected, today())
})

test('units.csv exports the filtered list with next due, overdue and the log', async () => {
  await t.api('PUT', '/api/settings', { unit_inspection_days: 90 })
  const res = await fetch(t.base + '/api/export/units.csv?due=overdue')
  await t.api('PUT', '/api/settings', { unit_inspection_days: 180 })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type')!, /text\/csv/)
  assert.match(res.headers.get('content-disposition')!, new RegExp(`serialised_units_${today()}\\.csv`))
  const raw = Buffer.from(await res.arrayBuffer())
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const rows = raw.toString('utf8').replace(/^﻿/, '').trimEnd().split('\r\n')
  assert.equal(rows[0], 'unit_id,holder_id,manufacturer,order_no,designation,description,serial_no,location,runout_um,last_inspected,inspected_by,next_due,overdue,status,log')
  assert.equal(rows.length, 2)
  assert.ok(rows[1]!.startsWith(`U-0100,H0060,MAPAL,31396171,MHC-HSK-A063-32-110-1-0-A,"UNIQ Mill Chuck, HA",,,,${daysAgo(100)},Test User,${daysAgo(10)},yes,IN_SERVICE,`))
  const all = (await t.api('GET', '/api/export/units.csv?status=all')).text.trimEnd().split('\r\n')
  assert.ok(all.length > 9, 'multi-line logs are quoted, so there are at least as many lines as units')
})

test('units never touched stock or the catalogue; acceptance numbers hold', () => {
  assert.equal(Number(db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')), 54)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE txn_type <> 'OPENING_BALANCE'`)), 0)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_changes')), 0)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM data_flags')), 31)
})
