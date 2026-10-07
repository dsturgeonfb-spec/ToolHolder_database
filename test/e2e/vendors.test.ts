import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startE2E, type E2E } from './helpers.js'
import { FIXTURES } from '../helpers.js'
import { HostGates } from '../../src/server/vendors/fetcher.js'
import { fixtureFetch } from '../../src/server/vendors/fixtures.js'
import { setVendorHooks } from '../../src/server/vendors/hooks.js'

let e: E2E
before(async () => {
  e = await startE2E()
  // Saved maker pages instead of the network; crawl delays shortened (no maker site is contacted).
  setVendorHooks(e.t.app.ctx, { fetch: fixtureFetch(join(FIXTURES, 'vendors')), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))), gates: new HostGates() })
})
after(async () => e.close())

const db = () => e.t.app.ctx.db
const row = (order: string) => e.page.locator(`.vn-table tr[data-order="${order}"]`)

test('vendors page: a card per maker (automated or manual route), the polite-scraping notice and the user agent', async () => {
  await e.goto('#/vendors')
  await e.page.waitForSelector('.vn-maker')
  assert.equal(await e.page.locator('.vn-maker').count(), 6)
  const haimer = e.page.locator('.vn-maker[data-maker="HAIMER"]')
  assert.match((await haimer.textContent())!, /Automated scan[\s\S]*37 on site · 37 in catalogue/)
  assert.equal(await haimer.locator('[data-act="pick-scan"]').count(), 1)
  const cer = e.page.locator('.vn-maker[data-maker="CERATIZIT"]')
  assert.match((await cer.textContent())!, /Manual route[\s\S]*403/)
  assert.equal(await cer.locator('[data-act="pick-scan"]').count(), 0, 'Ceratizit is never offered a scan')
  const notice = (await e.page.textContent('.vn-polite'))!
  assert.match(notice, /HolderCatalogue\/0\.1\.0 \(\+contact not set\)/)
  assert.match(notice, /robots\.txt/)
  assert.match(notice, /blocked — not retried/)
  assert.match(notice, /first live scan carefully/)
  assert.equal(await e.page.locator('.vn-polite a[href="#/settings"]').count(), 1)
  assert.equal(await e.page.locator('.vn-fixtures').count(), 1, 'test mode is visible')
  assert.deepEqual(e.errors, [])
})

