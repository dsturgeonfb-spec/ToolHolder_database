/**
 * Holder objects in the shape docs/API.md defines ("Holder object"), for the stock routes that
 * return holders (count list, stock by location, the holder after a count).
 *
 * The catalogue module builds the same shape for /api/holders. The two are built in parallel, so
 * this is a local copy of that query; if a shared helper lands in domain.ts, use it here instead.
 */
import { readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AppContext } from '../context.js'
import type { Params, Row } from '../db.js'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

/** holder_id -> served path of the cached maker photo (images/vendor/<holder_id>.<ext>). */
export function vendorImages(ctx: AppContext): Map<string, string> {
  const out = new Map<string, string>()
  try {
    for (const f of readdirSync(join(ctx.paths.imagesDir, 'vendor'))) {
      const ext = extname(f).toLowerCase()
      if (IMAGE_EXT.has(ext)) out.set(f.slice(0, -ext.length), `/images/vendor/${f}`)
    }
  } catch {
    // No vendor image folder yet — nothing cached.
  }
  return out
}

const HOLDER_SQL = `
SELECT h.*, m.name AS manufacturer, m.is_distributor, ht.type_name,
       s.qty_on_site, cs.count_status, cs.last_count_date,
       (SELECT COUNT(*) FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status = 'OPEN') AS open_flags,
       (SELECT COUNT(*) FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status = 'OPEN' AND f.severity <> 'INFO') AS open_issues,
       (SELECT f.severity FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status = 'OPEN' AND f.severity <> 'INFO'
          ORDER BY CASE f.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END LIMIT 1) AS worst_severity,
       COALESCE((SELECT SUM(w.qty_wanted) FROM wishlist w
                 WHERE w.holder_id = h.holder_id AND w.status IN ('OPEN','QUOTED','ORDERED')), 0) AS on_want_list
FROM holders h
JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
LEFT JOIN holder_types ht ON ht.type_code = h.type_code
JOIN v_stock_on_hand s ON s.holder_id = h.holder_id
JOIN v_count_status cs ON cs.holder_id = h.holder_id`

// Same order as the catalogue: type, then clamp Ø (holders without one last), gauge length, order no.
const HOLDER_ORDER = `ORDER BY COALESCE(ht.sort_order, 999), COALESCE(h.clamp_min_mm, 1e9), COALESCE(h.gauge_length_mm, 1e9), h.order_no`

export type Holder = Row & {
  holder_id: string
  manufacturer: string
  order_no: string
  type_code: string
  qty_on_site: number
  count_status: 'counted' | 'unverified' | 'booked' | 'none'
  dims: Record<string, unknown>
  vendor_image: string | null
}

function parseDims(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || !v.trim()) return {}
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

function toHolder(r: Row, images: Map<string, string>): Holder {
  const h = r as Holder
  h.qty_on_site = Number(h.qty_on_site ?? 0)
  h.open_flags = Number(h.open_flags ?? 0)
  h.open_issues = Number(h.open_issues ?? 0)
  h.on_want_list = Number(h.on_want_list ?? 0)
  h.dims = parseDims(h.dims_json)
  h.vendor_image = images.get(h.holder_id) ?? null
  return h
}

/** Holders matching an optional WHERE clause (on aliases h, m, ht, s, cs), catalogue order. */
export function holderRows(ctx: AppContext, where = '', params: Params = []): Holder[] {
  const images = vendorImages(ctx)
  return ctx.db.all(`${HOLDER_SQL} ${where ? 'WHERE ' + where : ''} ${HOLDER_ORDER}`, params).map((r) => toHolder(r, images))
}

export function holderById(ctx: AppContext, holderId: string): Holder | undefined {
  return holderRows(ctx, 'h.holder_id = ?', [holderId])[0]
}
