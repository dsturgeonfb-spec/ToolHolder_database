import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dimValue, interfaceMatch, labelCode, parseInterface, parseMassKg, parseNum, parseRange } from '../../src/server/vendors/parse.js'
import { clampSpecText, classifyByText, classifyHaimer, settleRecord } from '../../src/server/vendors/classify.js'
import type { HolderRecord } from '../../src/server/vendors/types.js'

test('numbers: units stripped, decimal commas, thousands separators in integer mode', () => {
  assert.equal(parseNum('3 mm'), 3)
  assert.equal(parseNum('12,5'), 12.5)
  assert.equal(parseNum('1,265 kg'), 1.265, 'HAIMER prints a German decimal comma on the English page')
  assert.equal(parseNum('1.870'), 1.87)
  assert.equal(parseNum('1.234,5'), 1234.5)
  assert.equal(parseNum('Ø 20 mm'), 20)
  assert.equal(parseNum('< 0.003 mm'), 0.003)
  assert.equal(parseNum('- (not applicable)'), null)
  assert.equal(parseNum(''), null)
  assert.equal(parseNum(null), null)
  assert.equal(parseNum(80), 80)
  assert.equal(parseNum('25.000 1/min', { integer: true }), 25000)
  assert.equal(parseNum('25,000 rpm', { integer: true }), 25000)
  assert.equal(parseNum('35000', { integer: true }), 35000)
  assert.equal(parseMassKg('957 g'), 0.957)
  assert.equal(parseMassKg('0,957 kg'), 0.957)
})

test('ranges and dims values', () => {
  assert.deepEqual(parseRange('2-20'), [2, 20])
  assert.deepEqual(parseRange('0,5 – 13 mm'), [0.5, 13])
  assert.deepEqual(parseRange('1 to 7'), [1, 7])
  assert.equal(parseRange('M3 - M12'), null, 'a tap range is not a clamp range')
  assert.equal(parseRange('12'), null)
  assert.equal(parseRange('20-2'), null)
  assert.equal(dimValue('80 mm'), 80)
  assert.equal(dimValue('12,5'), 12.5)
  assert.equal(dimValue('4,5 deg'), '4,5 deg')
  assert.equal(dimValue('< 0.003 mm'), '< 0.003 mm')
})

test('label codes: DIN 4000 / ISO 13399 prefixes, MAPAL lowercase codes, codes in brackets', () => {
  assert.deepEqual(labelCode('D2 Diameter 2'), { code: 'D2', text: 'Diameter 2' })
  assert.equal(labelCode('A4 Flange diameter:').code, 'A4')
  assert.equal(labelCode('A Length').code, 'A')
  assert.equal(labelCode('C71 Connection diameter min').code, 'C71')
  assert.equal(labelCode('A1_CHA chamfer angle').code, 'A1_CHA')
  assert.equal(labelCode('DCONWS clamping dia nominal workpiece side').code, 'DCONWS')
  assert.equal(labelCode('Clamping diameter (DCONWS)').code, 'DCONWS')
  assert.equal(labelCode('d1 [mm]').code, 'd1')
  assert.equal(labelCode('WT Weight').code, 'WT')
  assert.equal(labelCode('A-length version').code, null)
  assert.equal(labelCode('Runout accuracy').code, null)
  assert.equal(labelCode('Weight').code, null)
})

test('interfaces: HSK-A63 in every spelling; form-only and mismatches are told apart', () => {
  for (const s of ['HSK-A63', 'HSK-A 63', 'HSK-A063', 'HSK 63 A', 'Face Mill Arbor, DIN 69893-1, HSK-A63'])
    assert.deepEqual(parseInterface(s), { form: 'A', size: 63 }, s)
  assert.deepEqual(parseInterface('ISO 12164 (HSK-A)'), { form: 'A', size: null })
  assert.equal(interfaceMatch('HSK-A63', 'HSK-A 63'), 'yes')
  assert.equal(interfaceMatch('HSK-A63', 'HSK-A50'), 'no')
  assert.equal(interfaceMatch('HSK-A63', 'HSK-E63'), 'no')
  assert.equal(interfaceMatch('HSK-A63', 'ISO 12164 (HSK-A)'), 'form-only')
  assert.equal(interfaceMatch('HSK-A63', null), 'unknown')
  assert.equal(interfaceMatch('BT40', 'MAS-BT 40'), 'yes')
})

