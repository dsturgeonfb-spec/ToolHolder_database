/**
 * Holder type, series and clamp fields for records read from maker data — the same rules as classify(),
 * clamp_range() and the clamp_spec text in scripts/build_catalogue.py, so a holder found by a scan looks
 * exactly like one that came from the seed build. Unknown products fall back to keywords in the maker's
 * product name; anything still unclear becomes OTHER with a warning (the person fixes the type later).
 */
import type { HolderRecord } from './types.js'

export const FIXED_BORE = ['SHRINK', 'HYDRAULIC', 'FACE_MILL_ARBOR']
/** Types whose nominal clamp Ø is not stored (a range or a thread instead) — as build_catalogue.py. */
const NO_NOMINAL = ['ER_COLLET', 'PRECISION_COLLET', 'DRILL_CHUCK', 'TAP_CHUCK']

type TypeSeries = [type: string, series: string]

/** HAIMER: order-no. prefixes, exactly as classify() in build_catalogue.py. */
export function classifyHaimer(o: string): TypeSeries | null {
  if (o.startsWith('A63.050.') || o.startsWith('A63.051.')) return ['FACE_MILL_ARBOR', 'Face Mill Arbor (KKB = coolant bores)']
  if (o.startsWith('A63.020.')) return ['ER_COLLET', 'Collet Chuck Type ER']
  if (o.startsWith('A63.022.')) return ['ER_COLLET', 'Power Collet Chuck']
  if (o.startsWith('A63.120.')) return ['PRECISION_COLLET', 'High-Precision Chuck (HG collets)']
  if (o.startsWith('A63.182.') || o.startsWith('A63.184.')) return ['SHRINK', 'Power Mini Shrink Chuck']
  if (o.startsWith('A63.145.')) return ['SHRINK', 'Power Shrink Chuck – ultra short (Cool Jet)']
  if (o.startsWith('A63.144.') && o.endsWith('.3')) return ['SHRINK', 'Power Shrink Chuck – long ZG130 (Cool Jet)']
  if (o.startsWith('A63.144.')) return ['SHRINK', 'Shrink Fit Chuck Standard – long ZG130']
  if (o === 'A63.140.20.6') return ['SHRINK', 'Heavy Duty Shrink Chuck']
  if (o === 'A63.140.03' || o === 'A63.140.04') return ['SHRINK', 'Shrink Fit Chuck Standard – short, with slits']
  if (o.startsWith('A63.140.')) return ['SHRINK', 'Shrink Fit Chuck Standard – short']
  return null
}

/** CERATIZIT: as classify() — the Synchro tapping chuck, otherwise Centro-P collet chucks. */
export function classifyCeratizit(o: string, spec: string | null | undefined, name: string | null | undefined): TypeSeries | null {
  const s = spec ?? ''
  if (o === '83724612' || /SGSF|tapping/i.test(`${s} ${name ?? ''}`)) return ['TAP_CHUCK', 'Synchro Quick-Change Tapping Chuck (min. length comp.)']
  if (/\.ER\d+/i.test(s) || /collet/i.test(name ?? ''))
    return ['ER_COLLET', 'Centro-P precision collet chuck' + (s.includes('.SF.ER11') || s.includes('.SF.ER16') ? ' – slim' : '')]
  return null
}

/** MAPAL: designation family (MHC/HTC hydraulic, MPC drill chuck, MTC shrink). */
export function classifyMapal(designation: string | null | undefined, name: string | null | undefined): TypeSeries | null {
  const fam = /^([A-Z]{2,5})-HSK/.exec(designation ?? '')?.[1]
  const series = seriesFromName(name)
  if (fam === 'MPC' || /drill ?chuck/i.test(name ?? '')) return ['DRILL_CHUCK', series ?? 'Precision-DrillChuck']
  if (fam === 'MHC' || fam === 'HTC' || /hydro|hightorque|uniq/i.test(name ?? '')) return ['HYDRAULIC', series ?? 'Hydraulic expansion chuck']
  if (fam === 'MTC' || /thermo|shrink/i.test(name ?? '')) return ['SHRINK', series ?? 'ThermoChuck']
  return null
}

/** KEMMLER: A63.02 = ER collet chucks, A63.06 = milling arbors for screw-in cutters (verified families). */
export function classifyKemmler(o: string): TypeSeries | null {
  if (/^A\d+\.02\./.test(o)) return ['ER_COLLET', 'Collet chuck for ER collets']
  if (/^A\d+\.06\./.test(o)) return ['SCREW_IN', 'Milling arbor for screw-in cutters']
  return null
}

/** The maker's product name without the interface suffix: "Power Mini Shrink Chuck, DIN 69893-1, HSK-A63" → "Power Mini Shrink Chuck". */
export function seriesFromName(name: string | null | undefined): string | null {
  if (!name) return null
  const s = name
    .replace(/,?\s*(DIN|ISO)\s*\d{4,5}(-\d)?\b.*$/i, '')
    .replace(/,?\s*HSK[\s-]*[A-F]?\s*\d{2,3}\b.*$/i, '')
    .trim()
    .replace(/[,;\s]+$/, '')
  return s || name.trim()
}

