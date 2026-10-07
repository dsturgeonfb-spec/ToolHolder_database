import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FIXTURES } from '../helpers.js'
import { startE2E, type E2E } from './helpers.js'

const HM = join(FIXTURES, 'hypermill')
let e: E2E
before(async () => (e = await startE2E()))
after(async () => e.close())

const db = () => e.t.app.ctx.db
/** Requests a test provokes on purpose (4xx answers) show up as console errors; anything else is a bug. */
const unexpectedErrors = (allowed: RegExp[] = []) => e.errors.filter((m) => !allowed.some((re) => re.test(m)))
const count = (key: string) => e.page.textContent(`[data-count="${key}"]`)

async function previewPath(path: string) {
  const p = e.page
  await p.fill('[data-path]', path)
  await p.click('[data-act=preview]')
  await p.waitForSelector('[data-preview], [data-error]')
}

test('the import view explains itself; no file picker in a plain browser; empty history', async () => {
  const p = e.page
  await e.goto('#/import')
  await p.waitForSelector('[data-form]')
  const explain = (await p.textContent('.hm-explain'))!
  assert.match(explain, /never deletes/)
  assert.match(explain, /opening balance of 1/)
  assert.equal(await p.$('[data-act=pick]'), null, 'window.desktop is absent in the browser')
  assert.match((await p.getAttribute('[data-path]', 'placeholder'))!, /OPEN MIND\\tooldbReport/)
  assert.equal(await p.inputValue('[data-iface]'), 'HSK-A63')
  await p.waitForFunction(() => /No hyperMILL imports yet/.test(document.querySelector('[data-history]')!.textContent!))
  // Preview with no path: told what to do, no request made.
  await p.fill('[data-path]', '')
  await p.click('[data-act=preview]')
  assert.match((await p.textContent('[data-error]'))!, /Enter the path/)
  assert.deepEqual(unexpectedErrors(), [])
})

test('preview and apply the changed report through the UI', async () => {
  const p = e.page
  await e.goto('#/import')
  await previewPath(join(HM, 'report_changed.html'))
  assert.equal(await count('new'), '2')
  assert.equal(await count('renamed'), '1')
  assert.equal(await count('changed'), '1')
  assert.equal(await count('removed'), '1')
  assert.equal(await count('unmatched'), '1')
  assert.equal(await count('warnings'), '1')
  assert.match((await p.textContent('[data-unchanged]'))!, /Unchanged: 51 holders/)
  const newSec = (await p.textContent('[data-sec="new"]'))!
  assert.match(newSec, /A63\.140\.14/)
  assert.match(newSec, /NIKKEN/)
  assert.match(newSec, /new maker/)
  assert.match(newSec, /not recognised/)
  assert.match((await p.textContent('[data-sec="renamed"]'))!, /SHRINK FIT CHUCK A63\.140\.06/)
  assert.match((await p.textContent('[data-sec="changed"]'))!, /CAM gauge length\s*90 mm\s*→\s*95 mm/)
  assert.match((await p.textContent('[data-sec="removed"]'))!, /A63\.144\.08/)
  assert.match((await p.textContent('[data-sec="unmatched"]'))!, /SPARE HOLDER CELL 3/)
  // The new holders' profile pictures come from the preview and actually load.
  await p.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-sec="new"] .hm-thumb img'))
    return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth === 300)
  })
  // Enlarge one.
  await p.click('[data-sec="new"] .hm-thumb')
  await p.waitForSelector('dialog.dlg .hm-zoom img')
  await p.click('dialog.dlg [data-close]')

  const before = Number(db().value('SELECT COUNT(*) FROM holders'))
  await p.click('[data-act=apply]')
  await p.waitForSelector('dialog.dlg [data-ok]')
  assert.match((await p.textContent('dialog.dlg'))!, /2 new holders/)
  await p.click('dialog.dlg [data-ok]')
  await p.waitForSelector('[data-result-done]')
  const done = (await p.textContent('[data-result-done]'))!
  assert.match(done, /2 new holders, 2 holders updated, 7 issues raised, 2 opening balances booked/)
  assert.equal(await p.getAttribute('[data-result-done] a[href="#/holder/H0089"]', 'href'), '#/holder/H0089')
  assert.ok(await p.$('[data-result-done] a[href="#/holder/H0090"]'))
  assert.ok(await p.$('[data-result-done] a[href="#/issues"]'))
  // The count button goes to counting the new holders (a run can start at one holder; each has its own "count it").
  const countBtn = await p.$('[data-result-done] [data-count-new]')
  assert.ok(countBtn, 'a button to count the new holders')
  assert.equal(await countBtn.getAttribute('href'), '#/count?holder=H0089')
  assert.equal((await countBtn.textContent())!.trim(), 'Count the first new holder')
  assert.ok(await p.$('[data-result-done] a[href="#/count?holder=H0090"]'), 'the second one has its own count link')
  assert.equal(Number(db().value('SELECT COUNT(*) FROM holders')), before + 2)
  // Header strip refreshed: 56 on site, 2 more to count.
  await p.waitForFunction(() => document.getElementById('tTotal')?.textContent === '56')
  assert.equal(await p.textContent('#tCounted'), '0/56')
  // History shows the run.
  await p.waitForFunction(() => document.querySelectorAll('.hm-history tbody tr').length === 1)
  const row = (await p.textContent('.hm-history tbody tr'))!
  assert.match(row, /E2E Tester/)
  assert.match(row, /report_changed\.html/)

  // Preview again: nothing left to apply.
  await p.click('[data-result-done] [data-act=again]')
  await p.waitForSelector('[data-preview]')
  assert.equal(await count('new'), '0')
  assert.match((await p.textContent('.hm-apply'))!, /Nothing to apply/)
  assert.equal(await p.$('[data-act=apply]'), null)

  // The new holder opens from the link.
  await e.goto('#/holder/H0089')
  await p.waitForFunction(() => /A63\.140\.14/.test(document.getElementById('view')!.textContent!))

  // The maker the import added can be picked straight away, without restarting the app.
  await e.goto('#/catalogue')
  await p.waitForSelector('#fmk')
  assert.ok((await p.$$eval('#fmk option', (os) => os.map((o) => (o as HTMLOptionElement).value))).includes('NIKKEN'), 'catalogue maker filter')
  await e.goto('#/count')
  await p.waitForSelector('select[data-f=mk]')
  assert.ok((await p.$$eval('select[data-f=mk] option', (os) => os.map((o) => (o as HTMLOptionElement).value))).includes('NIKKEN'), 'count maker filter')

  // The count link opens Count on the new holder.
  await e.goto('#/count?holder=H0089')
  await p.waitForSelector('[data-card] .cm-ord')
  assert.match((await p.textContent('[data-card]'))!, /A63\.140\.14/)
  assert.deepEqual(unexpectedErrors(), [])
})

