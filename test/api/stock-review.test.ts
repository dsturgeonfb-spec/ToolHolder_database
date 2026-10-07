/**
 * Regression tests for the stock review findings (fix/stock):
 *  - the count rule: a 0 at one location leaves a not-yet-located holder unverified and on every list;
 *    the opening balance is superseded when a count at a real location FINDS the holder (any time);
 *    counting 0 at "Unassigned – count required" writes the opening balance off.
 *  - receipts / moves are retry-safe with an Idempotency-Key.
 *  - impossible calendar dates are refused.
 *  - the count sheet honours blind count.
 *  - "too long" messages name the field.
 * Each file gets its own server with a fresh copy of the seeded database.
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestApp } from '../helpers.js'
import { today, UNASSIGNED_LOCATION } from '../../src/server/domain.js'

let t: TestApp
let DMG = 0
before(async () => {
  t = await startTestApp()
  const r = await t.api('POST', '/api/locations', { name: 'DMG 1 magazine', kind: 'machine', counts_as_on_site: true })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  DMG = r.body.location_id
})
after(async () => t.close())

const UNASSIGNED = 1
const CRIB = 2
const VENDOR = 3
const SUPERSEDE = 'opening balance superseded by physical count'

const db = () => t.app.ctx.db
const qtyAt = (holder: string, loc: number) =>
  Number(db().value('SELECT COALESCE(SUM(qty_delta),0) FROM stock_transactions WHERE holder_id = ? AND location_id = ?', [holder, loc]))
const onSite = (holder: string) => Number(db().value('SELECT qty_on_site FROM v_stock_on_hand WHERE holder_id = ?', [holder]))
const status = (holder: string) => db().value<string>('SELECT count_status FROM v_count_status WHERE holder_id = ?', [holder])
const txnCount = () => Number(db().value('SELECT COUNT(*) FROM stock_transactions'))
const count = (holder_id: string, location_id: number, counted_qty: number, extra: Record<string, unknown> = {}) =>
  t.api('POST', '/api/counts', { holder_id, location_id, counted_qty, ...extra })
const listIds = async (loc: number, scope = 'site') =>
  ((await t.api('GET', `/api/count/list?location_id=${loc}&scope=${scope}`)).body.holders as any[]).map((h) => h.holder_id)
const orderNo = (holder: string) => db().value<string>('SELECT order_no FROM holders WHERE holder_id = ?', [holder])!
const onSheet = async (loc: number, holder: string, query = '') =>
  (await t.api('GET', `/api/export/count-sheet?location_id=${loc}${query}`)).text.includes(`<b>${orderNo(holder)}</b>`)

describe('the count rule (finding: a 0 at one location wiped the opening balance)', () => {
  test('counting 0 at a real location keeps a not-yet-located holder unverified and on every list and sheet', async () => {
    const h = 'H0030'
    assert.equal(status(h), 'unverified')
    const r = await count(h, CRIB, 0)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // Only the confirmation at the crib: nothing at Unassigned.
    assert.deepEqual(
      r.body.posted.map((p: any) => [p.location_id, p.qty_delta, p.note]),
      [[CRIB, 0, 'count confirmed, no change']],
    )
    assert.equal(qtyAt(h, UNASSIGNED), 1)
    assert.equal(onSite(h), 1)
    assert.equal(r.body.holder.count_status, 'unverified')
    assert.equal(r.body.holder.qty_on_site, 1)
    // Still expected at every other location, in count mode and on the default count sheet.
    assert.ok((await listIds(DMG)).includes(h), "DMG 'Expected on site' list still has it")
    assert.ok((await listIds(VENDOR)).includes(h))
    assert.ok(await onSheet(DMG, h), 'DMG count sheet still lists it')
    assert.ok(await onSheet(CRIB, h), 'and the crib sheet too (counted 0 there today, still not located)')
    const s = (await t.api('GET', '/api/summary')).body
    assert.equal(s.holders_on_site, 54)
    assert.equal(s.counted_of_opening, 0)
    // Not in "can buy" (it is still on site somewhere).
    assert.equal(Number(db().value(`SELECT qty_on_site FROM v_stock_on_hand WHERE holder_id = ?`, [h])), 1)
  })

  test('a count that finds the holder later, at another location, supersedes the opening balance', async () => {
    const h = 'H0030'
    const r = await count(h, DMG, 1)
    assert.equal(r.status, 200)
    assert.deepEqual(
      r.body.posted.map((p: any) => [p.location_id, p.qty_delta, p.note]),
      [
        [DMG, 1, null],
        [UNASSIGNED, -1, SUPERSEDE],
      ],
    )
    assert.equal(r.body.posted[1].reference, r.body.posted[0].reference, 'the clean-up row carries the count reference')
    assert.equal(onSite(h), 1)
    assert.equal(r.body.holder.count_status, 'counted')
    assert.deepEqual(
      (await t.api('GET', `/api/stock?holder_id=${h}`)).body.map((x: any) => [x.location, x.qty_at_location]),
      [['DMG 1 magazine', 1]],
    )
  })

  test('the result does not depend on the order the locations are counted', async () => {
    // Same physical reality as above (holder in the DMG magazine), counted DMG first, then the crib.
    const h = 'H0031'
    assert.equal((await count(h, DMG, 1)).body.posted.length, 2)
    assert.equal((await count(h, CRIB, 0)).body.posted.length, 1)
    assert.equal(onSite(h), 1)
    assert.equal(status(h), 'counted')
    assert.equal(qtyAt(h, UNASSIGNED), 0)
  })

  test('a first count at Unassigned does not use up the supersede (no double count once it is found)', async () => {
    const h = 'H0032'
    const un = await count(h, UNASSIGNED, 1)
    assert.equal(un.status, 200)
    assert.deepEqual(un.body.posted.map((p: any) => [p.location_id, p.qty_delta]), [[UNASSIGNED, 0]])
    assert.equal(un.body.holder.count_status, 'unverified', '1 still not located')
    const found = await count(h, DMG, 1)
    assert.deepEqual(
      found.body.posted.map((p: any) => [p.location_id, p.qty_delta, p.note]),
      [
        [DMG, 1, null],
        [UNASSIGNED, -1, SUPERSEDE],
      ],
    )
    assert.equal(onSite(h), 1, 'one physical holder is one on site, not two')
    assert.equal(status(h), 'counted')
  })

  test('counting 0 at Unassigned writes a holder that cannot be found anywhere off the site tally', async () => {
    const h = 'H0033'
    await count(h, CRIB, 0)
    await count(h, DMG, 0)
    assert.equal(status(h), 'unverified')
    const before = (await t.api('GET', '/api/summary')).body.holders_on_site
    const r = await count(h, UNASSIGNED, 0)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.posted.map((p: any) => [p.location_id, p.qty_delta, p.txn_type]), [[UNASSIGNED, -1, 'COUNT_ADJUST']])
    assert.equal(onSite(h), 0)
    assert.notEqual(r.body.holder.count_status, 'unverified')
    assert.equal((await t.api('GET', '/api/summary')).body.holders_on_site, before - 1)
    // (DMG and the crib keep it in today's list — counted there today — but nowhere else expects it.)
    assert.ok(!(await listIds(VENDOR)).includes(h), 'written off: no longer expected on site')
    assert.ok((await listIds(DMG)).includes(h), 'counted at DMG today, so it stays in that run')
    assert.ok(!(await onSheet(DMG, h)), 'and the next DMG count sheet leaves it out')
    // A resend of the same count posts nothing.
    const again = await count(h, UNASSIGNED, 0)
    assert.deepEqual(again.body.posted, [])
    assert.equal(again.body.duplicate, true)
  })

  test('a recount that finds the holder supersedes whatever still waits at Unassigned, even after earlier counts', async () => {
    const h = 'H0034'
    // Counted 1 at the crib (supersedes), then someone books 1 "still not located" at Unassigned.
    await count(h, CRIB, 1)
    assert.equal(qtyAt(h, UNASSIGNED), 0)
    const up = await count(h, UNASSIGNED, 1)
    assert.equal(up.body.posted[0].qty_delta, 1)
    assert.equal(status(h), 'unverified')
    // It turns up in the DMG magazine: that count clears Unassigned again.
    const r = await count(h, DMG, 1)
    assert.deepEqual(r.body.posted.map((p: any) => [p.location_id, p.qty_delta]), [
      [DMG, 1],
      [UNASSIGNED, -1],
    ])
    assert.equal(onSite(h), 2)
    assert.equal(status(h), 'counted')
  })

  test('the retry rule is unchanged: a resent count posts nothing', async () => {
    const h = 'H0035'
    const a = await count(h, CRIB, 2)
    assert.equal(a.body.posted.length, 2)
    const n = txnCount()
    const b = await count(h, CRIB, 2)
    assert.deepEqual(b.body.posted, [])
    assert.equal(b.body.duplicate, true)
    const z = await count('H0036', CRIB, 0)
    assert.equal(z.body.posted.length, 1)
    const z2 = await count('H0036', CRIB, 0)
    assert.equal(z2.body.duplicate, true)
    assert.equal(txnCount(), n + 1)
  })
})

describe('receipts and moves are retry-safe (finding: a resent request booked twice)', () => {
  const send = (path: string, body: unknown, key: string) =>
    fetch(t.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'HolderCatalogue', 'X-User': 'Test User', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })

  test('the same request key books a receipt once', async () => {
    const n = txnCount()
    const body = { holder_id: 'H0011', location_id: CRIB, txn_type: 'RECEIPT', qty: 1, reference: 'PO 1' }
    const a = await send('/api/transactions', body, 'stock-test-receipt-1')
    const b = await send('/api/transactions', body, 'stock-test-receipt-1')
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(b.headers.get('idempotent-replay'), 'true')
    assert.equal(txnCount(), n + 1)
  })

  test('the same request key books a move once', async () => {
    await count('H0061', CRIB, 1)
    const n = txnCount()
    const body = { holder_id: 'H0061', from_location_id: CRIB, to_location_id: VENDOR, qty: 1, reference: 'RMA 5' }
    const a = await send('/api/moves', body, 'stock-test-move-1')
    const b = await send('/api/moves', body, 'stock-test-move-1')
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(txnCount(), n + 2)
    assert.equal(qtyAt('H0061', VENDOR), 1)
  })
})

describe('dates (finding: impossible calendar dates were accepted)', () => {
  test('a booking dated 2026-02-31 is refused; real dates (incl. 29 Feb in a leap year) are fine', async () => {
    const n = txnCount()
    for (const d of ['2026-02-31', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
      const r = await t.api('POST', '/api/transactions', { holder_id: 'H0012', location_id: CRIB, txn_type: 'RECEIPT', qty: 1, reference: 'PO 2', txn_date: d })
      assert.equal(r.status, 400, `${d} → ${JSON.stringify(r.body)}`)
      assert.match(r.body.error, /not a real date|YYYY-MM-DD/)
    }
    assert.equal(txnCount(), n)
    const ok = await t.api('POST', '/api/transactions', { holder_id: 'H0012', location_id: CRIB, txn_type: 'RECEIPT', qty: 1, reference: 'PO 2', txn_date: '2024-02-29' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.posted[0].txn_date, '2024-02-29')
  })

  test('ledger filters refuse impossible dates too', async () => {
    const r = await t.api('GET', '/api/transactions?since=2026-02-30')
    assert.equal(r.status, 400)
    assert.match(r.body.error, /since/)
    assert.equal((await t.api('GET', '/api/transactions?until=2026-06-31')).status, 400)
    assert.equal((await t.api('GET', '/api/export/transactions.csv?since=2026-02-30')).status, 400)
  })
})

describe('count sheet (finding: blind count still printed the booked quantities)', () => {
  test('blind=1 leaves out the booked quantities and the "not located" hint; the normal sheet keeps them', async () => {
    await count('H0040', CRIB, 3)
    const normal = (await t.api('GET', `/api/export/count-sheet?location_id=${CRIB}`)).text
    assert.match(normal, /<th class="n">Booked here<\/th>/)
    assert.ok(normal.includes('not located'))
    const blind = await t.api('GET', `/api/export/count-sheet?location_id=${CRIB}&blind=1`)
    assert.equal(blind.status, 200)
    assert.doesNotMatch(blind.text, /Booked here/)
    assert.ok(!blind.text.includes('not located'), 'no hint that a holder is still on the opening balance')
    assert.match(blind.text, /Blind count/)
    // Same holders on both sheets (the blind one just hides the quantities).
    assert.ok(blind.text.includes(`<b>${orderNo('H0040')}</b>`))
    assert.ok(blind.text.includes(`<b>${orderNo('H0041')}</b>`), 'a holder not yet located is still listed')
    const rows = (s: string) => (s.match(/<td class="box"><\/td>/g) ?? []).length
    assert.equal(rows(blind.text), rows(normal))
    // The 3 booked at the crib for H0040 is not printed: every row has one cell fewer (no "Booked here" cell).
    const rowFor = (s: string, h: string) => s.split('<tr>').find((r) => r.includes(`<b>${orderNo(h)}</b>`))!
    assert.equal((rowFor(blind.text, 'H0040').match(/<td/g) ?? []).length, (rowFor(normal, 'H0040').match(/<td/g) ?? []).length - 1)
    assert.ok(!rowFor(blind.text, 'H0040').includes('>3<'))
    assert.equal((await t.api('GET', `/api/export/count-sheet?location_id=${CRIB}&blind=maybe`)).status, 400)
  })

  test('the sheet explains what a 0 means', async () => {
    const crib = (await t.api('GET', `/api/export/count-sheet?location_id=${CRIB}`)).text
    assert.match(crib, /stays on the other sheets until it is found/)
    const un = (await t.api('GET', `/api/export/count-sheet?location_id=${UNASSIGNED}`)).text
    assert.match(un, /still not located/)
    assert.match(un, /0 writes the opening balance off/)
    assert.ok(un.includes(UNASSIGNED_LOCATION))
  })
})

describe('messages name the field (optStr labels)', () => {
  test('a too-long reference or note says which field', async () => {
    const r = await t.api('POST', '/api/transactions', { holder_id: 'H0013', location_id: CRIB, txn_type: 'RECEIPT', qty: 1, reference: 'x'.repeat(121) })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /^Reference is too long \(at most 120 characters\)/)
    const n = await t.api('POST', '/api/moves', { holder_id: 'H0013', from_location_id: CRIB, to_location_id: VENDOR, qty: 1, note: 'x'.repeat(1001) })
    assert.match(n.body.error, /^Note is too long/)
    const c = await count('H0013', CRIB, 1, { reference: 'x'.repeat(121) })
    assert.match(c.body.error, /^Count sheet reference is too long/)
    const q = await t.api('GET', `/api/transactions?q=${'x'.repeat(201)}`)
    assert.match(q.body.error, /^Search text is too long/)
  })
})

test('data rules hold: no negative stock anywhere, every row has a person, today is the date of every count', () => {
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM (SELECT SUM(qty_delta) q FROM stock_transactions GROUP BY holder_id, location_id HAVING q < 0)`)), 0)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE by_user IS NULL OR TRIM(by_user) = ''`)), 0)
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE txn_type = 'COUNT_ADJUST' AND txn_date <> ?`, [today()])), 0)
})
