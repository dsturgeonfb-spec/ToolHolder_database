import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Request } from 'playwright-core'
import { startE2E, type E2E } from './helpers.js'
import { today } from '../../src/server/domain.js'
import { addDays } from '../../src/server/modules/units.js'

let e: E2E
before(async () => (e = await startE2E()))
after(async () => e.close())

const db = () => e.t.app.ctx.db
const dlg = 'dialog.dlg[open]'
const wish = (holderId: string) => db().get<any>(`SELECT * FROM wishlist WHERE holder_id = ? ORDER BY wish_id DESC LIMIT 1`, [holderId])
const unit = (id: string) => db().get<any>(`SELECT * FROM holder_units WHERE unit_id = ?`, [id])
/** Polls the database until `fn` is true (the UI writes asynchronously). */
async function until(fn: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const row = (holderId: string) => `.wl-row[data-id="${wish(holderId)!.wish_id}"]`

// ------------------------------------------------------------------ want list

test('empty want list points to Catalogue → Can buy; RFQ exports are disabled', async () => {
  await e.goto('#/want')
  await e.page.waitForSelector('.wl-empty')
  assert.match((await e.page.textContent('.wl-empty'))!, /Nothing on the want list yet/)
  assert.equal(await e.page.getAttribute('.wl-empty a', 'href'), '#/catalogue?scope=cat')
  assert.equal(await e.page.isDisabled('[data-act="csv"]'), true)
  assert.equal(await e.page.isDisabled('[data-act="xlsx"]'), true)
  assert.deepEqual(e.errors, [])
})

test('Catalogue → Can buy → Want on a MAPAL holder: dialog validates, posts, and the button shows the quantity', async () => {
  await e.goto('#/catalogue?scope=cat&mk=MAPAL')
  const want = '[data-row="H0060"] [data-act="want"]'
  await e.page.waitForSelector(want)
  await e.page.click(want)
  await e.page.waitForSelector(`${dlg} form`)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Add to want list')
  assert.match((await e.page.textContent(`${dlg} .wl-dlg`))!, /MAPAL 31396171[\s\S]*None on site now/)
  await e.page.fill(`${dlg} input[name="qty_wanted"]`, '0')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
  assert.match((await e.page.textContent(`${dlg} [data-err]`))!, /whole number from 1 to 999/)
  await e.page.fill(`${dlg} input[name="qty_wanted"]`, '2')
  await e.page.fill(`${dlg} textarea[name="reason"]`, 'Job 4711 needs Ø32 at 110 GL')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  await e.page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('Wanted · 2'), want)
  const w = wish('H0060')!
  assert.equal(w.qty_wanted, 2)
  assert.equal(w.status, 'OPEN')
  assert.equal(w.added_by, 'E2E Tester')
  assert.equal(w.reason, 'Job 4711 needs Ø32 at 110 GL')
  assert.deepEqual(e.errors, [])
})

test('Want list: grouped by maker, purchasing note shown, qty and status edits saved', async () => {
  // 30524702 carries the seeded MAPAL "also lists another order no." Purchasing flag.
  await e.t.api('POST', '/api/wishlist', { holder_id: 'H0018', qty_wanted: 1, reason: 'Second HTC' })
  await e.t.api('POST', '/api/wishlist', { holder_id: 'H0006', qty_wanted: 3, reason: 'ER16 spares' })
  await e.goto('#/want')
  await e.page.waitForSelector('.wl-group')
  assert.deepEqual(await e.page.$$eval('.wl-group', (els) => els.map((x) => (x as HTMLElement).dataset.maker)), ['HAIMER', 'MAPAL'])
  assert.match((await e.page.textContent(`${row('H0018')} .wl-note`))!, /MAPAL shop also lists 30655666/)
  assert.equal(await e.page.getAttribute(`${row('H0060')} a.ord`, 'href'), '#/holder/H0060')
  assert.match((await e.page.textContent('[data-count]'))!, /3 open lines · 6 holders to quote from 2 makers/)
  assert.equal(await e.page.isDisabled('[data-act="csv"]'), false)

  await e.page.fill(`${row('H0060')} input[data-f="qty"]`, '4')
  await e.page.press(`${row('H0060')} input[data-f="qty"]`, 'Enter')
  await until(() => wish('H0060')!.qty_wanted === 4, 'qty saved')
  assert.equal(wish('H0060')!.updated_on, today())

  await e.page.selectOption(`${row('H0006')} select[data-f="status"]`, 'QUOTED')
  await until(() => wish('H0006')!.status === 'QUOTED', 'status saved')
  await e.page.waitForFunction(() => document.querySelector('.wl-group[data-maker="HAIMER"] [data-act="print"]')?.hasAttribute('disabled'))
  assert.deepEqual(e.errors, [])
})

