import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startE2E, type E2E } from './helpers.js'

let e: E2E
before(async () => {
  e = await startE2E()
  // The holder search picker calls GET /api/holders?q= (catalogue module). Until that module is merged
  // into this build, stand in for it with the documented response shape, read from the same database.
  const probe = await e.t.api('GET', '/api/holders?q=A63')
  if (probe.status === 404) {
    await e.page.route('**/api/holders?*', async (route) => {
      const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase()
      const rows = e.t.app.ctx.db.all<any>(
        `SELECT h.*, m.name AS manufacturer, t.type_name, s.qty_on_site FROM holders h
         JOIN manufacturers m USING (manufacturer_id) JOIN holder_types t USING (type_code) JOIN v_stock_on_hand s USING (holder_id)`,
      )
      const terms = q.split(/\s+/).filter(Boolean)
      const holders = rows.filter((h) => terms.every((term) => `${h.manufacturer} ${h.order_no} ${h.cam_name ?? ''} ${h.series ?? ''}`.toLowerCase().includes(term)))
      await route.fulfill({ json: { holders, total: rows.length } })
    })
  }
})
after(async () => e.close())

const db = () => e.t.app.ctx.db
const dlg = 'dialog.dlg[open]'
const rows = () => e.page.$$eval('.iss-list .iss-row', (els) => els.map((x) => Number((x as HTMLElement).dataset.id)))
const waitHeaderFlags = (n: number) => e.page.waitForFunction((v) => document.getElementById('tFlags')?.textContent === String(v), n)
const waitRowCount = (n: number) => e.page.waitForFunction((v) => document.querySelectorAll('.iss-list .iss-row').length === v, n)

test('Issues view: summary chips, INFO apart, every open flag listed by severity', async () => {
  await e.goto('#/issues')
  await e.page.waitForSelector('.iss-list .iss-row')
  assert.equal(await e.page.textContent('[data-open-issues]'), '19')
  const chips = await e.page.$$eval('.iss-sum [data-sev]', (els) => els.map((x) => x.textContent!.trim()))
  assert.deepEqual(chips, ['1 HIGH', '9 MEDIUM', '9 LOW', '12 INFO notes'])
  assert.ok(await e.page.$('.iss-info [data-sev="INFO"]'), 'INFO is shown in its own group')
  const ids = await rows()
  assert.equal(ids.length, 31)
  const sevs = await e.page.$$eval('.iss-list .iss-row', (els) => els.map((x) => Array.from(x.classList).find((c) => c.startsWith('sev-'))))
  const rank = { 'sev-HIGH': 0, 'sev-MEDIUM': 1, 'sev-LOW': 2, 'sev-INFO': 3 } as Record<string, number>
  for (let i = 1; i < sevs.length; i++) assert.ok(rank[sevs[i - 1]!]! <= rank[sevs[i]!]!, 'sorted by severity')
  // Holder link + hyperMILL name on the HIGH flag; general flags would say "General".
  const first = await e.page.$('.iss-row[data-id="1"]')
  assert.equal(await first!.$eval('a.iss-holder', (a) => a.getAttribute('href')), '#/holder/H0010')
  assert.match((await first!.textContent())!, /CERATIZIT 84719607/)
  const wbCount = (await e.t.api('GET', '/api/writeback')).body.count
  assert.equal(await e.page.textContent('[data-wbcount]'), String(wbCount))
  assert.deepEqual(e.errors, [])
})

