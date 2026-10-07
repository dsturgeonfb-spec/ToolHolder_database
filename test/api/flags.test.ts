import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestApp } from '../helpers.js'
import { today } from '../../src/server/domain.js'

let t: TestApp
before(async () => (t = await startTestApp()))
after(async () => t.close())

const CAM = ['cam model', 'naming', 'gauge length', 'hypermill']
const sevCounts = (rows: Array<{ severity: string }>) =>
  rows.reduce<Record<string, number>>((m, r) => ((m[r.severity] = (m[r.severity] ?? 0) + 1), m), {})
const db = () => t.app.ctx.db
/** Open CAM-facing flags straight from the database — what the write-back report must contain. */
const expectedWriteback = () =>
  db()
    .all<{ flag_id: number; holder_id: string | null }>(
      `SELECT flag_id, holder_id FROM data_flags WHERE status = 'OPEN' AND LOWER(category) IN (${CAM.map(() => '?').join(',')}) ORDER BY flag_id`,
      CAM,
    )
const summary = async () => (await t.api('GET', '/api/summary')).body
/** Catalogue + stock fingerprint: closing/raising flags must never touch either. */
const fingerprint = () =>
  JSON.stringify([
    db().all('SELECT * FROM holders ORDER BY holder_id'),
    db().value('SELECT COUNT(*) FROM stock_transactions'),
    db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand'),
    db().value('SELECT COUNT(*) FROM holder_changes'),
  ])

// ------------------------------------------------------------------ reading (seeded state)

test('seeded flags: 31 (1 HIGH, 9 MEDIUM, 9 LOW, 12 INFO), all open, with holder fields joined', async () => {
  const r = await t.api('GET', '/api/flags')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body))
  assert.equal(r.body.length, 31)
  assert.deepEqual(sevCounts(r.body), { HIGH: 1, MEDIUM: 9, LOW: 9, INFO: 12 })
  assert.ok(r.body.every((f: any) => f.status === 'OPEN'))
  const high = r.body[0]
  assert.equal(high.severity, 'HIGH')
  assert.equal(high.holder_id, 'H0010')
  assert.equal(high.manufacturer, 'CERATIZIT')
  assert.equal(high.order_no, '84719607')
  assert.match(high.cam_name, /84719607/)
  for (const k of ['flag_id', 'category', 'message', 'action', 'raised_on', 'raised_by', 'source', 'closed_on', 'closed_by', 'close_note'])
    assert.ok(k in high, `flag has ${k}`)
})

test('flags are sorted OPEN first, then HIGH→INFO, then flag id', async () => {
  const rows = (await t.api('GET', '/api/flags?status=all')).body as any[]
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 } as Record<string, number>
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    const key = (f: any) => [f.status === 'OPEN' ? 0 : 1, rank[f.severity], f.flag_id]
    const [ka, kb] = [key(a), key(b)]
    const cmp = ka[0]! - kb[0]! || ka[1]! - kb[1]! || ka[2]! - kb[2]!
    assert.ok(cmp < 0, `row ${i} out of order`)
  }
})

test('19 open non-INFO issues — matches /api/summary', async () => {
  const r = await t.api('GET', '/api/flags?status=OPEN&severity=HIGH,MEDIUM,LOW')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 19)
  const s = await summary()
  assert.equal(s.open_flags, 19)
  assert.equal(s.open_high, 1)
  assert.equal(s.open_info, 12)
})

