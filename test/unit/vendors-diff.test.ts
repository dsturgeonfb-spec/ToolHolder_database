import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO } from '../helpers.js'
import { migrate, openDatabase, type Db } from '../../src/server/db.js'
import { mergeDims, parseApprove, proposalFor, sameValue, sanitizeRecord, statusAfter } from '../../src/server/vendors/diff.js'
import type { HolderRecord } from '../../src/server/vendors/types.js'
import { OTHER_TYPE_WARNING } from '../../src/server/vendors/classify.js'

let db: Db
let dir: string
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-diff-'))
  copyFileSync(join(REPO, 'db', 'holder_catalogue.sqlite'), join(dir, 'db.sqlite'))
  db = openDatabase(join(dir, 'db.sqlite'))
  migrate(db, readFileSync(join(REPO, 'db', 'schema.sql'), 'utf8'))
})
after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const rec = (r: Partial<HolderRecord>): HolderRecord => ({ manufacturer: 'HAIMER', order_no: 'A63.182.03.8', data_status: 'verified', data_source: 'shop.haimer.com', ...r })

test('equality: numbers within 0.01, text with whitespace collapsed, blanks equal', () => {
  assert.equal(sameValue('gauge_length_mm', 160, 160.009), true)
  assert.equal(sameValue('gauge_length_mm', 160, 160.02), false)
  assert.equal(sameValue('mass_kg', 1.265, '1.265'), true)
  assert.equal(sameValue('product_name', 'Power  Mini Shrink Chuck ', 'Power Mini Shrink Chuck'), true)
  assert.equal(sameValue('product_name', null, ''), true)
  assert.equal(sameValue('product_name', null, 'x'), false)
})

test('dims merge: adds new labels, replaces changed values, never removes; labels match ignoring case/underscores', () => {
  const ours = { 'L length': 32.5, length_adjustment: 'axial', d1: 6 }
  const { merged, changed } = mergeDims(ours, { 'L Length': 32.5, 'Length adjustment': 'radial', d1: 6.004, 'A4 Flange diameter': 63, empty: '' })
  assert.deepEqual(merged, { 'L length': 32.5, length_adjustment: 'radial', d1: 6, 'A4 Flange diameter': 63 })
  assert.deepEqual(changed, ['length_adjustment', 'A4 Flange diameter'])
  assert.deepEqual(mergeDims(ours, undefined).changed, [])
})

test('existing holder with identical maker data → same', () => {
  const p = proposalFor(
    db,
    rec({ clamp_dia_mm: 3, clamp_min_mm: 3, clamp_max_mm: 3, gauge_length_mm: 160, nose_dia_mm: 9, mass_kg: 1.265, product_name: 'Power Mini Shrink Chuck, DIN 69893-1, HSK-A63', dims: { 'D2 Diameter 2': 9 }, interface_seen: 'HSK-A63' }),
    'HSK-A63',
  )
  assert.equal(p.action, 'same')
  assert.equal(p.holder_id, 'H0025')
  assert.deepEqual(p.fields, {})
})

test('update: changed maker values proposed; null/empty from the source never blanks ours; curated text only fills gaps', () => {
  const p = proposalFor(
    db,
    rec({ gauge_length_mm: 161, gauge_length_ref: 'A (new label)', nose_dia_mm: null, mass_kg: undefined, series: 'Something else', coolant: 'New coolant text', image_url: 'https://shop.haimer.com/media/a.jpg', product_name: '' }),
    'HSK-A63',
  )
  assert.equal(p.action, 'update')
  assert.deepEqual(Object.keys(p.fields).sort(), ['gauge_length_mm', 'gauge_length_ref', 'image_url'])
  assert.deepEqual(p.fields.gauge_length_mm, { old: 160, new: 161 })
  assert.deepEqual(p.fields.gauge_length_ref, { old: 'A', new: 'A (new label)' }, 'a new GL brings its label')
  // series/coolant are curated and already set → not proposed; nose/mass/product_name blank → not proposed.
  const fill = proposalFor(db, rec({ order_no: 'A63.140.04', nose_dia_mm: 10, mass_kg: 0.74, balance: 'G2.5/25000' }), 'HSK-A63')
  assert.deepEqual(Object.keys(fill.fields).sort(), ['balance', 'mass_kg', 'nose_dia_mm'], 'empty fields of a partial row are filled')
})

