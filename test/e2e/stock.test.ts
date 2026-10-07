import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startE2E, type E2E } from './helpers.js'

let e: E2E
before(async () => (e = await startE2E()))
after(async () => e.close())

const CRIB = 2
const VENDOR = 3
const db = () => e.t.app.ctx.db
const qtyAt = (holder: string, loc: number) =>
  Number(db().value('SELECT COALESCE(SUM(qty_delta),0) FROM stock_transactions WHERE holder_id = ? AND location_id = ?', [holder, loc]))
const countRows = (holder: string, loc: number) =>
  Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = ? AND location_id = ? AND txn_type = 'COUNT_ADJUST'`, [holder, loc]))
const txnTotal = () => Number(db().value('SELECT COUNT(*) FROM stock_transactions'))
/** Opens a stock dialog the way the holder page does (the holder view may still be a stub in this branch). */
async function openAction(kind: string, holder: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  await e.page.evaluate(
    async ({ kind, holder, opts, url }) => {
      const m = await import(url)
      ;(window as any).__sa = m.openStockAction(kind, holder, opts)
    },
    { kind, holder, opts, url: '/ui/js/components/stock-actions.js' },
  )
}
const holderIdOf = (orderNo: string) => db().value<string>('SELECT holder_id FROM holders WHERE order_no = ?', [orderNo])!

/** The 4xx answers a test provokes on purpose show up as console errors ("Failed to load resource"). */
const unexpectedErrors = (allowed: RegExp[] = []) => e.errors.filter((m) => !allowed.some((re) => re.test(m)))

async function currentOrderNo() {
  return (await e.page.textContent('.cm-ord'))!.trim()
}
async function waitProgress(n: number) {
  await e.page.waitForFunction((n) => document.querySelector('[data-progress]')?.textContent?.startsWith(`${n} of`), n)
}

test('count mode: pick a location, count three holders with keyboard and buttons', async () => {
  const p = e.page
  await e.goto('#/count')
  await p.waitForSelector('.cm-loc')
  // Pick the tool crib and the default "expected on site" list.
  await p.click(`.cm-loc[data-loc="${CRIB}"]`)
  await p.waitForFunction(() => /54 holders in the list/.test(document.querySelector('[data-preview]')!.textContent!))
  await p.click('[data-act=start]')
  await p.waitForSelector('.cm-ord')
  assert.match((await p.textContent('.cm-where'))!, /Tool crib/)
  await waitProgress(0)

  // 1) Keyboard: type 2, Enter.
  const first = await currentOrderNo()
  const firstId = holderIdOf(first)
  await p.keyboard.press('2')
  assert.equal(await p.inputValue('[data-qty]'), '2')
  await p.keyboard.press('Enter')
  await waitProgress(1)
  assert.notEqual(await currentOrderNo(), first, 'moved on to the next holder')
  assert.equal(qtyAt(firstId, CRIB), 2)
  assert.equal(qtyAt(firstId, 1), 0, 'opening balance superseded')

  // 2) Buttons: rapid + / − only change the number on screen; one confirm posts one count.
  const second = await currentOrderNo()
  const secondId = holderIdOf(second)
  const before = txnTotal()
  for (let i = 0; i < 4; i++) await p.click('[data-act=inc]') // expected 1 → 5
  await p.click('[data-act=dec]')
  await p.click('[data-act=dec]') // → 3
  assert.equal(await p.inputValue('[data-qty]'), '3')
  assert.match((await p.textContent('[data-hint]'))!, /Books \+3 at Tool crib/)
  assert.equal(txnTotal(), before, 'nothing posted before Confirm')
  await p.click('[data-act=confirm]')
  await waitProgress(2)
  assert.equal(qtyAt(secondId, CRIB), 3)
  assert.equal(countRows(secondId, CRIB), 1)

  // 3) Arrow keys navigate without posting; then count 0 by keyboard.
  const third = await currentOrderNo()
  await p.keyboard.press('ArrowRight')
  assert.notEqual(await currentOrderNo(), third)
  await p.keyboard.press('ArrowLeft')
  assert.equal(await currentOrderNo(), third)
  const thirdId = holderIdOf(third)
  await p.keyboard.press('0')
  await p.keyboard.press('Enter')
  await waitProgress(3)
  assert.equal(countRows(thirdId, CRIB), 1)
  assert.equal(qtyAt(thirdId, CRIB), 0)
  assert.equal(Number(db().value('SELECT qty_on_site FROM v_stock_on_hand WHERE holder_id = ?', [thirdId])), 0, 'counted 0 → off site')

  // Header strip refreshed: 3 of the 54 opening-balance holders counted; 54 − 1 + 1 + 2 = 56 on site.
  await p.waitForFunction(() => document.getElementById('tCounted')!.textContent === '3/54')
  assert.equal(await p.textContent('#tTotal'), '56')

  // The run list shows the three as counted here today, and clicking one jumps to it.
  assert.equal(await p.locator('.cm-item.done').count(), 3)
  await p.click(`.cm-item.done >> text=${first}`)
  assert.equal(await currentOrderNo(), first)
  assert.match((await p.textContent('.cm-card'))!, /Counted here today/)
  // The URL follows the holder, so a reload comes back to it.
  assert.match(await p.evaluate(() => location.hash), new RegExp(`holder=${firstId}`))
  assert.deepEqual(unexpectedErrors(), [])
})

test('count mode: a double click on Confirm posts once', async () => {
  const p = e.page
  await p.click('.cm-item:not(.done)') // jump to the first holder not counted yet
  const target = await currentOrderNo()
  const tid = holderIdOf(target)
  const n = countRows(tid, CRIB)
  await p.dblclick('[data-act=confirm]')
  await p.waitForFunction((o) => document.querySelector('.cm-ord')?.textContent?.trim() !== o, target)
  // Give a stray second request time to land if one had been sent.
  await p.waitForTimeout(300)
  assert.equal(countRows(tid, CRIB), n + 1)
  assert.deepEqual(unexpectedErrors(), [])
})

test('count mode: Enter after tapping + confirms (it does not press + again); a reload resumes on the holder', async () => {
  const p = e.page
  await p.click('.cm-item:not(.done)')
  const order = await currentOrderNo()
  const id = holderIdOf(order)
  await p.click('[data-act=inc]') // expected 1 → 2, focus stays on the + button
  await p.keyboard.press('Enter')
  await p.waitForFunction((o) => document.querySelector('.cm-ord')?.textContent?.trim() !== o, order)
  assert.equal(qtyAt(id, CRIB), 2)
  const now = await currentOrderNo()
  await p.reload()
  await p.waitForSelector('.cm-ord')
  assert.equal(await currentOrderNo(), now)
  assert.match((await p.textContent('.cm-where'))!, /Tool crib/)
  assert.deepEqual(unexpectedErrors(), [])
})

test('count mode: ?holder= deep link opens that holder at the tool crib; works at tablet width', async () => {
  const p = e.page
  await p.setViewportSize({ width: 800, height: 1100 })
  try {
    await e.goto('#/count?holder=H0010')
    await p.waitForSelector('.cm-ord')
    assert.equal(await currentOrderNo(), '84719607')
    assert.match((await p.textContent('.cm-where'))!, /Tool crib/)
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(overflow <= 0, `no horizontal scroll at 800 px (overflow ${overflow})`)
    const box = (await p.locator('[data-act=confirm]').boundingBox())!
    assert.ok(box.height >= 48 && box.x + box.width <= 800, 'confirm is a big touch target inside the screen')
  } finally {
    await p.setViewportSize({ width: 1280, height: 900 })
  }
  assert.deepEqual(unexpectedErrors(), [])
})

test('count mode: end of the list and back to setup', async () => {
  const p = e.page
  await e.goto('#/count')
  await p.waitForSelector('.cm-loc')
  await p.click(`.cm-loc[data-loc="${CRIB}"]`)
  await p.click('[data-scope=location]')
  await p.waitForFunction(() => /in the list/.test(document.querySelector('[data-preview]')!.textContent!))
  await p.click('[data-act=start]')
  await p.waitForSelector('.cm-ord')
  const total = Number(/of (\d+)/.exec((await p.textContent('[data-progress]'))!)![1])
  for (let i = 0; i < total; i++) await p.keyboard.press('ArrowRight')
  await p.waitForSelector('.cm-end')
  await p.click('.cm-end [data-act=setup]')
  await p.waitForSelector('.cm-setup')
  assert.deepEqual(unexpectedErrors(), [])
})

test('stock actions: book a receipt and a move from the holder page dialog', async () => {
  const p = e.page
  await e.goto('#/holder/H0001')
  const holder = { holder_id: 'H0001', manufacturer: 'HAIMER', order_no: 'A63.050.16.KKB', series: 'Face mill arbor' }

  // Receipt
  await openAction('receipt', holder)
  await p.waitForSelector('dialog[open] [name=qty]')
  assert.match((await p.textContent('dialog[open] .dlg-head'))!, /Book a receipt/)
  assert.equal(await p.inputValue('dialog[open] [name=location_id]'), String(CRIB), 'defaults to the tool crib')
  await p.fill('dialog[open] [name=qty]', '2')
  await p.fill('dialog[open] [name=reference]', 'PO 4500777')
  await p.fill('dialog[open] [name=note]', 'second set for DMG 2')
  await p.click('dialog[open] button[type=submit]')
  assert.equal(await p.evaluate(() => (window as any).__sa), true)
  await p.waitForSelector('.toast.ok >> text=Booked receipt: 2 × A63.050.16.KKB at Tool crib')
  const rec = db().get<any>(`SELECT * FROM stock_transactions WHERE holder_id = 'H0001' AND txn_type = 'RECEIPT'`)
  assert.equal(rec.qty_delta, 2)
  assert.equal(rec.reference, 'PO 4500777')
  assert.equal(rec.by_user, 'E2E Tester')

  // Move one out for repair
  await openAction('move', holder)
  await p.waitForSelector('dialog[open] [name=from_location_id]')
  assert.match((await p.textContent(`dialog[open] [name=from_location_id] option[value="${CRIB}"]`))!, /Tool crib — 2 here/)
  await p.selectOption('dialog[open] [name=to_location_id]', String(VENDOR))
  await p.fill('dialog[open] [name=reference]', 'RMA 991')
  await p.click('dialog[open] button[type=submit]')
  assert.equal(await p.evaluate(() => (window as any).__sa), true)
  assert.equal(qtyAt('H0001', CRIB), 1)
  assert.equal(qtyAt('H0001', VENDOR), 1)
  const pair = db().all<any>(`SELECT txn_type, reference FROM stock_transactions WHERE holder_id = 'H0001' AND txn_type LIKE 'MOVE_%' ORDER BY txn_id`)
  assert.deepEqual(pair.map((r) => [r.txn_type, r.reference]), [['MOVE_OUT', 'RMA 991'], ['MOVE_IN', 'RMA 991']])

  // A return while one is still booked at the vendor warns that it is probably a move.
  await openAction('return', holder)
  await p.waitForSelector('dialog[open] .sa-warn')
  assert.match((await p.textContent('dialog[open] .sa-warn'))!, /1 at At vendor \/ repair is still booked off site/)
  await p.click('dialog[open] [data-close].btn')
  assert.equal(await p.evaluate(() => (window as any).__sa), false)

  // Scrap more than is there: the server's message shows in the dialog and nothing is booked.
  const before = txnTotal()
  await openAction('scrap', holder, { locationId: CRIB })
  await p.waitForSelector('dialog[open] [name=reference]')
  await p.fill('dialog[open] [name=qty]', '5')
  await p.fill('dialog[open] [name=reference]', 'NCR-2026-001')
  await p.click('dialog[open] button[type=submit]')
  await p.waitForSelector('dialog[open] [data-err]:not(.hidden)')
  assert.match((await p.textContent('dialog[open] [data-err]'))!, /Only 1 booked at Tool crib/)
  await p.click('dialog[open] [data-close].btn')
  assert.equal(await p.evaluate(() => (window as any).__sa), false)
  assert.equal(txnTotal(), before)

  // 'adjust' goes to Count mode on the holder.
  await openAction('adjust', holder)
  await p.waitForSelector('.cm-ord')
  assert.equal(await currentOrderNo(), 'A63.050.16.KKB')
  assert.deepEqual(unexpectedErrors([/status of 409/]), [])
})

test('ledger: filters, holder link and CSV export', async () => {
  const p = e.page
  await e.goto('#/log?holder=H0001')
  await p.waitForSelector('.lg-table')
  const holders = await p.$$eval('.lg-table tbody tr .lg-h a', (as) => as.map((a) => a.getAttribute('href')))
  assert.ok(holders.length >= 4 && holders.every((h) => h === '#/holder/H0001'))
  assert.match((await p.textContent('[data-holder]'))!, /HAIMER A63\.050\.16\.KKB/)
  // Newest first: the move is above the receipt.
  const types = await p.$$eval('.lg-table tbody tr td:nth-child(5)', (tds) => tds.map((t) => t.textContent!.trim()))
  assert.ok(types.indexOf('Move in') < types.indexOf('Receipt'))
  // Coloured deltas
  assert.ok(await p.$('.lg-delta.plus'))
  assert.ok(await p.$('.lg-delta.minus'))

  await p.selectOption('[data-f=type]', 'RECEIPT')
  await p.waitForFunction(() => document.querySelectorAll('.lg-table tbody tr').length === 1)
  assert.match(await p.evaluate(() => location.hash), /type=RECEIPT/)

  await p.click('[data-act=unholder]')
  await p.selectOption('[data-f=type]', '')
  await p.fill('[data-f=q]', 'RMA 991')
  await p.waitForFunction(() => document.querySelectorAll('.lg-table tbody tr').length === 2)

  await p.fill('[data-f=q]', 'no such reference anywhere')
  await p.waitForSelector('.lg .empty')

  await p.click('[data-act=clear]')
  await p.waitForFunction(() => document.querySelectorAll('.lg-table tbody tr').length > 60)
  const [download] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=csv]')])
  assert.match(download.suggestedFilename(), /^stock-ledger-\d{4}-\d{2}-\d{2}\.csv$/)
  assert.deepEqual(unexpectedErrors([/status of 409/]), [])
})

test('locations: add from a suggestion, take it off site, delete it', async () => {
  const p = e.page
  await e.goto('#/locations')
  await p.waitForSelector('.loc-table')
  await p.click('[data-suggest="DMG 1 magazine"]')
  assert.equal(await p.inputValue('[data-addform] [name=name]'), 'DMG 1 magazine')
  assert.equal(await p.inputValue('[data-addform] [name=kind]'), 'machine')
  await p.click('[data-addform] button[type=submit]')
  await p.waitForSelector('.loc-table >> text=DMG 1 magazine')
  const row = db().get<any>(`SELECT * FROM locations WHERE name = 'DMG 1 magazine'`)
  assert.equal(row.kind, 'machine')
  assert.equal(row.counts_as_on_site, 1)
  // The suggestion chip disappears once the location exists.
  assert.equal(await p.$('[data-suggest="DMG 1 magazine"]'), null)

  // Duplicate name: the server's message shows in the form.
  await p.fill('[data-addform] [name=name]', 'tool crib')
  await p.click('[data-addform] button[type=submit]')
  await p.waitForSelector('[data-adderr].errorbox')
  assert.match((await p.textContent('[data-adderr]'))!, /already exists/)

  await p.click(`[data-onsite="${row.location_id}"]`)
  await p.waitForFunction((id) => {
    const i = document.querySelector<HTMLInputElement>(`[data-onsite="${id}"]`)
    return i && !i.checked && i.parentElement!.textContent!.includes('No')
  }, row.location_id)
  assert.equal(Number(db().value('SELECT counts_as_on_site FROM locations WHERE location_id = ?', [row.location_id])), 0)

  await p.click(`[data-del="${row.location_id}"]`)
  await p.click('dialog[open] [data-ok]')
  await p.waitForFunction(() => !document.querySelector('.loc-table')?.textContent?.includes('DMG 1 magazine'))
  assert.equal(db().value(`SELECT 1 FROM locations WHERE name = 'DMG 1 magazine'`), undefined)
  // Used locations can't be deleted from the UI.
  assert.equal(await p.$(`[data-del="${CRIB}"]`), null)
  assert.deepEqual(unexpectedErrors([/status of 409/]), [])
})

test('count mode: blind count hides booked quantities and starts with an empty number', async () => {
  const p = e.page
  await e.goto('#/count')
  await p.waitForSelector('.cm-loc')
  await p.click(`.cm-loc[data-loc="${CRIB}"]`)
  await p.check('[data-f=blind]')
  await p.waitForFunction(() => /holders in the list/.test(document.querySelector('[data-preview]')!.textContent!))
  await p.selectOption('[data-f=show]', 'today')
  await p.click('[data-act=start]')
  await p.waitForSelector('.cm-ord')
  assert.equal(await p.inputValue('[data-qty]'), '', 'no pre-filled quantity')
  const card = (await p.textContent('[data-card]'))!
  assert.doesNotMatch(card, /Booked here|Total on site/)
  assert.match(card, /Blind count/)
  // Enter with nothing typed must not post.
  const before = txnTotal()
  await p.keyboard.press('Enter')
  assert.equal(txnTotal(), before)
  const ord = await currentOrderNo()
  const id = holderIdOf(ord)
  await p.keyboard.press('1')
  assert.match((await p.textContent('[data-hint]'))!, /Confirm records 1 at Tool crib/)
  await p.keyboard.press('Enter')
  await p.waitForFunction((o) => document.querySelector('.cm-ord')?.textContent?.trim() !== o, ord)
  assert.equal(qtyAt(id, CRIB), 1)
  // The setting is remembered on this device.
  assert.equal(await p.evaluate(() => localStorage.getItem('hc.count.blind')), '1')
  await p.evaluate(() => localStorage.removeItem('hc.count.blind'))
})
