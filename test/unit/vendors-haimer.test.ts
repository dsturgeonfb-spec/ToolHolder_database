import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, REPO } from '../helpers.js'
import { HostGates, PoliteFetcher } from '../../src/server/vendors/fetcher.js'
import { fixtureFetch } from '../../src/server/vendors/fixtures.js'
import { haimer, haimerOrderFromUrl, haimerSitemapProducts, haimerUrlTokens, parseHaimerPage, sitemapLocs } from '../../src/server/vendors/haimer.js'

const DIR = join(FIXTURES, 'vendors')
const page = (order: string) => readFileSync(join(DIR, 'haimer', `${order}.html`), 'utf8')
const raw = (file: string) => JSON.parse(readFileSync(join(REPO, 'data', 'raw', file), 'utf8')) as any[]
const rawShrink = new Map(raw('haimer_shrink.json').map((r) => [r.order_no, r]))
const rawOther = new Map(raw('haimer_other_kemmler.json').map((r) => [r.order_no, r]))
// The scan's fetcher: HAIMER's own origin only (fixtures never touch DNS, so no address check here).
const ONLY_HAIMER = { allowedOrigins: haimer.origins!, lookup: null }
const fetcher = () => new PoliteFetcher({ userAgent: 'HolderCatalogue/test (+t@example.com)', ...ONLY_HAIMER, fetch: fixtureFetch(DIR), sleep: async () => {}, gates: new HostGates() })

test('URL helpers: interface tokens and order no. = last URL segment (category pages excluded)', () => {
  assert.deepEqual(haimerUrlTokens('HSK-A63'), ['HSK-A63', '/A63.'])
  assert.deepEqual(haimerUrlTokens('HSK-A100'), ['HSK-A100', '/A100.'])
  assert.equal(haimerOrderFromUrl('https://shop.haimer.com/en/Power-Mini-Shrink-Chuck-DIN-69893-1-HSK-A63/A63.182.03.8'), 'A63.182.03.8')
  assert.equal(haimerOrderFromUrl('https://shop.haimer.com/en/Standard-Hydraulic-Chuck-DIN-69893-1-HSK-A63/A63.1H10.10'), 'A63.1H10.10')
  assert.equal(haimerOrderFromUrl('https://shop.haimer.com/en/Tool-Holders/HSK-Hollow-shank-DIN-69893/HSK-A63/'), null)
  assert.equal(haimerOrderFromUrl('https://shop.haimer.com/en/Shrink-Fit-Chuck-Standard-Version-DIN-69893-1-HSK-A63/1-WA-2-054000-3-054030-4-051000-5-051005'), null)
  assert.deepEqual(sitemapLocs('<sitemapindex><sitemap><loc> https://a/b.xml.gz </loc></sitemap></sitemapindex>'), { index: true, locs: ['https://a/b.xml.gz'] })
  assert.deepEqual(sitemapLocs('<urlset><url><loc>https://a/?x=1&amp;y=2</loc></url></urlset>').locs, ['https://a/?x=1&y=2'])
})

test('discovery: sitemap index → gzipped child sitemaps → HSK-A63 product pages (English, one per order no.)', async () => {
  const f = fetcher()
  const log: string[] = []
  const found = await haimerSitemapProducts(f, 'HSK-A63', (m) => log.push(m))
  assert.deepEqual([...found.keys()].sort(), ['A63.050.16.KKB', 'A63.140.03', 'A63.140.04', 'A63.147.05.1', 'A63.182.03.8', 'A63.182.04.8', 'A63.1H10.10'])
  assert.ok([...found.values()].every((u) => u.startsWith('https://shop.haimer.com/en/')), 'DE duplicates dropped')
  assert.ok(![...found.keys()].some((o) => o.startsWith('A50') || o.startsWith('40.')), 'other interfaces excluded')
  assert.match(log.join('\n'), /Sitemap index lists 2 sitemaps/)
})