test('Print RFQ opens the printable MAPAL RFQ with the order nos and the purchasing note', async () => {
  await e.goto('#/want')
  await e.page.waitForSelector('.wl-group[data-maker="MAPAL"] [data-act="print"]:not([disabled])')
  const popup = e.page.context().waitForEvent('page')
  await e.page.click('.wl-group[data-maker="MAPAL"] [data-act="print"]')
  const p = await popup
  await p.waitForLoadState()
  assert.match(p.url(), /\/api\/export\/rfq\.html\?maker=MAPAL(&by=[^&]+)?$/)
  const text = (await p.textContent('body'))!
  assert.match(text, /Request for quotation — MAPAL/)
  assert.ok(text.includes('31396171') && text.includes('30524702'))
  assert.match(text, /MAPAL shop also lists 30655666/)
  assert.ok(!text.includes('A63.020.16'), 'HAIMER line is not on the MAPAL RFQ')
  await p.close()
  assert.deepEqual(e.errors, [])
})

test('RFQ CSV button downloads the export', async () => {
  await e.goto('#/want')
  await e.page.waitForSelector('[data-act="csv"]:not([disabled])')
  const dl = e.page.waitForEvent('download')
  await e.page.click('[data-act="csv"]')
  const d = await dl
  assert.match(d.suggestedFilename(), new RegExp(`^rfq_${today()}\\.csv$`))
  assert.deepEqual(e.errors, [])
})

test('Add a holder: search picker shows can-buy holders, picks one, adds it', async () => {
  await e.goto('#/want')
  await e.page.click('[data-act="add"]')
  await e.page.waitForSelector('.wl-pick-item')
  await e.page.fill('.wl-pick [data-q]', '31229439')
  await e.page.waitForFunction(() => document.querySelectorAll('.wl-pick-item').length === 1)
  assert.match((await e.page.textContent('.wl-pick-item'))!, /MAPAL 31229439[\s\S]*Can buy/)
  await e.page.click('.wl-pick [data-pick="H0070"]')
  await e.page.waitForSelector(`${dlg} form`)
  await e.page.fill(`${dlg} textarea[name="reason"]`, 'Job 5120')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  await until(() => wish('H0070')?.status === 'OPEN', 'line added')
  await e.page.waitForSelector(row('H0070'))
  assert.deepEqual(e.errors, [])
})

