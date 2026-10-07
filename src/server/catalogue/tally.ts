/**
 * The tally (BUILD_SPEC §4): totals by type, maker, clamp Ø and location, plus the gauge-length check.
 * Built on the schema's tally views so these are the same numbers the acceptance checks assert.
 */
import type { AppContext } from '../context.js'

export interface ByType {
  type_code: string
  type_name: string
  articles_on_site: number
  holders_on_site: number
}
export interface ByMaker {
  manufacturer: string
  articles_on_site: number
  holders_on_site: number
  articles_in_catalogue: number
}
export interface ByClamp {
  clamp_dia_mm: number
  type_code: string
  type_name: string
  holders_on_site: number
  gauge_lengths: number[]
}
export interface GlCheck {
  holder_id: string
  order_no: string
  gauge_length_mm: number
  cam_gl_mm: number
  delta_mm: number
  manufacturer: string
  type_code: string
  type_name: string | null
  series: string | null
  cam_name: string | null
  /** Plain-English reason for the difference when it is the known face-mill-arbor convention. */
  note: string | null
}
export interface Tally {
  summary: unknown
  byType: ByType[]
  byMaker: ByMaker[]
  byClamp: ByClamp[]
  byLocation: Array<Record<string, unknown>>
  glCheck: GlCheck[]
}

const n = (v: unknown) => Number(v ?? 0)

export function byType(ctx: AppContext): ByType[] {
  return ctx.db
    .all<ByType>(
      `SELECT ht.type_code, ht.type_name,
              COUNT(CASE WHEN s.qty_on_site > 0 THEN 1 END) AS articles_on_site,
              COALESCE(SUM(s.qty_on_site), 0) AS holders_on_site
       FROM holder_types ht
       LEFT JOIN holders h ON h.type_code = ht.type_code
       LEFT JOIN v_stock_on_hand s ON s.holder_id = h.holder_id
       GROUP BY ht.type_code ORDER BY ht.sort_order, ht.type_code`,
    )
    .map((r) => ({ ...r, articles_on_site: n(r.articles_on_site), holders_on_site: n(r.holders_on_site) }))
}

export function byMaker(ctx: AppContext): ByMaker[] {
  return ctx.db
    .all<ByMaker>(`SELECT manufacturer, articles_on_site, holders_on_site, articles_in_catalogue FROM v_tally_by_manufacturer`)
    .map((r) => ({
      manufacturer: r.manufacturer,
      articles_on_site: n(r.articles_on_site),
      holders_on_site: n(r.holders_on_site),
      articles_in_catalogue: n(r.articles_in_catalogue),
    }))
}

/** Fixed-bore holders on site (clamp min = max) grouped by Ø and type, with the gauge lengths available. */
export function byClamp(ctx: AppContext): ByClamp[] {
  const rows = ctx.db.all<{ d: number; type_code: string; type_name: string; gl: number | null; qty: number }>(
    `SELECT h.clamp_min_mm AS d, h.type_code, COALESCE(ht.type_name, h.type_code) AS type_name,
            h.gauge_length_mm AS gl, s.qty_on_site AS qty
     FROM holders h
     LEFT JOIN holder_types ht ON ht.type_code = h.type_code
     JOIN v_stock_on_hand s ON s.holder_id = h.holder_id
     WHERE s.qty_on_site > 0 AND h.clamp_min_mm IS NOT NULL AND h.clamp_min_mm = h.clamp_max_mm
     ORDER BY h.clamp_min_mm, COALESCE(ht.sort_order, 999), h.type_code, h.gauge_length_mm`,
  )
  const out: ByClamp[] = []
  for (const r of rows) {
    let g = out.find((x) => x.clamp_dia_mm === Number(r.d) && x.type_code === r.type_code)
    if (!g) {
      g = { clamp_dia_mm: Number(r.d), type_code: r.type_code, type_name: r.type_name, holders_on_site: 0, gauge_lengths: [] }
      out.push(g)
    }
    g.holders_on_site += n(r.qty)
    if (r.gl != null && !g.gauge_lengths.includes(Number(r.gl))) g.gauge_lengths.push(Number(r.gl))
  }
  for (const g of out) g.gauge_lengths.sort((a, b) => a - b)
  return out
}

export function byLocation(ctx: AppContext): Array<Record<string, unknown>> {
  return ctx.db
    .all(`SELECT * FROM v_tally_by_location`)
    .map((r) => ({ ...r, counts_as_on_site: n(r.counts_as_on_site), articles: n(r.articles), holders: n(r.holders) }))
}

/**
 * Maker GL vs hyperMILL GL (v_gl_check). For Haimer face-mill arbors hyperMILL measures to the end of the
 * spigot: CAM GL = maker A + spigot length. When the maker's spigot length explains the delta, say so.
 */
export function glCheck(ctx: AppContext): GlCheck[] {
  const rows = ctx.db.all<GlCheck & { dims_json: string | null }>(
    `SELECT g.holder_id, g.order_no, g.gauge_length_mm, g.cam_gl_mm, g.delta_mm,
            m.name AS manufacturer, h.type_code, ht.type_name, h.series, h.cam_name, h.dims_json
     FROM v_gl_check g
     JOIN holders h ON h.holder_id = g.holder_id
     JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
     LEFT JOIN holder_types ht ON ht.type_code = h.type_code
     ORDER BY m.name, g.order_no`,
  )
  return rows.map(({ dims_json, ...r }) => {
    const gl = n(r.gauge_length_mm)
    const cgl = n(r.cam_gl_mm)
    const delta = n(r.delta_mm)
    let note: string | null = null
    if (r.type_code === 'FACE_MILL_ARBOR') {
      const spigot = spigotLength(dims_json)
      note =
        spigot != null && Math.abs(spigot - delta) < 0.01
          ? `Face-mill arbor convention: hyperMILL GL = maker A + spigot length (${fmtNum(gl)} + ${fmtNum(spigot)} = ${fmtNum(cgl)} mm).`
          : 'Face-mill arbor: hyperMILL may measure to the end of the spigot rather than the cutter seating face — check which face it references.'
    }
    return { ...r, gauge_length_mm: gl, cam_gl_mm: cgl, delta_mm: delta, note }
  })
}

const fmtNum = (v: number) => String(Math.round(v * 100) / 100)

/** Spigot length from the maker dimensions, e.g. Haimer "L length (spigot)". */
export function spigotLength(dimsJson: string | null): number | null {
  if (!dimsJson) return null
  try {
    const d = JSON.parse(dimsJson) as Record<string, unknown>
    for (const [k, v] of Object.entries(d)) {
      if (/spigot/i.test(k) && /(^L\b|length)/i.test(k) && Number.isFinite(Number(v))) return Number(v)
    }
  } catch {
    /* unreadable dims: no explanation */
  }
  return null
}

export function buildTally(ctx: AppContext, summary: unknown): Tally {
  return {
    summary,
    byType: byType(ctx),
    byMaker: byMaker(ctx),
    byClamp: byClamp(ctx),
    byLocation: byLocation(ctx),
    glCheck: glCheck(ctx),
  }
}