test('insert: unknown order no. → every value the source gave, with the scan interface', () => {
  const p = proposalFor(db, rec({ order_no: 'A63.147.05.1', type_code: 'SHRINK', clamp_dia_mm: 5, gauge_length_mm: 120, dims: { DF: 63 } }), 'HSK-A63')
  assert.equal(p.action, 'insert')
  assert.equal(p.holder_id, undefined)
  assert.deepEqual(p.fields.interface_code, { old: null, new: 'HSK-A63' })
  assert.deepEqual(p.fields.dims, { old: null, new: { DF: 63 } })
  assert.equal(p.fields.mass_kg, undefined)
})

test('interface checks: a product for another interface is an error row; form-only is a warning; order no. case differences match', () => {
  assert.equal(proposalFor(db, rec({ interface_seen: 'Power Mini Shrink Chuck, DIN 69893-1, HSK-A50' }), 'HSK-A63').action, 'error')
  const formOnly = proposalFor(db, rec({ interface_seen: 'ISO 12164 (HSK-A)' }), 'HSK-A63')
  assert.equal(formOnly.action, 'same')
  assert.match(formOnly.warnings.join(' '), /only names the form/)
  assert.equal(proposalFor(db, rec({ interface_code: 'HSK-A100' }), 'HSK-A63').action, 'error')
  const lower = proposalFor(db, rec({ order_no: 'a63.182.03.8' }), 'HSK-A63')
  assert.equal(lower.holder_id, 'H0025')
  assert.match(lower.warnings.join(' '), /spells the order no/)
  assert.equal(proposalFor(db, rec({ manufacturer: 'NOBODY' }), 'HSK-A63').action, 'error')
})

test('sanitize: implausible numbers, non-web links and unknown types are dropped with a warning', () => {
  const r = sanitizeRecord(db, rec({ gauge_length_mm: -5, mass_kg: 9999, max_rpm: 1.5, image_url: 'javascript:alert(1)', drawing_url: 'file:///c:/x.pdf', type_code: 'LASER', product_name: '  Power\u0007 Chuck  ' }))
  assert.equal(r.gauge_length_mm, null)
  assert.equal(r.mass_kg, null)
  assert.equal(r.max_rpm, null)
  assert.equal(r.image_url, null)
  assert.equal(r.drawing_url, null)
  assert.equal(r.type_code, 'OTHER')
  assert.equal(r.product_name, 'Power Chuck')
  assert.equal(r.warnings!.length, 5)
  // The unknown type is noted separately: it only matters if the record becomes a new holder.
  assert.deepEqual(r.type_warnings, ['Holder type "LASER" is not one of ours — it will be added as "Other".'])
})

test('"will be added as Other" is only said on an insert proposal — an existing holder keeps its type', () => {
  const unclear = { product_name: 'Coolant tube', type_code: null, type_warnings: [OTHER_TYPE_WARNING] }
  // Existing ER collet chuck (H0010, CERATIZIT 84719607) read from a file whose type could not be worked out.
  const upd = proposalFor(db, rec({ manufacturer: 'CERATIZIT', order_no: '84719607', ...unclear, type_code: 'OTHER', mass_kg: 0.9 }), 'HSK-A63')
  assert.equal(upd.action, 'update')
  assert.doesNotMatch(upd.warnings.join(' '), /added as "Other"/)
  assert.doesNotMatch(JSON.stringify(upd.record), /added as \\"Other\\"/)
  const odd = proposalFor(db, rec({ manufacturer: 'CERATIZIT', order_no: '84719607', type_code: 'LASER', mass_kg: 0.9 }), 'HSK-A63')
  assert.doesNotMatch(odd.warnings.join(' '), /added as "Other"/)
  const same = proposalFor(db, rec({ type_code: 'LASER', clamp_dia_mm: 3, gauge_length_mm: 160 }), 'HSK-A63')
  assert.equal(same.holder_id, 'H0025')
  assert.doesNotMatch(same.warnings.join(' '), /added as "Other"/)
  // A new holder: the note is shown, because that is what will happen.
  const ins = proposalFor(db, rec({ order_no: 'Z-NEW-1', ...unclear, type_code: 'OTHER' }), 'HSK-A63')
  assert.equal(ins.action, 'insert')
  assert.match(ins.warnings.join(' '), /it will be added as "Other"; set the right type/)
  assert.match(proposalFor(db, rec({ order_no: 'Z-NEW-2', type_code: 'LASER' }), 'HSK-A63').warnings.join(' '), /"LASER" is not one of ours — it will be added as "Other"/)
})

