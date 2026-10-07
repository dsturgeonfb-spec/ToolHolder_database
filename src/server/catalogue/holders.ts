/**
 * Reading holders: the Holder object every list/detail endpoint returns (docs/API.md "Holder object"),
 * the catalogue filters, and the detail record.
 *
 * Stock and count status come from the views (v_stock_on_hand, v_count_status) so the numbers here are
 * always the same ones the tally and the acceptance checks use — never a stored quantity.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '../context.js'
import type { Row } from '../db.js'
import { HttpError } from '../http.js'

export type Scope = 'site' | 'cat' | 'all'
export const COUNT_STATUSES = ['counted', 'unverified', 'booked', 'none'] as const

export interface HolderFilters {
  scope: Scope
  /** Lower-cased search terms; every one must match. */
  terms: string[]
  type: string | null
  mk: string | null
  fit: number | null
  flag: boolean
  iface: string | null
  status: string | null
}

export type Holder = Row & {
  holder_id: string
  manufacturer: string
  order_no: string
  qty_on_site: number
  count_status: string
  dims: Record<string, unknown>
  vendor_image: string | null
}

/** Severity order for "worst" — INFO never counts as an issue. */
const SEV_RANK = `CASE f.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END`

const HOLDER_SELECT = `
SELECT h.*,
       m.name AS manufacturer,
       m.is_distributor AS is_distributor,
       ht.type_name AS type_name,
       s.qty_on_site AS qty_on_site,
       cs.count_status AS count_status,
       cs.last_count_date AS last_count_date,
       (SELECT COUNT(*) FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status = 'OPEN') AS open_flags,
       (SELECT COUNT(*) FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status = 'OPEN' AND f.severity <> 'INFO') AS open_issues,
       (SELECT f.severity FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status = 'OPEN' AND f.severity <> 'INFO'
         ORDER BY ${SEV_RANK} LIMIT 1) AS worst_severity,
       (SELECT COALESCE(SUM(w.qty_wanted), 0) FROM wishlist w
         WHERE w.holder_id = h.holder_id AND w.status IN ('OPEN', 'QUOTED', 'ORDERED')) AS on_want_list
FROM holders h
JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
LEFT JOIN holder_types ht ON ht.type_code = h.type_code
JOIN v_stock_on_hand s ON s.holder_id = h.holder_id
JOIN v_count_status cs ON cs.holder_id = h.holder_id`

// Same order as the prototype: by type, then smallest clamp Ø (open ranges last), shortest GL, order no.
const HOLDER_ORDER = `ORDER BY COALESCE(ht.sort_order, 999), h.type_code, (h.clamp_min_mm IS NULL), h.clamp_min_mm,
         COALESCE(h.gauge_length_mm, 0), h.order_no`

/** Parses the catalogue filters from a query string. Bad values are a 400 with a plain message. */
export function parseFilters(q: URLSearchParams): HolderFilters {
  const scopeRaw = (q.get('scope') ?? '').trim() || 'all'
  if (!['site', 'cat', 'all'].includes(scopeRaw)) throw new HttpError(400, `scope must be site, cat or all (got "${scopeRaw}")`)
  const fitRaw = (q.get('fit') ?? '').trim()
  let fit: number | null = null
  if (fitRaw) {
    fit = Number(fitRaw.replace(',', '.'))
    if (!Number.isFinite(fit) || fit <= 0) throw new HttpError(400, 'Fits shank Ø must be a diameter in mm, e.g. 12 or 12.5')
  }
  const status = (q.get('status') ?? '').trim() || null
  if (status && !(COUNT_STATUSES as readonly string[]).includes(status))
    throw new HttpError(400, `status must be one of ${COUNT_STATUSES.join(', ')}`)
  const flag = (q.get('flag') ?? '').trim()
  return {
    scope: scopeRaw as Scope,
    terms: (q.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20),
    type: (q.get('type') ?? '').trim() || null,
    mk: (q.get('mk') ?? '').trim() || null,
    fit,
    flag: flag === '1' || flag === 'true',
    iface: (q.get('iface') ?? '').trim() || null,
    status,
  }
}

/** Cached maker photos: holder_id -> /images/vendor/<file>. Read once per request, not per holder. */
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif']
export function vendorImageIndex(ctx: AppContext): Map<string, string> {
  const out = new Map<string, string>()
  let files: string[] = []
  try {
    files = readdirSync(join(ctx.paths.imagesDir, 'vendor'))
  } catch {
    return out
  }
  // Prefer the extension order above when one holder has several files.
  const ranked = files
    .map((f) => {
      const m = /^(.+)\.([a-z0-9]+)$/i.exec(f)
      return m ? { id: m[1]!, ext: m[2]!.toLowerCase(), f } : null
    })
    .filter((x): x is { id: string; ext: string; f: string } => !!x && IMAGE_EXT.includes(x.ext))
    .sort((a, b) => IMAGE_EXT.indexOf(a.ext) - IMAGE_EXT.indexOf(b.ext))
  for (const r of ranked) if (!out.has(r.id)) out.set(r.id, `/images/vendor/${encodeURIComponent(r.f)}`)
  return out
}