test('scan HAIMER for entered order nos → proposals → untick one field → approve → the new holder is in the catalogue', async () => {
  await e.goto('#/vendors')
  await e.page.click('.vn-maker[data-maker="HAIMER"] [data-act="pick-scan"]')
  assert.equal(await e.page.inputValue('[data-form="scan"] select[name="maker"]'), 'HAIMER')
  await e.page.fill('[data-form="scan"] textarea[name="orders"]', 'A63.182.04.8\nA63.147.05.1\nA63.140.04')
  assert.match((await e.page.textContent('[data-form="scan"] [data-estimate]'))!, /About 3 pages at 10 s each/)
  await e.page.click('[data-form="scan"] button[type="submit"]')
  await e.page.waitForSelector('.vn-props .vn-table', { timeout: 20_000 })
  assert.match((await e.page.textContent('.vn-job'))!, /Finished/)
  assert.match((await e.page.textContent('.vn-props-head'))!, /HAIMER · HSK-A63[\s\S]*1 new[\s\S]*1 to update[\s\S]*1 error/)

  assert.match((await row('A63.147.05.1').textContent())!, /New[\s\S]*Shrink fit chuck[\s\S]*120 mm/)
  assert.equal(await row('A63.147.05.1').locator('[data-sel]').isChecked(), true)
  assert.match((await row('A63.140.04').textContent())!, /Page not found/)
  assert.equal(await row('A63.140.04').locator('[data-sel]').count(), 0, 'error rows cannot be approved')
  const upd = row('A63.182.04.8')
  assert.match((await upd.textContent())!, /Photo[\s\S]*Drawing[\s\S]*Maker dimensions[\s\S]*A4 Flange diameter/)
  await upd.locator('[data-field][value="drawing_url"]').uncheck()
  assert.match((await e.page.textContent('[data-selcount]'))!, /2 rows selected/)

  await e.page.click('[data-act="approve"]')
  await e.page.waitForSelector('.vn-result')
  const result = (await e.page.textContent('.vn-result'))!
  assert.match(result, /Approved by E2E Tester/)
  assert.match(result, /1 added to the catalogue \(can buy, no stock\): H0089/)
  assert.match(result, /1 updated: H0026/)
  assert.equal(await e.page.locator('[data-act="approve"]').count(), 0, 'applied proposals cannot be approved again')
  const h26 = db().get<any>(`SELECT image_url, drawing_url FROM holders WHERE holder_id = 'H0026'`)!
  assert.match(h26.image_url, /asset-113402-659\.jpg$/)
  assert.equal(h26.drawing_url, null, 'the unticked field was not written')
  assert.equal(Number(db().value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = 'H0089'`)), 0)
  await e.page.waitForFunction(() => document.getElementById('nCat')?.textContent === '89')
  assert.match((await e.page.textContent('.vn-runs'))!, /Vendor scan · HAIMER[\s\S]*1 new · 1 updated/)

  await e.page.click('.vn-result a[href="#/holder/H0089"]')
  await e.page.waitForFunction(() => location.hash === '#/holder/H0089' && !document.querySelector('#view .loading'))
  assert.match((await e.page.textContent('#view'))!, /A63\.147\.05\.1/)
  assert.deepEqual(e.errors, [])
})

const CSV = [
  'Article,ADINTMS,DCONWS,LPR,DLN,WT,product_name,spec_code',
  '84722615,HSK-A63,2-20,130,50,"1,45",CoreLine Prec. Collet Chucks Centro-P,CP.ISO12164-A63.SF.ER32.130.F',
  '84719999,HSK-A100,1-7,100,16,,Wrong interface,CP.ISO12164-A100.SF.ER11.16.100.F',
].join('\r\n')

test('file import through the UI: choose a CSV, say where it came from, approve', async () => {
  await e.goto('#/vendors')
  await e.page.click('.vn-maker[data-maker="CERATIZIT"] [data-act="pick-import"]')
  assert.equal(await e.page.inputValue('[data-form="import"] select[name="maker"]'), 'CERATIZIT')
  await e.page.setInputFiles('[data-form="import"] input[type="file"]', { name: 'ceratizit_hsk63.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') })
  // The source is required before anything is sent.
  await e.page.click('[data-form="import"] button[type="submit"]')
  await e.page.waitForSelector('.toast.error')
  assert.match((await e.page.textContent('.toast.error'))!, /Say where the file came from/)
  assert.equal(await e.page.locator('.vn-props').count(), 0)
  await e.page.fill('[data-form="import"] input[name="source"]', 'ISO 13399 package from the Ceratizit rep, 05/10/2026')
  await e.page.click('[data-form="import"] button[type="submit"]')
  await e.page.waitForSelector('.vn-props .vn-table')
  assert.match((await e.page.textContent('.vn-props-head'))!, /ceratizit_hsk63\.csv · CERATIZIT · HSK-A63[\s\S]*1 new[\s\S]*1 error/)
  assert.match((await row('84719999').textContent())!, /ADINTMS "HSK-A100" is not HSK-A63/)
  await e.page.click('[data-act="approve"]')
  await e.page.waitForSelector('.vn-result')
  assert.match((await e.page.textContent('.vn-result'))!, /1 added to the catalogue/)
  const h = db().get<any>(`SELECT type_code, gauge_length_mm, data_status, data_source FROM holders WHERE order_no = '84722615'`)!
  assert.deepEqual({ ...h }, { type_code: 'ER_COLLET', gauge_length_mm: 130, data_status: 'catalogue_pdf', data_source: 'ISO 13399 package from the Ceratizit rep, 05/10/2026' })
  assert.match((await e.page.textContent('.vn-runs'))!, /File import · ceratizit_hsk63\.csv/)
  assert.deepEqual(e.errors, [])
})

test('cache maker photos: job progress, then what was saved and why the rest failed', async () => {
  await e.goto('#/vendors')
  await e.page.click('[data-act="images"]')
  await e.page.waitForSelector('.vn-images .vn-job')
  await e.page.waitForSelector('.vn-images .warnbox, .vn-images .okbox', { timeout: 30_000 })
  const text = (await e.page.textContent('.vn-images'))!
  assert.match(text, /\d+ saved, 0 already saved, \d+ could not be downloaded/)
  assert.match(text, /of them are saved on this PC/)
  const saved = Number(/(\d+) saved/.exec(text)![1])
  assert.ok(saved >= 2, `saved ${saved}`)
  assert.deepEqual(e.errors, [])
})

test('tablet width (800 px): no sideways page scroll, proposals still usable', async () => {
  await e.page.setViewportSize({ width: 800, height: 1000 })
  await e.goto('#/vendors')
  await e.page.waitForSelector('.vn-maker')
  assert.ok((await e.page.evaluate(() => document.documentElement.scrollWidth)) <= 800)
  await e.page.selectOption('[data-form="scan"] select[name="maker"]', 'MAPAL')
  await e.page.fill('[data-form="scan"] textarea[name="orders"]', '30524702\n31270591')
  await e.page.click('[data-form="scan"] button[type="submit"]')
  await e.page.waitForSelector('.vn-props .vn-table', { timeout: 20_000 })
  assert.ok((await e.page.evaluate(() => document.documentElement.scrollWidth)) <= 800)
  assert.equal(await row('30524702').locator('[data-sel]').isChecked(), true)
  assert.ok(await e.page.locator('[data-act="approve"]').isVisible())
  await e.page.setViewportSize({ width: 1280, height: 900 })
  assert.deepEqual(e.errors, [])
})

test('leaving the page mid-review and coming back: the last scan can be reopened and approved', async () => {
  await e.goto('#/catalogue')
  await e.goto('#/vendors')
  await e.page.waitForSelector('[data-act="reopen"]')
  assert.match((await e.page.textContent('[data-work]'))!, /Last scan: Scan MAPAL for HSK-A63 \(2 order nos\.\) \(done\)/)
  await e.page.click('[data-act="reopen"]')
  await e.page.waitForSelector('.vn-props .vn-table')
  assert.match((await row('30524702').textContent())!, /Photo/)
  await e.page.click('[data-act="approve"]')
  await e.page.waitForSelector('.vn-result')
  assert.match((await e.page.textContent('.vn-result'))!, /1 updated: H0018/)
  assert.deepEqual(e.errors, [])
})
