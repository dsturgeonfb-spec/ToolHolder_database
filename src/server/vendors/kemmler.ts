/**
 * KEMMLER (www.kemmler-shop.de, Shopware 6).
 *  - The shop search works for order nos: /search?search=<order no.> lists the product (or opens it).
 *  - Product pages carry ISO 13399 properties (ADINTMS, DCONWS, DLN, LPR, BD…), photos and free 2D/3D files.
 *  - BUILD_SPEC asks to check which field is the gauge length against the drawing: LPR is mapped to
 *    gauge_length_mm, but the record is marked 'partial' and the proposal carries a warning until the
 *    mapping has been confirmed once on a drawing.
 *  - No robots.txt (404): the app keeps its own 2 s minimum between requests.
 */
import { classifyKemmler, settleRecord } from './classify.js'
import { firstText, galleryImages, loadPage, metaContent, ogImage, photoAndDrawing, specPairs, canonicalUrl } from './html.js'
import { absUrl, cleanText, dimValue, labelCode, parseMassKg, parseNum, parseRange } from './parse.js'
import type { DiscoverOptions, HolderRecord, ProductRef, ScanContext, VendorAdapter } from './types.js'

export const KEMMLER_ORIGIN = 'https://www.kemmler-shop.de'
export const kemmlerSearchUrl = (orderNo: string) => `${KEMMLER_ORIGIN}/search?search=${encodeURIComponent(orderNo)}`

export const KEMMLER_GL_WARNING =
  'Gauge length is mapped from Kemmler\'s LPR (protruding length). Confirm once against the drawing that LPR runs from the HSK gauge line to the nose; until then the data is marked "partly verified".'

const lastSegment = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    return ''
  }
}

/** Product links on a Kemmler search page whose last URL segment is the order no. */
export function kemmlerSearchHits(html: string, pageUrl: string, orderNo: string): string[] {
  const $ = loadPage(html)
  const hits = new Set<string>()
  $('a[href]').each((_, a) => {
    const href = absUrl($(a).attr('href'), pageUrl)
    if (href && new URL(href).host === new URL(KEMMLER_ORIGIN).host && lastSegment(href).toUpperCase() === orderNo.toUpperCase()) hits.add(href.split('#')[0]!)
  })
  return [...hits]
}

/** Is this HTML a product page (Shopware shows the order no. in .product-detail-ordernumber)? */
export function kemmlerPageOrder(html: string): string | null {
  return firstText(loadPage(html), '.product-detail-ordernumber', '[itemprop="sku"]')
}

/** "HSK 63 - M12 - 126 - LB100" → 126: Kemmler titles list clamp, then the protruding length. */
export function glFromKemmlerTitle(title: string | null | undefined): number | null {
  const m = /HSK[\s-]*(?:A[\s-]*)?0*63\b(.*)$/i.exec(title ?? '')
  if (!m) return null
  const parts = m[1]!.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean)
  for (const p of parts.slice(1)) if (/^\d+(?:[.,]\d+)?$/.test(p)) return parseNum(p)
  return null
}