test('marking a line RECEIVED offers the receipt booking; the receipt goes through the stock ledger', async () => {
  await e.goto('#/want')
  await e.page.waitForSelector(row('H0060'))
  const txns = () => Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = 'H0060'`))
  assert.equal(txns(), 0)
  await e.page.selectOption(`${row('H0060')} select[data-f="status"]`, 'RECEIVED')
  await e.page.waitForSelector(`${dlg} [data-ok]`)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Book the receipt now?')
  assert.equal(wish('H0060')!.status, 'RECEIVED')
  assert.equal(txns(), 0, 'marking RECEIVED alone books nothing')
  await e.page.click(`${dlg} [data-ok]`)
  await e.page.waitForSelector(`${dlg} form input[name="reference"]`)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Book a receipt')
  await e.page.fill(`${dlg} input[name="qty"]`, '4')
  await e.page.fill(`${dlg} input[name="reference"]`, 'PO 4500123')
  await e.page.click(`${dlg} button[type=submit]`)
  await until(() => txns() === 1, 'receipt booked')
  const t = db().get<any>(`SELECT * FROM stock_transactions WHERE holder_id = 'H0060'`)!
  assert.equal(t.txn_type, 'RECEIPT')
  assert.equal(t.qty_delta, 4)
  assert.equal(t.reference, 'PO 4500123')
  assert.equal(t.by_user, 'E2E Tester')
  await e.page.waitForFunction(() => document.getElementById('tTotal')?.textContent === '58')
  // Received lines leave "Still wanted" and show under Received with a link to book (more) receipts.
  await e.page.waitForSelector(row('H0060'), { state: 'detached' })
  await e.page.click('.wl-seg [data-status="RECEIVED"]')
  await e.page.waitForSelector(`${row('H0060')} [data-act="receipt"]`)
  assert.equal(await e.page.isDisabled(`${row('H0060')} input[data-f="qty"]`), true)
  assert.match(await e.page.evaluate(() => location.hash), /status=RECEIVED/)
  assert.deepEqual(e.errors, [])
})

test('cancelling a line asks first and keeps it as CANCELLED', async () => {
  await e.goto('#/want')
  await e.page.waitForSelector(row('H0070'))
  await e.page.selectOption(`${row('H0070')} select[data-f="status"]`, 'CANCELLED')
  await e.page.waitForSelector(`${dlg} [data-ok]`)
  await e.page.click(`${dlg} [data-close].btn`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  // The select is put back once the dialog's close event (a queued task) has run.
  await e.page.waitForFunction((sel) => (document.querySelector(sel) as HTMLSelectElement | null)?.value === 'OPEN', `${row('H0070')} select[data-f="status"]`)
  assert.equal(wish('H0070')!.status, 'OPEN', 'declining leaves it open')
  await e.page.selectOption(`${row('H0070')} select[data-f="status"]`, 'CANCELLED')
  await e.page.click(`${dlg} [data-ok]`)
  await until(() => wish('H0070')!.status === 'CANCELLED', 'cancelled')
  await e.page.waitForSelector(row('H0070'), { state: 'detached' })
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM wishlist WHERE holder_id = 'H0070'`)), 1, 'row kept')
  assert.deepEqual(e.errors, [])
})

const openLine = (holderId: string) => db().get<any>(`SELECT * FROM wishlist WHERE holder_id = ? AND status = 'OPEN'`, [holderId])
const MAPAL_WANT = '[data-row="H0070"] [data-act="want"]'

test('the want dialog says what an add will do: a new line when the existing one is ordered, a top-up of an open line', async () => {
  // H0070's earlier line was cancelled; a new one is ordered, so nothing open is left to top up.
  const first = await e.t.api('POST', '/api/wishlist', { holder_id: 'H0070', qty_wanted: 2, reason: 'Job 5120' })
  assert.equal(first.status, 201)
  assert.equal((await e.t.api('PATCH', `/api/wishlist/${first.body.wish_id}`, { status: 'ORDERED' })).status, 200)
  await e.goto('#/catalogue?scope=cat&mk=MAPAL')
  await e.page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('Wanted · 2'), MAPAL_WANT)
  await e.page.click(MAPAL_WANT)
  await e.page.waitForSelector(`${dlg} form`)
  let text = (await e.page.textContent(`${dlg} .wl-dlg`))!
  assert.match(text, /2 already ordered — this starts a new line/)
  assert.doesNotMatch(text, /added to/)
  // Over-long reasons stop in the form (the server allows 1000 characters).
  assert.equal(await e.page.getAttribute(`${dlg} textarea[name="reason"]`, 'maxlength'), '1000')
  await e.page.fill(`${dlg} input[name="qty_wanted"]`, '1')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  await until(() => openLine('H0070')?.qty_wanted === 1, 'a new open line')
  assert.equal(db().value(`SELECT qty_wanted FROM wishlist WHERE wish_id = ?`, [first.body.wish_id]), 2, 'the ordered line is unchanged')

  // Now there is an open line: the next add goes onto it.
  await e.page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('Wanted · 3'), MAPAL_WANT)
  await e.page.click(MAPAL_WANT)
  await e.page.waitForSelector(`${dlg} form`)
  text = (await e.page.textContent(`${dlg} .wl-dlg`))!
  assert.match(text, /1 already on its open line — this quantity is added to it/)
  assert.match(text, /2 more already ordered/)
  await e.page.click(`${dlg} [data-close].btn`)
  await e.page.waitForSelector(dlg, { state: 'detached' })

  // From the holder page (the wishlist rows come with the holder): H0006's only line is QUOTED.
  await e.goto('#/holder/H0006')
  await e.page.click('[data-act="want"] >> nth=0')
  await e.page.waitForSelector(`${dlg} form`)
  text = (await e.page.textContent(`${dlg} .wl-dlg`))!
  assert.match(text, /3 already quoted — this starts a new line/)
  await e.page.click(`${dlg} [data-close].btn`)
  assert.deepEqual(e.errors, [])
})

