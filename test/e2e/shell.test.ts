import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startE2E, type E2E } from './helpers.js'

let e: E2E
before(async () => (e = await startE2E()))
after(async () => e.close())

test('shell loads: header strip shows the seeded tally and the user', async () => {
  await e.goto('#/catalogue')
  await e.page.waitForFunction(() => document.getElementById('tTotal')?.textContent === '54')
  assert.equal(await e.page.textContent('#tArticles'), '54')
  assert.equal(await e.page.textContent('#tCounted'), '0/54')
  assert.equal(await e.page.textContent('#userName'), 'E2E Tester')
})

test('every tab renders without script errors', async () => {
  for (const tab of ['catalogue', 'count', 'tally', 'issues', 'want', 'units', 'import', 'vendors', 'log', 'settings', 'locations', 'holder/H0001']) {
    await e.goto('#/' + tab)
    const err = await e.page.$('#view .errorbox')
    assert.equal(err ? await err.textContent() : null, null, `view ${tab} failed`)
  }
  assert.deepEqual(e.errors, [])
})