export function parseKemmlerPage(html: string, pageUrl: string, orderNo: string): HolderRecord {
  const $ = loadPage(html)
  const name = firstText($, 'h1.product-detail-name', 'h1[itemprop="name"]', 'h1') ?? metaContent($, 'og:title')
  const pageOrder = firstText($, '.product-detail-ordernumber', '[itemprop="sku"]')
  if (pageOrder && pageOrder.toUpperCase() !== orderNo.toUpperCase())
    throw new Error(`The Kemmler page shows order no. ${pageOrder}, not ${orderNo} — not used.`)
  if (!pageOrder && !specPairs($).length) throw new Error(`No Kemmler product page found for ${orderNo}.`)

  const rec: HolderRecord = {
    manufacturer: 'KEMMLER',
    order_no: orderNo,
    product_name: name,
    dims: {},
    product_url: canonicalUrl($, pageUrl) ?? pageUrl,
    data_status: 'verified',
    data_source: 'kemmler-shop.de',
    warnings: [],
  }
  const dims = rec.dims!
  let dln: number | null = null
  let bd: number | null = null
  let thread: number | null = null
  let dconws: number | null = null
  let ifaceForm: string | null = null
  let lpr: number | null = null
  const balance: string[] = []
  for (const { label, value } of specPairs($)) {
    if (/order ?number|product ?number|^ean\b|gtin|price|delivery|availability|manufacturer/i.test(label)) continue
    const { code } = labelCode(label)
    switch (code) {
      case 'ADINTMS':
        ifaceForm = value
        break
      case 'HSK':
        rec.interface_seen = value
        break
      case 'DCONWS': {
        const range = parseRange(value)
        if (range) [rec.clamp_min_mm, rec.clamp_max_mm] = range
        else dconws = parseNum(value)
        dims[label] = dimValue(value)
        break
      }
      case 'LPR':
        lpr = parseNum(value)
        dims[label] = dimValue(value)
        break
      case 'DLN':
        dln = parseNum(value)
        dims[label] = dimValue(value)
        break
      case 'BD':
      case 'BD1':
      case 'BD_1':
        bd ??= parseNum(value)
        dims[label] = dimValue(value)
        break
      case 'THSZWS':
        thread = parseNum(/M\s*(\d+(?:[.,]\d+)?)/i.exec(value)?.[1] ?? value)
        dims[label] = dimValue(value)
        break
      case 'WT':
        rec.mass_kg = parseMassKg(value)
        break
      case 'RPMX':
        rec.max_rpm = parseNum(value, { integer: true })
        break
      default:
        if (/^(weight|mass)\b/i.test(label)) rec.mass_kg = parseMassKg(value)
        else if (/balanc/i.test(label)) balance.push(value)
        else dims[label] = dimValue(value)
    }
  }
  rec.interface_seen ??= ifaceForm ?? name
  rec.nose_dia_mm = dln ?? bd
  if (balance.length) rec.balance = cleanText(balance.join('; '))

  const typeSeries = classifyKemmler(orderNo)
  // Screw-in arbors clamp by thread (M12 → 12, as the seed); DCONWS there is a centring Ø and stays in dims.
  const titleThread = parseNum(/\bM(\d{1,2})\b/.exec(name ?? '')?.[1])
  if (typeSeries?.[0] === 'SCREW_IN' || /screw-in/i.test(name ?? '')) rec.clamp_dia_mm = thread ?? titleThread
  else if (dconws != null) rec.clamp_dia_mm = dconws

  const titleGl = glFromKemmlerTitle(name)
  if (lpr != null) {
    rec.gauge_length_mm = lpr
    if (titleGl != null && Math.abs(titleGl - lpr) > 0.01)
      rec.warnings!.push(`LPR on the page is ${lpr} mm but the product title says ${titleGl} — check the drawing before approving.`)
  } else if (titleGl != null) {
    rec.gauge_length_mm = titleGl
    rec.warnings!.push(`No LPR in the technical data — gauge length ${titleGl} mm read from the product title "${name}".`)
  }
  if (rec.gauge_length_mm != null) rec.gauge_length_ref = 'LPR'
  rec.data_status = 'partial'
  rec.partial_fields = ['gauge_length_mm', 'gauge_length_ref']
  rec.warnings!.push(rec.gauge_length_mm != null ? KEMMLER_GL_WARNING : 'No gauge length (LPR) on this page — the existing value is kept.')

  const images = galleryImages($, pageUrl, '.gallery-slider-image, .gallery-slider-item img, img[itemprop="image"]')
  const pd = photoAndDrawing(images, ogImage($, pageUrl))
  rec.image_url = pd.image_url
  // Kemmler offers the 2D drawing as a PDF next to the DXF/STEP files.
  rec.drawing_url =
    pd.drawing_url ??
    absUrl(
      $('a[href]')
        .map((_, a) => $(a).attr('href'))
        .get()
        .find((h) => /2D-Zeichnung\.pdf$|drawing.*\.pdf$/i.test(h)),
      pageUrl,
    )
  settleRecord(rec, typeSeries)
  return rec
}

export const kemmler: VendorAdapter = {
  maker: 'KEMMLER',
  method: 'Static HTML (shop search by order no.)',
  automated: true,
  notes:
    'Product pages carry ISO 13399 properties, photos and free DXF/STEP downloads; the shop search finds a product by order no. Gauge length comes from LPR and is marked partly verified until confirmed against a drawing.',
  robots: 'No robots.txt (404) — the app keeps its own 2 s minimum between requests.',
  source_url: 'https://www.kemmler-shop.de/en/Products-Shop/ISO-12164-HSK-A/',
  delay_hint_s: 2,
  origins: [KEMMLER_ORIGIN],

  async discover(sc: ScanContext, _iface: string, o: DiscoverOptions): Promise<ProductRef[]> {
    if (o.full) sc.log('Kemmler has no full-range discovery here — scanning the catalogue holders and any order nos entered.')
    const known = new Map(o.known.map((k) => [k.order_no.toUpperCase(), k]))
    const refs = new Map<string, ProductRef>()
    for (const e of o.entered) refs.set(e.toUpperCase(), known.get(e.toUpperCase()) ?? { order_no: e, origin: 'entered' })
    if (!o.entered.length || o.full) for (const k of o.known) if (!refs.has(k.order_no.toUpperCase())) refs.set(k.order_no.toUpperCase(), k)
    // Only a stored address that is the product page itself is reused; otherwise search by order no.
    return [...refs.values()].map((r) => ({ ...r, url: r.url && lastSegment(r.url).toUpperCase() === r.order_no.toUpperCase() ? r.url : null }))
  },

  async fetch(sc: ScanContext, ref: ProductRef): Promise<HolderRecord> {
    let page: { url: string; text: string }
    if (ref.url) page = await sc.fetcher.getText(ref.url)
    else {
      const search = await sc.fetcher.getText(kemmlerSearchUrl(ref.order_no))
      if (kemmlerPageOrder(search.text)) page = search // the shop opened the product directly
      else {
        const hits = kemmlerSearchHits(search.text, search.url, ref.order_no)
        if (!hits.length) throw new Error(`Kemmler's shop search found no product with order no. ${ref.order_no}.`)
        page = await sc.fetcher.getText(hits[0]!)
      }
    }
    return parseKemmlerPage(page.text, page.url, ref.order_no)
  },
}