test('filters: severity chip, category, search, closed — and the URL keeps them', async () => {
  await e.goto('#/issues')
  await e.page.waitForSelector('.iss-list .iss-row')
  await e.page.click('.iss-sum [data-sev="HIGH"]')
  await waitRowCount(1)
  assert.deepEqual(await rows(), [1])
  assert.match(await e.page.evaluate(() => location.hash), /severity=HIGH/)

  await e.page.selectOption('[data-f="severity"]', '')
  await e.page.selectOption('[data-f="category"]', 'Gauge length')
  const gl = Number(db().value(`SELECT COUNT(*) FROM data_flags WHERE status='OPEN' AND category='Gauge length'`))
  await waitRowCount(gl)

  await e.page.selectOption('[data-f="category"]', '')
  await e.page.fill('[data-f="q"]', 'A63.140.08')
  await waitRowCount(1)
  assert.deepEqual(await rows(), [2])
  assert.match(await e.page.evaluate(() => location.hash), /q=A63\.140\.08/)

  await e.page.fill('[data-f="q"]', 'nothing-matches-this')
  await e.page.waitForSelector('.iss-list .empty')
  assert.match((await e.page.textContent('.iss-list .empty'))!, /No issues match/)
  await e.page.click('[data-act="clear"]')
  await waitRowCount(31)

  await e.page.click('[data-status="CLOSED"]')
  await e.page.waitForSelector('.iss-list .empty')
  assert.match((await e.page.textContent('.iss-list .empty'))!, /No issues have been closed yet/)
  await e.page.click('[data-status="OPEN"]')
  await waitRowCount(31)
  assert.deepEqual(e.errors, [])
})

test('close a flag from the Issues view: note required, recorded against the person; header updates; reopen', async () => {
  await e.goto('#/issues')
  await e.page.waitForSelector('.iss-row[data-id="2"]')
  await e.page.click('.iss-row[data-id="2"] [data-act="close"]')
  await e.page.waitForSelector(dlg)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Mark fixed in hyperMILL', 'Gauge length is a hyperMILL fix')
  // Empty note is refused in the dialog.
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
  assert.match((await e.page.textContent(`${dlg} [data-err]`))!, /What did you change/)
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Comment changed to 80GL in hyperMILL')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector('.iss-row[data-id="2"]', { state: 'detached' })
  await waitHeaderFlags(18)
  assert.equal(await e.page.textContent('[data-open-issues]'), '18')
  const f = db().get<any>(`SELECT status, closed_by, closed_on, close_note FROM data_flags WHERE flag_id = 2`)!
  assert.equal(f.status, 'CLOSED')
  assert.equal(f.closed_by, 'E2E Tester')
  assert.ok(f.closed_on)
  assert.equal(f.close_note, 'Comment changed to 80GL in hyperMILL')

  // It shows under Closed with who/what, and can be reopened with a reason.
  await e.page.click('[data-status="CLOSED"]')
  await waitRowCount(1)
  assert.match((await e.page.textContent('.iss-row[data-id="2"] .iss-done'))!, /by E2E Tester: Comment changed to 80GL/)
  await e.page.click('.iss-row[data-id="2"] [data-act="reopen"]')
  await e.page.waitForSelector(dlg)
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Still 90GL after import')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector('.iss-list .empty')
  await waitHeaderFlags(19)
  assert.equal(db().value(`SELECT status FROM data_flags WHERE flag_id = 2`), 'OPEN')
  assert.match(String(db().value(`SELECT action FROM data_flags WHERE flag_id = 2`)), /Reopened \S+ by E2E Tester: Still 90GL after import/)
  await e.page.click('[data-status="OPEN"]')
  await e.page.waitForSelector('.iss-row[data-id="2"] .iss-act')
  assert.match((await e.page.textContent('.iss-row[data-id="2"] .iss-act'))!, /Reopened .* by E2E Tester/)
  assert.deepEqual(e.errors, [])
})

test('the close dialog shows the server error (closed elsewhere meanwhile) and keeps the dialog open', async () => {
  await e.goto('#/issues')
  await e.page.waitForSelector('.iss-row[data-id="3"]')
  await e.page.click('.iss-row[data-id="3"] [data-act="close"]')
  await e.page.waitForSelector(dlg)
  // Someone at another PC closes it first.
  assert.equal((await e.t.api('POST', '/api/flags/3/close', { note: 'Done at the CAM PC' }, { user: 'Sam CAM' })).status, 200)
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Fixed too')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`${dlg} [data-err]:not(.hidden)`)
  assert.match((await e.page.textContent(`${dlg} [data-err]`))!, /already closed .* by Sam CAM/)
  await e.page.click(`${dlg} [data-close]`)
  assert.equal(db().value(`SELECT closed_by FROM data_flags WHERE flag_id = 3`), 'Sam CAM')
  // The failed POST logs a resource error in the console; that one is expected.
  e.errors.splice(0, e.errors.length, ...e.errors.filter((m) => !/status of 409/.test(m)))
  assert.deepEqual(e.errors, [])
})

