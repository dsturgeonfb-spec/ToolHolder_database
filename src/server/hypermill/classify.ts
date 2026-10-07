/**
 * Reading a hyperMILL holder name: order no., maker, holder type and the CAM gauge length.
 *
 * The order-no./maker/type rules are a port of order_from_cam, maker_from_cam and classify in
 * scripts/build_catalogue.py (the script that built the seed), so the 54 seeded holders read back
 * exactly as they were stored. Holders added to hyperMILL later are not in that script's tables, so
 * keyword fallbacks classify them from the name; when nothing matches the type is OTHER and the import
 * raises an issue for a person to set it — a guessed type would end up in "what fits a Ø d shank".
 *
 * Nothing here reads dimensions from the name: catalogue values only ever come from maker data.
 */

/** Collapses runs of whitespace (incl. non-breaking spaces) and trims. */
export const collapse = (s: string | null | undefined): string => String(s ?? '').replace(/[\s ]+/g, ' ').trim()

const LEADING_TAG = /^\(([^)]*)\)\s*/

/**
 * The name as stored in holders.cam_name. The seed dropped the leading "(HSK63) " tag
 * (build_catalogue.py: .replace("(HSK63) ", "")); any leading "(<tag>) " is dropped the same way.
 */
export function normaliseName(raw: string): string {
  return collapse(raw).replace(LEADING_TAG, '').trim()
}

/** The leading "(<tag>)" of a hyperMILL name, e.g. "HSK63", or null. */
export function nameTag(raw: string): string | null {
  const m = LEADING_TAG.exec(collapse(raw))
  return m ? m[1]!.trim() || null : null
}

/** hyperMILL comment as stored: whitespace collapsed, empty → null. */
export function normaliseComment(raw: string | null | undefined): string | null {
  const s = collapse(raw)
  return s ? s : null
}

const GL_TOKEN = /(\d+(?:[.,]\d+)?)\s*GL\b/i