test('filters: status, severity, category, holder, free text', async () => {
  assert.equal((await t.api('GET', '/api/flags?status=CLOSED')).body.length, 0)
  assert.equal((await t.api('GET', '/api/flags?status=open')).body.length, 31)
  assert.equal((await t.api('GET', '/api/flags?severity=HIGH')).body.length, 1)
  assert.equal((await t.api('GET', '/api/flags?severity=info')).body.length, 12)
  assert.equal((await t.api('GET', '/api/flags?severity=MEDIUM,LOW')).body.length, 18)

  const naming = Number(db().value(`SELECT COUNT(*) FROM data_flags WHERE category = 'Naming'`))
  assert.equal((await t.api('GET', '/api/flags?category=Naming')).body.length, naming)
  assert.equal((await t.api('GET', '/api/flags?category=naming')).body.length, naming, 'category match ignores case')
  const nm = (await t.api('GET', '/api/flags?category=Naming&severity=MEDIUM')).body
  assert.ok(nm.length > 0 && nm.every((f: any) => f.category === 'Naming' && f.severity === 'MEDIUM'))

  const h2 = (await t.api('GET', '/api/flags?holder_id=H0002')).body
  assert.equal(h2.length, Number(db().value(`SELECT COUNT(*) FROM data_flags WHERE holder_id = 'H0002'`)))
  assert.ok(h2.every((f: any) => f.holder_id === 'H0002'))

  // Order no. (holder field), several terms that must all match, hyperMILL name, "#id".
  const byOrder = (await t.api('GET', '/api/flags?q=A63.140.08')).body
  assert.deepEqual(byOrder.map((f: any) => f.holder_id), ['H0048'])
  const short = (await t.api('GET', '/api/flags?q=' + encodeURIComponent('short shrink'))).body
  assert.ok(short.length >= 4)
  assert.ok(short.every((f: any) => /short/i.test(JSON.stringify(f)) && /shrink/i.test(JSON.stringify(f))))
  const byId = (await t.api('GET', '/api/flags?q=' + encodeURIComponent('#12'))).body
  assert.deepEqual(byId.map((f: any) => f.flag_id), [12])
  // LIKE wildcards are literal.
  assert.equal((await t.api('GET', '/api/flags?q=' + encodeURIComponent('%_%'))).body.length, 0)
  assert.equal((await t.api('GET', '/api/flags?q=zzzz-no-such-thing')).body.length, 0)
})

test('bad filter values are refused with a plain message', async () => {
  const s = await t.api('GET', '/api/flags?status=maybe')
  assert.equal(s.status, 400)
  assert.match(s.body.error, /OPEN, CLOSED or all/)
  const v = await t.api('GET', '/api/flags?severity=URGENT')
  assert.equal(v.status, 400)
  assert.match(v.body.error, /HIGH, MEDIUM, LOW or INFO/)
})

test('search: a very long pasted search is a plain 400, not a server error; only the first 20 words count', async () => {
  // ~1000 words used to build an SQL expression deeper than SQLite allows (500 "Expression tree is too large").
  const huge = await t.api('GET', '/api/flags?q=' + encodeURIComponent(Array(1000).fill('ab').join(' ')))
  assert.equal(huge.status, 400, JSON.stringify(huge.body))
  assert.match(huge.body.error, /Search text is too long \(at most 200 characters\)/)
  const csv = await t.api('GET', '/api/export/flags.csv?q=' + encodeURIComponent('x'.repeat(201)))
  assert.equal(csv.status, 400)
  assert.match(csv.body.error, /Search text is too long/)
  // 200 characters is allowed.
  const max = await t.api('GET', '/api/flags?q=' + encodeURIComponent(('a '.repeat(100)).slice(0, 200)))
  assert.equal(max.status, 200)
  // Words after the 20th are ignored, as in the catalogue search.
  const capped = await t.api('GET', '/api/flags?q=' + encodeURIComponent(`${Array(20).fill('a').join(' ')} zzzz-no-such-thing`))
  assert.equal(capped.status, 200)
  assert.equal(capped.body.length, (await t.api('GET', '/api/flags?q=a')).body.length)
})

test('raise: over-long text is refused with a message that names the field', async () => {
  const before = Number(db().value('SELECT COUNT(*) FROM data_flags'))
  const ok = { holder_id: 'H0048', severity: 'LOW', category: 'Data source', message: 'Long action test' }
  const action = await t.api('POST', '/api/flags', { ...ok, action: 'x'.repeat(2001) })
  assert.equal(action.status, 400)
  assert.match(action.body.error, /What should be done \(action\) is too long \(at most 2000 characters\)/)
  const holder = await t.api('POST', '/api/flags', { ...ok, holder_id: 'H'.repeat(41) })
  assert.equal(holder.status, 400)
  assert.match(holder.body.error, /Holder id is too long/)
  const category = await t.api('POST', '/api/flags', { ...ok, category: 'c'.repeat(61) })
  assert.equal(category.status, 400)
  assert.match(category.body.error, /Category is too long/)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM data_flags')), before, 'nothing was written')
  // 2000 characters is still fine.
  const fits = await t.api('POST', '/api/flags', { ...ok, action: 'y'.repeat(2000) })
  assert.equal(fits.status, 201)
})