test('the want dialog sends one request key for all its attempts, so a resent add is not booked twice', async () => {
  const line = openLine('H0070')!
  assert.equal((await e.t.api('PATCH', `/api/wishlist/${line.wish_id}`, { qty_wanted: 998 })).status, 200)
  await e.goto('#/catalogue?scope=cat&mk=MAPAL&q=31229439')
  await e.page.waitForSelector(MAPAL_WANT)
  const keys: string[] = []
  const onRequest = (r: Request) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/wishlist') keys.push(r.headers()['idempotency-key'] ?? '')
  }
  e.page.on('request', onRequest)
  try {
    await e.page.click(MAPAL_WANT)
    await e.page.waitForSelector(`${dlg} form`)
    // The first attempt is refused by the server (999 is the most on one line); the second one goes through.
    await e.page.fill(`${dlg} input[name="qty_wanted"]`, '5')
    await e.page.click(`${dlg} button[type=submit]`)
    await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
    assert.match((await e.page.textContent(`${dlg} [data-err]`))!, /That would make 1003 wanted/)
    await e.page.fill(`${dlg} input[name="qty_wanted"]`, '1')
    await e.page.click(`${dlg} button[type=submit]`)
    await e.page.waitForSelector(dlg, { state: 'detached' })
  } finally {
    e.page.off('request', onRequest)
  }
  await until(() => openLine('H0070')?.qty_wanted === 999, 'topped up')
  assert.equal(keys.length, 2)
  assert.match(keys[0]!, /^[0-9a-f]{32}$/)
  assert.equal(keys[1], keys[0], 'the same key on every attempt from one dialog')
  // The answer to the second attempt is "lost" and it is sent again: the first result comes back, nothing is added.
  const resend = await fetch(`${e.t.base}/api/wishlist`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'HolderCatalogue', 'X-User': 'E2E Tester', 'Content-Type': 'application/json', 'Idempotency-Key': keys[0]! },
    body: JSON.stringify({ holder_id: 'H0070', qty_wanted: 1 }),
  })
  assert.equal(resend.status, 200)
  assert.equal(resend.headers.get('idempotent-replay'), 'true')
  assert.equal(openLine('H0070')!.qty_wanted, 999)
  // Chromium logs the refused first attempt; nothing else may have gone wrong.
  assert.deepEqual(e.errors, ['console: Failed to load resource: the server responded with a status of 400 (Bad Request)'])
  e.errors.length = 0
})

// ------------------------------------------------------------------ serialised units

