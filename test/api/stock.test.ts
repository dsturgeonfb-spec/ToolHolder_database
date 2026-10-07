import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestApp } from '../helpers.js'
import { today, UNASSIGNED_LOCATION } from '../../src/server/domain.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

const UNASSIGNED = 1
const CRIB = 2
const VENDOR = 3

const db = () => t.app.ctx.db
const qtyAt = (holder: string, loc: number) =>
  Number(db().value('SELECT COALESCE(SUM(qty_delta),0) FROM stock_transactions WHERE holder_id = ? AND location_id = ?', [holder, loc]))
const onSite = (holder: string) => Number(db().value('SELECT qty_on_site FROM v_stock_on_hand WHERE holder_id = ?', [holder]))
const txnCount = () => Number(db().value('SELECT COUNT(*) FROM stock_transactions'))
const summary = async () => (await t.api('GET', '/api/summary')).body

describe('before any count (BUILD_SPEC §7)', () => {
  test('summary is still 54 on site and nothing counted', async () => {
    const s = await summary()
    assert.equal(s.holders_on_site, 54)
    assert.equal(s.counted, 0)
    assert.equal(s.counted_of_opening, 0)
    assert.equal(Number(db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')), 54)
  })

  test('GET /api/locations lists the seeded locations with what is there', async () => {
    const r = await t.api('GET', '/api/locations')
    assert.equal(r.status, 200)
    assert.deepEqual(
      r.body.map((l: any) => [l.location_id, l.name, l.kind, l.counts_as_on_site]),
      [
        [1, UNASSIGNED_LOCATION, 'holding', 1],
        [2, 'Tool crib', 'crib', 1],
        [3, 'At vendor / repair', 'external', 0],
      ],
    )
    const un = r.body[0]
    assert.equal(un.holders, 54)
    assert.equal(un.articles, 54)
    assert.equal(un.is_unassigned, true)
    assert.equal(un.can_delete, false)
    assert.equal(r.body[1].can_delete, true)
  })

  test('GET /api/count/list: scopes, filters and validation', async () => {
    assert.equal((await t.api('GET', '/api/count/list')).status, 400)
    assert.equal((await t.api('GET', '/api/count/list?location_id=999')).status, 404)
    assert.equal((await t.api('GET', '/api/count/list?location_id=2&scope=nope')).status, 400)
    const site = await t.api('GET', '/api/count/list?location_id=2')
    assert.equal(site.status, 200)
    assert.equal(site.body.location.name, 'Tool crib')
    assert.equal(site.body.holders.length, 54)
    assert.equal(site.body.counted_today, 0)
    const h1 = site.body.holders.find((h: any) => h.holder_id === 'H0001')
    assert.equal(h1.qty_at_location, 0)
    assert.equal(h1.qty_unassigned, 1)
    assert.equal(h1.counted_here_today, false)
    assert.equal(h1.count_status, 'unverified')
    assert.equal(h1.manufacturer, 'HAIMER')
    assert.equal(typeof h1.dims, 'object')
    assert.equal((await t.api('GET', '/api/count/list?location_id=2&scope=all')).body.holders.length, 88)
    assert.equal((await t.api('GET', '/api/count/list?location_id=2&scope=location')).body.holders.length, 0)
    assert.equal((await t.api('GET', '/api/count/list?location_id=1&scope=location')).body.holders.length, 54)
    const haimer = await t.api('GET', '/api/count/list?location_id=2&mk=HAIMER')
    assert.equal(haimer.body.holders.reduce((s: number, h: any) => s + h.qty_on_site, 0), 37)
    const arbors = await t.api('GET', '/api/count/list?location_id=2&type=FACE_MILL_ARBOR&mk=HAIMER')
    assert.ok(arbors.body.holders.length >= 4)
    assert.ok(arbors.body.holders.every((h: any) => h.type_code === 'FACE_MILL_ARBOR' && h.manufacturer === 'HAIMER'))
  })
})

describe('physical counts', () => {
  test('first count supersedes the opening balance', async () => {
    const before = txnCount()
    const r = await t.api('POST', '/api/counts', { holder_id: 'H0001', location_id: CRIB, counted_qty: 1 })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.posted.length, 2)
    const [count, clear] = r.body.posted
    const ref = `COUNT ${today()} Tool crib`
    assert.deepEqual([count.txn_type, count.location_id, count.qty_delta, count.reference, count.by_user], ['COUNT_ADJUST', CRIB, 1, ref, 'Test User'])
    assert.deepEqual([clear.txn_type, clear.location_id, clear.qty_delta, clear.reference, clear.note], [
      'COUNT_ADJUST',
      UNASSIGNED,
      -1,
      ref,
      'opening balance superseded by physical count',
    ])
    assert.equal(count.txn_date, today())
    assert.match(count.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(txnCount(), before + 2)
    assert.equal(onSite('H0001'), 1)
    assert.equal(qtyAt('H0001', UNASSIGNED), 0)
    assert.equal(qtyAt('H0001', CRIB), 1)
    assert.equal(r.body.holder.holder_id, 'H0001')
    assert.equal(r.body.holder.count_status, 'counted')
    assert.equal(r.body.holder.qty_on_site, 1)
    assert.equal(r.body.holder.last_count_date, today())
    assert.equal(r.body.previous_qty, 0)
    const s = await summary()
    assert.equal(s.holders_on_site, 54)
    assert.equal(s.counted, 1)
    assert.equal(s.counted_of_opening, 1)
  })

  test('a retried count (same holder, location, reference, today, delta 0) posts nothing', async () => {
    const before = txnCount()
    const r = await t.api('POST', '/api/counts', { holder_id: 'H0001', location_id: CRIB, counted_qty: 1 })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.posted, [])
    assert.equal(r.body.duplicate, true)
    assert.equal(txnCount(), before)
  })

  test('a zero-delta count with a new reference is recorded once as a confirmation', async () => {
    const before = txnCount()
    const r = await t.api('POST', '/api/counts', { holder_id: 'H0001', location_id: CRIB, counted_qty: 1, reference: 'SHEET 42', note: 'second check' })
    assert.equal(r.status, 200)
    assert.equal(r.body.posted.length, 1)
    assert.equal(r.body.posted[0].qty_delta, 0)
    assert.equal(r.body.posted[0].reference, 'SHEET 42')
    assert.equal(r.body.posted[0].note, 'count confirmed, no change — second check')
    const again = await t.api('POST', '/api/counts', { holder_id: 'H0001', location_id: CRIB, counted_qty: 1, reference: 'SHEET 42' })
    assert.deepEqual(again.body.posted, [])
    assert.equal(txnCount(), before + 1)
  })

  test('a recount posts only the difference and never touches the opening balance again', async () => {
    const r = await t.api('POST', '/api/counts', { holder_id: 'H0001', location_id: CRIB, counted_qty: 3, note: 'two more found in drawer' })
    assert.equal(r.status, 200)
    assert.equal(r.body.posted.length, 1)
    assert.equal(r.body.posted[0].qty_delta, 2)
    assert.equal(r.body.posted[0].note, 'two more found in drawer')
    assert.equal(onSite('H0001'), 3)
    assert.equal(qtyAt('H0001', UNASSIGNED), 0)
    const down = await t.api('POST', '/api/counts', { holder_id: 'H0001', location_id: CRIB, counted_qty: 2 })
    assert.equal(down.body.posted[0].qty_delta, -1)
    assert.equal(onSite('H0001'), 2)
  })

  test('count 0 removes a holder from site', async () => {
    const r = await t.api('POST', '/api/counts', { holder_id: 'H0002', location_id: CRIB, counted_qty: 0 })
    assert.equal(r.status, 200)
    assert.equal(r.body.posted.length, 2)
    assert.equal(r.body.posted[0].qty_delta, 0)
    assert.equal(r.body.posted[0].note, 'count confirmed, no change')
    assert.equal(r.body.posted[1].qty_delta, -1)
    assert.equal(onSite('H0002'), 0)
    assert.equal(r.body.holder.count_status, 'counted')
    const s = await summary()
    assert.equal(s.holders_on_site, 55 - 1) // H0001 is 2 now (54 + 1), H0002 gone
    // Still in today's count list at the crib, so counting it to 0 doesn't make it vanish mid-run.
    const list = await t.api('GET', '/api/count/list?location_id=2&scope=site')
    const h2 = list.body.holders.find((h: any) => h.holder_id === 'H0002')
    assert.ok(h2)
    assert.equal(h2.counted_here_today, true)
    assert.equal(h2.qty_at_location, 0)
  })

  test('counting AT the Unassigned location does not post a supersede row', async () => {
    const r = await t.api('POST', '/api/counts', { holder_id: 'H0003', location_id: UNASSIGNED, counted_qty: 1 })
    assert.equal(r.status, 200)
    assert.equal(r.body.posted.length, 1)
    assert.equal(r.body.posted[0].location_id, UNASSIGNED)
    assert.equal(r.body.posted[0].qty_delta, 0)
    assert.equal(r.body.holder.count_status, 'counted')
    assert.equal(onSite('H0003'), 1)
  })

  test('first count of a holder booked in by receipt still clears its opening balance', async () => {
    const rec = await t.api('POST', '/api/transactions', { holder_id: 'H0004', location_id: CRIB, txn_type: 'RECEIPT', qty: 1, reference: 'PO 1001' })
    assert.equal(rec.status, 200)
    assert.equal(onSite('H0004'), 2) // opening 1 + receipt 1
    const r = await t.api('POST', '/api/counts', { holder_id: 'H0004', location_id: CRIB, counted_qty: 2 })
    assert.equal(r.body.posted.length, 2)
    assert.equal(r.body.posted[0].qty_delta, 1)
    assert.equal(r.body.posted[1].qty_delta, -1)
    assert.equal(onSite('H0004'), 2)
  })

  test('count list reflects counts at the location', async () => {
    const list = await t.api('GET', '/api/count/list?location_id=2&scope=location')
    const ids = list.body.holders.map((h: any) => h.holder_id).sort()
    assert.deepEqual(ids, ['H0001', 'H0002', 'H0004'])
    assert.equal(list.body.counted_today, 3)
    const h1 = list.body.holders.find((h: any) => h.holder_id === 'H0001')
    assert.equal(h1.qty_at_location, 2)
    assert.equal(h1.last_count_here, today())
    assert.deepEqual(h1.stock.map((s: any) => [s.location, s.qty]), [['Tool crib', 2]])
    // At Unassigned, H0001's clean-up row is not "a count here today".
    const un = await t.api('GET', '/api/count/list?location_id=1&scope=site')
    assert.equal(un.body.holders.find((h: any) => h.holder_id === 'H0001').counted_here_today, false)
    assert.equal(un.body.holders.find((h: any) => h.holder_id === 'H0003').counted_here_today, true)
  })

  test('count validation', async () => {
    const before = txnCount()
    const bad = async (body: unknown, status: number, re: RegExp, user?: string | null) => {
      const r = await t.api('POST', '/api/counts', body, { user })
      assert.equal(r.status, status, JSON.stringify(r.body))
      assert.match(r.body.error, re)
    }
    await bad({ holder_id: 'H0005', location_id: CRIB, counted_qty: 1 }, 400, /Enter your name/, null)
    await bad({ holder_id: 'H0005', location_id: CRIB }, 400, /counted_qty is required/)
    await bad({ holder_id: 'H0005', location_id: CRIB, counted_qty: -1 }, 400, /can't be negative/)
    await bad({ holder_id: 'H0005', location_id: CRIB, counted_qty: 1.5 }, 400, /whole number/)
    await bad({ holder_id: 'H0005', location_id: CRIB, counted_qty: 100000 }, 400, /typo/)
    await bad({ holder_id: 'H9999', location_id: CRIB, counted_qty: 1 }, 404, /No holder H9999/)
    await bad({ holder_id: 'H0005', location_id: 999, counted_qty: 1 }, 404, /Location 999/)
    await bad({ location_id: CRIB, counted_qty: 1 }, 400, /holder_id is required/)
    await bad({ holder_id: 'H0005', location_id: 'crib', counted_qty: 1 }, 400, /location_id must be a whole number/)
    assert.equal(txnCount(), before)
  })
})

describe('moves', () => {
  test('a move is a MOVE_OUT/MOVE_IN pair with one reference; total is conserved', async () => {
    // H0001: 2 at the crib.
    const totalBefore = Number(db().value(`SELECT SUM(qty_delta) FROM stock_transactions WHERE holder_id = 'H0001'`))
    const r = await t.api('POST', '/api/moves', { holder_id: 'H0001', from_location_id: CRIB, to_location_id: VENDOR, qty: 1, reference: 'RMA 77', note: 'regrind' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.posted.length, 2)
    const [out, inn] = r.body.posted
    assert.deepEqual([out.txn_type, out.location_id, out.qty_delta, out.reference, out.by_user], ['MOVE_OUT', CRIB, -1, 'RMA 77', 'Test User'])
    assert.deepEqual([inn.txn_type, inn.location_id, inn.qty_delta, inn.reference, inn.note], ['MOVE_IN', VENDOR, 1, 'RMA 77', 'regrind'])
    const totalAfter = Number(db().value(`SELECT SUM(qty_delta) FROM stock_transactions WHERE holder_id = 'H0001'`))
    assert.equal(totalAfter, totalBefore)
    // "At vendor / repair" doesn't count as on site.
    assert.equal(onSite('H0001'), 1)
    assert.equal(r.body.holder.qty_on_site, 1)
    const back = await t.api('POST', '/api/moves', { holder_id: 'H0001', from_location_id: VENDOR, to_location_id: CRIB, qty: 1 })
    assert.equal(back.status, 200)
    assert.match(back.body.posted[0].reference, /^MOVE \d{4}-\d{2}-\d{2} /)
    assert.equal(back.body.posted[0].reference, back.body.posted[1].reference)
    assert.equal(onSite('H0001'), 2)
  })

  test('moving out of Unassigned locates a holder without counting it', async () => {
    const r = await t.api('POST', '/api/moves', { holder_id: 'H0006', from_location_id: UNASSIGNED, to_location_id: CRIB, qty: 1 })
    assert.equal(r.status, 200)
    assert.equal(r.body.holder.count_status, 'unverified')
    assert.equal(onSite('H0006'), 1)
  })

  test("can't move more than is there, or to the same place, or into Unassigned", async () => {
    const before = txnCount()
    const more = await t.api('POST', '/api/moves', { holder_id: 'H0001', from_location_id: CRIB, to_location_id: VENDOR, qty: 5 })
    assert.equal(more.status, 409)
    assert.match(more.body.error, /Only 2 booked at Tool crib/)
    const none = await t.api('POST', '/api/moves', { holder_id: 'H0007', from_location_id: CRIB, to_location_id: VENDOR, qty: 1 })
    assert.equal(none.status, 409)
    assert.match(none.body.error, /Nothing of this holder is booked at Tool crib/)
    assert.equal((await t.api('POST', '/api/moves', { holder_id: 'H0001', from_location_id: CRIB, to_location_id: CRIB, qty: 1 })).status, 400)
    assert.equal((await t.api('POST', '/api/moves', { holder_id: 'H0001', from_location_id: CRIB, to_location_id: UNASSIGNED, qty: 1 })).status, 400)
    assert.equal((await t.api('POST', '/api/moves', { holder_id: 'H0001', from_location_id: CRIB, to_location_id: VENDOR, qty: 0 })).status, 400)
    assert.equal((await t.api('POST', '/api/moves', { holder_id: 'H0001', from_location_id: CRIB, to_location_id: VENDOR, qty: 1 }, { user: null })).status, 400)
    assert.equal(txnCount(), before)
  })
})

describe('receipts, returns and scrap', () => {
  test('receipt and return book +qty; receipt without a PO warns but books', async () => {
    const rec = await t.api('POST', '/api/transactions', {
      holder_id: 'H0060',
      location_id: CRIB,
      txn_type: 'RECEIPT',
      qty: 2,
      reference: 'PO 4500123',
      note: 'new',
      txn_date: '2026-01-15',
    })
    assert.equal(rec.status, 200, JSON.stringify(rec.body))
    assert.deepEqual(rec.body.warnings, [])
    const [row] = rec.body.posted
    assert.deepEqual([row.txn_type, row.qty_delta, row.reference, row.txn_date, row.by_user, row.location], ['RECEIPT', 2, 'PO 4500123', '2026-01-15', 'Test User', 'Tool crib'])
    assert.equal(rec.body.holder.count_status, 'booked')
    const noPo = await t.api('POST', '/api/transactions', { holder_id: 'H0060', location_id: CRIB, txn_type: 'receipt', qty: 1 })
    assert.equal(noPo.status, 200)
    assert.equal(noPo.body.warnings.length, 1)
    assert.match(noPo.body.warnings[0], /PO number/)
    const ret = await t.api('POST', '/api/transactions', { holder_id: 'H0060', location_id: CRIB, txn_type: 'RETURN', qty: 1, reference: 'Loan from Plant 2' })
    assert.equal(ret.body.posted[0].qty_delta, 1)
    assert.equal(qtyAt('H0060', CRIB), 4)
  })

  test('scrap books −qty, needs an NCR no., and cannot exceed what is there', async () => {
    const before = txnCount()
    const noNcr = await t.api('POST', '/api/transactions', { holder_id: 'H0060', location_id: CRIB, txn_type: 'SCRAP', qty: 1 })
    assert.equal(noNcr.status, 400)
    assert.match(noNcr.body.error, /NCR/)
    const tooMany = await t.api('POST', '/api/transactions', { holder_id: 'H0060', location_id: CRIB, txn_type: 'SCRAP', qty: 5, reference: 'NCR-1' })
    assert.equal(tooMany.status, 409)
    assert.match(tooMany.body.error, /Only 4 booked at Tool crib/)
    const nothing = await t.api('POST', '/api/transactions', { holder_id: 'H0060', location_id: VENDOR, txn_type: 'SCRAP', qty: 1, reference: 'NCR-1' })
    assert.equal(nothing.status, 409)
    assert.equal(txnCount(), before)
    const ok = await t.api('POST', '/api/transactions', { holder_id: 'H0060', location_id: CRIB, txn_type: 'SCRAP', qty: 1, reference: 'NCR-2026-014', note: 'cracked taper' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.posted[0].qty_delta, -1)
    assert.equal(ok.body.posted[0].txn_type, 'SCRAP')
    assert.equal(qtyAt('H0060', CRIB), 3)
  })

  test('booking validation', async () => {
    const before = txnCount()
    const post = (body: Record<string, unknown>, user?: string | null) =>
      t.api('POST', '/api/transactions', { holder_id: 'H0061', location_id: CRIB, txn_type: 'RECEIPT', qty: 1, reference: 'PO 1', ...body }, { user })
    const cases: Array<[Record<string, unknown>, number, RegExp, (string | null)?]> = [
      [{}, 400, /Enter your name/, null],
      [{ txn_type: 'COUNT_ADJUST' }, 400, /Count mode/],
      [{ txn_type: 'OPENING_BALANCE' }, 400, /Count mode/],
      [{ txn_type: 'MOVE_IN' }, 400, /moves/],
      [{ txn_type: 'GIFT' }, 400, /txn_type must be one of/],
      [{ qty: 0 }, 400, /at least 1/],
      [{ qty: -2 }, 400, /at least 1/],
      [{ qty: 1.5 }, 400, /whole number/],
      [{ qty: '' }, 400, /Quantity is required/],
      [{ qty: 10000 }, 400, /typo/],
      [{ txn_date: '2999-01-01' }, 400, /future/],
      [{ txn_date: '15/01/2026' }, 400, /YYYY-MM-DD/],
      [{ location_id: UNASSIGNED }, 400, /real location/],
      [{ location_id: 999 }, 404, /Location 999/],
      [{ holder_id: 'H9999' }, 404, /No holder/],
      [{ reference: 'x'.repeat(200) }, 400, /too long/],
    ]
    for (const [body, status, re, user] of cases) {
      const r = await post(body, user)
      assert.equal(r.status, status, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`)
      assert.match(r.body.error, re)
    }
    assert.equal(txnCount(), before)
  })
})

describe('stock on hand', () => {
  test('GET /api/stock by location and by holder', async () => {
    const crib = await t.api('GET', '/api/stock?location_id=2')
    assert.equal(crib.status, 200)
    const ids = crib.body.map((r: any) => r.holder_id)
    assert.ok(ids.includes('H0001') && ids.includes('H0060'))
    assert.ok(!ids.includes('H0002'), 'a holder counted to 0 is not listed')
    assert.ok(crib.body.every((r: any) => r.location_id === CRIB && r.qty_at_location !== 0))
    const h = await t.api('GET', '/api/stock?holder_id=H0001')
    assert.deepEqual(h.body.map((r: any) => [r.location, r.qty_at_location]), [['Tool crib', 2]])
    assert.equal(h.body[0].manufacturer, 'HAIMER')
    assert.equal((await t.api('GET', '/api/stock?location_id=999')).status, 404)
  })
})

describe('ledger', () => {
  test('newest first with names, and every filter', async () => {
    const all = await t.api('GET', '/api/transactions')
    assert.equal(all.status, 200)
    assert.ok(all.body.length > 54 && all.body.length <= 500)
    const first = all.body[0]
    for (const k of ['txn_id', 'txn_date', 'created_at', 'holder_id', 'manufacturer', 'order_no', 'location', 'txn_type', 'qty_delta', 'reference', 'by_user', 'note'])
      assert.ok(k in first, `ledger row has ${k}`)
    for (let i = 1; i < all.body.length; i++) {
      const a = all.body[i - 1]
      const b = all.body[i]
      assert.ok(a.txn_date > b.txn_date || (a.txn_date === b.txn_date && a.txn_id > b.txn_id), 'newest first')
    }
    const h1 = await t.api('GET', '/api/transactions?holder_id=H0001')
    assert.ok(h1.body.length >= 8 && h1.body.every((r: any) => r.holder_id === 'H0001'))
    const vendor = await t.api('GET', '/api/transactions?location_id=3')
    assert.deepEqual(vendor.body.map((r: any) => r.txn_type).sort(), ['MOVE_IN', 'MOVE_OUT'])
    const moves = await t.api('GET', '/api/transactions?type=MOVE_IN,MOVE_OUT')
    assert.ok(moves.body.length >= 6 && moves.body.every((r: any) => r.txn_type.startsWith('MOVE_')))
    const scrap = await t.api('GET', '/api/transactions?type=scrap')
    assert.equal(scrap.body.length, 1)
    const system = await t.api('GET', '/api/transactions?user=SYST')
    assert.equal(system.body.length, 54)
    const mine = await t.api('GET', `/api/transactions?user=${encodeURIComponent('test user')}&since=${today()}&until=${today()}`)
    assert.ok(mine.body.length > 0 && mine.body.every((r: any) => r.by_user === 'Test User' && r.txn_date === today()))
    const jan = await t.api('GET', '/api/transactions?since=2026-01-01&until=2026-01-31')
    assert.deepEqual(jan.body.map((r: any) => r.reference), ['PO 4500123'])
    const q = await t.api('GET', '/api/transactions?q=ncr-2026')
    assert.equal(q.body.length, 1)
    const q2 = await t.api('GET', `/api/transactions?q=${encodeURIComponent('haimer A63.050.16')}&type=MOVE_OUT`)
    assert.ok(q2.body.length >= 1 && q2.body.every((r: any) => r.holder_id === 'H0001'))
    const pct = await t.api('GET', '/api/transactions?q=%25')
    assert.equal(pct.body.length, 0, 'LIKE wildcards in the search are literal')
    assert.equal((await t.api('GET', '/api/transactions?limit=3')).body.length, 3)
  })

  test('ledger filter validation', async () => {
    assert.equal((await t.api('GET', '/api/transactions?since=yesterday')).status, 400)
    assert.equal((await t.api('GET', '/api/transactions?type=BOGUS')).status, 400)
    assert.equal((await t.api('GET', '/api/transactions?limit=0')).status, 400)
    assert.equal((await t.api('GET', '/api/transactions?since=2026-02-01&until=2026-01-01')).status, 400)
    assert.equal((await t.api('GET', '/api/transactions?location_id=abc')).status, 400)
  })

  test('CSV export: Excel-friendly, same filters, every row', async () => {
    const r = await t.api('GET', '/api/export/transactions.csv?holder_id=H0001')
    assert.equal(r.status, 200)
    // Response.text() drops a BOM, so check the bytes.
    const raw = Buffer.from(await (await fetch(t.base + '/api/export/transactions.csv?limit=1')).arrayBuffer())
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    assert.match(r.headers.get('content-type')!, /text\/csv/)
    assert.match(r.headers.get('content-disposition')!, /attachment; filename="stock-ledger-\d{4}-\d{2}-\d{2}\.csv"/)
    assert.ok(r.text.replace(/^\uFEFF/, '').startsWith('txn_id,txn_date,written_at,holder_id,manufacturer,order_no,location'))
    const lines = r.text.trim().split('\r\n')
    const n = (await t.api('GET', '/api/transactions?holder_id=H0001')).body.length
    assert.equal(lines.length, n + 1)
    assert.ok(lines.slice(1).every((l) => l.split(',')[3] === 'H0001'))
    const all = await t.api('GET', '/api/export/transactions.csv')
    assert.equal(all.text.trim().split('\r\n').length - 1, txnCount())
  })
})

describe('count sheet', () => {
  test('printable sheet lists the holders with boxes and a sign-off', async () => {
    const r = await t.api('GET', '/api/export/count-sheet?location_id=2')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type')!, /text\/html/)
    assert.match(r.headers.get('content-disposition')!, /^inline/)
    assert.match(r.text, /Count sheet — Tool crib/)
    assert.ok(r.text.includes(`COUNT ${today()} Tool crib`))
    // Booked at the crib, and holders not yet located (still on the opening balance).
    assert.ok(r.text.includes('A63.050.16.KKB'), 'H0001 (booked at the crib)')
    const unverified = db().value<string>(`SELECT order_no FROM holders WHERE holder_id = 'H0010'`)!
    assert.ok(r.text.includes(unverified), 'a holder still on the opening balance')
    assert.ok(r.text.includes('not located'))
    assert.ok(r.text.includes('td class="box"'))
    assert.match(r.text, /Counted by/)
    assert.match(r.text, /Checked by/)
    assert.ok(!r.text.includes(db().value<string>(`SELECT order_no FROM holders WHERE holder_id = 'H0002'`)! + '</b>'), 'H0002 was counted to 0 and is not located anywhere')
  })

  test('Unassigned lists everything on site; scope, filters and reference apply; location required', async () => {
    const un = await t.api('GET', '/api/export/count-sheet?location_id=1')
    assert.equal(un.status, 200)
    const onSiteCount = Number(db().value('SELECT COUNT(*) FROM v_stock_on_hand WHERE qty_on_site > 0'))
    assert.equal((un.text.match(/<td class="box"><\/td>/g) ?? []).length, onSiteCount + 6)
    const loc = await t.api('GET', `/api/export/count-sheet?location_id=2&scope=location&reference=${encodeURIComponent('SHEET <7>')}`)
    assert.ok(loc.text.includes('SHEET &lt;7&gt;'), 'reference is escaped')
    const atCrib = (await t.api('GET', '/api/count/list?location_id=2&scope=location')).body.holders.length
    assert.equal((loc.text.match(/<td class="box"><\/td>/g) ?? []).length, atCrib + 6)
    const all = await t.api('GET', '/api/export/count-sheet?location_id=3&scope=all&mk=MAPAL')
    assert.ok(all.text.includes('every holder in the catalogue'))
    assert.equal((await t.api('GET', '/api/export/count-sheet')).status, 400)
    assert.equal((await t.api('GET', '/api/export/count-sheet?location_id=99')).status, 404)
  })
})

describe('locations admin', () => {
  let magId = 0
  test('add a location; defaults and validation', async () => {
    const r = await t.api('POST', '/api/locations', { name: '  DMG 1   magazine ', kind: 'machine', counts_as_on_site: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.name, 'DMG 1 magazine')
    assert.equal(r.body.kind, 'machine')
    assert.equal(r.body.counts_as_on_site, 1)
    assert.equal(r.body.can_delete, true)
    magId = r.body.location_id
    const ext = await t.api('POST', '/api/locations', { name: 'Out for regrind', kind: 'external' })
    assert.equal(ext.body.counts_as_on_site, 0, 'external places default to not on site')
    assert.equal((await t.api('POST', '/api/locations', { name: 'dmg 1 MAGAZINE', kind: 'machine' })).status, 409)
    assert.equal((await t.api('POST', '/api/locations', { name: '', kind: 'crib' })).status, 400)
    assert.equal((await t.api('POST', '/api/locations', { name: 'X', kind: 'shelf' })).status, 400)
    assert.equal((await t.api('POST', '/api/locations', { name: 'Presetter', kind: 'crib' }, { user: null })).status, 400)
    assert.equal((await t.api('POST', '/api/locations', { name: 'x'.repeat(61), kind: 'crib' })).status, 400)
  })

  test('rename / change kind / on-site toggle changes the tally', async () => {
    const ren = await t.api('PATCH', `/api/locations/${magId}`, { name: 'DMG 1 tool magazine' })
    assert.equal(ren.status, 200)
    assert.equal(ren.body.name, 'DMG 1 tool magazine')
    assert.equal((await t.api('PATCH', `/api/locations/${magId}`, { name: 'Tool crib' })).status, 409)
    assert.equal((await t.api('PATCH', `/api/locations/${magId}`, { kind: 'bin' })).status, 400)
    assert.equal((await t.api('PATCH', `/api/locations/${magId}`, { kind: 'crib' }, { user: null })).status, 400)
    assert.equal((await t.api('PATCH', '/api/locations/999', { kind: 'crib' })).status, 404)
    // Book one there, then take the location off site: the site total drops by one.
    await t.api('POST', '/api/counts', { holder_id: 'H0008', location_id: magId, counted_qty: 1 })
    const before = (await summary()).holders_on_site
    const off = await t.api('PATCH', `/api/locations/${magId}`, { counts_as_on_site: false })
    assert.equal(off.body.counts_as_on_site, 0)
    assert.equal(off.body.holders, 1)
    assert.equal((await summary()).holders_on_site, before - 1)
    await t.api('PATCH', `/api/locations/${magId}`, { counts_as_on_site: true })
    assert.equal((await summary()).holders_on_site, before)
  })

  test('the Unassigned location keeps its name, stays on site, and is never deleted', async () => {
    const r = await t.api('PATCH', `/api/locations/${UNASSIGNED}`, { name: 'Somewhere' })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /keeps its name/)
    assert.equal((await t.api('PATCH', `/api/locations/${UNASSIGNED}`, { counts_as_on_site: false })).status, 400)
    assert.equal((await t.api('PATCH', `/api/locations/${UNASSIGNED}`, { name: UNASSIGNED_LOCATION })).status, 200, 'same name is not a rename')
    assert.equal((await t.api('DELETE', `/api/locations/${UNASSIGNED}`)).status, 400)
  })

  test('delete only when unused', async () => {
    const used = await t.api('DELETE', `/api/locations/${magId}`)
    assert.equal(used.status, 409)
    assert.match(used.body.error, /audit trail/)
    const fresh = await t.api('POST', '/api/locations', { name: 'Presetter', kind: 'crib' })
    assert.equal((await t.api('DELETE', `/api/locations/${fresh.body.location_id}`, undefined, { user: null })).status, 400)
    const del = await t.api('DELETE', `/api/locations/${fresh.body.location_id}`)
    assert.equal(del.status, 200)
    assert.equal(del.body.deleted, fresh.body.location_id)
    assert.ok(!(await t.api('GET', '/api/locations')).body.some((l: any) => l.name === 'Presetter'))
    assert.equal((await t.api('DELETE', `/api/locations/${fresh.body.location_id}`)).status, 404)
  })
})

test('data rules hold after all of the above: stock is the ledger sum, nothing negative, every row has a person', () => {
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE by_user IS NULL OR TRIM(by_user) = ''`)), 0)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM (SELECT SUM(qty_delta) q FROM stock_transactions GROUP BY holder_id, location_id HAVING q < 0)`)), 0)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM holders`)), 88)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM data_flags`)), 31)
})
