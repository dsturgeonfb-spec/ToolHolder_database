/**
 * Browser regression tests for the stock review findings (fix/stock): the count hints under the
 * count rule, blind count on screen and on the printed sheet, Confirm above the fold at 1280×900,
 * and retry-safe stock dialogs (one request key per dialog, sent with every attempt).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startE2E, type E2E } from './helpers.js'
import { today } from '../../src/server/domain.js'

let e: E2E
before(async () => (e = await startE2E()))
after(async () => e.close())

const UNASSIGNED = 1
const CRIB = 2
const VENDOR = 3
const db = () => e.t.app.ctx.db
const qtyAt = (holder: string, loc: number) =>
  Number(db().value('SELECT COALESCE(SUM(qty_delta),0) FROM stock_transactions WHERE holder_id = ? AND location_id = ?', [holder, loc]))
const status = (holder: string) => db().value<string>('SELECT count_status FROM v_count_status WHERE holder_id = ?', [holder])
const holderIdOf = (orderNo: string) => db().value<string>('SELECT holder_id FROM holders WHERE order_no = ?', [orderNo])!
const unexpectedErrors = (allowed: RegExp[] = []) => e.errors.filter((m) => !allowed.some((re) => re.test(m)))
const hint = async () => (await e.page.textContent('[data-hint]'))!.trim()
const currentOrderNo = async () => (await e.page.textContent('.cm-ord'))!.trim()

async function startCount(loc: number, opts: { blind?: boolean } = {}) {
  const p = e.page
  await e.goto('#/count')
  await p.waitForSelector('.cm-loc')
  await p.click(`.cm-loc[data-loc="${loc}"]`)
  if (opts.blind) await p.check('[data-f=blind]')
  else await p.uncheck('[data-f=blind]')
  await p.waitForFunction(() => /holders in the list/.test(document.querySelector('[data-preview]')!.textContent!))
  await p.click('[data-act=start]')
  await p.waitForSelector('.cm-ord')
}

test('count hints follow the count rule: 0 keeps a holder unverified, a find replaces the opening balance', async () => {
  const p = e.page
  await startCount(CRIB)
  const ord = await currentOrderNo()
  const id = holderIdOf(ord)
  assert.equal(status(id), 'unverified')
  // Pre-filled with what the books expect: 1 (the opening balance, not yet located).
  assert.equal(await p.inputValue('[data-qty]'), '1')
  assert.equal(await hint(), 'Books +1 at Tool crib and replaces the unverified opening balance (1). Site total after: 1.')
  await p.keyboard.press('0')
  assert.equal(
    await hint(),
    "None here — it stays unverified (not yet located) until it is found at another location, or written off by counting 0 at 'Unassigned – count required'.",
  )
  assert.doesNotMatch(await hint(), /Matches the books/)
  await p.keyboard.press('Enter')
  await p.waitForFunction((o) => document.querySelector('.cm-ord')?.textContent?.trim() !== o, ord)
  await p.waitForSelector('.toast.ok >> text=still not located')
  assert.equal(qtyAt(id, CRIB), 0)
  assert.equal(qtyAt(id, UNASSIGNED), 1, 'the opening balance is untouched')
  assert.equal(status(id), 'unverified')
  // Back on that holder: counted here today, still unverified, and the hint still says so.
  await p.click(`.cm-item.done >> text=${ord}`)
  assert.equal(await currentOrderNo(), ord)
  assert.match((await p.textContent('.cm-card'))!, /Unverified/)
  assert.match(await hint(), /^Same as already counted here today\. None here — it stays unverified/)
  assert.deepEqual(unexpectedErrors(), [])
})

test('count hints at Unassigned: counting there is "how many are still not located", and 0 writes it off', async () => {
  const p = e.page
  await startCount(UNASSIGNED)
  assert.match((await p.textContent('.cm-q-label'))!, /still not located/)
  const ord = await currentOrderNo()
  const id = holderIdOf(ord)
  assert.match(await hint(), /^1 still not located — matches the books; it stays unverified\./)
  await p.keyboard.press('0')
  assert.match(await hint(), /^Writes off the opening balance \(1\): the holder is recorded as not found anywhere and leaves the site tally\. Site total after: 0\./)
  await p.keyboard.press('Enter')
  await p.waitForFunction((o) => document.querySelector('.cm-ord')?.textContent?.trim() !== o, ord)
  assert.equal(qtyAt(id, UNASSIGNED), 0)
  assert.notEqual(status(id), 'unverified')
  assert.deepEqual(unexpectedErrors(), [])
})

test('blind count: hints never show booked quantities but still warn about a write-off at Unassigned', async () => {
  const p = e.page
  await startCount(UNASSIGNED, { blind: true })
  assert.equal(await p.inputValue('[data-qty]'), '')
  assert.match(await hint(), /0 writes the opening balance off/)
  await p.keyboard.press('0')
  const h0 = await hint()
  assert.match(h0, /writes the opening balance off/)
  assert.doesNotMatch(h0, /\d+\)|Site total|Books/)
  await p.keyboard.press('Backspace')
  await p.keyboard.press('2')
  assert.equal(await hint(), 'Confirm records 2 still not located — it stays unverified.')

  await startCount(CRIB, { blind: true })
  const first = await hint()
  assert.equal(first, 'Enter the number you counted — 0 if there are none here.')
  await p.keyboard.press('0')
  assert.equal(
    await hint(),
    "None here — it stays unverified (not yet located) until it is found at another location, or written off by counting 0 at 'Unassigned – count required'.",
  )
  await p.keyboard.press('Backspace')
  await p.keyboard.press('3')
  assert.equal(await hint(), 'Confirm records 3 at Tool crib and replaces the unverified opening balance.')
  assert.deepEqual(unexpectedErrors(), [])
})

test('the printed count sheet honours blind count', async () => {
  const p = e.page
  const opened = async () => {
    await p.evaluate(() => {
      ;(window as any).__opened = null
      window.open = ((u: string) => (((window as any).__opened = u), null)) as any
    })
    await p.click('[data-act=print]')
    return (await p.evaluate(() => (window as any).__opened)) as string
  }
  // Blind is still on from the test above (it is remembered per device).
  await e.goto('#/count')
  await p.waitForSelector('.cm-loc')
  await p.click(`.cm-loc[data-loc="${CRIB}"]`)
  assert.equal(await p.isChecked('[data-f=blind]'), true)
  const blindUrl = await opened()
  assert.match(blindUrl, /[?&]blind=1(&|$)/)
  const sheet = await (await fetch(e.t.base + blindUrl)).text()
  assert.doesNotMatch(sheet, /Booked here/)
  assert.ok(!sheet.includes('not located</span>'))
  assert.match(sheet, /Blind count/)

  await p.uncheck('[data-f=blind]')
  const normalUrl = await opened()
  assert.doesNotMatch(normalUrl, /blind=/)
  assert.match(await (await fetch(e.t.base + normalUrl)).text(), /Booked here/)

  // From inside a blind run as well.
  await p.check('[data-f=blind]')
  await p.click('[data-act=start]')
  await p.waitForSelector('.cm-ord')
  assert.match(await opened(), /[?&]blind=1(&|$)/)
  await p.evaluate(() => localStorage.removeItem('hc.count.blind'))
  assert.deepEqual(unexpectedErrors(), [])
})

test('count mode at 1280×900: Confirm count & next is on screen without scrolling; on a 768 px laptop it is brought into view', async () => {
  const p = e.page
  const onScreen = async (sel: string, height: number) => {
    const b = (await p.locator(sel).boundingBox())!
    return b.y >= 0 && b.y + b.height <= height
  }
  // 1280×900 (the desktop window): everything that matters fits with the page scrolled to the top.
  await p.setViewportSize({ width: 1280, height: 900 })
  await startCount(CRIB)
  assert.equal(await p.evaluate(() => window.scrollY), 0, 'no scrolling needed')
  const box = (await p.locator('[data-act=confirm]').boundingBox())!
  assert.ok(box.y + box.height <= 900, `confirm at y=${box.y}..${box.y + box.height}`)
  assert.ok(box.height >= 48, 'still a big touch target')
  assert.ok(await onScreen('[data-qty]', 900))
  assert.ok(await onScreen('.cm-ord', 900))
  assert.ok(await onScreen('[data-hint]', 900))
  // Stepping on keeps it there.
  await p.keyboard.press('ArrowRight')
  assert.ok(await onScreen('[data-act=confirm]', 900))

  // 1366×768: the page scrolls just enough to show Confirm, the holder's identity stays on screen.
  await p.setViewportSize({ width: 1366, height: 768 })
  await startCount(CRIB)
  assert.ok(await onScreen('[data-act=confirm]', 768), 'confirm visible at 768 px')
  assert.ok(await onScreen('.cm-ord', 768), 'identity visible at 768 px')
  assert.ok(await onScreen('.cm-top', 768))
  await p.setViewportSize({ width: 1280, height: 900 })
  assert.deepEqual(unexpectedErrors(), [])
})

/** Opens a stock dialog the way the holder page does. */
async function openAction(kind: string, holder: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  await e.page.evaluate(
    async ({ kind, holder, opts, url }) => {
      const m = await import(url)
      ;(window as any).__sa = m.openStockAction(kind, holder, opts)
    },
    { kind, holder, opts, url: '/ui/js/components/stock-actions.js' },
  )
}

