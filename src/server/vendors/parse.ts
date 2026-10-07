/**
 * Tolerant readers for values copied off maker pages and data files.
 *
 * Maker sites mix conventions: HAIMER's English shop prints "1,265 kg" (German decimal comma) next to
 * "25,000 rpm" (English thousands comma); Kemmler writes "12,5"; MAPAL labels are "d1 [mm]". Every value
 * goes through these helpers so one convention is applied everywhere and the tests pin it down.
 */

const SPACES = /[    ]/g

/**
 * First number in a maker value. Units and text around it are ignored.
 * Decimal mode (mm, kg): a single "," or "." is the decimal mark ("1,265 kg" → 1.265, "12,5" → 12.5);
 * when both appear the last one is the decimal mark ("1.234,5" → 1234.5).
 * Integer mode (rpm): "," and "." between groups of three digits are thousands separators
 * ("25.000 1/min" and "25,000 rpm" → 25000).
 */
export function parseNum(v: unknown, opts: { integer?: boolean } = {}): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v === null || v === undefined) return null
  const s = String(v).replace(SPACES, ' ').replace(/−/g, '-')
  const m = /-?\d[\d.,]*/.exec(s)
  if (!m) return null
  let tok = m[0].replace(/[.,]+$/, '')
  const neg = tok.startsWith('-')
  if (neg) tok = tok.slice(1)
  let n: number
  if (opts.integer) {
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(tok)) n = Number(tok.replace(/[.,]/g, ''))
    else n = Math.round(Number(tok.replace(',', '.')))
  } else {
    const lastDot = tok.lastIndexOf('.')
    const lastComma = tok.lastIndexOf(',')
    if (lastDot >= 0 && lastComma >= 0) {
      const dec = lastDot > lastComma ? '.' : ','
      const thou = dec === '.' ? ',' : '.'
      tok = tok.split(thou).join('').replace(dec, '.')
    } else if (lastComma >= 0) {
      tok = (tok.match(/,/g)!.length > 1 ? tok.split(',').join('') : tok.replace(',', '.'))
    } else if (lastDot >= 0 && tok.match(/\./g)!.length > 1) {
      tok = tok.split('.').join('')
    }
    n = Number(tok)
  }
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

/** Mass in kg from "1,265 kg", "957 g", "0.957". */
export function parseMassKg(v: unknown): number | null {
  const n = parseNum(v)
  if (n == null) return null
  return /\d\s*g\b/i.test(String(v)) && !/kg/i.test(String(v)) ? n / 1000 : n
}

/** A clamping range "2-20", "0,5 – 13 mm", "1 to 7" → [min, max]; null when the value is not a range. */
export function parseRange(v: unknown): [number, number] | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(SPACES, ' ')
  const m = /(\d+(?:[.,]\d+)?)\s*(?:-|–|—|\bto\b|\bbis\b|\.\.\.?)\s*(\d+(?:[.,]\d+)?)/i.exec(s)
  if (!m) return null
  const a = parseNum(m[1])
  const b = parseNum(m[2])
  if (a == null || b == null || a > b) return null
  return [a, b]
}

/** True when a value is just a number with an optional mm unit (stored as a number in dims). */
export function isPlainMm(v: string): boolean {
  return /^\s*-?\d+(?:[.,]\d+)?\s*(?:mm)?\s*$/i.test(v.replace(SPACES, ' '))
}

/** Dims value as stored: plain "80 mm" → 80; anything else (ranges, "< 0.003 mm", "4,5 deg") stays text. */
export function dimValue(v: string): string | number {
  const t = cleanText(v) ?? ''
  if (isPlainMm(t)) return parseNum(t) ?? t
  return t
}

/** Collapses whitespace and strips control characters; null when empty. */
export function cleanText(v: unknown, max = 1000): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(SPACES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Splits a spec-table label into its DIN 4000 / ISO 13399 code and the description:
 * "D2 Diameter 2" → D2, "DCONWS clamping dia…" → DCONWS, "Clamping diameter (DCONWS)" → DCONWS,
 * "d1 [mm]" → d1 (MAPAL), "WT Weight:" → WT. "A-length version" or "Runout accuracy" have no code.
 */
export function labelCode(label: string): { code: string | null; text: string } {
  const l = (cleanText(label) ?? '').replace(/\s*:$/, '')
  const paren = /\(([A-Z][A-Z0-9_]{1,11})\)/.exec(l)
  const first = /^([A-Z]{1,7}\d{0,3}(?:_[A-Z0-9]+)?|[a-z]{1,2}\d{1,2})(?=$|\s|\[)/.exec(l)
  if (first) return { code: first[1]!, text: l.slice(first[0].length).trim() }
  if (paren) return { code: paren[1]!, text: l.replace(paren[0], '').trim() }
  return { code: null, text: l }
}

/**
 * Reads an interface designation into form + size: "HSK-A63", "HSK-A 63", "HSK-A063", "HSK 63 A",
 * "ISO 12164 (HSK-A)" (form only). Null when the text names no HSK interface.
 */
export function parseInterface(v: unknown): { form: string; size: number | null } | null {
  if (v === null || v === undefined) return null
  const s = String(v).toUpperCase().replace(SPACES, ' ')
  let m = /HSK\s*-?\s*([A-F])\s*-?\s*0*(\d{2,3})\b/.exec(s)
  if (m) return { form: m[1]!, size: Number(m[2]) }
  m = /HSK\s*-?\s*0*(\d{2,3})\s*-?\s*([A-F])\b/.exec(s)
  if (m) return { form: m[2]!, size: Number(m[1]) }
  m = /HSK\s*-?\s*([A-F])\b/.exec(s)
  if (m) return { form: m[1]!, size: null }
  return null
}

/**
 * Does a stated interface match the one being scanned? 'yes', 'no', or 'unknown' when the source
 * does not say (or only says the form, e.g. "ISO 12164 (HSK-A)").
 */
export function interfaceMatch(iface: string, stated: unknown): 'yes' | 'no' | 'unknown' | 'form-only' {
  const want = parseInterface(iface)
  const got = parseInterface(stated)
  if (!got) {
    // Non-HSK interfaces (BT40, CAT40…) compare as plain text with spaces/hyphens removed.
    if (!want && stated) {
      const norm = (x: unknown) => String(x).toUpperCase().replace(/[\s\-_]/g, '')
      return norm(stated).includes(norm(iface)) ? 'yes' : 'unknown'
    }
    return 'unknown'
  }
  if (!want) return 'no'
  if (got.form !== want.form) return 'no'
  if (got.size == null) return 'form-only'
  return got.size === want.size ? 'yes' : 'no'
}

/** Makes an absolute http(s) URL from an href on a page; null for anything else (data:, javascript:, mailto:). */
export function absUrl(href: unknown, base: string): string | null {
  if (typeof href !== 'string' || !href.trim()) return null
  try {
    const u = new URL(href.trim(), base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** Normalises an order no. typed by a person or read from a file (trim, no inner whitespace runs). */
export function normOrderNo(v: unknown): string | null {
  const s = cleanText(v, 80)
  if (!s) return null
  return s.replace(/\s+/g, ' ')
}

const ORDER_NO_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_/ +]{0,59}$/
export function isValidOrderNo(s: string): boolean {
  return ORDER_NO_RE.test(s)
}