test('raise an issue for a holder found with the search picker', async () => {
  await e.goto('#/issues')
  await e.page.waitForSelector('.iss-list .iss-row')
  const before = (await e.t.api('GET', '/api/summary')).body.open_flags as number
  await e.page.click('[data-act="raise"]')
  await e.page.waitForSelector('dialog.iss-pick[open]')
  await e.page.fill('dialog.iss-pick [data-q]', 'A63.140.12')
  await e.page.waitForSelector('dialog.iss-pick .pick')
  const hid = String(db().value(`SELECT holder_id FROM holders WHERE order_no = 'A63.140.12'`))
  await e.page.click(`dialog.iss-pick .pick[data-pick="${hid}"]`)
  await e.page.waitForSelector(`${dlg} select[name="severity"]`)
  assert.match((await e.page.textContent(`${dlg} .flagdlg`))!, /HAIMER A63\.140\.12/)
  // The category box suggests the categories in use.
  const opts = await e.page.$$eval('#flagCategoryList option', (os) => os.map((o) => (o as HTMLOptionElement).value))
  assert.ok(opts.includes('Naming') && opts.includes('Gauge length') && opts.includes('hyperMILL'))
  await e.page.selectOption(`${dlg} select[name="severity"]`, 'MEDIUM')
  await e.page.fill(`${dlg} input[name="category"]`, 'naming')
  await e.page.fill(`${dlg} textarea[name="message"]`, 'hyperMILL name omits the 90 mm gauge length')
  await e.page.fill(`${dlg} textarea[name="action"]`, 'Add 90GL to the hyperMILL holder name')
  await e.page.click(`${dlg} button[type=submit]`)
  await waitHeaderFlags(before + 1)
  const f = db().get<any>(`SELECT * FROM data_flags WHERE message = 'hyperMILL name omits the 90 mm gauge length'`)!
  assert.equal(f.holder_id, hid)
  assert.equal(f.severity, 'MEDIUM')
  assert.equal(f.category, 'Naming')
  assert.equal(f.raised_by, 'E2E Tester')
  assert.equal(f.source, 'manual')
  await e.page.waitForSelector(`.iss-row[data-id="${f.flag_id}"]`)
  assert.match((await e.page.textContent(`.iss-row[data-id="${f.flag_id}"]`))!, /Raised \d{2}\/\d{2}\/\d{4} by E2E Tester/)
  assert.deepEqual(e.errors, [])
})

test('raise a general issue (no holder)', async () => {
  await e.goto('#/issues')
  await e.page.waitForSelector('.iss-list .iss-row')
  await e.page.click('[data-act="raise"]')
  await e.page.waitForSelector('dialog.iss-pick[open]')
  await e.page.click('dialog.iss-pick [data-general]')
  await e.page.waitForSelector(`${dlg} select[name="severity"]`)
  assert.match((await e.page.textContent(`${dlg} .flagdlg`))!, /general issue/)
  await e.page.selectOption(`${dlg} select[name="severity"]`, 'LOW')
  await e.page.fill(`${dlg} input[name="category"]`, 'Process')
  await e.page.fill(`${dlg} textarea[name="message"]`, 'Holder labels fade in the coolant')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(dlg, { state: 'detached' })
  const id = Number(db().value(`SELECT flag_id FROM data_flags WHERE message = 'Holder labels fade in the coolant' AND holder_id IS NULL`))
  assert.ok(id > 31)
  await e.page.waitForSelector(`.iss-row[data-id="${id}"]`)
  assert.match((await e.page.textContent(`.iss-row[data-id="${id}"] .iss-who`))!, /General/)
  assert.deepEqual(e.errors, [])
})

