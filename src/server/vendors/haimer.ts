/**
 * HAIMER (shop.haimer.com, Shopware storefront).
 *  - Product pages are static HTML with a DIN 4000 / ISO 13399 spec table and photo URLs.
 *  - Category pages answer 404 to non-browser clients and /search is disallowed by robots.txt, so the range
 *    is discovered from sitemap.xml (an index of gzipped child sitemaps) filtered on "HSK-A63" or "/A63.".
 *  - robots.txt asks for a 10 s crawl delay: about six pages a minute.
 * Order no. = last URL segment. Spec labels are matched by their code (D1 clamp Ø, A gauge length,
 * D2 nose Ø, WT mass, D6 max rpm, D5 balance, H21/H22 coolant); everything else goes to dims.
 */
import { classifyHaimer, settleRecord } from './classify.js'
import { BlockedError, VendorFetchError, maybeGunzip, decodeText, type PoliteFetcher } from './fetcher.js'
import { canonicalUrl, firstText, galleryImages, loadPage, metaContent, ogImage, photoAndDrawing, specPairs } from './html.js'
import { cleanText, dimValue, labelCode, parseMassKg, parseNum, parseRange } from './parse.js'
import type { DiscoverOptions, HolderRecord, ProductRef, ScanContext, VendorAdapter } from './types.js'

export const HAIMER_ORIGIN = 'https://shop.haimer.com'
export const HAIMER_SITEMAP = `${HAIMER_ORIGIN}/sitemap.xml`

/** URL fragments that mark a product for an interface: HSK-A63 → ["HSK-A63", "/A63."]. */
export function haimerUrlTokens(iface: string): string[] {
  const m = /^HSK-([A-F])(\d{2,3})$/i.exec(iface.trim())
  if (m) return [`HSK-${m[1]!.toUpperCase()}${m[2]}`, `/${m[1]!.toUpperCase()}${m[2]}.`]
  return [iface.trim()]
}

/** True for an address on HAIMER's own shop (https://shop.haimer.com, no user name or other port). */
export function isHaimerUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.origin === HAIMER_ORIGIN && !u.username && !u.password
  } catch {
    return false
  }
}

/** Order no. from a HAIMER product URL (last path segment), or null for category/other pages. */
export function haimerOrderFromUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.pathname.endsWith('/')) return null
  const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
  return /^[A-Z]\d{1,4}\.[A-Z0-9]+(?:\.[A-Z0-9]+)*$/i.test(seg) ? seg : null
}

/** <loc> entries of a sitemap or sitemap index. */
export function sitemapLocs(xml: string): { index: boolean; locs: string[] } {
  const index = /<sitemapindex[\s>]/i.test(xml)
  const locs: string[] = []
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi))
    locs.push(m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
  return { index, locs }
}

/**
 * Every product URL for the interface found through the sitemap. English pages are preferred
 * (the DE sitemap lists the same products), and each order no. appears once.
 */
