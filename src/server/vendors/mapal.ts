/**
 * MAPAL (shop.mapal.com).
 *  - Every product opens at https://shop.mapal.com/en/p/0000000000<order no.> (redirects to its full address).
 *  - The designation encodes the geometry: MHC-HSK-A063-12-075-… = HydroChuck, HSK-A63, Ø12, GL (l1) 75.
 *    It is parsed as a fallback and cross-checked against the technical data; a mismatch is a warning.
 *  - There is no practical full-range discovery (listings run to 1,100+ items across every HSK size), so a
 *    scan covers the MAPAL order nos already in the catalogue plus any the person types in.
 */
import { classifyMapal, settleRecord } from './classify.js'
import { canonicalUrl, firstText, galleryImages, loadPage, metaContent, ogImage, photoAndDrawing, specPairs } from './html.js'
import { cleanText, dimValue, labelCode, parseMassKg, parseNum, parseRange } from './parse.js'
import type { DiscoverOptions, HolderRecord, ProductRef, ScanContext, VendorAdapter } from './types.js'

export const MAPAL_ORIGIN = 'https://shop.mapal.com'
export const mapalProductUrl = (orderNo: string) => `${MAPAL_ORIGIN}/en/p/0000000000${orderNo}`

/** A MAPAL product page address: https://shop.mapal.com/…/p/<digits> — anchored, so nothing can hide it in a query string. */
const MAPAL_PRODUCT_URL = /^https:\/\/shop\.mapal\.com\/(?:[^/?#]+\/)*p\/0*(\d+)\/?(?:[?#]|$)/

/** The order no. in a MAPAL product address, or null for any other address (another site, a category page…). */
export function mapalOrderFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = MAPAL_PRODUCT_URL.exec(url)
  if (!m) return null
  try {
    const u = new URL(url)
    if (u.origin !== MAPAL_ORIGIN || u.username || u.password) return null
  } catch {
    return null
  }
  return m[1]!
}

export interface MapalDesignation {
  family: string
  form: string
  size: number
  d1: number
  l1: number
}

/** MHC-HSK-A063-12-075-1-0-A → {family MHC, form A, size 63, d1 12, l1 75}; null when it is not that pattern. */
export function parseMapalDesignation(d: string | null | undefined): MapalDesignation | null {
  const m = /^([A-Z]{2,5})-HSK-([A-F])0*(\d{2,3})-(\d+(?:[.,]\d+)?)-(\d+(?:[.,]\d+)?)(?:-|$)/i.exec((d ?? '').trim())
  if (!m) return null
  return { family: m[1]!.toUpperCase(), form: m[2]!.toUpperCase(), size: Number(m[3]), d1: parseNum(m[4])!, l1: parseNum(m[5])! }
}

/** MAPAL order nos are 8 digits; people also paste the shop's 18-digit form with leading zeros. */
export function normMapalOrder(s: string): string {
  const t = s.trim()
  const m = /^0+(\d{8})$/.exec(t)
  return m ? m[1]! : t
}

const SKIP_LABEL = /order ?no|order ?number|material ?no|article|^ean\b|gtin|price|delivery|availability/i

export function parseMapalPage(html: string, pageUrl: string, orderNo: string, requestedUrl?: string): HolderRecord {
  const $ = loadPage(html)
  const name = firstText($, 'h1.product-details__name', 'h1[itemprop="name"]', 'h1') ?? metaContent($, 'og:title')
  const urlOrder = mapalOrderFromUrl(canonicalUrl($, pageUrl)) ?? mapalOrderFromUrl(pageUrl) ?? undefined
  const textOrder = /(\d{8})/.exec(firstText($, '.product-details__code', '[itemprop="sku"]') ?? '')?.[1]
  const pageOrder = textOrder ?? urlOrder
  if (pageOrder && pageOrder !== orderNo.replace(/^0+/, ''))
    throw new Error(`The MAPAL page shows order no. ${pageOrder}, not ${orderNo} — not used.`)

  const rec: HolderRecord = {
    manufacturer: 'MAPAL',
    order_no: orderNo,
    product_name: name,
    dims: {},
    // The /p/<order no.> address always resolves, so it is the stable link to keep.
    product_url: requestedUrl ?? pageUrl,
    data_status: 'verified',
    data_source: 'shop.mapal.com',
    warnings: [],
  }
  const dims = rec.dims!
  let designation = firstText($, '.product-details__designation')
  let d1Page: number | null = null
  let d1Range: [number, number] | null = null
  let supply: string | null = null
  let outlet: string | null = null
  const balance: string[] = []
  for (const { label, value } of specPairs($)) {
    if (SKIP_LABEL.test(label)) continue
    const { code, text } = labelCode(label)
    if (/designation|bezeichnung/i.test(label)) designation ??= value
    else if (code === 'd1') {
      d1Range = parseRange(value)
      if (!d1Range) {
        d1Page = parseNum(value)
        dims.d1 = dimValue(value)
      }
    } else if (code === 'l1') {
      rec.gauge_length_mm = parseNum(value)
      rec.gauge_length_ref = 'l1'
    } else if (code === 'd2') {
      rec.nose_dia_mm = parseNum(value)
      dims.d2 = dimValue(value)
    } else if (/^(weight|mass)\b/i.test(text || label)) rec.mass_kg = parseMassKg(value)
    else if (/speed|rpm|n ?max/i.test(label)) rec.max_rpm = parseNum(value, { integer: true })
    else if (/balanc/i.test(label)) balance.push(value)
    else if (/coolant (supply|entry)/i.test(label)) supply = value
    else if (/coolant (outlet|exit)/i.test(label)) outlet = value
    else if (/connection.*machine side|machine side.*connection|interface.*machine/i.test(label)) rec.interface_seen = value
    // "d3 [mm]" is stored as d3 (as the UNIQ catalogue rows are); descriptive labels keep their wording.
    else dims[code && /^[a-z]{1,2}\d{1,2}\s*(\[[^\]]*\])?$/.test(label) ? code : label] = dimValue(value)
  }
  if (!designation) designation = /\b[A-Z]{2,5}-HSK-[A-F]\d{2,3}(?:-[0-9A-Z.,]+)+/.exec($('body').text())?.[0] ?? null
  rec.spec_code = cleanText(designation, 200)
  if (supply || outlet) rec.coolant = cleanText([supply ? `${supply.toLowerCase()} supply` : null, outlet ? `outlet ${outlet.toLowerCase()}` : null].filter(Boolean).join('; '))
  if (balance.length) rec.balance = cleanText(balance.join('; '))

  const des = parseMapalDesignation(designation)
  if (des) {
    rec.interface_seen ??= `HSK-${des.form}${des.size}`
    if (d1Range) {
      ;[rec.clamp_min_mm, rec.clamp_max_mm] = d1Range
      if (Math.abs(d1Range[1] - des.d1) > 0.01)
        rec.warnings!.push(`The designation says ${des.d1} mm but the technical data gives a clamping range of ${d1Range[0]}–${d1Range[1]} mm — check before approving.`)
    } else if (d1Page != null) {
      rec.clamp_dia_mm = d1Page
      if (Math.abs(d1Page - des.d1) > 0.01) rec.warnings!.push(`Designation says Ø${des.d1} mm but the technical data says d1 = ${d1Page} mm — check the drawing before approving.`)
    } else {
      rec.clamp_dia_mm = des.d1
      rec.warnings!.push(`Clamp Ø ${des.d1} mm read from the designation ${designation} (no d1 in the technical data).`)
    }
    if (rec.gauge_length_mm != null) {
      if (Math.abs(rec.gauge_length_mm - des.l1) > 0.01)
        rec.warnings!.push(`Designation says gauge length ${des.l1} mm but the technical data says l1 = ${rec.gauge_length_mm} mm — check the drawing before approving.`)
    } else {
      rec.gauge_length_mm = des.l1
      rec.gauge_length_ref = 'l1'
      rec.warnings!.push(`Gauge length ${des.l1} mm read from the designation ${designation} (no l1 in the technical data).`)
    }
  } else {
    if (d1Range) [rec.clamp_min_mm, rec.clamp_max_mm] = d1Range
    else if (d1Page != null) rec.clamp_dia_mm = d1Page
    if (designation) rec.warnings!.push(`Designation "${designation}" is not in the usual MAPAL pattern, so it could not be cross-checked.`)
  }

  const images = galleryImages($, pageUrl, '.product-image img, .gallery img, img[itemprop="image"], .product-details__image img')
  Object.assign(rec, photoAndDrawing(images, ogImage($, pageUrl)))
  if (rec.gauge_length_mm == null) {
    rec.data_status = 'partial'
    rec.partial_fields = ['gauge_length_mm']
    rec.warnings!.push('No gauge length (l1) on this page — the existing value is kept.')
  }
  settleRecord(rec, classifyMapal(designation, name))
  return rec
}