test('categories: distinct, sorted', async () => {
  const r = await t.api('GET', '/api/flags/categories')
  assert.equal(r.status, 200)
  const want = db()
    .all<{ c: string }>(`SELECT DISTINCT category AS c FROM data_flags ORDER BY LOWER(category)`)
    .map((x) => x.c)
  assert.deepEqual(r.body, want)
  assert.ok(r.body.includes('Naming') && r.body.includes('Gauge length') && r.body.includes('CAM model'))
})

test('single flag by id; unknown and malformed ids', async () => {
  const r = await t.api('GET', '/api/flags/2')
  assert.equal(r.status, 200)
  assert.equal(r.body.flag_id, 2)
  assert.equal(r.body.order_no, 'A63.140.08')
  assert.equal((await t.api('GET', '/api/flags/99999')).status, 404)
  assert.equal((await t.api('GET', '/api/flags/abc')).status, 400)
})

// ------------------------------------------------------------------ write-back report

test('write-back: open CAM-facing flags joined to the holder hyperMILL data (derived from the DB)', async () => {
  const want = expectedWriteback()
  const r = await t.api('GET', '/api/writeback')
  assert.equal(r.status, 200)
  assert.equal(r.body.count, want.length)
  assert.equal(r.body.items.length, want.length)
  assert.deepEqual(
    r.body.items.map((i: any) => i.flag_id).sort((a: number, b: number) => a - b),
    want.map((w) => w.flag_id),
  )
  assert.equal(r.body.holders, new Set(want.map((w) => w.holder_id).filter(Boolean)).size)
  assert.deepEqual(r.body.categories, ['CAM model', 'Naming', 'Gauge length', 'hyperMILL'])
  assert.ok(r.body.items.every((i: any) => CAM.includes(String(i.category).toLowerCase())))
  // The HIGH CAM-model flag comes first; INFO CAM items are included (e.g. "no comment in hyperMILL").
  assert.equal(r.body.items[0].severity, 'HIGH')
  assert.ok(r.body.items.some((i: any) => i.severity === 'INFO'))
  // Holder fields come from the holder row.
  for (const i of r.body.items) {
    if (!i.holder_id) continue
    const h = db().get<any>(`SELECT order_no, cam_name, cam_comment, cam_gl_mm, gauge_length_mm FROM holders WHERE holder_id = ?`, [i.holder_id])!
    assert.equal(i.order_no, h.order_no)
    assert.equal(i.cam_name, h.cam_name)
    assert.equal(i.cam_comment, h.cam_comment)
    assert.equal(i.cam_gl_mm, h.cam_gl_mm)
    assert.equal(i.gauge_length_mm, h.gauge_length_mm)
  }
  // Haimer face mill arbor: hyperMILL GL = A + spigot (BUILD_SPEC §3) → delta shown.
  const arbor = r.body.items.find((i: any) => i.order_no === 'A63.050.16.KKB' && i.category === 'Gauge length')
  assert.equal(arbor.gl_delta_mm, 17)
  // Data source / Purchasing flags are not hyperMILL fixes.
  assert.ok(!r.body.items.some((i: any) => ['Data source', 'Purchasing'].includes(i.category)))
})

test('write-back CSV export: one row per fix, Excel-friendly', async () => {
  const want = expectedWriteback()
  const r = await t.api('GET', '/api/export/writeback.csv')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type')!, /text\/csv/)
  assert.match(r.headers.get('content-disposition')!, /^attachment; filename="hypermill-writeback-\d{4}-\d{2}-\d{2}\.csv"/)
  // fetch's text() drops a BOM, so look at the bytes.
  const raw = Buffer.from(await (await fetch(t.base + '/api/export/writeback.csv')).arrayBuffer())
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel')
  const lines = r.text.replace(/^﻿/, '').trim().split('\r\n')
  assert.match(lines[0]!, /^issue_no,severity,category,holder_id,manufacturer,order_no,spec_code,hypermill_name,hypermill_comment,hypermill_gl_mm,maker_gl_mm/)
  // Messages have no embedded newlines in the seed, so line count = rows + header.
  assert.equal(lines.length, want.length + 1)
  assert.ok(r.text.includes('HAIMER 8mm STD SHRINK A63-140-08 90GL'), 'current hyperMILL comment is listed')
})

test('write-back printable HTML: inline, escaped, lists every fix', async () => {
  const want = expectedWriteback()
  const r = await t.api('GET', '/api/export/writeback.html')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type')!, /text\/html/)
  assert.match(r.headers.get('content-disposition')!, /^inline;/)
  assert.match(r.text, /<title>hyperMILL write-back<\/title>/)
  for (const w of want) assert.ok(r.text.includes(`#${w.flag_id}<br>`), `fix #${w.flag_id} listed`)
  assert.match(r.text, new RegExp(`${want.length} open fixes`))
})