export async function haimerSitemapProducts(fetcher: PoliteFetcher, iface: string, log: (m: string) => void, signal?: AbortSignal): Promise<Map<string, string>> {
  const tokens = haimerUrlTokens(iface).map((t) => t.toLowerCase())
  const urls: string[] = []
  const queue = [HAIMER_SITEMAP]
  const seen = new Set<string>()
  while (queue.length && seen.size < 50) {
    if (signal?.aborted) break
    const sm = queue.shift()!
    if (seen.has(sm)) continue
    seen.add(sm)
    let xml: string
    try {
      const r = await fetcher.get(sm, { accept: 'application/xml,text/xml,application/x-gzip,*/*;q=0.5', maxBytes: 50 * 1024 * 1024 })
      fetcher.assertOk(r)
      xml = decodeText(maybeGunzip(r.body), r.contentType.includes('gzip') ? 'utf-8' : r.contentType)
    } catch (err) {
      // The index itself, a block or a cancel ends discovery; one unreadable child sitemap does not.
      if (sm === HAIMER_SITEMAP || err instanceof BlockedError || (err instanceof VendorFetchError && err.kind === 'cancelled')) throw err
      log(`Could not read ${sm.split('/').pop()}: ${(err as Error).message} — skipped`)
      continue
    }
    const { index, locs: all } = sitemapLocs(xml)
    // Only addresses on HAIMER's own shop are followed or read (a sitemap could list any site).
    const locs = all.filter(isHaimerUrl)
    if (locs.length < all.length) log(`${sm.split('/').pop()}: ${all.length - locs.length} address${all.length - locs.length === 1 ? '' : 'es'} on other sites ignored`)
    if (index) {
      log(`Sitemap index lists ${locs.length} sitemap${locs.length === 1 ? '' : 's'}`)
      queue.push(...locs)
    } else {
      urls.push(...locs)
      log(`${sm.split('/').pop()}: ${locs.length} addresses`)
    }
  }
  const matching = urls.filter((u) => tokens.some((t) => u.toLowerCase().includes(t)) && haimerOrderFromUrl(u))
  const english = matching.filter((u) => /\/en\//.test(u))
  const out = new Map<string, string>()
  for (const u of english.length ? english : matching) {
    const o = haimerOrderFromUrl(u)!
    if (!out.has(o)) out.set(o, u)
  }
  log(`${out.size} ${iface} product pages in the sitemap`)
  return out
}

const SKIP_LABEL = /order ?number|product ?number|article ?number|^ean\b|gtin|manufacturer|^price|delivery|availability|^sku\b/i

/**
 * Parses one HAIMER product page into a record. Throws when the page is for a different order no.
 * (a redirect to another variant must never be filed under the one we asked for).
 */
export function parseHaimerPage(html: string, pageUrl: string, orderNo: string): HolderRecord {
  const $ = loadPage(html)
  const name = firstText($, 'h1.product-detail-name', 'h1[itemprop="name"]', 'h1') ?? metaContent($, 'og:title')
  const pageOrder = firstText($, '.product-detail-ordernumber', '[itemprop="sku"]') ?? metaContent($, 'sku', 'productID')
  if (pageOrder && pageOrder.toUpperCase() !== orderNo.toUpperCase())
    throw new Error(`The HAIMER page shows order no. ${pageOrder}, not ${orderNo} — not used. Check the address on the holder.`)
  if (!name && !specPairs($).length) throw new Error('This does not look like a HAIMER product page (no product name or technical data).')

  const rec: HolderRecord = {
    manufacturer: 'HAIMER',
    order_no: orderNo,
    product_name: name,
    interface_seen: name && /HSK/i.test(name) ? name : firstText($, '.breadcrumb'),
    dims: {},
    product_url: canonicalUrl($, pageUrl) ?? pageUrl,
    data_status: 'verified',
    data_source: 'shop.haimer.com',
    warnings: [],
  }
  const dims = rec.dims!
  const coolant: string[] = []
  const balance: string[] = []
  let noseD: number | null = null
  for (const { label, value } of specPairs($)) {
    if (SKIP_LABEL.test(label)) continue
    const { code, text } = labelCode(label)
    const lt = text.toLowerCase()
    if (code === 'D1' || (!code && /^clamping diameter$/i.test(text))) {
      const range = parseRange(value)
      if (range) [rec.clamp_min_mm, rec.clamp_max_mm] = range
      else rec.clamp_dia_mm = parseNum(value)
    } else if (/clamping range/i.test(label)) {
      const range = parseRange(value)
      if (range) [rec.clamp_min_mm, rec.clamp_max_mm] = range
      else dims[label] = dimValue(value)
    } else if (code === 'A' || (!code && /^(length a|gauge length)$/i.test(text))) {
      rec.gauge_length_mm = parseNum(value)
      rec.gauge_length_ref = 'A'
    } else if (code === 'D2') {
      rec.nose_dia_mm = parseNum(value)
      dims[label] = dimValue(value)
    } else if (code === 'D' && /diameter|nut/i.test(lt)) {
      noseD = parseNum(value)
      dims[label] = dimValue(value)
    } else if (code === 'WT' || (!code && /^(weight|mass)\b/i.test(text))) {
      rec.mass_kg = parseMassKg(value)
    } else if (code === 'D6' || code === 'RPMX' || /rotation speed max|max(imum)?\.? (rotation(al)? )?speed|speed max/i.test(label)) {
      rec.max_rpm = parseNum(value, { integer: true })
    } else if (code === 'D5' || /balanc/i.test(label)) {
      balance.push(value)
    } else if (code === 'H21' || code === 'H22' || /coolant/i.test(label)) {
      coolant.push(`${label} = ${value}`)
    } else {
      dims[label] = dimValue(value)
    }
  }
  if (rec.nose_dia_mm == null && noseD != null) rec.nose_dia_mm = noseD
  if (coolant.length) rec.coolant = cleanText(coolant.join('; '))
  if (balance.length) rec.balance = cleanText(balance.join('; '))

  const images = galleryImages($, pageUrl, '.gallery-slider-image, .gallery-slider-item img, img[itemprop="image"], .product-detail-media img')
  Object.assign(rec, photoAndDrawing(images, ogImage($, pageUrl)))

  if (rec.gauge_length_mm == null) {
    rec.data_status = 'partial'
    rec.partial_fields = ['gauge_length_mm']
    rec.warnings!.push('No gauge length (A) on this page — the existing value is kept.')
  }
  settleRecord(rec, classifyHaimer(orderNo))
  return rec
}

export const haimer: VendorAdapter = {
  maker: 'HAIMER',
  method: 'Static HTML (product pages, sitemap discovery)',
  automated: true,
  notes:
    'Product pages are plain HTML with a DIN 4000 / ISO 13399 spec table and photo URLs. Category pages refuse non-browser requests, so the range is found through shop.haimer.com/sitemap.xml.',
  robots: 'robots.txt: Crawl-delay 10 s (about six pages a minute); /search, /printpage/ and /downloadfile/ are disallowed and never requested.',
  source_url: 'https://shop.haimer.com/en/Tool-Holders/HSK-Hollow-shank-DIN-69893/HSK-A63/',
  delay_hint_s: 10,
  origins: [HAIMER_ORIGIN],

  async discover(sc: ScanContext, iface: string, o: DiscoverOptions): Promise<ProductRef[]> {
    const refs = new Map<string, ProductRef>()
    const known = new Map(o.known.map((k) => [k.order_no.toUpperCase(), k]))
    // A stored URL is reused only when it is the product's own page on HAIMER's shop (some seed rows point at
    // a variant selector; a link edited to another site is never followed — the sitemap finds the page instead).
    const usable = (k: ProductRef) => isHaimerUrl(k.url) && haimerOrderFromUrl(k.url!)?.toUpperCase() === k.order_no.toUpperCase()
    const wanted = o.entered.length ? o.entered.map((e) => known.get(e.toUpperCase()) ?? { order_no: e, origin: 'entered' as const }) : o.full ? [] : o.known
    let sitemap: Map<string, string> | null = null
    const needSitemap = o.full || wanted.some((w) => !usable(w))
    if (needSitemap) {
      sc.log('Reading the HAIMER sitemap to find product pages…')
      sitemap = await haimerSitemapProducts(sc.fetcher, iface, sc.log, sc.signal)
    }
    const bySitemap = new Map([...(sitemap ?? new Map<string, string>())].map(([k, v]) => [k.toUpperCase(), { order: k, url: v }]))
    for (const w of wanted) {
      if (usable(w)) refs.set(w.order_no.toUpperCase(), { ...w })
      else {
        const hit = bySitemap.get(w.order_no.toUpperCase())
        refs.set(
          w.order_no.toUpperCase(),
          hit
            ? { ...w, url: hit.url }
            : { ...w, url: null, error: `${w.order_no} is not in HAIMER's sitemap for ${iface} — check the order no. on shop.haimer.com.` },
        )
      }
    }
    if (o.full && sitemap) {
      for (const k of o.known) if (!refs.has(k.order_no.toUpperCase())) {
        const hit = bySitemap.get(k.order_no.toUpperCase())
        refs.set(k.order_no.toUpperCase(), usable(k) ? k : hit ? { ...k, url: hit.url } : { ...k, error: `${k.order_no} is no longer in HAIMER's sitemap — it may be discontinued.` })
      }
      for (const [key, hit] of bySitemap) if (!refs.has(key)) refs.set(key, { order_no: hit.order, url: hit.url, origin: 'discovered' })
    }
    return [...refs.values()]
  },

  async fetch(sc: ScanContext, ref: ProductRef): Promise<HolderRecord> {
    if (!ref.url) throw new Error(`No HAIMER page address for ${ref.order_no}.`)
    if (!isHaimerUrl(ref.url)) throw new Error(`${ref.url} is not a shop.haimer.com address — not read.`)
    const page = await sc.fetcher.getText(ref.url)
    // page.url is where any redirect ended: a moved product keeps its new address.
    return parseHaimerPage(page.text, page.url, ref.order_no)
  },
}
