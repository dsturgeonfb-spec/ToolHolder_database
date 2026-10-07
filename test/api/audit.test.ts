import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestApp } from '../helpers.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

const events = async (q = '') => (await t.api('GET', `/api/audit${q}`)).body as any[]

test('location add, edit and delete are recorded with the person', async () => {
  const add = await t.api('POST', '/api/locations', { name: 'Presetter', kind: 'crib' }, { user: 'Sam' })
  assert.equal(add.status, 200)
  const id = add.body.location_id
  await t.api('PATCH', `/api/locations/${id}`, { name: 'Zoller presetter' }, { user: 'Sam' })
  await t.api('DELETE', `/api/locations/${id}`, undefined, { user: 'Dave' })
  const ev = await events(`?entity=location&entity_id=${id}`)
  assert.deepEqual(ev.map((e) => e.action), ['DELETE', 'EDIT', 'ADD'])
  assert.deepEqual(ev.map((e) => e.by_user), ['Dave', 'Sam', 'Sam'])
  assert.match(ev[1].detail.changes[0], /Presetter.*Zoller presetter/)
})

test('want-list lines record add, top-up and status changes', async () => {
  const add = await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 2, reason: 'Ø12 job' })
  const id = add.body.wish_id
  await t.api('POST', '/api/wishlist', { holder_id: 'H0060', qty_wanted: 1 })
  await t.api('PATCH', `/api/wishlist/${id}`, { status: 'QUOTED' })
  await t.api('DELETE', `/api/wishlist/${id}`)
  const ev = await events(`?entity=wishlist&entity_id=${id}`)
  assert.deepEqual(ev.map((e) => e.action), ['STATUS', 'STATUS', 'EDIT', 'ADD'])
  assert.deepEqual(ev[0].detail.to, { status: 'CANCELLED' })
  assert.deepEqual(ev[1].detail.from, { status: 'OPEN' })
  assert.equal(ev[2].detail.qty_wanted, 3)
})

test('a unit inspection is a structured quality record', async () => {
  await t.api('POST', '/api/units', { unit_id: 'U-0001', holder_id: 'H0010' })
  await t.api('POST', '/api/units/U-0001/inspect', { runout_check_um: 2.5, passed: true })
  await t.api('POST', '/api/units/U-0001/inspect', { runout_check_um: 9, passed: false, note: 'taper fretting' }, { user: 'QA Inspector' })
  const ev = await events('?entity=unit&entity_id=U-0001')
  assert.deepEqual(ev.map((e) => e.action), ['INSPECT', 'INSPECT', 'ADD'])
  assert.deepEqual(
    { um: ev[0].detail.runout_check_um, passed: ev[0].detail.passed, before: ev[0].detail.status_before, after: ev[0].detail.status_after, by: ev[0].by_user },
    { um: 9, passed: false, before: 'IN_SERVICE', after: 'QUARANTINE', by: 'QA Inspector' },
  )
  assert.equal(ev[1].detail.passed, true)
})

test('audit export is a CSV of the events', async () => {
  const r = await t.api('GET', '/api/export/audit.csv?entity=unit')
  assert.equal(r.status, 200)
  assert.match(r.text.replace(/^\uFEFF/, ''), /^event_id,at,entity,entity_id,action,by_user,detail/)
  assert.match(r.text, /INSPECT/)
})