test('dims: a bare ISO code from a file updates our labelled entry instead of adding a second one; refresh values never add labels', () => {
  const ours = { 'DLN (diameter lock nut)': 16, 'BD (neck diameter)': 16, 'LSCX (clamping length maximum machine side)': 68, L2: '18 - 36 (12 - 26)' }
  const a = mergeDims(ours, { BD: 16, LSCX: 70, BD1: 40 }, { DLN: 17, DCONWS: '1-7', LPR: 100 })
  assert.deepEqual(a.merged, { 'DLN (diameter lock nut)': 17, 'BD (neck diameter)': 16, 'LSCX (clamping length maximum machine side)': 70, L2: '18 - 36 (12 - 26)', BD1: 40 })
  assert.deepEqual(a.changed, ['LSCX (clamping length maximum machine side)', 'BD1', 'DLN (diameter lock nut)'])
  assert.deepEqual(mergeDims({}, undefined, { DLN: 17 }), { merged: {}, changed: [] }, 'nothing to refresh → nothing added')
  // Ambiguous (two labels carry the code) → treated as a new label, never a guess.
  assert.deepEqual(mergeDims({ 'D1 a': 1, 'D1 b': 2 }, { D1: 3 }).merged, { 'D1 a': 1, 'D1 b': 2, D1: 3 })
  assert.deepEqual(mergeDims({ 'D1 a': 1, 'D1 b': 2 }, undefined, { D1: 3 }).changed, [])
})

test('data status after apply: never claims more than was checked', () => {
  const web = rec({})
  const kemmlerRec = rec({ data_status: 'partial', partial_fields: ['gauge_length_mm', 'gauge_length_ref'] })
  const file = rec({ data_status: 'catalogue_pdf' })
  assert.equal(statusAfter('partial', web, true, ['nose_dia_mm', 'mass_kg']), 'verified', 'all approved, geometry from the maker page')
  assert.equal(statusAfter('catalogue_pdf', web, true, []), 'verified', 'confirmed unchanged against the maker page → upgrade')
  assert.equal(statusAfter('verified', file, true, []), 'verified', 'a matching file never downgrades a web-verified row')
  assert.equal(statusAfter('verified', file, true, ['gauge_length_mm']), 'catalogue_pdf', 'geometry now comes from the file')
  assert.equal(statusAfter('verified', kemmlerRec, true, ['image_url']), 'verified', 'LPR caveat irrelevant when GL is untouched')
  assert.equal(statusAfter('verified', kemmlerRec, true, ['gauge_length_mm']), 'partial')
  assert.equal(statusAfter('verified', web, false, ['image_url']), 'verified', 'declined fields: status unchanged')
  assert.equal(statusAfter('unverified', web, false, ['image_url']), 'partial')
})

test('approve list: no field list means every proposed field; repeats widen the list; bad shapes are refused', () => {
  assert.deepEqual(parseApprove([{ order_no: 'A' }]), [{ order_no: 'A', fields: undefined }])
  assert.deepEqual(parseApprove(['A']), [{ order_no: 'A', fields: undefined }])
  assert.deepEqual(parseApprove([{ order_no: 'A', fields: ['mass_kg'] }, { order_no: 'A', fields: ['nose_dia_mm'] }]), [{ order_no: 'A', fields: ['mass_kg', 'nose_dia_mm'] }])
  assert.deepEqual(parseApprove([{ order_no: 'A', fields: ['mass_kg'] }, { order_no: 'A' }]), [{ order_no: 'A', fields: undefined }])
  assert.throws(() => parseApprove([]), /Tick at least one row/)
  assert.throws(() => parseApprove('A'), /Tick at least one row/)
  assert.throws(() => parseApprove([{ fields: [] }]), /needs its order_no/)
  assert.throws(() => parseApprove([{ order_no: 'A', fields: [1] }]), /list of field names/)
})
