import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from '../helpers.js'
import {
  camGlFromName,
  classify,
  makerFromName,
  nameKey,
  nameTag,
  normaliseComment,
  normaliseName,
  orderFromComment,
  orderFromName,
} from '../../src/server/hypermill/classify.js'

interface CamRow {
  seq: number
  cam_name: string
  cam_comment: string
}
interface CatRow {
  holder_id: string
  manufacturer: string
  order_no: string
  type_code: string
  series: string
  cam_name: string | null
  cam_comment: string | null
  cam_gl_mm: number | null
  on_site: boolean
}
const cam: CamRow[] = JSON.parse(readFileSync(join(REPO, 'data', 'raw', 'cam_holders_hypermill.json'), 'utf8'))
const catalogue: CatRow[] = JSON.parse(readFileSync(join(REPO, 'data', 'holders.json'), 'utf8'))
const onSite = catalogue.filter((h) => h.on_site)
// The four MAPAL UNIQ chucks take their series from the UNIQ catalogue PDF, which a name cannot tell.
const UNIQ = new Set(['31270591', '31270593', '31270595', '31229418'])

test('the 54 seeded holders read back exactly as build_catalogue.py stored them', () => {
  assert.equal(cam.length, 54)
  for (const [i, c] of cam.entries()) {
    const h = onSite[i]!
    const name = normaliseName(c.cam_name)
    assert.equal(name, h.cam_name, `name of ${h.holder_id}`)
    assert.equal(normaliseComment(c.cam_comment), h.cam_comment, `comment of ${h.holder_id}`)
    const order = orderFromName(name)
    assert.equal(order, h.order_no, `order no. of ${h.holder_id}`)
    const maker = makerFromName(name, ['HAIMER', 'MAPAL', 'CERATIZIT', 'KEMMLER', 'SANDVIK COROMANT', 'CUTWEL'])
    assert.equal(maker, h.manufacturer, `maker of ${h.holder_id}`)
    assert.equal(camGlFromName(name), h.cam_gl_mm, `CAM GL of ${h.holder_id}`)
    const c2 = classify(maker!, order!, name, normaliseComment(c.cam_comment))
    assert.equal(c2.type_code, h.type_code, `type of ${h.holder_id} (${name})`)
    if (!UNIQ.has(h.order_no)) assert.equal(c2.series, h.series, `series of ${h.holder_id} (${name})`)
    assert.notEqual(c2.by, 'none')
  }
})

test('leading tag is removed like the seed did, and kept aside', () => {
  assert.equal(normaliseName('(HSK63) HAIMER 6mm STD SHRINK A63.140.06 80GL'), 'HAIMER 6mm STD SHRINK A63.140.06 80GL')
  assert.equal(normaliseName('  (HSK-A100)   SCHUNK  TENDO 0208010 120GL '), 'SCHUNK TENDO 0208010 120GL')
  assert.equal(normaliseName('HAIMER no tag A63.140.06 80GL'), 'HAIMER no tag A63.140.06 80GL')
  assert.equal(nameTag('(HSK63) HAIMER'), 'HSK63')
  assert.equal(nameTag('HAIMER'), null)
  assert.equal(normaliseComment('   '), null)
  assert.equal(normaliseComment(' a  b '), 'a b')
})

test('order no.: HAIMER/KEMMLER dotted, 8-digit, fallbacks, and the comment', () => {
  assert.equal(orderFromName('HAIMER 3mm POWER MINI SHRINK A63.182.03.8 160GL'), 'A63.182.03.8')
  assert.equal(orderFromName('haimer spigot arbor a63.050.16.kkb 67gl'), 'A63.050.16.KKB')
  assert.equal(orderFromName('MAPAL 12MM HTC HYDRAULIC CHUCK 30524702 80GL'), '30524702')
  assert.equal(orderFromName('HAIMER SHRINK A10.140.12 100GL'), 'A10.140.12')
  assert.equal(orderFromName('SCHUNK TENDO E COMPACT 0208010 100GL'), '0208010')
  assert.equal(orderFromName('SPARE HOLDER CELL 3 75GL'), null)
  assert.equal(orderFromName('ER32 COLLET CHUCK 100GL'), null)
  // A drawing number in a comment is not mistaken for an order no.
  assert.equal(orderFromName('Hydro High Pressure Chuck 12dia 606585650-000-00-e43'), null)
  assert.equal(orderFromComment('HAIMER SPIGOT ARBOR 16mm A63-050-16-KKB'), 'A63.050.16.KKB')
  assert.equal(orderFromComment('HAIMER 6mm STD SHRINK A63.140.06'), 'A63.140.06')
  assert.equal(orderFromComment(null), null)
})