export const mapal: VendorAdapter = {
  maker: 'MAPAL',
  method: 'Static HTML (product pages by order no.) + PDF catalogue',
  automated: true,
  notes:
    'Every MAPAL product opens at shop.mapal.com/en/p/0000000000<order no.>, and the designation encodes the geometry (MHC-HSK-A063-12-075 is Ø12, GL 75). Scans cover the MAPAL holders already in the catalogue plus any order nos you enter.',
  robots: 'robots.txt read at scan time; at least 2 s between requests.',
  source_url: 'https://shop.mapal.com/Spannen/Spannfutter/c/chucks?q=%3Adiameter-asc%3AClampingConnectionCodeMachineSide%3AHSK0506',
  delay_hint_s: 2,
  origins: [MAPAL_ORIGIN],

  async discover(sc: ScanContext, _iface: string, o: DiscoverOptions): Promise<ProductRef[]> {
    if (o.full) sc.log('MAPAL has no full-range discovery (its listings mix every HSK size) — scanning the catalogue holders and any order nos entered.')
    const known = new Map(o.known.map((k) => [k.order_no, k]))
    const wanted = o.entered.length ? o.entered.map(normMapalOrder) : []
    const refs = new Map<string, ProductRef>()
    for (const e of wanted) refs.set(e, known.get(e) ?? { order_no: e, origin: 'entered' })
    if (!wanted.length || o.full) for (const k of o.known) if (!refs.has(k.order_no)) refs.set(k.order_no, k)
    return [...refs.values()].map((r) => ({
      ...r,
      error: /^\d{6,10}$/.test(r.order_no) ? r.error : `"${r.order_no}" is not a MAPAL order no. (8 digits, e.g. 30524702).`,
      // A stored address is reused only when it is a MAPAL product page for this very order no.
      url: mapalOrderFromUrl(r.url) === r.order_no.replace(/^0+/, '') ? r.url : mapalProductUrl(r.order_no),
    }))
  },

  async fetch(sc: ScanContext, ref: ProductRef): Promise<HolderRecord> {
    const url = ref.url ?? mapalProductUrl(ref.order_no)
    const page = await sc.fetcher.getText(url)
    return parseMapalPage(page.text, page.url, ref.order_no, url)
  },
}
