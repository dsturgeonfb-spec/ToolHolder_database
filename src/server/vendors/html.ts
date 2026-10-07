/**
 * Reading maker pages with cheerio. Kept generic so a small change in a maker's markup (a class name,
 * a table turned into a definition list) does not break the parse: specs are read as label/value pairs
 * from any two-cell table row or dt/dd pair, and labels are matched by their DIN/ISO code.
 */
import * as cheerio from 'cheerio'
import { absUrl, cleanText } from './parse.js'

export type Page = cheerio.CheerioAPI

export function loadPage(html: string): Page {
  return cheerio.load(html)
}

export interface SpecPair {
  label: string
  value: string
}

/** Every label/value pair on the page, in document order (first occurrence of a label wins). */
export function specPairs($: Page): SpecPair[] {
  const out: SpecPair[] = []
  const seen = new Set<string>()
  const push = (l: string | null, v: string | null) => {
    const label = (l ?? '').replace(/\s*:\s*$/, '').trim()
    if (!label || v == null || label.length > 160) return
    const key = label.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ label, value: v })
  }
  $('tr').each((_, tr) => {
    const cells = $(tr).children('th,td')
    if (cells.length !== 2) return
    push(cleanText($(cells[0]).text(), 200), cleanText($(cells[1]).text(), 600))
  })
  $('dl').each((_, dl) => {
    $(dl)
      .children('dt')
      .each((__, dt) => {
        const dd = $(dt).nextAll('dd').first()
        if (dd.length) push(cleanText($(dt).text(), 200), cleanText(dd.text(), 600))
      })
  })
  return out
}

export function metaContent($: Page, ...names: string[]): string | null {
  for (const n of names) {
    const v = $(`meta[property="${n}"]`).attr('content') ?? $(`meta[name="${n}"]`).attr('content') ?? $(`meta[itemprop="${n}"]`).attr('content')
    const t = cleanText(v)
    if (t) return t
  }
  return null
}

export function firstText($: Page, ...selectors: string[]): string | null {
  for (const s of selectors) {
    const t = cleanText($(s).first().text(), 400)
    if (t) return t
  }
  return null
}

/** The page's og:image as an absolute http(s) URL (shops often write it relative). */
export function ogImage($: Page, base: string): string | null {
  return absUrl(metaContent($, 'og:image'), base)
}

export function canonicalUrl($: Page, base: string): string | null {
  return absUrl($('link[rel="canonical"]').attr('href'), base)
}

export interface PageImage {
  url: string
  alt: string
}

/** Product images in the page's gallery (absolute http(s) URLs, no duplicates, no data: URIs). */
export function galleryImages($: Page, base: string, selector: string): PageImage[] {
  const out: PageImage[] = []
  const seen = new Set<string>()
  $(selector).each((_, el) => {
    const $el = $(el)
    const src = $el.attr('data-full-image') ?? $el.attr('data-src') ?? $el.attr('src') ?? $el.attr('href')
    const url = absUrl(src, base)
    if (!url || seen.has(url)) return
    seen.add(url)
    out.push({ url, alt: cleanText(`${$el.attr('alt') ?? ''} ${$el.attr('title') ?? ''}`) ?? '' })
  })
  return out
}

const DRAWING_RE = /drawing|zeichnung|dimension|ma(ß|ss)bild|technical/i
/** Splits gallery images into the product photo and the dimension drawing (by alt/title text or file name). */
export function photoAndDrawing(images: PageImage[], og: string | null): { image_url: string | null; drawing_url: string | null } {
  const drawing = images.find((i) => DRAWING_RE.test(i.alt) || /zeichnung|drawing/i.test(i.url)) ?? null
  // The shop's own og:image is the product photo it chose to show, unless it is the drawing.
  const photo = og && og !== drawing?.url ? og : (images.find((i) => i !== drawing)?.url ?? null)
  return { image_url: photo, drawing_url: drawing?.url ?? null }
}
