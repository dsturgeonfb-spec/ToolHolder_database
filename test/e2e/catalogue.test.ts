import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startE2E, type E2E } from './helpers.js'

let e: E2E
before(async () => (e = await startE2E()))
after(async () => e.close())

const rows = () => e.page.locator('.cat-list .row')
/** Waits until the catalogue shows exactly n rows and is not mid-fetch. */
async function waitRows(n: number) {
  await e.page.waitForFunction(
    (n) => !document.querySelector('.cat-list.is-loading') && document.querySelectorAll('.cat-list .row').length === n,
    n,
    { timeout: 10_000 },
  )
}
const hashParams = async () => new URLSearchParams((await e.page.evaluate(() => location.hash)).split('?')[1] ?? '')

test('deep link #/catalogue?fit=12 shows the 13 on-site holders that fit a Ø12 shank', async () => {
  await e.goto('#/catalogue?fit=12')
  await waitRows(13)
  assert.equal(await e.page.inputValue('#fit'), '12')
  assert.equal(await e.page.getAttribute('[data-scope="site"]', 'aria-pressed'), 'true')
  assert.equal(await e.page.textContent('#countLine'), '13 of 88 articles shown')
  assert.deepEqual(e.errors, [])
})

test('tally renders progress, makers, clamp table, locations and the 4-row GL check; count CSV downloads', async () => {
  await e.goto('#/tally')
  await e.page.waitForSelector('.tv-progress')
  assert.match((await e.page.textContent('.tv-progress .big'))!, /0 of 54 articles physically counted/)
  assert.match((await e.page.textContent('.tv-progress'))!, /54 still unverified/)
  const makerBars = await e.page.$$eval('#tv-mk-h + .bars .bar', (bs) => bs.map((b) => [b.querySelector('span')!.firstChild!.textContent!.trim(), b.querySelector('.c')!.textContent]))
  assert.deepEqual(makerBars, [['HAIMER', '37'], ['MAPAL', '9'], ['CERATIZIT', '7'], ['KEMMLER', '1']])
  const glRows = e.page.locator('[aria-labelledby="tv-gl-h"] tbody tr')
  assert.equal(await glRows.count(), 4)
  assert.match((await glRows.first().textContent())!, /\+17/)
  assert.match((await e.page.textContent('[aria-labelledby="tv-clamp-h"]'))!, /Face \/ shell mill arbor/)
  assert.match((await e.page.textContent('[aria-labelledby="tv-loc-h"] tfoot'))!, /54/)
  const [dl] = await Promise.all([e.page.waitForEvent('download'), e.page.click('[data-path="/api/export/tally.csv"]')])
  assert.match(dl.suggestedFilename(), /holder_count_.*\.csv$/)
  const [x] = await Promise.all([e.page.waitForEvent('download'), e.page.click('[data-path="/api/export/tally.xlsx"]')])
  assert.match(x.suggestedFilename(), /holder_tally_.*\.xlsx$/)
  assert.deepEqual(e.errors, [])
})

test('default view: on site, grouped by type with article and quantity counts', async () => {
  await e.goto('#/catalogue')
  await waitRows(54)
  const first = e.page.locator('.cat-list .grp').first()
  assert.equal(await first.locator('h3').textContent(), 'Shrink fit chuck')
  assert.match((await first.locator('.eyebrow').textContent())!, /27 articles · 27 on site/)
  // Row content: maker + order no. linking to the record, clamp, GL with CAM delta for an arbor, qty + status.
  const arbor = e.page.locator('[data-row="H0001"]')
  assert.equal(await arbor.locator('a.ord').getAttribute('href'), '#/holder/H0001')
  assert.match((await arbor.locator('.gl .num').textContent())!, /GL 50 mm · CAM 67/)
  assert.match((await arbor.locator('.stock').textContent())!, /1\s*on site\s*Unverified/)
  assert.equal(await arbor.locator('a[href="#/count?holder=H0001"]').count(), 1)
  assert.equal(await arbor.locator('[data-act="want"]').count(), 0, 'Want is only offered for can-buy articles')
  assert.match((await e.page.locator('[data-row="H0010"] .cat-issues').textContent())!, /1 issue/)
  assert.deepEqual(e.errors, [])
})