test('CAM gauge length from the GL token; renames ignore the GL token, case and spacing', () => {
  assert.equal(camGlFromName('HAIMER 6mm STD SHRINK A63.140.06 80GL'), 80)
  assert.equal(camGlFromName('X 82.5 GL'), 82.5)
  assert.equal(camGlFromName('X 82,5GL'), 82.5)
  assert.equal(camGlFromName('HAIMER no gauge length'), null)
  assert.equal(nameKey('HAIMER 12mm STD SHRINK A63.140.12 90GL'), nameKey('HAIMER 12MM  STD SHRINK A63.140.12 95GL'))
  assert.notEqual(nameKey('HAIMER 6mm STD SHRINK A63.140.06 80GL'), nameKey('HAIMER 6mm STD SHRINK FIT CHUCK A63.140.06 80GL'))
})

test('maker: known words, makers already in the catalogue, word boundaries, first one named wins', () => {
  assert.equal(makerFromName('SANDVIK CAPTO ADAPTOR 12345678'), 'SANDVIK COROMANT')
  assert.equal(makerFromName('COROMANT HYDROGRIP 12345678'), 'SANDVIK COROMANT')
  assert.equal(makerFromName('BIG DAISHOWA MEGA ER 12345678'), 'BIG DAISHOWA')
  assert.equal(makerFromName('REGOFIX POWERGRIP 1234567'), 'REGO-FIX')
  assert.equal(makerFromName('Gühring GM 300 12345678'), 'GUHRING')
  assert.equal(makerFromName('NIKKEN BLANK ADAPTOR 41234567 90GL'), 'NIKKEN')
  assert.equal(makerFromName('BIGGER SHRINK 12345678'), null, 'BIG only as a whole word')
  assert.equal(makerFromName('SECONDARY ARBOR 12345678'), null)
  assert.equal(makerFromName('ACME SPECIAL 12345678', ['ACME']), 'ACME', 'a maker the shop added by hand')
  assert.equal(makerFromName('MAPAL HTC FOR HAIMER COLLETS 12345678'), 'MAPAL')
  assert.equal(makerFromName('SPARE HOLDER CELL 3 75GL'), null)
})

test('keyword fallbacks classify holders the seed rules do not know', () => {
  const t = (maker: string, name: string, comment: string | null = null) => classify(maker, orderFromName(name) ?? 'X', name, comment)
  assert.deepEqual(t('HAIMER', 'HAIMER 14mm STD SHRINK A63.140.14 80GL'), { type_code: 'SHRINK', series: 'Shrink Fit Chuck Standard – short', by: 'order' })
  assert.equal(t('SCHUNK', 'SCHUNK TENDO HYD 12MM 0208010 90GL').type_code, 'HYDRAULIC')
  assert.equal(t('MAPAL', 'MAPAL 16MM SHRINK CHUCK 30999999 90GL').type_code, 'SHRINK', 'a MAPAL shrink chuck is not assumed to be HTC hydraulic')
  assert.deepEqual(t('NIKKEN', 'NIKKEN ER 25 COLLET CHUCK 12345678 100GL'), { type_code: 'ER_COLLET', series: 'ER25 collet chuck', by: 'keyword' })
  assert.equal(t('BIG DAISHOWA', 'BIG HIGH-PRECISION COLLET 12345678 100GL').type_code, 'PRECISION_COLLET')
  assert.equal(t('HAIMER', 'HAIMER HG10 CHUCK A63.121.10 100GL').type_code, 'PRECISION_COLLET')
  assert.equal(t('SANDVIK COROMANT', 'COROMANT SHELL MILL ARBOR 22MM 12345678 60GL').type_code, 'FACE_MILL_ARBOR')
  assert.equal(t('KEMMLER', 'KEMMLER SCREW-IN ADAPTOR A63.06.16.3 110GL').type_code, 'SCREW_IN')
  assert.equal(t('SCHUNK', 'SCHUNK TAPPING CHUCK M3-M12 12345678 90GL').type_code, 'TAP_CHUCK')
  assert.equal(t('SCHUNK', 'SCHUNK 40TAPER ADAPTOR 12345678 90GL').type_code, 'OTHER', 'TAPER is not TAP')
  assert.equal(t('ISCAR', 'ISCAR DRILL CHUCK 1-13 12345678 110GL').type_code, 'DRILL_CHUCK')
  assert.equal(t('SCHUNK', 'SCHUNK SPECIAL 12345678 90GL', 'hydraulic expansion chuck 20mm').type_code, 'HYDRAULIC', 'comment used when the name says nothing')
  assert.deepEqual(t('NIKKEN', 'NIKKEN BLANK ADAPTOR 41234567 90GL', 'NIKKEN HSK63A blank for special tools'), { type_code: 'OTHER', series: null, by: 'none' })
})