test('errors read plainly: a wrong path, and a catalogue that changed after the preview', async () => {
  const p = e.page
  await e.goto('#/import')
  await previewPath(join(HM, 'no-such-report.html'))
  assert.match((await p.textContent('[data-error]'))!, /No file at .*no-such-report\.html/)

  await previewPath(join(HM, 'report_54.html'))
  assert.equal(await count('renamed'), '1')
  // Someone else changes a holder before this preview is applied.
  db().run(`UPDATE holders SET cam_comment = 'changed meanwhile' WHERE holder_id = 'H0020'`)
  await p.click('[data-act=apply]')
  await p.click('dialog.dlg [data-ok]')
  await p.waitForSelector('[data-error]')
  assert.match((await p.textContent('[data-error]'))!, /The catalogue changed since the preview — preview again/)
  await p.click('[data-error] [data-act=again]')
  await p.waitForSelector('[data-preview]')
  assert.match((await p.textContent('[data-sec="changed"]'))!, /changed meanwhile/)
  // Editing the path after a preview withdraws it, so the wrong report can't be applied.
  await p.fill('[data-path]', join(HM, 'report_changed.html'))
  await p.waitForSelector('.infobox')
  assert.equal(await p.$('[data-act=apply]'), null)
  assert.deepEqual(unexpectedErrors([/status of 400/, /status of 409/]), [])
})

test('works at tablet width without sideways scrolling', async () => {
  const p = e.page
  await p.setViewportSize({ width: 800, height: 1000 })
  await e.goto('#/import')
  await previewPath(join(HM, 'report_changed.html'))
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`)
  await p.setViewportSize({ width: 1280, height: 900 })
})

test('a network client is told to run the import on the host PC', async () => {
  const p = e.page
  await e.goto('#/import')
  await p.evaluate(async () => {
    const m = await import('/ui/js/state.js' as string)
    m.state.session.host = false
  })
  await e.goto('#/catalogue')
  await e.goto('#/import')
  await p.waitForSelector('[data-not-host]')
  assert.match((await p.textContent('[data-not-host]'))!, /host PC/)
  assert.equal(await p.$('[data-path]'), null)
  await p.waitForSelector('.hm-history')
  await p.evaluate(async () => {
    const m = await import('/ui/js/state.js' as string)
    m.state.session.host = true
  })
  assert.deepEqual(unexpectedErrors([/status of 400/, /status of 409/]), [])
})
