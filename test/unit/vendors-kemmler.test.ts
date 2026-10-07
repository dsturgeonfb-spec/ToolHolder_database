import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, REPO } from '../helpers.js'
import { HostGates, PoliteFetcher } from '../../src/server/vendors/fetcher.js'
import { fixtureFetch } from '../../src/server/vendors/fixtures.js'
import { KEMMLER_GL_WARNING, glFromKemmlerTitle, kemmler, kemmlerSearchHits, parseKemmlerPage } from '../../src/server/vendors/kemmler.js'

const DIR = join(FIXTURES, 'vendors')
const page = (f: string) => readFileSync(join(DIR, 'kemmler', f), 'utf8')
const rawK = (JSON.parse(readFileSync(join(REPO, 'data', 'raw', 'haimer_other_kemmler.json'), 'utf8')) as any[]).find((r) => r.order_no === 'A63.06.12.3')

test('search page: the product link whose last segment is exactly the order no. is chosen', () => {
  const hits = kemmlerSearchHits(page('search-A63.02.20.0.html'), 'https://www.kemmler-shop.de/search?search=A63.02.20.0', 'A63.02.20.0')
  assert.deepEqual(hits, ['https://www.kemmler-shop.de/en/ER-Collet-chuck-HSK-63-2-20-75-ER-32/A63.02.20.0'])
  assert.deepEqual(kemmlerSearchHits(page('search-A63.02.20.0.html'), 'https://www.kemmler-shop.de/search', 'A63.99.99.9'), [])
})

test('GL in Kemmler titles: "HSK 63 - M12 - 126 - LB100" → 126, "HSK 63 - 2-20 - 75 - ER 32" → 75', () => {
  assert.equal(glFromKemmlerTitle('Milling arbors for screw-in cutters HSK 63 - M12 - 126 - LB100'), 126)
  assert.equal(glFromKemmlerTitle('ER Collet chuck HSK 63 - 2-20 - 75 - ER 32'), 75)
  assert.equal(glFromKemmlerTitle('Something else'), null)
})

test('screw-in arbor page → record matching data/raw (BD1 nose, M12 thread, GL from title), marked partial with the GL warning', () => {
  const rec = parseKemmlerPage(page('A63.06.12.3.html'), rawK.product_url, 'A63.06.12.3')
  assert.equal(rec.type_code, 'SCREW_IN')
  assert.equal(rec.clamp_dia_mm, rawK.clamp_dia_mm, 'thread size, as the seed stores screw-in holders')
  assert.deepEqual([rec.clamp_min_mm, rec.clamp_max_mm], [null, null])
  assert.equal(rec.gauge_length_mm, rawK.gauge_length_mm)
  assert.equal(rec.gauge_length_ref, 'LPR')
  assert.equal(rec.nose_dia_mm, rawK.diameters['BD1 body diameter 1'])
  assert.equal(rec.dims!['DCONWS clamping dia nominal workpiece side'], 12.5, 'centring Ø kept in dims (comma decimal)')
  assert.equal(rec.dims!['LB body length'], 100)
  assert.equal(rec.image_url, rawK.image_url)
  assert.equal(rec.drawing_url, rawK.drawing_url, 'the 2D drawing PDF')
  assert.equal(rec.balance, rawK.balancing)
  assert.equal(rec.interface_seen, 'HSK-A 63')
  assert.equal(rec.data_status, 'partial')
  assert.deepEqual(rec.partial_fields, ['gauge_length_mm', 'gauge_length_ref'])
  assert.ok(rec.warnings!.includes(KEMMLER_GL_WARNING))
  assert.match(rec.warnings!.join(' '), /read from the product title/)
})

test('ER collet chuck: DCONWS range → clamp min/max, DLN → nose, weight in kg', () => {
  const rec = parseKemmlerPage(page('A63.02.20.0.html'), 'https://www.kemmler-shop.de/en/ER-Collet-chuck-HSK-63-2-20-75-ER-32/A63.02.20.0', 'A63.02.20.0')
  assert.equal(rec.type_code, 'ER_COLLET')
  assert.deepEqual([rec.clamp_min_mm, rec.clamp_max_mm, rec.clamp_dia_mm], [2, 20, null])
  assert.equal(rec.nose_dia_mm, 50)
  assert.equal(rec.mass_kg, 1)
  assert.equal(rec.gauge_length_mm, 75)
  assert.equal(rec.clamp_spec, 'ER32 · 2–20 mm')
  assert.equal(rec.drawing_url, null, 'only DXF/STEP downloads here — not a viewable drawing')
})