/** CAM gauge length from the "<n>GL" token in the name (build_catalogue.py: re.search(r"(\d+)GL")). */
export function camGlFromName(name: string): number | null {
  const m = GL_TOKEN.exec(name)
  if (!m) return null
  const n = Number(m[1]!.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Key for "is this a rename?": case, spacing and the GL token ignored. A name that differs only in its
 * GL token is a gauge-length change (raised as such), not a rename.
 */
export function nameKey(name: string): string {
  return collapse(name).toUpperCase().replace(new RegExp(GL_TOKEN.source, 'gi'), '#GL')
}

// ---------------------------------------------------------------------------------------- order no.
// HAIMER / KEMMLER HSK-A63 articles (A63.140.12, A63.050.16.KKB); 8-digit MAPAL / CERATIZIT numbers.
const ORDER_A63 = /(?<![A-Z0-9.])A63\.[0-9]+(?:\.[0-9A-Z]+)*/
const ORDER_8 = /(?<![A-Z0-9.-])(\d{8})(?![A-Z0-9-])/
// Fallbacks for holders added later: HAIMER-style numbers of other HSK sizes (A10.…, E40.…) and
// plain 7–10 digit article numbers (SCHUNK, KENNAMETAL…).
const ORDER_HSK_OTHER = /(?<![A-Z0-9.])[ACEF]\d{2,3}\.[0-9]+(?:\.[0-9A-Z]+)*/
const ORDER_DIGITS = /(?<![A-Z0-9.-])(\d{7}|\d{9,10})(?![A-Z0-9-])/

/** Order no. in a hyperMILL holder name, or null (build_catalogue.py order_from_cam + fallbacks). */
export function orderFromName(name: string): string | null {
  const u = collapse(name).toUpperCase()
  for (const re of [ORDER_A63, ORDER_8, ORDER_HSK_OTHER, ORDER_DIGITS]) {
    const m = re.exec(u)
    if (m) return (m[1] ?? m[0]).replace(/\.+$/, '')
  }
  return null
}

/**
 * Order no. from the comment, used only when the name has none. Comments write HAIMER numbers with
 * dashes ("A63-050-16-KKB"), so those are turned back into the maker's dotted form.
 */
export function orderFromComment(comment: string | null): string | null {
  if (!comment) return null
  const direct = orderFromName(comment)
  if (direct) return direct
  const m = /(?<![A-Z0-9])A63-[0-9]+(?:-[0-9A-Z]+)*/.exec(collapse(comment).toUpperCase())
  return m ? m[0].replace(/-/g, '.') : null
}

// ---------------------------------------------------------------------------------------- maker
/** Maker words recognised in hyperMILL names → the name used in the manufacturers table. */
export const KNOWN_MAKERS: Array<[canonical: string, pattern: string]> = [
  ['HAIMER', 'HAIMER'],
  ['MAPAL', 'MAPAL'],
  ['KEMMLER', 'KEMMLER'],
  ['CERATIZIT', 'CERATIZIT'],
  ['SANDVIK COROMANT', 'SANDVIK|COROMANT'],
  ['CUTWEL', 'CUTWEL'],
  ['NIKKEN', 'NIKKEN'],
  ['BIG DAISHOWA', 'BIG|DAISHOWA|BIG-DAISHOWA'],
  ['SCHUNK', 'SCHUNK'],
  ['REGO-FIX', 'REGO-?FIX'],
  ['GUHRING', 'GUHRING|GÜHRING|GUEHRING'],
  ['KENNAMETAL', 'KENNAMETAL'],
  ['WALTER', 'WALTER'],
  ['ISCAR', 'ISCAR'],
  ['SECO', 'SECO'],
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (alternatives: string) => new RegExp(`(?<![A-Z0-9])(?:${alternatives})(?![A-Z0-9])`)

/**
 * Maker named in a hyperMILL holder name. Recognises the known maker words plus any maker already in
 * the manufacturers table (so a maker the shop added by hand is found too). When several appear, the
 * first one in the name wins. Returns the manufacturers-table spelling, upper case, or null.
 */
export function makerFromName(name: string, dbMakers: readonly string[] = []): string | null {
  const u = collapse(name).toUpperCase()
  const candidates: Array<{ maker: string; at: number; len: number }> = []
  for (const [canonical, pattern] of KNOWN_MAKERS) {
    const m = wordRe(pattern).exec(u)
    if (m) candidates.push({ maker: canonical, at: m.index, len: m[0].length })
  }
  for (const db of dbMakers) {
    const up = collapse(db).toUpperCase()
    if (!up) continue
    const m = wordRe(escapeRe(up)).exec(u)
    if (m) candidates.push({ maker: up, at: m.index, len: m[0].length })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.at - b.at || b.len - a.len)
  return candidates[0]!.maker
}

// ---------------------------------------------------------------------------------------- holder type
export interface Classification {
  type_code: string
  /** Family description for holders.series; null when the type could not be worked out. */
  series: string | null
  /** order = a rule on the maker's order no. (seed rules); keyword = from words in the name/comment; none = OTHER. */
  by: 'order' | 'keyword' | 'none'
}

/** build_catalogue.py classify(): the rules that hang off the maker's order no. */
function classifyByOrder(maker: string, o: string): Classification | null {
  const r = (type_code: string, series: string): Classification => ({ type_code, series, by: 'order' })
  if (maker === 'HAIMER') {
    if (o.startsWith('A63.050.') || o.startsWith('A63.051.')) return r('FACE_MILL_ARBOR', 'Face Mill Arbor (KKB = coolant bores)')
    if (o.startsWith('A63.020.')) return r('ER_COLLET', 'Collet Chuck Type ER')
    if (o.startsWith('A63.022.')) return r('ER_COLLET', 'Power Collet Chuck')
    if (o.startsWith('A63.120.')) return r('PRECISION_COLLET', 'High-Precision Chuck (HG collets)')
    if (o.startsWith('A63.182.') || o.startsWith('A63.184.')) return r('SHRINK', 'Power Mini Shrink Chuck')
    if (o.startsWith('A63.145.')) return r('SHRINK', 'Power Shrink Chuck – ultra short (Cool Jet)')
    if (o.startsWith('A63.144.') && o.endsWith('.3')) return r('SHRINK', 'Power Shrink Chuck – long ZG130 (Cool Jet)')
    if (o.startsWith('A63.144.')) return r('SHRINK', 'Shrink Fit Chuck Standard – long ZG130')
    if (o === 'A63.140.20.6') return r('SHRINK', 'Heavy Duty Shrink Chuck')
    if (o === 'A63.140.03' || o === 'A63.140.04') return r('SHRINK', 'Shrink Fit Chuck Standard – short, with slits')
    if (o.startsWith('A63.140.')) return r('SHRINK', 'Shrink Fit Chuck Standard – short')
  }
  if (maker === 'CERATIZIT' && o === '83724612') return r('TAP_CHUCK', 'Synchro Quick-Change Tapping Chuck (min. length comp.)')
  if (maker === 'MAPAL' && (o === '30259875' || o === '30259879')) return r('DRILL_CHUCK', 'Precision-DrillChuck')
  return null
}

/**
 * Keyword fallbacks. Order matters: a "SHRINK … FOR DRILLS" is a shrink chuck, a "HIGH-PRECISION COLLET
 * CHUCK" takes HG collets (not ER), and an "M12 ARBOR" is a screw-in holder, not a shell-mill arbor.
 * The maker-specific series reproduce build_catalogue.py's descriptions for the seeded makers.
 */
function classifyByKeyword(maker: string, text: string): Classification | null {
  const u = ` ${collapse(text).toUpperCase()} `
  const has = (re: RegExp) => re.test(u)
  const k = (type_code: string, series: string): Classification => ({ type_code, series, by: 'keyword' })
  if (has(/SHRINK|SCHRUMPF/)) return k('SHRINK', 'Shrink fit chuck')
  if (has(/HYDRAULIC|(?<![A-Z])HYD(?![A-Z])|HYDRO|(?<![A-Z])HTC(?![A-Z])|EXPANSION/)) {
    if (maker === 'MAPAL' && has(/(?<![A-Z])HTC(?![A-Z])/)) return k('HYDRAULIC', 'HighTorque Chuck HTC – short heavy design')
    return k('HYDRAULIC', 'Hydraulic expansion chuck')
  }
  if (has(/(?<![A-Z0-9])HG\d*(?![A-Z])|HIGH[- ]?PRECISION/)) return k('PRECISION_COLLET', 'High-precision collet chuck (HG collets)')
  const er = /(?<![A-Z0-9])ER ?(\d{2})(?!\d)/.exec(u)
  if (er || has(/COLLET/)) {
    if (maker === 'CERATIZIT') return k('ER_COLLET', 'Centro-P precision collet chuck' + (has(/SLIM/) ? ' – slim' : ''))
    return k('ER_COLLET', er ? `ER${er[1]} collet chuck` : 'Collet chuck')
  }
  if (has(/(?<![A-Z])TAP(PING|S)?(?![A-Z])/)) return k('TAP_CHUCK', 'Tapping chuck')
  if (has(/(?<![A-Z])DRILL(ING)?(?![A-Z])/)) return k('DRILL_CHUCK', 'Drill chuck')
  const screwIn = maker === 'KEMMLER' ? 'Milling arbor for screw-in cutters' : 'Screw-in cutter holder'
  if (has(/SCREW[- ]?IN|(?<![A-Z])THREAD(ED)?(?![A-Z])/)) return k('SCREW_IN', screwIn)
  if (has(/SPIGOT|SHELL|FACE ?MILL|(?<![A-Z])COMBI(?![A-Z])/)) return k('FACE_MILL_ARBOR', 'Face / shell mill arbor')
  if (has(/(?<![A-Z0-9])M\d{1,2}(?![0-9A-Z])/)) return k('SCREW_IN', screwIn)
  if (has(/ARBOU?R/)) return k('FACE_MILL_ARBOR', 'Face / shell mill arbor')
  return null
}

/**
 * Holder type for a hyperMILL holder: the seed's order-no. rules first, then keywords in the name,
 * then keywords in the comment; OTHER when nothing matches.
 */
export function classify(maker: string, orderNo: string, name: string, comment: string | null = null): Classification {
  return (
    classifyByOrder(maker, orderNo.toUpperCase()) ??
    classifyByKeyword(maker, name) ??
    (comment ? classifyByKeyword(maker, comment) : null) ?? { type_code: 'OTHER', series: null, by: 'none' }
  )
}