test('stock dialogs are retry-safe: the answer is lost, Book is pressed again, it is booked once', async () => {
  const p = e.page
  await e.goto('#/holder/H0070')
  const holder = { holder_id: 'H0070', manufacturer: 'MAPAL', order_no: '31229439' }
  const rows = (type: string, ref: string) =>
    Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = 'H0070' AND txn_type = ? AND reference = ?`, [type, ref]))

  /** Submits the open dialog; the first attempt reaches the server but its answer is lost on the way back. */
  async function submitWithLostAnswer(path: string): Promise<string[]> {
    const keys: string[] = []
    let first = true
    await p.route(`**${path}`, async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '')
      if (first) {
        first = false
        await route.fetch() // the server books it…
        await route.abort('connectionreset') // …but the answer never arrives
      } else await route.continue()
    })
    await p.click('dialog[open] button[type=submit]')
    await p.waitForSelector('dialog[open] [data-err]:not(.hidden)')
    assert.match((await p.textContent('dialog[open] [data-err]'))!, /Cannot reach the catalogue server/)
    await p.click('dialog[open] button[type=submit]')
    await p.waitForFunction(() => !document.querySelector('dialog[open]'))
    await p.unroute(`**${path}`)
    assert.equal(await p.evaluate(() => (window as any).__sa), true)
    assert.equal(keys.length, 2)
    assert.ok(keys[0] && keys[0].length >= 16, 'a request key is sent')
    assert.equal(keys[1], keys[0], 'the same key on the retry')
    return keys
  }

  // Receipt
  await openAction('receipt', holder)
  await p.waitForSelector('dialog[open] [name=qty]')
  await p.fill('dialog[open] [name=reference]', 'PO 777001')
  const k1 = await submitWithLostAnswer('/api/transactions')
  assert.equal(rows('RECEIPT', 'PO 777001'), 1)
  assert.equal(qtyAt('H0070', CRIB), 1)
  await p.waitForSelector('.toast.ok >> text=Booked receipt: 1 × 31229439 at Tool crib')

  // Return
  await openAction('return', holder)
  await p.waitForSelector('dialog[open] [name=qty]')
  await p.fill('dialog[open] [name=reference]', 'Loan back 5')
  const k2 = await submitWithLostAnswer('/api/transactions')
  assert.notEqual(k2[0], k1[0], 'a new dialog gets a new key')
  assert.equal(rows('RETURN', 'Loan back 5'), 1)
  assert.equal(qtyAt('H0070', CRIB), 2)

  // Move
  await openAction('move', holder)
  await p.waitForSelector('dialog[open] [name=from_location_id]')
  await p.selectOption('dialog[open] [name=to_location_id]', String(VENDOR))
  await p.fill('dialog[open] [name=reference]', 'RMA 4242')
  await submitWithLostAnswer('/api/moves')
  assert.equal(rows('MOVE_OUT', 'RMA 4242'), 1)
  assert.equal(qtyAt('H0070', VENDOR), 1)
  assert.equal(qtyAt('H0070', CRIB), 1)

  // Scrap
  await openAction('scrap', holder, { locationId: CRIB })
  await p.waitForSelector('dialog[open] [name=reference]')
  await p.fill('dialog[open] [name=reference]', 'NCR-2026-099')
  await submitWithLostAnswer('/api/transactions')
  assert.equal(rows('SCRAP', 'NCR-2026-099'), 1)
  assert.equal(qtyAt('H0070', CRIB), 0)

  // A real refusal (409) is not cached: the person corrects the form and the same dialog books it.
  await openAction('receipt', holder)
  await p.waitForSelector('dialog[open] [name=qty]')
  await p.fill('dialog[open] [name=reference]', 'PO 777002')
  await p.fill('dialog[open] [name=txn_date]', '2999-01-01')
  await p.click('dialog[open] button[type=submit]')
  await p.waitForSelector('dialog[open] [data-err]:not(.hidden)')
  await p.fill('dialog[open] [name=txn_date]', today())
  await p.click('dialog[open] button[type=submit]')
  await p.waitForFunction(() => !document.querySelector('dialog[open]'))
  assert.equal(rows('RECEIPT', 'PO 777002'), 1)
  assert.deepEqual(unexpectedErrors([/status of 400/, /ERR_CONNECTION_RESET/, /Failed to load resource/]), [])
})