// ------------------------------------------------------------------ raising

test('raise: needs a person, a severity, a category and a message', async () => {
  const before = Number(db().value('SELECT COUNT(*) FROM data_flags'))
  const ok = { holder_id: 'H0048', severity: 'LOW', category: 'Naming', message: 'Test message', action: 'Do it' }
  const noUser = await t.api('POST', '/api/flags', ok, { user: null })
  assert.equal(noUser.status, 400)
  assert.match(noUser.body.error, /name/i)
  assert.equal((await t.api('POST', '/api/flags', { ...ok, severity: '' })).status, 400)
  const badSev = await t.api('POST', '/api/flags', { ...ok, severity: 'CRITICAL' })
  assert.equal(badSev.status, 400)
  assert.match(badSev.body.error, /HIGH, MEDIUM, LOW or INFO/)
  assert.equal((await t.api('POST', '/api/flags', { ...ok, category: '  ' })).status, 400)
  const noMsg = await t.api('POST', '/api/flags', { ...ok, message: '' })
  assert.equal(noMsg.status, 400)
  assert.match(noMsg.body.error, /required/)
  const noHolder = await t.api('POST', '/api/flags', { ...ok, holder_id: 'H9999' })
  assert.equal(noHolder.status, 404)
  assert.match(noHolder.body.error, /H9999/)
  assert.equal((await t.api('POST', '/api/flags', { ...ok, message: 'x'.repeat(2001) })).status, 400)
  // No CSRF header → refused by the server.
  const res = await fetch(t.base + '/api/flags', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': 'X' }, body: JSON.stringify(ok) })
  assert.equal(res.status, 403)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM data_flags')), before, 'nothing was written')
})

test('raise for a holder: recorded with the person, today, source manual; summary updates', async () => {
  const fp = fingerprint()
  const s0 = await summary()
  const r = await t.api('POST', '/api/flags', {
    holder_id: 'H0048',
    severity: 'medium',
    category: 'naming',
    message: '  hyperMILL name lacks the clamp range  ',
    action: 'Rename in hyperMILL',
  }, { user: 'Dave Sturgeon' })
  assert.equal(r.status, 201)
  assert.equal(r.body.created, true)
  assert.equal(r.body.status, 'OPEN')
  assert.equal(r.body.severity, 'MEDIUM')
  assert.equal(r.body.category, 'Naming', 'category takes the existing spelling')
  assert.equal(r.body.message, 'hyperMILL name lacks the clamp range')
  assert.equal(r.body.raised_by, 'Dave Sturgeon')
  assert.equal(r.body.source, 'manual')
  assert.equal(r.body.raised_on, today())
  assert.equal(r.body.order_no, 'A63.140.08')
  assert.equal(r.body.manufacturer, 'HAIMER')
  const s1 = await summary()
  assert.equal(s1.open_flags, s0.open_flags + 1)
  assert.equal(fingerprint(), fp, 'raising a flag never touches catalogue or stock')
  // It is a CAM-facing category, so it is on the write-back list.
  const wb = (await t.api('GET', '/api/writeback')).body
  assert.ok(wb.items.some((i: any) => i.flag_id === r.body.flag_id))
})

test('raise: an identical open flag is not duplicated', async () => {
  const body = { holder_id: 'H0010', severity: 'LOW', category: 'Data source', message: 'Duplicate check message', action: null }
  const a = await t.api('POST', '/api/flags', body)
  assert.equal(a.status, 201)
  const n = Number(db().value('SELECT COUNT(*) FROM data_flags'))
  const b = await t.api('POST', '/api/flags', { ...body, message: ' Duplicate check message ', category: 'data source' })
  assert.equal(b.status, 200)
  assert.equal(b.body.created, false)
  assert.equal(b.body.flag_id, a.body.flag_id)
  assert.equal(Number(db().value('SELECT COUNT(*) FROM data_flags')), n)
  // The same message for a different holder is a different flag.
  const c = await t.api('POST', '/api/flags', { ...body, holder_id: 'H0011' })
  assert.equal(c.status, 201)
  assert.notEqual(c.body.flag_id, a.body.flag_id)
})

test('raise a general issue (no holder) and an INFO note (not counted as an open issue)', async () => {
  const s0 = await summary()
  const g = await t.api('POST', '/api/flags', { severity: 'LOW', category: 'Process', message: 'Holder labels fade in the coolant', action: 'Trial laser marking' })
  assert.equal(g.status, 201)
  assert.equal(g.body.holder_id, null)
  assert.equal(g.body.order_no, null)
  const info = await t.api('POST', '/api/flags', { holder_id: '', severity: 'INFO', category: 'Process', message: 'Noted for the record' })
  assert.equal(info.status, 201)
  assert.equal(info.body.holder_id, null)
  const s1 = await summary()
  assert.equal(s1.open_flags, s0.open_flags + 1, 'INFO does not count as an open issue')
  assert.equal(s1.open_info, s0.open_info + 1)
  const cats = (await t.api('GET', '/api/flags/categories')).body
  assert.ok(cats.includes('Process'))
  // A new category spelled like a CAM category is stored with the standard spelling → on the write-back.
  const hm = await t.api('POST', '/api/flags', { holder_id: 'H0001', severity: 'LOW', category: 'HYPERMILL', message: 'Arbor model has no spigot chamfer' })
  assert.equal(hm.body.category, 'hyperMILL')
  const wb = (await t.api('GET', '/api/writeback')).body
  assert.ok(wb.items.some((i: any) => i.flag_id === hm.body.flag_id))
  assert.ok(!wb.items.some((i: any) => i.flag_id === g.body.flag_id), 'non-CAM categories stay off the write-back')
})

// ------------------------------------------------------------------ closing and reopening

test('close: needs the person and a note saying what was done', async () => {
  const noUser = await t.api('POST', '/api/flags/2/close', { note: 'Fixed' }, { user: null })
  assert.equal(noUser.status, 400)
  assert.match(noUser.body.error, /name/i)
  const noNote = await t.api('POST', '/api/flags/2/close', {})
  assert.equal(noNote.status, 400)
  assert.match(noNote.body.error, /What was done/)
  assert.equal((await t.api('POST', '/api/flags/2/close', { note: '   ' })).status, 400)
  assert.equal((await t.api('POST', '/api/flags/99999/close', { note: 'x' })).status, 404)
  assert.equal((await t.api('POST', '/api/flags/x/close', { note: 'x' })).status, 400)
  assert.equal(db().value(`SELECT status FROM data_flags WHERE flag_id = 2`), 'OPEN')
})

test('close: records who, when and what; open_flags in /api/summary drops; write-back drops it', async () => {
  const fp = fingerprint()
  const s0 = await summary()
  const wb0 = (await t.api('GET', '/api/writeback')).body
  assert.ok(wb0.items.some((i: any) => i.flag_id === 2))
  const r = await t.api('POST', '/api/flags/2/close', { note: 'Comment changed to 80GL in hyperMILL' }, { user: 'Sam CAM' })
  assert.equal(r.status, 200)
  assert.equal(r.body.status, 'CLOSED')
  assert.equal(r.body.closed_by, 'Sam CAM')
  assert.equal(r.body.closed_on, today())
  assert.equal(r.body.close_note, 'Comment changed to 80GL in hyperMILL')
  const s1 = await summary()
  assert.equal(s1.open_flags, s0.open_flags - 1)
  const wb1 = (await t.api('GET', '/api/writeback')).body
  assert.equal(wb1.count, wb0.count - 1)
  assert.ok(!wb1.items.some((i: any) => i.flag_id === 2))
  assert.equal(fingerprint(), fp, 'closing never changes catalogue or stock data')
  // Closed list and flag never deleted.
  const closed = (await t.api('GET', '/api/flags?status=CLOSED')).body
  assert.ok(closed.some((f: any) => f.flag_id === 2))
  // Closing twice is refused.
  const again = await t.api('POST', '/api/flags/2/close', { note: 'again' })
  assert.equal(again.status, 409)
  assert.match(again.body.error, /already closed/)
  // Closing an INFO note leaves the open-issue count alone.
  const s2 = await summary()
  assert.equal((await t.api('POST', '/api/flags/31/close', { note: 'Consistent — nothing to do' })).status, 200)
  const s3 = await summary()
  assert.equal(s3.open_flags, s2.open_flags)
  assert.equal(s3.open_info, s2.open_info - 1)
})

test('reopen: needs person and note; back to OPEN with the history kept in action', async () => {
  assert.equal((await t.api('POST', '/api/flags/2/reopen', { note: 'x' }, { user: null })).status, 400)
  const noNote = await t.api('POST', '/api/flags/2/reopen', {})
  assert.equal(noNote.status, 400)
  assert.equal((await t.api('POST', '/api/flags/3/reopen', { note: 'x' })).status, 409, 'an open flag cannot be reopened')
  const before = db().get<any>(`SELECT action FROM data_flags WHERE flag_id = 2`)!
  const s0 = await summary()
  const r = await t.api('POST', '/api/flags/2/reopen', { note: 'Still says 90GL after import' }, { user: 'Dave Sturgeon' })
  assert.equal(r.status, 200)
  assert.equal(r.body.status, 'OPEN')
  assert.equal(r.body.closed_on, null)
  assert.equal(r.body.closed_by, null)
  assert.equal(r.body.close_note, null)
  assert.ok(r.body.action.startsWith(before.action + '\n'), 'original action kept')
  const last = r.body.action.split('\n').pop()
  assert.ok(last.startsWith(`Reopened ${today()} by Dave Sturgeon: Still says 90GL after import`))
  assert.match(last, /was closed .* by Sam CAM: Comment changed to 80GL in hyperMILL/)
  assert.equal((await summary()).open_flags, s0.open_flags + 1)
  assert.ok((await t.api('GET', '/api/writeback')).body.items.some((i: any) => i.flag_id === 2))
})

test('reopen is refused when the same issue was raised again meanwhile', async () => {
  const body = { holder_id: 'H0047', severity: 'LOW', category: 'Naming', message: 'Twin test' }
  const a = await t.api('POST', '/api/flags', body)
  assert.equal((await t.api('POST', `/api/flags/${a.body.flag_id}/close`, { note: 'done' })).status, 200)
  // Once closed, raising the same thing again makes a new flag (dedupe is for OPEN flags only).
  const b = await t.api('POST', '/api/flags', body)
  assert.equal(b.status, 201)
  assert.notEqual(b.body.flag_id, a.body.flag_id)
  const re = await t.api('POST', `/api/flags/${a.body.flag_id}/reopen`, { note: 'back' })
  assert.equal(re.status, 409)
  assert.match(re.body.error, new RegExp(`#${b.body.flag_id}`))
})

// ------------------------------------------------------------------ exports with writes in place

test('flags CSV export honours the filters', async () => {
  const all = await t.api('GET', '/api/export/flags.csv?status=all')
  assert.equal(all.status, 200)
  assert.match(all.headers.get('content-type')!, /text\/csv/)
  assert.match(all.headers.get('content-disposition')!, /^attachment; filename="issues-\d{4}-\d{2}-\d{2}\.csv"/)
  const n = Number(db().value('SELECT COUNT(*) FROM data_flags'))
  const lines = all.text.replace(/^﻿/, '').trim().split('\r\n')
  assert.equal(lines[0], 'issue_no,status,severity,category,holder_id,manufacturer,order_no,hypermill_name,message,action,raised_on,raised_by,source,closed_on,closed_by,close_note')
  // Reopen history puts newlines inside one quoted field, so count records by parsing.
  const { parseCsv } = await import('../../src/server/lib/csv.js')
  assert.equal(parseCsv(all.text).length, n + 1)
  const high = parseCsv((await t.api('GET', '/api/export/flags.csv?status=OPEN&severity=HIGH')).text)
  assert.equal(high.length, 2)
  assert.equal(high[1]![2], 'HIGH')
  const closed = parseCsv((await t.api('GET', '/api/export/flags.csv?status=CLOSED')).text)
  assert.ok(closed.slice(1).every((row) => row[1] === 'CLOSED' && row[14]))
  assert.equal((await t.api('GET', '/api/export/flags.csv?severity=BAD')).status, 400)
})

test('exports neutralise spreadsheet formulas and HTML in user text', async () => {
  const r = await t.api('POST', '/api/flags', {
    holder_id: 'H0040',
    severity: 'LOW',
    category: 'Naming',
    message: '=HYPERLINK("http://x") <script>alert(1)</script>',
    action: '<b>bold</b>',
  })
  assert.equal(r.status, 201)
  const csv = (await t.api('GET', '/api/export/writeback.csv')).text
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"") <script>alert(1)</script>"`), 'formula prefixed with a quote')
  const html = (await t.api('GET', '/api/export/writeback.html')).text
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'))
})

test('acceptance numbers are untouched by flag work: still 54 on site', () => {
  assert.equal(Number(db().value('SELECT SUM(qty_on_site) FROM v_stock_on_hand')), 54)
})