test('Serialised: empty state, add a unit through the holder picker, duplicate id refused in the dialog', async () => {
  await e.goto('#/units')
  await e.page.waitForSelector('.un-empty')
  assert.match((await e.page.textContent('.un-empty'))!, /No serialised units yet/)
  await e.page.click('[data-act="add"]')
  await e.page.waitForSelector('.wl-pick-item')
  assert.equal(await e.page.getAttribute('.wl-pick [data-scope="site"]', 'aria-pressed'), 'true', 'on-site holders first')
  await e.page.fill('.wl-pick [data-q]', 'A63.144.12.3')
  await e.page.waitForFunction(() => document.querySelectorAll('.wl-pick-item').length === 1)
  await e.page.click('.wl-pick [data-pick="H0033"]')
  await e.page.waitForSelector(`${dlg} form input[name="unit_id"]`)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Add serialised unit')
  await e.page.fill(`${dlg} input[name="unit_id"]`, ' U-0001 ')
  await e.page.fill(`${dlg} input[name="serial_no"]`, 'HMR-77812')
  await e.page.selectOption(`${dlg} select[name="location_id"]`, { label: 'Tool crib' })
  await e.page.fill(`${dlg} input[name="runout_check_um"]`, '2.5')
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Balanced G2.5, cert 1234')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  await e.page.waitForSelector('.un-row[data-id="U-0001"]')
  const u = unit('U-0001')!
  assert.equal(u.holder_id, 'H0033')
  assert.equal(u.serial_no, 'HMR-77812')
  assert.equal(u.location_id, 2)
  assert.equal(u.runout_check_um, 2.5)
  assert.equal(u.status, 'IN_SERVICE')
  assert.match(u.note, /E2E Tester: Added/)
  assert.match((await e.page.textContent('.un-row[data-id="U-0001"]'))!, /Never inspected/)

  // Same number again: the server's 409 is shown in the dialog, which stays open.
  await e.page.click('[data-act="add"]')
  await e.page.fill('.wl-pick [data-q]', 'A63.144.12')
  await e.page.waitForSelector('.wl-pick [data-pick="H0038"]')
  await e.page.click('.wl-pick [data-pick="H0038"]')
  await e.page.waitForSelector(`${dlg} form input[name="unit_id"]`)
  await e.page.fill(`${dlg} input[name="unit_id"]`, 'u-0001')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
  assert.match((await e.page.textContent(`${dlg} [data-err]`))!, /Unit id U-0001 is already used/)
  await e.page.click(`${dlg} [data-close].btn`)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holder_units')), 1)
  // Chromium logs every non-2xx response; this 409 was the point of the step, nothing else may have gone wrong.
  assert.deepEqual(e.errors, ['console: Failed to load resource: the server responded with a status of 409 (Conflict)'])
  e.errors.length = 0
})

