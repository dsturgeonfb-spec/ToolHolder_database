import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFileImport } from '../../src/server/vendors/iso13399.js'

const opts = { maker: 'CERATIZIT', iface: 'HSK-A63', source: 'ISO 13399 package from the Ceratizit rep', dataStatus: 'catalogue_pdf' as const, isDistributor: false, knownMakers: ['HAIMER', 'MAPAL', 'CERATIZIT', 'KEMMLER', 'SANDVIK COROMANT', 'CUTWEL'] }

test('ISO 13399 headers map to our columns (DCONWS, LPR, DLN beats BD, WT, RPMX, ADINTMS); other codes go to dims', () => {
  const csv = [
    'ORDER_NO;ADINTMS;DCONWS;LPR;DLN;BD;WT;RPMX;LSCX;Price;product_name;spec_code',
    '84719607;HSK-A63;1-7;100;16;17;0,62;25.000;68;99.00;CoreLine Prec. Collet chuck, Slim;CP.ISO12164-A63.SF.ER11.16.100.F',
    '83724612;HSK-A 63;20;64;;43;;;;;Synchro Tapping Chuck M3-M12;ISO12164-A63.SGSF.M3-M12.64',
  ].join('\r\n')
  const r = parseFileImport(csv, opts)
  assert.deepEqual(r.unused_columns, ['Price'])
  assert.equal(r.rows.length, 2)
  const er = r.rows[0]!.record!
  assert.equal(r.rows[0]!.line, 2)
  assert.deepEqual([er.clamp_min_mm, er.clamp_max_mm, er.clamp_dia_mm], [1, 7, null], 'range DCONWS on a collet chuck')
  assert.deepEqual([er.gauge_length_mm, er.gauge_length_ref], [100, 'LPR'])
  assert.equal(er.nose_dia_mm, 16, 'DLN (lock nut) wins over BD')
  assert.equal(er.mass_kg, 0.62)
  assert.equal(er.max_rpm, 25000)
  assert.equal(er.dims!.LSCX, 68)
  assert.equal(er.type_code, 'ER_COLLET')
  assert.equal(er.series, 'Centro-P precision collet chuck – slim', 'classify() rules for CERATIZIT')
  assert.equal(er.data_status, 'catalogue_pdf')
  assert.equal(er.data_source, opts.source)
  const tap = r.rows[1]!.record!
  assert.equal(tap.type_code, 'TAP_CHUCK')
  assert.equal(tap.nose_dia_mm, 43, 'BD when there is no DLN')
  assert.deepEqual([tap.clamp_min_mm, tap.clamp_max_mm, tap.clamp_dia_mm], [null, null, null])
  assert.equal(tap.clamp_spec, 'Taps M3–M12')
})

test('codes that went into holder columns are not copied into the maker dimensions (they only refresh an existing labelled entry)', () => {
  const csv = [
    'Article,ADINTMS,DCONWS,LPR,DLN,BD,WT,RPMX,LSCX',
    '84719607,HSK-A63,1-7,100,17,16,"0,9",25000,68',
    '83724612,HSK-A63,20,64,,43,,,',
  ].join('\n')
  const [er, tap] = parseFileImport(csv, opts).rows.map((r) => r.record!)
  // ER collet chuck: DCONWS → clamp range, DLN → nose, LPR/WT/RPMX → columns. None of them is a dimension too.
  assert.deepEqual([er!.clamp_min_mm, er!.clamp_max_mm, er!.nose_dia_mm, er!.gauge_length_mm, er!.mass_kg, er!.max_rpm], [1, 7, 17, 100, 0.9, 25000])
  assert.deepEqual(er!.dims, { BD: 16, LSCX: 68 }, 'BD is not the nose Ø here (DLN is), so it stays a dimension of its own')
  assert.deepEqual(er!.dims_refresh, { DCONWS: '1-7', LPR: 100, DLN: 17, WT: 0.9, RPMX: 25000 })
  // Tap chuck: no nominal clamp Ø is stored, so DCONWS stays a dimension (nothing is lost); BD is the nose Ø.
  assert.equal(tap!.type_code, 'TAP_CHUCK')
  assert.equal(tap!.clamp_dia_mm, null)
  assert.deepEqual(tap!.dims, { DCONWS: 20 })
  assert.equal(tap!.nose_dia_mm, 43)
  assert.deepEqual(tap!.dims_refresh, { LPR: 64, BD: 43 })
})

test('ADINTMS for another interface → that row is an error; unreadable numbers too; blank lines skipped', () => {
  const csv = 'Article,ADINTMS,DCONWS,LPR\nA,HSK-A100,12,80\nB,HSK-A63,abc,80\n\nC,ISO 12164 (HSK-A),12,90\n,,,\n'
  const r = parseFileImport(csv, opts)
  assert.equal(r.rows.length, 3)
  assert.match(r.rows[0]!.error!, /Line 2: ADINTMS "HSK-A100" is not HSK-A63/)
  assert.match(r.rows[1]!.error!, /Line 3: clamp_dia_mm "abc" is not a number/)
  assert.match(r.rows[2]!.record!.warnings!.join(' '), /names the form only/)
})

test('order no. headers: Art.-Nr. accepted; a file without one is refused with the names to use', () => {
  assert.equal(parseFileImport('Art.-Nr.;LPR\nX1;75\n', opts).rows[0]!.record!.gauge_length_mm, 75)
  const none = parseFileImport('Item;LPR\nX1;75\n', opts)
  assert.match(none.rows[0]!.error!, /No order no\. column — name one of: order_no, ORDER_NO, Article, Art\.-Nr\./)
  assert.deepEqual(parseFileImport('', opts).rows, [])
})

test('our own column names work too and win over ISO codes; manufacturer column picks the maker; distributors get the maker-order-no. hint', () => {
  const csv = 'order_no,manufacturer,gauge_length_mm,LPR,type_code,clamp_dia_mm,data_status,dims\nX,haimer,120,999,shrink,6,verified,"{""L"": 41}"\n'
  const rec = parseFileImport(csv, opts).rows[0]!.record!
  assert.equal(rec.manufacturer, 'HAIMER')
  assert.equal(rec.gauge_length_mm, 120)
  assert.equal(rec.type_code, 'SHRINK')
  assert.deepEqual([rec.clamp_min_mm, rec.clamp_max_mm], [6, 6])
  assert.equal(rec.data_status, 'verified')
  assert.equal(rec.dims!.L, 41)
  assert.match(parseFileImport('order_no,manufacturer\nX,WALTER\n', opts).rows[0]!.error!, /maker "WALTER" is not in the catalogue/)
  assert.match(parseFileImport('order_no,data_status\nX,great\n', opts).rows[0]!.error!, /data_status "great" must be one of/)

  const dist = { ...opts, maker: 'CUTWEL', isDistributor: true, dataStatus: 'distributor_only' as const }
  const withMaker = parseFileImport('order_no,maker_order_no,product_name\nCW-HSK63-SF06,A63.140.06,Shrink fit chuck HSK63 6mm\n', dist).rows[0]!.record!
  assert.equal(withMaker.spec_code, 'A63.140.06')
  assert.equal(withMaker.type_code, 'SHRINK')
  const without = parseFileImport('order_no,product_name\nCW-HSK63-SF06,Shrink fit chuck HSK63 6mm\n', dist).rows[0]!.record!
  assert.match(without.warnings!.join(' '), /Distributor part no\./)
})