test('LPR in the technical data is the gauge length (partial + warning); disagreeing with the title is flagged', () => {
  const html = (lpr: string) => `<html><body><h1 class="product-detail-name">Milling arbors for screw-in cutters HSK 63 - M12 - 126 - LB100</h1>
    <span class="product-detail-ordernumber">A63.06.12.3</span><table>
    <tr><th>LPR protruding length:</th><td>${lpr}</td></tr><tr><th>DLN</th><td>22</td></tr><tr><th>BD1</th><td>21</td></tr>
    <tr><th>THSZWS</th><td>M12</td></tr><tr><th>ADINTMS</th><td>ISO 12164 (HSK-A)</td></tr></table></body></html>`
  const ok = parseKemmlerPage(html('126'), 'https://www.kemmler-shop.de/en/x/A63.06.12.3', 'A63.06.12.3')
  assert.deepEqual([ok.gauge_length_mm, ok.gauge_length_ref, ok.nose_dia_mm, ok.clamp_dia_mm], [126, 'LPR', 22, 12], 'DLN wins over BD1')
  assert.ok(ok.warnings!.includes(KEMMLER_GL_WARNING))
  assert.equal(ok.interface_seen, 'ISO 12164 (HSK-A)', 'form only — the diff warns that the size is not stated')
  const off = parseKemmlerPage(html('130'), 'https://www.kemmler-shop.de/en/x/A63.06.12.3', 'A63.06.12.3')
  assert.match(off.warnings!.join(' '), /LPR on the page is 130 mm but the product title says 126/)
  assert.throws(() => parseKemmlerPage(html('126'), 'https://www.kemmler-shop.de/en/x/A63.06.12.3', 'A63.06.12.4'), /shows order no\. A63\.06\.12\.3/)
})

test('fetch(): search → product page; a search that redirects straight to the product is followed', async () => {
  const net = fixtureFetch(DIR)
  const f = new PoliteFetcher({ userAgent: 'HolderCatalogue/test', allowedOrigins: kemmler.origins!, lookup: null, fetch: net, sleep: async () => {}, gates: new HostGates() })
  const sc = { db: null as any, fetcher: f, log: () => {} }
  const refs = await kemmler.discover!(sc, 'HSK-A63', { known: [], entered: ['A63.02.20.0', 'A63.06.12.3'], full: false })
  assert.ok(refs.every((r) => r.url === null))
  const er = await kemmler.fetch!(sc, refs[0]!, 'HSK-A63')
  assert.equal(er.order_no, 'A63.02.20.0')
  const arbor = await kemmler.fetch!(sc, refs[1]!, 'HSK-A63')
  assert.equal(arbor.product_url, 'https://www.kemmler-shop.de/en/Milling-arbors-for-screw-in-cutters-HSK-63-M12-126-LB100/A63.06.12.3')
  assert.deepEqual(
    net.requested.map((r) => r.url),
    [
      'https://www.kemmler-shop.de/robots.txt',
      'https://www.kemmler-shop.de/search?search=A63.02.20.0',
      'https://www.kemmler-shop.de/en/ER-Collet-chuck-HSK-63-2-20-75-ER-32/A63.02.20.0',
      'https://www.kemmler-shop.de/search?search=A63.06.12.3',
      'https://www.kemmler-shop.de/en/Milling-arbors-for-screw-in-cutters-HSK-63-M12-126-LB100/A63.06.12.3',
    ],
  )
})

test('discover(): a stored URL is reused only on kemmler-shop.de — one on another host falls back to the shop search', async () => {
  const f = new PoliteFetcher({ userAgent: 'HolderCatalogue/test', allowedOrigins: kemmler.origins!, lookup: null, fetch: fixtureFetch(DIR), sleep: async () => {}, gates: new HostGates() })
  const sc = { db: null as any, fetcher: f, log: () => {} }
  const own = 'https://www.kemmler-shop.de/en/Milling-arbors-for-screw-in-cutters-HSK-63-M12-126-LB100/A63.06.12.3'
  const refs = await kemmler.discover!(sc, 'HSK-A63', {
    known: [
      { order_no: 'A63.06.12.3', url: own, origin: 'catalogue' },
      { order_no: 'A63.02.20.0', url: 'http://127.0.0.1:27499/admin/A63.02.20.0', origin: 'catalogue' },
    ],
    entered: [],
    full: false,
  })
  assert.deepEqual(refs.map((r) => r.url), [own, null])
  await assert.rejects(kemmler.fetch!(sc, { order_no: 'A63.02.20.0', url: 'http://10.0.0.8/A63.02.20.0', origin: 'catalogue' }, 'HSK-A63'), /not a kemmler-shop\.de address/)
  // Search hits only ever point at the shop itself.
  const html = '<a href="http://127.0.0.1/x/A63.02.20.0">evil</a><a href="https://www.kemmler-shop.de.evil.example/A63.02.20.0">look-alike</a>'
  assert.deepEqual(kemmlerSearchHits(html, 'https://www.kemmler-shop.de/search?search=A63.02.20.0', 'A63.02.20.0'), [])
})
