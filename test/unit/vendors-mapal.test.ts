import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, REPO } from '../helpers.js'
import { HostGates, PoliteFetcher } from '../../src/server/vendors/fetcher.js'
import { fixtureFetch } from '../../src/server/vendors/fixtures.js'
import { mapal, mapalOrderFromUrl, mapalProductUrl, normMapalOrder, parseMapalDesignation, parseMapalPage } from '../../src/server/vendors/mapal.js'

const DIR = join(FIXTURES, 'vendors')
const page = (order: string) => readFileSync(join(DIR, 'mapal', `${order}.html`), 'utf8')
const rawMapal = new Map(
  (JSON.parse(readFileSync(join(REPO, 'data', 'raw', 'ceratizit_mapal.json'), 'utf8')) as any[]).filter((r) => r.manufacturer === 'MAPAL').map((r) => [r.order_no, r]),
)

test('designation encodes Ø and GL: MHC-HSK-A063-12-075-… → Ø12, l1 75', () => {
  assert.deepEqual(parseMapalDesignation('MHC-HSK-A063-12-075-1-0-A'), { family: 'MHC', form: 'A', size: 63, d1: 12, l1: 75 })
  assert.deepEqual(parseMapalDesignation('HTC-HSK-A063-32-105-1-0-A'), { family: 'HTC', form: 'A', size: 63, d1: 32, l1: 105 })
  assert.deepEqual(parseMapalDesignation('MPC-HSK-A063-13-110-1-0-W'), { family: 'MPC', form: 'A', size: 63, d1: 13, l1: 110 })
  assert.deepEqual(parseMapalDesignation('MHC-HSK-A063-06-065-1-0-A'), { family: 'MHC', form: 'A', size: 63, d1: 6, l1: 65 })
  assert.equal(parseMapalDesignation('CP.ISO12164-A63.SF.ER11.16.100.F'), null)
  assert.equal(normMapalOrder('000000000030524702'), '30524702')
  assert.equal(mapalProductUrl('30524702'), 'https://shop.mapal.com/en/p/000000000030524702')
})

test('HTC page → record matching data/raw/ceratizit_mapal.json; coolant in the seed\'s wording', () => {
  const r = rawMapal.get('30524702')!
  const rec = parseMapalPage(page('30524702'), 'https://shop.mapal.com/en/Clamping/Chucks/HighTorque-Chuck-HTC%2C-short-heavy-design/p/000000000030524702', '30524702', mapalProductUrl('30524702'))
  assert.equal(rec.spec_code, r.spec_code)
  assert.equal(rec.product_name, r.product_name)
  assert.equal(rec.clamp_dia_mm, r.clamp_dia_mm)
  assert.equal(rec.gauge_length_mm, r.gauge_length_mm)
  assert.equal(rec.gauge_length_ref, 'l1')
  assert.equal(rec.nose_dia_mm, r.diameters.d2)
  assert.equal(rec.coolant, r.coolant)
  assert.equal(rec.dims!.d3, r.diameters.d3)
  assert.equal(rec.dims!.l4, r.other_dims.l4)
  assert.equal(rec.dims!['Length adjustment'], r.other_dims.length_adjustment)
  assert.equal(rec.type_code, 'HYDRAULIC')
  assert.equal(rec.interface_seen, 'HSK-A63')
  assert.equal(rec.product_url, mapalProductUrl('30524702'), 'the stable /p/<order no.> address is kept')
  assert.match(rec.image_url!, /^https:\/\/shop\.mapal\.com\/medias\/30524702/)
  assert.deepEqual(rec.warnings, [])
})

test('drill chuck: d1 is a range → clamp min/max, no nominal Ø; max speed read as rpm', () => {
  const r = rawMapal.get('30259875')!
  const rec = parseMapalPage(page('30259875'), 'https://shop.mapal.com/en/Clamping/Chucks/Precision-DrillChuck/p/000000000030259875', '30259875')
  assert.equal(rec.type_code, 'DRILL_CHUCK')
  assert.deepEqual([rec.clamp_min_mm, rec.clamp_max_mm, rec.clamp_dia_mm], [r.clamp_range_mm.min, r.clamp_range_mm.max, null])
  assert.equal(rec.max_rpm, r.max_rpm)
  assert.equal(rec.gauge_length_mm, r.gauge_length_mm)
  assert.equal(rec.clamp_spec, 'Drill chuck · 0.5–13 mm')
})

const mini = (rows: string, designation = 'HTC-HSK-A063-12-080-1-0-A', order = '30524702') =>
  `<html><body><h1>HighTorque Chuck HTC</h1><div class="product-details__designation">${designation}</div>
   <div class="product-details__code">Order no. <span>${order}</span></div><table>${rows}</table></body></html>`