test('discovery: one unreadable child sitemap is skipped (logged); the index failing or a block ends discovery', async () => {
  const fx = fixtureFetch(DIR)
  const broken = (bad: RegExp, status: number) => async (url: string, init: RequestInit) => (bad.test(url) ? new Response('err', { status }) : fx(url, init))
  const log: string[] = []
  const f = new PoliteFetcher({ userAgent: 'HolderCatalogue/test', ...ONLY_HAIMER, fetch: broken(/-de-1\.xml\.gz$/, 500), sleep: async () => {}, gates: new HostGates() })
  const found = await haimerSitemapProducts(f, 'HSK-A63', (m) => log.push(m))
  assert.equal(found.size, 7)
  assert.match(log.join('\n'), /Could not read .*-de-1\.xml\.gz: .*HTTP 500.* — skipped/)
  const g = new PoliteFetcher({ userAgent: 'HolderCatalogue/test', ...ONLY_HAIMER, fetch: broken(/sitemap\.xml$/, 404), sleep: async () => {}, gates: new HostGates() })
  await assert.rejects(haimerSitemapProducts(g, 'HSK-A63', () => {}), /Page not found \(404\)/)
  const h = new PoliteFetcher({ userAgent: 'HolderCatalogue/test', ...ONLY_HAIMER, fetch: broken(/-en-1\.xml\.gz$/, 429), sleep: async () => {}, gates: new HostGates() })
  await assert.rejects(haimerSitemapProducts(h, 'HSK-A63', () => {}), /blocked — not retried/)
})