test('classification matches classify() in build_catalogue.py for HAIMER order prefixes', () => {
  const cases: Array<[string, string, string]> = [
    ['A63.050.16.KKB', 'FACE_MILL_ARBOR', 'Face Mill Arbor (KKB = coolant bores)'],
    ['A63.020.16', 'ER_COLLET', 'Collet Chuck Type ER'],
    ['A63.022.32.3', 'ER_COLLET', 'Power Collet Chuck'],
    ['A63.120.01', 'PRECISION_COLLET', 'High-Precision Chuck (HG collets)'],
    ['A63.184.12.8', 'SHRINK', 'Power Mini Shrink Chuck'],
    ['A63.145.20.3', 'SHRINK', 'Power Shrink Chuck – ultra short (Cool Jet)'],
    ['A63.144.06.3', 'SHRINK', 'Power Shrink Chuck – long ZG130 (Cool Jet)'],
    ['A63.144.06', 'SHRINK', 'Shrink Fit Chuck Standard – long ZG130'],
    ['A63.140.20.6', 'SHRINK', 'Heavy Duty Shrink Chuck'],
    ['A63.140.04', 'SHRINK', 'Shrink Fit Chuck Standard – short, with slits'],
    ['A63.140.12', 'SHRINK', 'Shrink Fit Chuck Standard – short'],
  ]
  for (const [o, type, series] of cases) assert.deepEqual(classifyHaimer(o), [type, series], o)
  assert.equal(classifyHaimer('A63.1H10.10'), null)
  assert.equal(classifyByText('Standard Hydraulic Chuck, DIN 69893-1, HSK-A63'), 'HYDRAULIC')
  assert.equal(classifyByText('Coolant tube HSK-A63'), 'OTHER')
})

test('clamp fields settle like the seed: fixed bore min = max = Ø; collets keep a range and no nominal Ø', () => {
  const shrink: HolderRecord = { manufacturer: 'HAIMER', order_no: 'X', clamp_dia_mm: 6, data_status: 'verified', data_source: 's', product_name: 'Shrink Fit Chuck' }
  settleRecord(shrink, null)
  assert.equal(shrink.type_code, 'SHRINK')
  assert.deepEqual([shrink.clamp_min_mm, shrink.clamp_max_mm], [6, 6])
  assert.equal(shrink.clamp_spec, 'Ø6 mm shank (h6)')
  const er: HolderRecord = { manufacturer: 'K', order_no: 'Y', clamp_dia_mm: 20, clamp_min_mm: 2, clamp_max_mm: 20, product_name: 'ER Collet chuck HSK 63 - 2-20 - 75 - ER 32', data_status: 'verified', data_source: 's' }
  settleRecord(er, ['ER_COLLET', 'Collet chuck for ER collets'])
  assert.equal(er.clamp_dia_mm, null)
  assert.equal(er.clamp_spec, 'ER32 · 2–20 mm')
  const half: HolderRecord = { manufacturer: 'K', order_no: 'Z', clamp_min_mm: 2, data_status: 'verified', data_source: 's', type_code: 'ER_COLLET' }
  settleRecord(half, null)
  assert.deepEqual([half.clamp_min_mm, half.clamp_max_mm], [null, null], 'never half-open')
  const unknown: HolderRecord = { manufacturer: 'K', order_no: 'Q', data_status: 'verified', data_source: 's', product_name: 'Coolant tube' }
  settleRecord(unknown, null)
  assert.equal(unknown.type_code, 'OTHER')
  // Insert-only note (the diff shows it on new holders only — an existing holder keeps its type).
  assert.match(unknown.type_warnings!.join(' '), /could not be worked out/)
  assert.doesNotMatch((unknown.warnings ?? []).join(' '), /could not be worked out/)
  assert.equal(clampSpecText({ manufacturer: 'C', order_no: '83724612', type_code: 'TAP_CHUCK', product_name: 'ISO12164-A63.SGSF.M3-M12.64', data_status: 'verified', data_source: 's' }), 'Taps M3–M12')
})