test('cross-check: technical data disagreeing with the designation gives a warning; missing l1 falls back to the designation', () => {
  const bad = parseMapalPage(mini('<tr><td>d1 [mm]</td><td>12</td></tr><tr><td>l1 [mm]</td><td>85</td></tr>'), 'https://shop.mapal.com/en/x/p/000000000030524702', '30524702')
  assert.equal(bad.gauge_length_mm, 85, 'the technical data wins')
  assert.match(bad.warnings!.join(' '), /Designation says gauge length 80 mm but the technical data says l1 = 85 mm/)
  const fallback = parseMapalPage(mini('<tr><td>d2 [mm]</td><td>32</td></tr>'), 'https://shop.mapal.com/en/x/p/000000000030524702', '30524702')
  assert.deepEqual([fallback.clamp_dia_mm, fallback.gauge_length_mm, fallback.gauge_length_ref], [12, 80, 'l1'])
  assert.match(fallback.warnings!.join(' '), /read from the designation/)
  assert.equal(fallback.data_status, 'verified')
  assert.throws(() => parseMapalPage(mini('', 'HTC-HSK-A063-12-080-1-0-A', '30490553'), 'https://shop.mapal.com/en/x/p/000000000030490553', '30524702'), /shows order no\. 30490553/)
  const a50 = parseMapalPage(mini('', 'MHC-HSK-A050-12-080-1-0-A'), 'https://shop.mapal.com/en/x/p/000000000030524702', '30524702')
  assert.equal(a50.interface_seen, 'HSK-A50', 'the interface from the designation is checked later by the diff')
})

test('discover(): catalogue order nos + entered ones (no full-range listing); malformed order nos are error rows', async () => {
  const f = new PoliteFetcher({ userAgent: 'HolderCatalogue/test', allowedOrigins: mapal.origins!, lookup: null, fetch: fixtureFetch(DIR), sleep: async () => {}, gates: new HostGates() })
  const log: string[] = []
  const sc = { db: null as any, fetcher: f, log: (m: string) => log.push(m) }
  const known = [{ order_no: '30524702', url: mapalProductUrl('30524702'), origin: 'catalogue' as const }]
  const refs = await mapal.discover!(sc, 'HSK-A63', { known, entered: ['000000000030655666', 'HTC-12'], full: true })
  assert.deepEqual(refs.map((r) => r.order_no), ['30655666', 'HTC-12', '30524702'])
  assert.match(refs[1]!.error!, /not a MAPAL order no/)
  assert.match(log.join(' '), /no full-range discovery/)
  const rec = await mapal.fetch!(sc, refs[0]!, 'HSK-A63')
  assert.equal(rec.order_no, '30655666')
  assert.equal(rec.product_url, mapalProductUrl('30655666'))
})

test('discover(): a stored address is reused only when it really is a shop.mapal.com product page for that order no. (anchored match)', async () => {
  const sc = { db: null as any, fetcher: null as any, log: () => {} }
  const page = 'https://shop.mapal.com/en/Clamping/Chucks/Hydraulic-Chucks/UNIQ-Mill-Chuck%2C-HA/p/000000000031270591'
  const cases: Array<[string | null, string]> = [
    [page, page],
    [mapalProductUrl('31270591'), mapalProductUrl('31270591')],
    // The SSRF report: the shop address hidden in a query string on another host.
    ['http://127.0.0.1:9999/admin?x=shop.mapal.com/en/p/31270591', mapalProductUrl('31270591')],
    ['http://127.0.0.1:27499/admin?ref=shop.mapal.com/en/p/31270591', mapalProductUrl('31270591')],
    ['https://shop.mapal.com.evil.example/en/p/31270591', mapalProductUrl('31270591')],
    ['https://shop.mapal.com@10.0.0.1/en/p/31270591', mapalProductUrl('31270591')],
    ['https://evil.example/shop.mapal.com/en/p/31270591', mapalProductUrl('31270591')],
    ['https://shop.mapal.com/en/search?q=/p/31270591', mapalProductUrl('31270591')],
    ['https://shop.mapal.com/en/p/000000000030524702', mapalProductUrl('31270591')], // another product's page
    [null, mapalProductUrl('31270591')],
  ]
  for (const [stored, want] of cases) {
    const [ref] = await mapal.discover!(sc, 'HSK-A63', { known: [{ order_no: '31270591', url: stored, origin: 'catalogue' }], entered: [], full: false })
    assert.equal(ref!.url, want, String(stored))
  }
  assert.equal(mapalOrderFromUrl('https://shop.mapal.com/en/p/000000000031270591?ref=1'), '31270591')
  assert.equal(mapalOrderFromUrl('http://127.0.0.1/?u=https://shop.mapal.com/en/p/31270591'), null)
  // The page check reads the order no. from a product address itself, never from a query string: a canonical
  // link hiding "shop.mapal.com/en/p/30524702" in its query no longer passes another product's page off as 30524702.
  const html = mini('', 'HTC-HSK-A063-12-080-1-0-A', '').replace('<html><body>', '<html><head><link rel="canonical" href="http://127.0.0.1:27499/?shop.mapal.com/en/p/30524702"></head><body>')
  assert.throws(() => parseMapalPage(html, 'https://shop.mapal.com/en/x/p/000000000030490553', '30524702'), /shows order no\. 30490553/)
})