/** Last resort: keywords in the maker's name/designation. */
export function classifyByText(text: string): string {
  const t = text.toLowerCase()
  if (/shrink|thermo/.test(t)) return 'SHRINK'
  if (/high-precision chuck|hg ?0?\d collet|hg collet/.test(t)) return 'PRECISION_COLLET'
  if (/hydraulic|hydro ?chuck|hightorque|high torque|expansion/.test(t)) return 'HYDRAULIC'
  if (/tap(ping)? chuck|synchro|tapping/.test(t)) return 'TAP_CHUCK'
  if (/drill ?chuck|drillchuck|bohrfutter/.test(t)) return 'DRILL_CHUCK'
  if (/face mill|shell mill|arbor for face|aufsteckfr/.test(t)) return 'FACE_MILL_ARBOR'
  if (/screw-in|screw in|einschraub/.test(t)) return 'SCREW_IN'
  if (/collet|\ber ?\d{2}\b|spannzange/.test(t)) return 'ER_COLLET'
  return 'OTHER'
}

/**
 * Fills type_code/series (when the source did not give them) and settles the clamp fields the way the
 * catalogue stores them: fixed-bore types min = max = Ø; collet and drill chucks keep a range and no
 * nominal Ø; screw-in and tap chucks keep min/max empty. Adds warnings for anything left unclear.
 */
export function settleRecord(rec: HolderRecord, typeSeries: TypeSeries | null): void {
  const warnings = (rec.warnings ??= [])
  if (!rec.type_code) {
    if (typeSeries) [rec.type_code] = typeSeries
    else rec.type_code = classifyByText(`${rec.product_name ?? ''} ${rec.series ?? ''} ${rec.spec_code ?? ''}`)
  }
  if (!rec.series) rec.series = typeSeries?.[1] ?? seriesFromName(rec.product_name)
  if (rec.type_code === 'OTHER')
    warnings.push('Holder type could not be worked out from the maker data — it will be added as "Other"; set the right type on the holder afterwards.')

  const t = rec.type_code
  if (FIXED_BORE.includes(t)) {
    if (rec.clamp_dia_mm == null && rec.clamp_min_mm != null && rec.clamp_min_mm === rec.clamp_max_mm) rec.clamp_dia_mm = rec.clamp_min_mm
    if (rec.clamp_dia_mm != null) rec.clamp_min_mm = rec.clamp_max_mm = rec.clamp_dia_mm
  } else if (NO_NOMINAL.includes(t)) {
    rec.clamp_dia_mm = null
    if (t === 'TAP_CHUCK') rec.clamp_min_mm = rec.clamp_max_mm = null
  } else if (t === 'SCREW_IN') {
    rec.clamp_min_mm = rec.clamp_max_mm = null
  }
  // A half-open range would break "fits a Ø d shank": keep both ends or neither.
  if ((rec.clamp_min_mm == null) !== (rec.clamp_max_mm == null)) rec.clamp_min_mm = rec.clamp_max_mm = null
  if (rec.clamp_min_mm != null && rec.clamp_max_mm != null && rec.clamp_min_mm > rec.clamp_max_mm) {
    warnings.push(`Clamp range ${rec.clamp_min_mm}–${rec.clamp_max_mm} mm is reversed on the source — left empty.`)
    rec.clamp_min_mm = rec.clamp_max_mm = null
  }
  if (!rec.clamp_spec) rec.clamp_spec = clampSpecText(rec)
}

const g = (n: number) => String(Math.round(n * 1000) / 1000)

/** Short operator-facing clamp text, in the seed's style ("Ø6 mm shank (h6)", "ER16 · 0.5–10 mm"). */
export function clampSpecText(rec: HolderRecord): string | null {
  const t = rec.type_code
  const name = `${rec.product_name ?? ''} ${rec.spec_code ?? ''} ${rec.series ?? ''}`
  const range = rec.clamp_min_mm != null && rec.clamp_max_mm != null ? `${g(rec.clamp_min_mm)}–${g(rec.clamp_max_mm)} mm` : null
  if (t === 'FACE_MILL_ARBOR' && rec.clamp_dia_mm != null) return `Spigot Ø${g(rec.clamp_dia_mm)} mm`
  if ((t === 'SHRINK' || t === 'HYDRAULIC') && rec.clamp_dia_mm != null) return `Ø${g(rec.clamp_dia_mm)} mm shank (h6)`
  if (t === 'ER_COLLET') {
    const er = /\bER\s?(\d{2})\b/i.exec(name)?.[1]
    return [er ? `ER${er}` : null, range].filter(Boolean).join(' · ') || null
  }
  if (t === 'PRECISION_COLLET') {
    const hg = /\bHG\s?(\d{2})\b/i.exec(name)?.[1]
    return [hg ? `HG${hg} collet` : null, range ? `${range} (h6)` : null].filter(Boolean).join(' · ') || null
  }
  if (t === 'DRILL_CHUCK' && range) return `Drill chuck · ${range}`
  if (t === 'SCREW_IN' && rec.clamp_dia_mm != null) return `M${g(rec.clamp_dia_mm)} screw-in thread`
  if (t === 'TAP_CHUCK') {
    const m = /M(\d+)\s*[-–]\s*M(\d+)/i.exec(name)
    return m ? `Taps M${m[1]}–M${m[2]}` : null
  }
  return range
}