test('failing an inspection quarantines the unit; passing it again offers the return to service', async () => {
  await e.goto('#/units')
  await e.page.click('.un-row[data-id="U-0001"] [data-act="inspect"]')
  await e.page.waitForSelector(`${dlg} form`)
  await e.page.fill(`${dlg} input[name="runout_check_um"]`, '12')
  await e.page.selectOption(`${dlg} select[name="result"]`, 'fail')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
  assert.match((await e.page.textContent(`${dlg} [data-err]`))!, /Say what failed/)
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Taper fretting, 12 µm at 50 mm')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  await until(() => unit('U-0001')!.status === 'QUARANTINE', 'quarantined')
  const u = unit('U-0001')!
  assert.equal(u.last_inspected, today())
  assert.equal(u.inspected_by, 'E2E Tester')
  assert.equal(u.runout_check_um, 12)
  await e.page.waitForFunction(() => /Quarantine/.test(document.querySelector('.un-row[data-id="U-0001"]')?.textContent || ''))
  assert.match((await e.page.textContent('.un-sum'))!, /1 in quarantine/)

  // Re-ground and passed: the status dialog opens with "In service" preselected; the note is required.
  await e.page.click('.un-row[data-id="U-0001"] [data-act="inspect"]')
  await e.page.waitForSelector(`${dlg} form`)
  await e.page.fill(`${dlg} input[name="runout_check_um"]`, '2')
  await e.page.selectOption(`${dlg} select[name="result"]`, 'pass')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} select[name="status"]`)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Change unit status')
  assert.equal(await e.page.inputValue(`${dlg} select[name="status"]`), 'IN_SERVICE')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Re-ground taper, runout 2 µm')
  await e.page.click(`${dlg} button[type=submit]`)
  await until(() => unit('U-0001')!.status === 'IN_SERVICE', 'back in service')
  // The log shows every step, newest last.
  await e.page.click('.un-row[data-id="U-0001"] [data-act="log"]')
  await e.page.waitForSelector('.un-log li:nth-child(4)')
  const log = await e.page.$$eval('.un-log li', (els) => els.map((x) => x.textContent!.trim()))
  assert.equal(log.length, 4)
  assert.match(log[1]!, /FAILED — quarantined\. Taper fretting/)
  assert.match(log[3]!, /Status quarantine → in service: Re-ground taper/)
  assert.deepEqual(e.errors, [])
})

test('overdue units are highlighted and the due filters find them', async () => {
  await e.t.api('POST', '/api/units', { unit_id: 'U-0002', holder_id: 'H0038', last_inspected: addDays(today(), -200) })
  await e.t.api('POST', '/api/units', { unit_id: 'U-0003', holder_id: 'H0006', last_inspected: addDays(today(), -10) })
  // A different hash from the previous test's, so the view renders again and reads the new units.
  await e.goto('#/units?status=all')
  await e.page.waitForSelector('.un-row[data-id="U-0002"].due-overdue')
  assert.match((await e.page.textContent('.un-row[data-id="U-0002"]'))!, /20 days overdue/)
  assert.equal(await e.page.$('.un-row[data-id="U-0003"].due-overdue'), null)
  await e.page.selectOption('[data-f="due"]', 'overdue')
  await e.page.waitForFunction(() => document.querySelectorAll('.un-row').length === 1)
  assert.match(await e.page.evaluate(() => location.hash), /due=overdue/)
  await e.page.selectOption('[data-f="due"]', '')
  await e.page.fill('[data-f="q"]', 'HMR-778')
  await e.page.waitForFunction(() => document.querySelectorAll('.un-row').length === 1 && !!document.querySelector('.un-row[data-id="U-0001"]'))
  assert.deepEqual(e.errors, [])
})

test('Edit… on a unit: change where it is kept and the serial no., add a remark — all in its log, stock untouched', async () => {
  const loc = await e.t.api('POST', '/api/locations', { name: 'DMG 1 magazine', kind: 'machine', counts_as_on_site: true })
  assert.ok(loc.status < 300, JSON.stringify(loc.body))
  const dmg = Number(db().value(`SELECT location_id FROM locations WHERE name = 'DMG 1 magazine'`))
  const txns = Number(db().value('SELECT COUNT(*) FROM stock_transactions'))
  await e.goto('#/units?q=U-0001')
  await e.page.click('.un-row[data-id="U-0001"] [data-act="edit"]')
  await e.page.waitForSelector(`${dlg} form select[name="location_id"]`)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Edit serialised unit')
  assert.equal(await e.page.inputValue(`${dlg} select[name="location_id"]`), '2', 'starts at its current location (Tool crib)')
  assert.equal(await e.page.inputValue(`${dlg} input[name="serial_no"]`), 'HMR-77812')
  assert.equal(await e.page.getAttribute(`${dlg} input[name="serial_no"]`, 'maxlength'), '80')
  assert.equal(await e.page.getAttribute(`${dlg} textarea[name="note"]`, 'maxlength'), '2000')
  // Nothing changed: said in the dialog, nothing sent.
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
  assert.match((await e.page.textContent(`${dlg} [data-err]`))!, /Nothing to save/)
  await e.page.selectOption(`${dlg} select[name="location_id"]`, String(dmg))
  await e.page.fill(`${dlg} input[name="serial_no"]`, 'HMR-77813')
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Serial misread, checked against cert 1234')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  await until(() => unit('U-0001')!.location_id === dmg, 'unit moved')
  const u = unit('U-0001')!
  assert.equal(u.serial_no, 'HMR-77813')
  assert.match(u.note, /E2E Tester: Edited: serial no\. "HMR-77812" → "HMR-77813"; location Tool crib → DMG 1 magazine\. Note: Serial misread, checked against cert 1234$/)
  await e.page.waitForFunction(() => /DMG 1 magazine/.test(document.querySelector('.un-row[data-id="U-0001"]')?.textContent || ''))
  assert.equal(db().value(`SELECT by_user FROM audit_events WHERE entity = 'unit' AND entity_id = 'U-0001' AND action = 'EDIT' ORDER BY rowid DESC LIMIT 1`), 'E2E Tester')
  assert.equal(Number(db().value('SELECT COUNT(*) FROM stock_transactions')), txns, 'editing a unit books nothing')
  assert.deepEqual(e.errors, [])
})

test('scrapping a unit preselects its own location in "Book scrap", not where most stock is', async () => {
  const dmg = Number(db().value(`SELECT location_id FROM locations WHERE name = 'DMG 1 magazine'`))
  // H0012: 3 counted at the Tool crib, 1 of them moved into the DMG 1 magazine — the unit is that one.
  assert.equal((await e.t.api('POST', '/api/counts', { holder_id: 'H0012', location_id: 2, counted_qty: 3 })).status, 200)
  assert.equal((await e.t.api('POST', '/api/moves', { holder_id: 'H0012', from_location_id: 2, to_location_id: dmg, qty: 1 })).status, 200)
  assert.equal((await e.t.api('POST', '/api/units', { unit_id: 'U-SCRAP', holder_id: 'H0012', location_id: dmg })).status, 201)
  const at = (loc: number) => Number(db().value(`SELECT COALESCE(SUM(qty_delta), 0) FROM stock_transactions WHERE holder_id = 'H0012' AND location_id = ?`, [loc]))
  await e.goto('#/units?q=U-SCRAP')
  await e.page.click('.un-row[data-id="U-SCRAP"] [data-act="status"]')
  await e.page.waitForSelector(`${dlg} select[name="status"]`)
  await e.page.selectOption(`${dlg} select[name="status"]`, 'SCRAPPED')
  await e.page.fill(`${dlg} textarea[name="note"]`, 'NCR-2026-099 taper cracked')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-ok]`)
  assert.equal(await e.page.textContent(`${dlg} [data-ok]`), 'Book scrap now')
  await e.page.click(`${dlg} [data-ok]`)
  await e.page.waitForSelector(`${dlg} form input[name="reference"]`)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Scrap a holder')
  assert.equal(await e.page.inputValue(`${dlg} select[name="location_id"]`), String(dmg), 'the unit’s location, not the Tool crib (2 there)')
  await e.page.fill(`${dlg} input[name="reference"]`, 'NCR-2026-099')
  await e.page.click(`${dlg} button[type=submit]`)
  await until(() => at(dmg) === 0, 'scrap booked at the DMG 1 magazine')
  assert.equal(at(2), 2, 'Tool crib untouched')
  assert.equal(unit('U-SCRAP')!.status, 'SCRAPPED')
  assert.deepEqual(e.errors, [])
})

test('tablet width (800 px): both views fit without sideways scrolling', async () => {
  await e.page.setViewportSize({ width: 800, height: 1000 })
  try {
    for (const v of ['#/want?status=all', '#/units']) {
      await e.goto(v)
      await e.page.waitForSelector(v.startsWith('#/want') ? '.wl-row' : '.un-row')
      const [sw, iw] = await e.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth])
      assert.ok(sw <= iw, `${v}: page is ${sw}px wide in a ${iw}px window`)
    }
  } finally {
    await e.page.setViewportSize({ width: 1280, height: 900 })
  }
  assert.deepEqual(e.errors, [])
})