test('filters are server-side, kept in the URL, and back/forward restores them', async () => {
  await e.goto('#/catalogue')
  await waitRows(54)
  await e.page.fill('#fit', '12')
  await waitRows(13)
  assert.equal((await hashParams()).get('fit'), '12')
  await e.page.click('[data-scope="cat"]')
  await waitRows(3) // MAPAL UNIQ Ø12 chucks you can buy
  assert.equal((await hashParams()).get('scope'), 'cat')
  await e.page.goBack()
  await waitRows(13)
  assert.equal(await e.page.getAttribute('[data-scope="site"]', 'aria-pressed'), 'true')
  await e.page.goForward()
  await waitRows(3)
  // Multi-term search (AND), debounced typing.
  await e.goto('#/catalogue?scope=all')
  await waitRows(88)
  await e.page.fill('#q', 'haimer gl80')
  await waitRows(4)
  assert.equal((await hashParams()).get('q'), 'haimer gl80')
  await e.page.selectOption('#fmk', 'MAPAL')
  await waitRows(0)
  assert.match((await e.page.textContent('.cat-list .empty'))!, /No holders match/)
  await e.page.click('[data-act="clear"]')
  await waitRows(88)
  await e.page.check('#fflag')
  await waitRows(18)
  await e.page.selectOption('#fstatus', 'unverified')
  await e.page.selectOption('#ftype', 'SHRINK')
  await waitRows(7)
  assert.deepEqual(e.errors, [])
})

test('a row expands inline (profile or toggle) with the compact detail and its open issues', async () => {
  await e.goto('#/catalogue')
  await waitRows(54)
  await e.page.click('[data-row="H0002"] .cat-toggle')
  await e.page.waitForSelector('#cat-d-H0002 .fl')
  const det = e.page.locator('#cat-d-H0002')
  assert.equal(await det.locator('.fl .f').count(), 2)
  assert.match((await det.textContent())!, /HAIMER SPIGOT ARBOR 22mm/)
  assert.equal(await det.locator('a.cat-open').getAttribute('href'), '#/holder/H0002')
  assert.equal(await e.page.getAttribute('[data-row="H0002"] .cat-toggle', 'aria-expanded'), 'true')
  await e.page.click('[data-row="H0002"] .cat-prof')
  await e.page.waitForSelector('#cat-d-H0002', { state: 'detached' })
  assert.deepEqual(e.errors, [])
})

test('open a holder from the list: the record shows identity, GL check, stock, issues and history', async () => {
  await e.goto('#/catalogue')
  await waitRows(54)
  await e.page.click('[data-row="H0001"] a.ord')
  await e.page.waitForSelector('.hv-head')
  assert.equal(await e.page.evaluate(() => location.hash), '#/holder/H0001')
  assert.equal(await e.page.textContent('.hv-head h2'), 'A63.050.16.KKB')
  assert.match((await e.page.textContent('.hv-glcmp'))!, /50 \+ 17 = 67 mm/)
  assert.match((await e.page.textContent('.hv-chips'))!, /Verified on maker site/)
  assert.equal(await e.page.locator('.hv-dims tbody tr').count(), 7)
  assert.match((await e.page.textContent('#hv-flags'))!, /Convention difference/)
  assert.equal(await e.page.locator('[data-act="close-flag"]').count(), 1)
  assert.match((await e.page.locator('.hv-media').textContent())!, /Maker page/)
  assert.deepEqual(e.errors, [])
})

test('edit catalogue data: data source required, only changed fields saved and logged', async () => {
  await e.goto('#/holder/H0049')
  await e.page.waitForSelector('.hv-head')
  await e.page.click('.hv-actions [data-act="edit"]')
  const dlg = e.page.locator('dialog.hf-dlg')
  await dlg.waitFor()
  await dlg.locator('[name="gauge_length_mm"]').fill('91')
  assert.match((await dlg.locator('[data-diff]').textContent())!, /1 field changed/)
  await dlg.locator('button[type=submit]').click()
  await dlg.locator('[data-err]:not(.hidden)').waitFor()
  assert.match((await dlg.locator('[data-err]').textContent())!, /Data source/)
  await dlg.locator('[name="data_source"]').fill('HAIMER catalogue 2025 p. 212')
  await dlg.locator('button[type=submit]').click()
  await dlg.waitFor({ state: 'detached' })
  await e.page.waitForFunction(() => /91 mm/.test(document.querySelector('.hv-glcmp')?.textContent ?? ''))
  const hist = (await e.page.textContent('.hv-change'))!
  assert.match(hist, /Gauge length/)
  assert.match(hist, /90\s*→\s*91/)
  assert.match(hist, /HAIMER catalogue 2025 p\. 212/)
  const changes = e.t.app.ctx.db.all<{ field: string; by_user: string }>(`SELECT field, by_user FROM holder_changes WHERE holder_id='H0049' ORDER BY field`)
  assert.deepEqual(changes.map((c) => c.field), ['data_source', 'gauge_length_mm'])
  assert.ok(changes.every((c) => c.by_user === 'E2E Tester'))
  // Notes alone need no source.
  await e.page.click('.hv-actions [data-act="edit"]')
  await dlg.waitFor()
  await dlg.locator('[name="notes"]').fill('Lives in drawer 4')
  await dlg.locator('button[type=submit]').click()
  await dlg.waitFor({ state: 'detached' })
  await e.page.waitForFunction(() => /Lives in drawer 4/.test(document.querySelector('.kv')?.textContent ?? ''))
  // Stock untouched by catalogue edits.
  assert.equal(Number(e.t.app.ctx.db.value(`SELECT SUM(qty_on_site) FROM v_stock_on_hand`)), 54)
  assert.deepEqual(e.errors, [])
})