function parseDims(json: unknown): Record<string, unknown> {
  if (typeof json !== 'string' || !json.trim()) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function hydrate(r: Row, images: Map<string, string>): Holder {
  const id = String(r.holder_id)
  return {
    ...r,
    holder_id: id,
    manufacturer: String(r.manufacturer ?? ''),
    order_no: String(r.order_no ?? ''),
    is_distributor: Number(r.is_distributor ?? 0),
    qty_on_site: Number(r.qty_on_site ?? 0),
    count_status: String(r.count_status ?? 'none'),
    last_count_date: r.last_count_date ?? null,
    open_flags: Number(r.open_flags ?? 0),
    open_issues: Number(r.open_issues ?? 0),
    worst_severity: r.worst_severity ?? null,
    on_want_list: Number(r.on_want_list ?? 0),
    dims: parseDims(r.dims_json),
    vendor_image: images.get(id) ?? null,
  } as Holder
}

/** The text a search term is matched against (same fields as the prototype, plus gl<GL> and d<clamp Ø>). */
function haystack(h: Holder): string {
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)))
  return [
    h.manufacturer,
    h.order_no,
    h.spec_code,
    h.product_name,
    h.series,
    h.clamp_spec,
    h.cam_name,
    h.cam_comment,
    h.gauge_length_mm != null ? 'gl' + num(h.gauge_length_mm) : '',
    h.clamp_dia_mm != null ? 'd' + num(h.clamp_dia_mm) : '',
  ]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' ')
    .toLowerCase()
}

export function listHolders(ctx: AppContext, f: HolderFilters): Holder[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (f.scope === 'site') where.push('s.qty_on_site > 0')
  // "Can buy" = nothing on site. <= 0 so a holder can never fall between the two scopes.
  if (f.scope === 'cat') where.push('s.qty_on_site <= 0')
  if (f.type) {
    where.push('h.type_code = ?')
    params.push(f.type)
  }
  if (f.mk) {
    where.push('m.name = ? COLLATE NOCASE')
    params.push(f.mk)
  }
  if (f.iface) {
    where.push('h.interface_code = ?')
    params.push(f.iface)
  }
  if (f.fit != null) {
    // BUILD_SPEC §3: fits a Ø d shank = clamp_min <= d <= clamp_max. Open ranges (null) never match.
    where.push('h.clamp_min_mm IS NOT NULL AND h.clamp_max_mm IS NOT NULL AND h.clamp_min_mm <= ? AND ? <= h.clamp_max_mm')
    params.push(f.fit, f.fit)
  }
  if (f.flag)
    where.push(`EXISTS (SELECT 1 FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status = 'OPEN' AND f.severity <> 'INFO')`)
  if (f.status) {
    where.push('cs.count_status = ?')
    params.push(f.status)
  }
  const sql = `${HOLDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${HOLDER_ORDER}`
  const images = vendorImageIndex(ctx)
  let rows = ctx.db.all(sql, params).map((r) => hydrate(r, images))
  if (f.terms.length) rows = rows.filter((h) => {
    const hay = haystack(h)
    return f.terms.every((t) => hay.includes(t))
  })
  return rows
}

export function countAllHolders(ctx: AppContext): number {
  return Number(ctx.db.value(`SELECT COUNT(*) FROM holders`) ?? 0)
}

export function getHolder(ctx: AppContext, id: string): Holder | undefined {
  const r = ctx.db.get(`${HOLDER_SELECT} WHERE h.holder_id = ?`, [id])
  return r ? hydrate(r, vendorImageIndex(ctx)) : undefined
}

export function requireHolder(ctx: AppContext, id: string): Holder {
  const h = getHolder(ctx, id)
  if (!h) throw new HttpError(404, `There is no holder ${id} in the catalogue. Search the catalogue for the order no. instead.`)
  return h
}

/** GET /api/holders/:id — the holder plus everything recorded against it. */
export function holderDetail(ctx: AppContext, id: string) {
  const db = ctx.db
  const h = requireHolder(ctx, id)
  const stock = db.all(
    `SELECT l.location_id, l.name AS location, l.kind, l.counts_as_on_site, SUM(t.qty_delta) AS qty
     FROM stock_transactions t JOIN locations l ON l.location_id = t.location_id
     WHERE t.holder_id = ?
     GROUP BY l.location_id HAVING SUM(t.qty_delta) <> 0
     ORDER BY l.counts_as_on_site DESC, l.location_id`,
    [id],
  )
  const transactions = db.all(
    `SELECT t.*, l.name AS location FROM stock_transactions t JOIN locations l ON l.location_id = t.location_id
     WHERE t.holder_id = ? ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT 200`,
    [id],
  )
  const transactions_total = Number(db.value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = ?`, [id]) ?? 0)
  const flags = db.all(
    `SELECT f.* FROM data_flags f WHERE f.holder_id = ?
     ORDER BY CASE f.status WHEN 'OPEN' THEN 0 ELSE 1 END, ${SEV_RANK}, f.flag_id`,
    [id],
  )
  const units = db.all(
    `SELECT u.*, l.name AS location FROM holder_units u LEFT JOIN locations l ON l.location_id = u.location_id
     WHERE u.holder_id = ? ORDER BY u.unit_id`,
    [id],
  )
  const wishlist = db.all(`SELECT * FROM wishlist WHERE holder_id = ? ORDER BY wish_id DESC`, [id])
  const changes = db.all(`SELECT * FROM holder_changes WHERE holder_id = ? ORDER BY change_id DESC LIMIT 500`, [id])
  const manufacturer_row = db.get(`SELECT * FROM manufacturers WHERE manufacturer_id = ?`, [h.manufacturer_id as number]) ?? null
  return { ...h, stock, transactions, transactions_total, flags, units, wishlist, changes, manufacturer_row }
}