test('hyperMILL write-back: checklist, mark fixed records who, CSV and printable', async () => {
  await e.goto('#/issues/writeback')
  await e.page.waitForSelector('.wb-fix')
  const wb = (await e.t.api('GET', '/api/writeback')).body
  assert.equal((await e.page.$$('.wb-fix')).length, wb.count)
  assert.equal((await e.page.$$('.wb-holder')).length, new Set(wb.items.map((i: any) => i.holder_id ?? `g${i.flag_id}`)).size)
  // Current hyperMILL name and comment are shown for the CAM engineer.
  const arbor = await e.page.$('.wb-holder:has(a[href="#/holder/H0001"])')
  assert.match((await arbor!.textContent())!, /HAIMER SPIGOT ARBOR 16mm A63\.050\.16\.KKB 67GL/)
  assert.match((await arbor!.textContent())!, /Δ \+17 mm/)

  // Mark one fixed.
  const id = wb.items.find((i: any) => i.order_no === 'A63.145.06.3').flag_id
  await e.page.click(`.wb-fix[data-id="${id}"] [data-act="close"]`)
  await e.page.waitForSelector(dlg)
  assert.equal(await e.page.textContent(`${dlg} h2`), 'Mark fixed in hyperMILL')
  await e.page.fill(`${dlg} textarea[name="note"]`, 'Renamed to HAIMER 6mm POWER SHRINK ULTRA SHORT A63.145.06.3 70GL')
  await e.page.click(`${dlg} button[type=submit]`)
  await e.page.waitForSelector(`.wb-fix[data-id="${id}"]`, { state: 'detached' })
  assert.equal(await e.page.textContent('[data-wbcount]'), String(wb.count - 1))
  const f = db().get<any>(`SELECT status, closed_by, close_note FROM data_flags WHERE flag_id = ?`, [id])!
  assert.deepEqual([f.status, f.closed_by], ['CLOSED', 'E2E Tester'])
  assert.match(f.close_note, /POWER SHRINK ULTRA SHORT/)

  // CSV download.
  const [download] = await Promise.all([e.page.waitForEvent('download'), e.page.click('[data-act="wb-csv"]')])
  assert.match(download.suggestedFilename(), /^hypermill-writeback-\d{4}-\d{2}-\d{2}\.csv$/)

  // Printable checklist opens in a new window.
  const [popup] = await Promise.all([e.page.context().waitForEvent('page'), e.page.click('[data-act="wb-print"]')])
  await popup.waitForLoadState('domcontentloaded')
  assert.equal(await popup.title(), 'hyperMILL write-back')
  assert.equal((await popup.$$('tbody tr')).length, wb.count - 1)
  assert.match((await popup.textContent('body'))!, /Changes made by/)
  await popup.close()
  assert.deepEqual(e.errors, [])
})

test('flags CSV export from the list uses the filters', async () => {
  await e.goto('#/issues?severity=HIGH')
  await e.page.waitForSelector('.iss-list .iss-row')
  const [download] = await Promise.all([e.page.waitForEvent('download'), e.page.click('[data-act="csv"]')])
  assert.match(download.suggestedFilename(), /^issues-\d{4}-\d{2}-\d{2}\.csv$/)
  const { readFileSync } = await import('node:fs')
  const text = readFileSync((await download.path())!, 'utf8').replace(/^﻿/, '')
  const lines = text.trim().split('\r\n')
  assert.equal(lines.length, 2, 'header + the one HIGH flag')
  assert.match(lines[1]!, /^1,OPEN,HIGH,CAM model,H0010/)
  assert.deepEqual(e.errors, [])
})

test('works at tablet width without sideways scrolling', async () => {
  await e.page.setViewportSize({ width: 800, height: 1000 })
  for (const hash of ['#/issues', '#/issues/writeback']) {
    await e.goto(hash)
    await e.page.waitForSelector(hash.endsWith('writeback') ? '.wb-fix' : '.iss-row')
    const overflow = await e.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(overflow <= 0, `${hash} overflows by ${overflow}px`)
    const btn = await e.page.$(hash.endsWith('writeback') ? '.wb-fix [data-act="close"]' : '.iss-row [data-act="close"]')
    const box = await btn!.boundingBox()
    assert.ok(box && box.height >= 34, 'touch-sized buttons')
  }
  await e.page.setViewportSize({ width: 1280, height: 900 })
  assert.deepEqual(e.errors, [])
})