test('discover(): stored product URLs are reused; entered order nos are found in the sitemap; unknown ones become error rows', async () => {
  const sc = { db: null as any, fetcher: fetcher(), log: () => {} }
  const known = [
    { order_no: 'A63.182.03.8', url: 'https://shop.haimer.com/en/Power-Mini-Shrink-Chuck-DIN-69893-1-HSK-A63/A63.182.03.8', origin: 'catalogue' as const },
    { order_no: 'A63.140.03', url: 'https://shop.haimer.com/en/Shrink-Fit-Chuck-Standard-Version-DIN-69893-1-HSK-A63/1-WA-2-054000-3-054030-4-051000-5-051005', origin: 'catalogue' as const },
  ]
  // Only stored, usable URLs: no sitemap needed.
  const f1 = fetcher()
  const r1 = await haimer.discover!({ ...sc, fetcher: f1 }, 'HSK-A63', { known: known.slice(0, 1), entered: [], full: false })
  assert.equal(r1.length, 1)
  assert.equal(f1.requests, 0, 'nothing fetched just to discover a stored page')
  const r2 = await haimer.discover!(sc, 'HSK-A63', { known, entered: ['a63.140.03', 'A63.147.05.1', 'A63.999.99'], full: false })
  const by = new Map(r2.map((r) => [r.order_no, r]))
  assert.equal(by.get('A63.140.03')!.url, 'https://shop.haimer.com/en/Shrink-Fit-Chuck-Standard-Version-DIN-69893-1-HSK-A63/A63.140.03', 'variant-selector URL replaced from the sitemap')
  assert.equal(by.get('A63.147.05.1')!.origin, 'entered')
  assert.match(by.get('A63.999.99')!.error!, /not in HAIMER's sitemap/)
  const r3 = await haimer.discover!(sc, 'HSK-A63', { known, entered: [], full: true })
  assert.equal(r3.length, 7)
  assert.equal(r3.filter((r) => r.origin === 'discovered').length, 5)
})

test('discover(): a stored URL on another host is never reused, even when its last segment is the order no.; sitemap entries on other hosts are ignored', async () => {
  const f = fetcher()
  const log: string[] = []
  const sc = { db: null as any, fetcher: f, log: (m: string) => log.push(m) }
  const known = [{ order_no: 'A63.182.03.8', url: 'http://127.0.0.1:27499/admin/A63.182.03.8', origin: 'catalogue' as const }]
  const refs = await haimer.discover!(sc, 'HSK-A63', { known, entered: [], full: false })
  assert.equal(refs[0]!.url, 'https://shop.haimer.com/en/Power-Mini-Shrink-Chuck-DIN-69893-1-HSK-A63/A63.182.03.8', 'found through the sitemap instead')
  const lookalike = [{ order_no: 'A63.182.03.8', url: 'https://shop.haimer.com.evil.example/en/x/A63.182.03.8', origin: 'catalogue' as const }]
  assert.match((await haimer.discover!(sc, 'HSK-A63', { known: lookalike, entered: [], full: false }))[0]!.url!, /^https:\/\/shop\.haimer\.com\/en\//)
  // fetch() refuses a foreign address outright (defence in depth behind discover()).
  await assert.rejects(haimer.fetch!(sc, { order_no: 'A63.182.03.8', url: 'http://127.0.0.1:27499/A63.182.03.8', origin: 'catalogue' }, 'HSK-A63'), /not a shop\.haimer\.com address/)

  // A sitemap index that lists another site: that entry is neither followed nor used.
  const fx = fixtureFetch(DIR)
  const xml = await (await fx('https://shop.haimer.com/sitemap.xml', {})).text()
  const evil = xml.replace('</sitemapindex>', '<sitemap><loc>http://127.0.0.1:27499/sitemap.xml</loc></sitemap></sitemapindex>')
  const requested: string[] = []
  const net = async (url: string, init: RequestInit) => (requested.push(url), url === 'https://shop.haimer.com/sitemap.xml' ? new Response(evil, { headers: { 'content-type': 'application/xml' } }) : fx(url, init))
  const g = new PoliteFetcher({ userAgent: 'HolderCatalogue/test', ...ONLY_HAIMER, fetch: net, sleep: async () => {}, gates: new HostGates() })
  const glog: string[] = []
  const found = await haimerSitemapProducts(g, 'HSK-A63', (m) => glog.push(m))
  assert.equal(found.size, 7)
  assert.match(glog.join('\n'), /1 address on other sites ignored/)
  assert.ok(requested.every((u) => u.startsWith('https://shop.haimer.com/')), requested.join(', '))
})

test('product page → record in our column names, matching the values captured in data/raw/haimer_shrink.json', () => {
  for (const order of ['A63.182.03.8', 'A63.182.04.8', 'A63.140.03']) {
    const url = rawShrink.get(order)!.product_url.includes(order) ? rawShrink.get(order)!.product_url : `https://shop.haimer.com/en/Shrink-Fit-Chuck-Standard-Version-DIN-69893-1-HSK-A63/${order}`
    const rec = parseHaimerPage(page(order), url, order)
    const r = rawShrink.get(order)!
    assert.equal(rec.manufacturer, 'HAIMER')
    assert.equal(rec.order_no, order)
    assert.equal(rec.clamp_dia_mm, r.clamp_dia_mm, `${order} D1`)
    assert.deepEqual([rec.clamp_min_mm, rec.clamp_max_mm], [r.clamp_dia_mm, r.clamp_dia_mm], 'fixed bore: min = max = D1')
    assert.equal(rec.gauge_length_mm, r.gauge_length_mm, `${order} A`)
    assert.equal(rec.gauge_length_ref, 'A')
    assert.equal(rec.nose_dia_mm, r.diameters['D2 Diameter 2'], `${order} D2`)
    assert.equal(rec.mass_kg, r.mass_kg, `${order} mass`)
    assert.equal(rec.dims!['L Length'], r.other_dims['L Length'])
    assert.equal(rec.dims!['Runout accuracy'], r.other_dims['Runout accuracy'])
    assert.equal(rec.type_code, 'SHRINK')
    assert.equal(rec.data_status, 'verified')
    assert.equal(rec.data_source, 'shop.haimer.com')
    assert.equal(rec.product_url, url)
    assert.ok(!('D1 Clamping diameter' in rec.dims!) && !('WT Weight' in rec.dims!), 'mapped labels are not repeated in dims')
  }
  const r03 = parseHaimerPage(page('A63.182.03.8'), rawShrink.get('A63.182.03.8')!.product_url, 'A63.182.03.8')
  assert.equal(r03.series, 'Power Mini Shrink Chuck')
  assert.equal(r03.clamp_spec, 'Ø3 mm shank (h6)')
  assert.equal(r03.dims!['A4 Flange diameter'], 63)
  assert.equal(r03.dims!['A-length version'], 'oversize (160 mm)')
  assert.match(r03.coolant!, /H22 Coolant exit style code = 1/)
  assert.match(r03.balance!, /G2\.5/)
  assert.equal(r03.image_url, null, 'no photo on this page (as captured)')
  const r04 = parseHaimerPage(page('A63.182.04.8'), rawShrink.get('A63.182.04.8')!.product_url, 'A63.182.04.8')
  assert.equal(r04.image_url, 'https://shop.haimer.com/media/5e/0c/8a/1690201622/asset-113402-659.jpg')
  assert.equal(r04.drawing_url, 'https://shop.haimer.com/media/6f/1d/9b/1690201622/asset-113402-658.jpg', 'the drawing is told apart by its alt text')
})

test('face mill arbor page: values from data/raw/haimer_other_kemmler.json, photo and drawing, FACE_MILL_ARBOR', () => {
  const r = rawOther.get('A63.050.16.KKB')!
  const rec = parseHaimerPage(page('A63.050.16.KKB'), r.product_url, 'A63.050.16.KKB')
  assert.equal(rec.type_code, 'FACE_MILL_ARBOR')
  assert.equal(rec.series, 'Face Mill Arbor (KKB = coolant bores)')
  assert.equal(rec.clamp_dia_mm, r.clamp_dia_mm)
  assert.equal(rec.gauge_length_mm, r.gauge_length_mm)
  assert.equal(rec.nose_dia_mm, r.diameters['D2 diameter (collar)'])
  assert.equal(rec.mass_kg, r.mass_kg)
  assert.equal(rec.image_url, r.image_url)
  assert.equal(rec.drawing_url, r.drawing_url)
  assert.equal(rec.clamp_spec, 'Spigot Ø16 mm')
})

test('new product pages: hydraulic chuck classified by name; the source register values are read', () => {
  const rec = parseHaimerPage(page('A63.1H10.10'), 'https://shop.haimer.com/en/Standard-Hydraulic-Chuck-DIN-69893-1-HSK-A63/A63.1H10.10', 'A63.1H10.10')
  assert.equal(rec.type_code, 'HYDRAULIC')
  assert.equal(rec.series, 'Standard Hydraulic Chuck')
  assert.deepEqual([rec.clamp_dia_mm, rec.gauge_length_mm, rec.nose_dia_mm], [10, 80, 26])
  assert.equal(rec.dims!['G Thread for length adjustment screw'], 'M8x1')
  const s = parseHaimerPage(page('A63.147.05.1'), 'https://shop.haimer.com/en/x/A63.147.05.1', 'A63.147.05.1')
  assert.deepEqual([s.type_code, s.clamp_dia_mm, s.gauge_length_mm, s.nose_dia_mm, s.mass_kg], ['SHRINK', 5, 120, 10, 0.957])
})

test('tolerant parse: dt/dd lists, codes in brackets, comma decimals; a page for another order no. is refused; no GL → partial', () => {
  const html = `<html><head><meta property="og:image" content="/media/x/photo.jpg"></head><body>
    <h1>Shrink Fit Chuck, DIN 69893-1, HSK-A63</h1><span class="product-detail-ordernumber">A63.140.12</span>
    <dl><dt>Clamping diameter (D1):</dt><dd>12,0 mm</dd><dt>Gauge length</dt><dd>90 mm</dd><dt>Weight</dt><dd>940 g</dd>
    <dt>Rotation speed max (rpm)</dt><dd>25.000</dd><dt>D2 Diameter 2</dt><dd>24</dd></dl></body></html>`
  const rec = parseHaimerPage(html, 'https://shop.haimer.com/en/x/A63.140.12', 'A63.140.12')
  assert.deepEqual([rec.clamp_dia_mm, rec.gauge_length_mm, rec.mass_kg, rec.max_rpm, rec.nose_dia_mm], [12, 90, 0.94, 25000, 24])
  assert.equal(rec.image_url, 'https://shop.haimer.com/media/x/photo.jpg', 'relative photo URL made absolute')
  assert.throws(() => parseHaimerPage(html, 'https://shop.haimer.com/en/x/A63.140.10', 'A63.140.10'), /shows order no\. A63\.140\.12, not A63\.140\.10/)
  const noGl = parseHaimerPage(html.replace(/<dt>Gauge length<\/dt><dd>90 mm<\/dd>/, ''), 'https://shop.haimer.com/en/x/A63.140.12', 'A63.140.12')
  assert.equal(noGl.gauge_length_mm, undefined)
  assert.equal(noGl.data_status, 'partial')
  assert.match(noGl.warnings!.join(' '), /No gauge length/)
  assert.throws(() => parseHaimerPage('<html><body><p>Maintenance</p></body></html>', 'https://shop.haimer.com/en/x/A63.1', 'A63.1'), /does not look like a HAIMER product page/)
})