test('add a holder from a maker catalogue, then find it under Can buy', async () => {
  await e.goto('#/catalogue')
  await waitRows(54)
  await e.page.click('[data-act="add"]')
  const dlg = e.page.locator('dialog.hf-dlg')
  await dlg.waitFor()
  await dlg.locator('[name="manufacturer"]').selectOption('HAIMER')
  await dlg.locator('[name="order_no"]').fill('A63.140.12')
  await dlg.locator('[name="type_code"]').selectOption('SHRINK')
  await dlg.locator('[name="clamp_dia_mm"]').fill('25')
  await dlg.locator('[name="gauge_length_mm"]').fill('100')
  await dlg.locator('[name="nose_dia_mm"]').fill('44')
  await dlg.locator('[name="dims"]').fill('D1: 25\nD2: 44\nA: 100')
  await dlg.locator('[name="data_source"]').fill('HAIMER catalogue 2025 p. 212')
  await dlg.locator('button[type=submit]').click()
  // Same maker + order no. as H0049: refused with a link to the existing record.
  await dlg.locator('[data-err]:not(.hidden)').waitFor()
  assert.match((await dlg.locator('[data-err]').textContent())!, /already in the catalogue \(H0049\)/)
  assert.equal(await dlg.locator('[data-err] a').getAttribute('href'), '#/holder/H0049')
  await dlg.locator('[name="order_no"]').fill('A63.140.25')
  await dlg.locator('button[type=submit]').click()
  await e.page.waitForFunction(() => location.hash === '#/holder/H0089')
  await e.page.waitForSelector('.hv-head')
  assert.equal(await e.page.textContent('.hv-head h2'), 'A63.140.25')
  assert.match((await e.page.textContent('.hv-chips'))!, /Unverified/)
  assert.match((await e.page.textContent('.kv'))!, /Ø25 mm fixed bore/)
  assert.match((await e.page.textContent('.hv-change'))!, /Record created/)
  await e.goto('#/catalogue?scope=cat&fit=25')
  await e.page.waitForSelector('[data-row="H0089"]')
  assert.equal(await e.page.locator('[data-row="H0089"] [data-act="want"]').count(), 1)
  await e.page.waitForFunction(() => document.getElementById('nCat')?.textContent === '89')
  // The browser logs the refused duplicate (409) itself; anything else would be a real error.
  assert.deepEqual(e.errors.filter((m) => !/409/.test(m)), [])
  e.errors.length = 0
})

test('exports download from the catalogue with the current filters', async () => {
  await e.goto('#/catalogue?fit=12')
  await waitRows(13)
  const [dl] = await Promise.all([e.page.waitForEvent('download'), e.page.click('[data-act="export"][data-fmt="xlsx"]')])
  assert.match(dl.suggestedFilename(), /^HSK-A63_holder_catalogue_\d{4}-\d{2}-\d{2}\.xlsx$/)
  const [csv] = await Promise.all([e.page.waitForEvent('download'), e.page.click('[data-act="export"][data-fmt="csv"]')])
  const path = await csv.path()
  const { readFileSync } = await import('node:fs')
  const lines = readFileSync(path!, 'utf8').trimEnd().split('\r\n')
  assert.equal(lines.length, 1 + 13)
  assert.deepEqual(e.errors, [])
})

test('an unknown holder gets a friendly message with a way back, not an error', async () => {
  await e.goto('#/holder/H9999')
  await e.page.waitForSelector('.hv .warnbox')
  assert.match((await e.page.textContent('.hv .warnbox'))!, /H9999 is not in the catalogue/)
  assert.equal(await e.page.locator('.hv .warnbox a[href="#/catalogue"]').count(), 1)
  assert.equal(await e.page.locator('#view .errorbox').count(), 0)
  // The browser logs the 404 response itself; that is the expected request, not a script error.
  const unexpected = e.errors.filter((m) => !/404/.test(m))
  assert.deepEqual(unexpected, [])
  e.errors.length = 0
})

test('tablet width (800 px): catalogue, record and tally fit without sideways scrolling', async () => {
  await e.page.setViewportSize({ width: 800, height: 1000 })
  for (const hash of ['#/catalogue?scope=all', '#/holder/H0001', '#/tally']) {
    await e.goto(hash)
    await e.page.waitForSelector('.cat-list .row, .hv-head, .tv-progress')
    const over = await e.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(over <= 0, `${hash} overflows by ${over}px`)
  }
  await e.page.setViewportSize({ width: 1280, height: 900 })
  assert.deepEqual(e.errors, [])
})
