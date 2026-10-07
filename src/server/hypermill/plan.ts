/**
 * Compares a parsed hyperMILL report with the catalogue and says what an import would do — without
 * writing anything. The same function runs at preview and again at apply, so the person approves
 * exactly what gets written (apply refuses when the two differ).
 *
 * Matching is on (maker, order no.) — the catalogue's identity (BUILD_SPEC §3). A holder whose maker was
 * corrected by hand in the catalogue is still found by its hyperMILL name.
 */
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Db } from '../db.js'
import { camGlFromName, classify, collapse, makerFromName, nameKey, orderFromComment, orderFromName, type Classification } from './classify.js'
import { sha256, type Coupling, type ParsedHolder, type ParsedReport, type ReportWarning } from './parse.js'

export type CamField = 'cam_name' | 'cam_comment' | 'cam_gl_mm' | 'cam_image'
export interface FieldChange {
  field: CamField
  old: string | number | null
  new: string | number | null
}

export interface PlanNew {
  seq: number
  cam_name: string
  cam_comment: string | null
  manufacturer: string
  /** The maker is not in the catalogue yet; apply adds it. */
  manufacturer_new: boolean
  order_no: string
  /** Where the order no. was read: the name (normal) or, failing that, the comment. */
  order_from: 'name' | 'comment'
  type_code: string
  type_name: string
  series: string | null
  classified_by: Classification['by']
  cam_gl_mm: number | null
  coupling: Coupling[]
  image: number | null
  image_sha: string | null
  image_ext: string | null
}

export interface PlanMatched {
  seq: number
  holder_id: string
  manufacturer: string
  order_no: string
  interface_code: string
  /** Name in the report (cam_name after apply). */
  cam_name: string
  /** Name in the catalogue now. */
  old_name: string | null
  changes: FieldChange[]
  image: number | null
  image_sha: string | null
  image_change: 'added' | 'replaced' | null
  /** No stock has ever been booked for this holder: apply books the unverified opening balance of 1. */
  opening_balance: boolean
  /** Maker gauge length, for the gauge-length issue text. */
  gauge_length_mm: number | null
}

export interface PlanRemoved {
  holder_id: string
  manufacturer: string
  order_no: string
  cam_name: string
  qty_on_site: number
  /**
   * No new issue: one is already open, or one was closed and nothing of it is on site any more (it was
   * scrapped or moved off site). A closed issue with stock still on site is raised again.
   */
  already_flagged: boolean
  /** State of the latest "not in the hyperMILL report" issue for this holder, if any. */
  flag_status: 'OPEN' | 'CLOSED' | null
}

export interface PlanUnmatched {
  seq: number
  cam_name: string
  cam_comment: string | null
  reason: string
}

export interface Plan {
  interface_code: string
  new: PlanNew[]
  renamed: PlanMatched[]
  changed: PlanMatched[]
  removed: PlanRemoved[]
  unchanged: number
  unmatched: PlanUnmatched[]
  warnings: ReportWarning[]
}

/** Message prefix of the issue raised for a holder missing from the report (also how it is found again). */
export const REMOVED_PREFIX = 'Not in the hyperMILL report'

interface HolderRow {
  holder_id: string
  manufacturer_id: number
  manufacturer: string
  order_no: string
  interface_code: string
  cam_name: string | null
  cam_comment: string | null
  cam_gl_mm: number | null
  cam_image: string | null
  gauge_length_mm: number | null
}
const HOLDER_COLS = `h.holder_id, h.manufacturer_id, m.name AS manufacturer, h.order_no, h.interface_code, h.cam_name, h.cam_comment,
  h.cam_gl_mm, h.cam_image, h.gauge_length_mm`

/** Path of a stored CAM image in the data folder; null if the stored value points outside it. */
export function storedImagePath(dataDir: string, camImage: string | null): string | null {
  if (!camImage) return null
  const root = resolve(dataDir)
  const full = resolve(root, camImage.replace(/^\/+/, ''))
  return full.startsWith(root + sep) ? full : null
}

/** File name a report image gets in images/cam: a new name per content, so an older picture is never overwritten. */
export function camImageName(holderId: string, sha: string, ext: string): string {
  return `images/cam/cam_${holderId}_${sha.slice(0, 8)}${ext || '.png'}`
}

const sameNum = (a: unknown, b: number | null) => (a === null || a === undefined ? b === null : b !== null && Math.abs(Number(a) - b) < 1e-9)

export function buildPlan(db: Db, dataDir: string, report: ParsedReport, interfaceCode: string): Plan {
  const plan: Plan = { interface_code: interfaceCode, new: [], renamed: [], changed: [], removed: [], unchanged: 0, unmatched: [], warnings: [] }
  const warn = (h: ParsedHolder | null, message: string) => plan.warnings.push({ seq: h?.seq ?? null, cam_name: h?.cam_name ?? null, message })
  const makers = db.all<{ manufacturer_id: number; name: string }>(`SELECT manufacturer_id, name FROM manufacturers`)
  const makerByName = new Map(makers.map((m) => [m.name.toUpperCase(), m]))
  const typeNames = new Map(db.all<{ type_code: string; type_name: string }>(`SELECT type_code, type_name FROM holder_types`).map((t) => [t.type_code, t.type_name]))

  // 1) Read each block's identity; anything without one is listed as unmatched and never inserted.
  interface Ident {
    h: ParsedHolder
    maker: string
    order: string
    from: 'name' | 'comment'
  }
  const idents: Ident[] = []
  const firstSeq = new Map<string, number>()
  for (const h of report.holders) {
    const unmatched = (reason: string) => plan.unmatched.push({ seq: h.seq, cam_name: h.cam_name, cam_comment: h.cam_comment, reason })
    if (!h.cam_name) {
      unmatched('The block has no holder name.')
      continue
    }
    let order = orderFromName(h.cam_name)
    let from: Ident['from'] = 'name'
    if (!order && (order = orderFromComment(h.cam_comment))) from = 'comment'
    if (!order) {
      unmatched('No order no. in the name or comment. Add the maker order no. to the holder name in hyperMILL.')
      warn(h, 'No order no. found — this holder is listed under Unmatched and not imported.')
      continue
    }
    const maker = makerFromName(h.cam_name, [...makerByName.keys()]) ?? (h.cam_comment ? makerFromName(h.cam_comment, [...makerByName.keys()]) : null)
    if (!maker) {
      unmatched('Maker not recognised. Put the maker (e.g. HAIMER, MAPAL) in the holder name in hyperMILL.')
      warn(h, 'Maker not recognised — this holder is listed under Unmatched and not imported.')
      continue
    }
    const key = `${maker}|${order.toUpperCase()}`
    const first = firstSeq.get(key)
    if (first !== undefined) {
      unmatched(`Same maker and order no. as holder ${first} in the report — only the first one is used.`)
      warn(h, `Duplicate of holder ${first} in the report (${maker} ${order}).`)
      continue
    }
    firstSeq.set(key, h.seq)
    if (from === 'comment') warn(h, `Order no. ${order} taken from the comment — the name has none.`)
    idents.push({ h, maker, order, from })
  }

  // 2) Match: (maker, order no.) first for every block, then the hyperMILL name for the rest.
  const matched = new Map<Ident, HolderRow>()
  const taken = new Set<string>()
  for (const id of idents) {
    const mk = makerByName.get(id.maker.toUpperCase())
    if (!mk) continue
    const row = db.get<HolderRow>(
      `SELECT ${HOLDER_COLS} FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
       WHERE h.manufacturer_id = ? AND h.order_no = ? COLLATE NOCASE ORDER BY h.holder_id LIMIT 1`,
      [mk.manufacturer_id, id.order],
    )
    if (row && !taken.has(row.holder_id)) {
      matched.set(id, row)
      taken.add(row.holder_id)
    }
  }
  for (const id of idents) {
    if (matched.has(id)) continue
    const rows = db.all<HolderRow>(
      `SELECT ${HOLDER_COLS} FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
       WHERE h.interface_code = ? AND h.cam_name = ? COLLATE NOCASE ORDER BY h.holder_id`,
      [interfaceCode, id.h.cam_name],
    )
    const row = rows.find((r) => !taken.has(r.holder_id))
    if (row) {
      matched.set(id, row)
      taken.add(row.holder_id)
      warn(id.h, `Matched to ${row.holder_id} by its hyperMILL name — the catalogue has it as ${row.manufacturer} ${row.order_no}, the name reads as ${id.maker} ${id.order}.`)
    }
  }

  // 3) Compare matched holders; plan the new ones.
  const hashCache = new Map<string, string | null>()
  const storedHash = (camImage: string | null): string | null => {
    const p = storedImagePath(dataDir, camImage)
    if (!p) return null
    if (!hashCache.has(p)) {
      try {
        hashCache.set(p, sha256(readFileSync(p)))
      } catch {
        hashCache.set(p, null)
      }
    }
    return hashCache.get(p)!
  }
  for (const id of idents) {
    const { h } = id
    const img = h.image !== null ? report.images[h.image]! : null
    const imageSha = img?.sha256 ?? null
    const gl = camGlFromName(h.cam_name)
    const row = matched.get(id)
    if (!row) {
      const c = classify(id.maker, id.order, h.cam_name, h.cam_comment)
      if (gl === null) warn(h, 'No gauge length ("…GL") in the name — the hyperMILL gauge length is left empty.')
      plan.new.push({
        seq: h.seq,
        cam_name: h.cam_name,
        cam_comment: h.cam_comment,
        manufacturer: makerByName.get(id.maker.toUpperCase())?.name ?? id.maker,
        manufacturer_new: !makerByName.has(id.maker.toUpperCase()),
        order_no: id.order,
        order_from: id.from,
        type_code: c.type_code,
        type_name: typeNames.get(c.type_code) ?? c.type_code,
        series: c.series,
        classified_by: c.by,
        cam_gl_mm: gl,
        coupling: h.coupling,
        image: imageSha ? h.image : null,
        image_sha: imageSha,
        image_ext: imageSha ? img!.ext : null,
      })
      continue
    }
    if (row.interface_code !== interfaceCode)
      warn(h, `${row.holder_id} is an ${row.interface_code} holder in the catalogue, but this report is being imported as ${interfaceCode}.`)
    const changes: FieldChange[] = []
    const dbName = collapse(row.cam_name)
    let renamed = false
    if (dbName !== h.cam_name) {
      // No name yet = the holder is being linked to hyperMILL, not renamed. A difference only in case,
      // spacing or the GL token is recorded but is not a rename (a GL change raises its own issue).
      if (dbName && nameKey(dbName) !== nameKey(h.cam_name)) renamed = true
      changes.push({ field: 'cam_name', old: row.cam_name, new: h.cam_name })
    }
    if ((collapse(row.cam_comment) || null) !== h.cam_comment) changes.push({ field: 'cam_comment', old: row.cam_comment, new: h.cam_comment })
    if (gl !== null && !sameNum(row.cam_gl_mm, gl)) changes.push({ field: 'cam_gl_mm', old: row.cam_gl_mm, new: gl })
    let imageChange: PlanMatched['image_change'] = null
    if (imageSha) {
      const stored = storedHash(row.cam_image)
      if (stored !== imageSha) {
        imageChange = stored === null ? 'added' : 'replaced'
        changes.push({ field: 'cam_image', old: row.cam_image, new: camImageName(row.holder_id, imageSha, img!.ext) })
      }
    }
    const openingBalance = Number(db.value(`SELECT COUNT(*) FROM stock_transactions WHERE holder_id = ?`, [row.holder_id])) === 0
    if (!changes.length && !openingBalance) {
      plan.unchanged++
      continue
    }
    const item: PlanMatched = {
      seq: h.seq,
      holder_id: row.holder_id,
      manufacturer: row.manufacturer,
      order_no: row.order_no,
      interface_code: row.interface_code,
      cam_name: h.cam_name,
      old_name: row.cam_name,
      changes,
      image: imageChange ? h.image : null,
      image_sha: imageChange ? imageSha : null,
      image_change: imageChange,
      opening_balance: openingBalance,
      gauge_length_mm: row.gauge_length_mm,
    }
    ;(renamed ? plan.renamed : plan.changed).push(item)
  }

  // 4) Holders of this interface linked to hyperMILL that the report no longer lists.
  const linked = db.all<Omit<PlanRemoved, 'already_flagged' | 'flag_status'> & { flag_status: string | null }>(
    `SELECT h.holder_id, m.name AS manufacturer, h.order_no, h.cam_name, s.qty_on_site,
            (SELECT f.status FROM data_flags f WHERE f.holder_id = h.holder_id AND f.category = 'hyperMILL' AND f.message LIKE ?
             ORDER BY (f.status = 'OPEN') DESC, f.flag_id DESC LIMIT 1) AS flag_status
     FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
     JOIN v_stock_on_hand s ON s.holder_id = h.holder_id
     WHERE h.interface_code = ? AND h.cam_name IS NOT NULL AND TRIM(h.cam_name) <> ''
     ORDER BY h.holder_id`,
    [`${REMOVED_PREFIX}%`, interfaceCode],
  )
  for (const r of linked) {
    const qty = Number(r.qty_on_site)
    const status = r.flag_status === 'OPEN' || r.flag_status === 'CLOSED' ? r.flag_status : null
    if (taken.has(r.holder_id)) {
      if (status === 'OPEN') {
        const h = [...matched.entries()].find(([, row]) => row.holder_id === r.holder_id)?.[0].h ?? null
        warn(h, `${r.holder_id} is back in the report — close its open "${REMOVED_PREFIX}" issue if it is in use again.`)
      }
      continue
    }
    plan.removed.push({ ...r, qty_on_site: qty, flag_status: status, already_flagged: status === 'OPEN' || (status === 'CLOSED' && qty <= 0) })
  }

  // 5) Sanity checks that catch the wrong report or the wrong interface before anything is written.
  if (plan.removed.length > 3 && plan.removed.length * 2 > linked.length)
    warn(null, `${plan.removed.length} of the ${linked.length} ${interfaceCode} holders linked to hyperMILL are missing from this report. Check it is the right report and the right interface before applying.`)
  const tagCount = new Map<string, number>()
  for (const h of report.holders) if (h.tag) tagCount.set(h.tag, (tagCount.get(h.tag) ?? 0) + 1)
  const commonTag = [...tagCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join('')
  if (commonTag && digits(commonTag) && digits(interfaceCode) && digits(commonTag) !== digits(interfaceCode))
    warn(null, `The holder names are tagged "(${commonTag})" but the import is set to ${interfaceCode}. Check the interface.`)
  return plan
}

/**
 * What must not change between preview and apply: every planned write, in a stable form.
 * (Quantities on site are shown for information only and may change in between.)
 */
export function planFingerprint(p: Plan): string {
  const matched = (m: PlanMatched) => [m.holder_id, m.changes.map((c) => [c.field, c.old, c.new]), m.opening_balance]
  return JSON.stringify({
    i: p.interface_code,
    n: p.new.map((n) => [n.manufacturer, n.manufacturer_new, n.order_no, n.type_code, n.series, n.cam_name, n.cam_comment, n.cam_gl_mm, n.image_sha]),
    r: p.renamed.map(matched),
    c: p.changed.map(matched),
    x: p.removed.map((r) => [r.holder_id, r.already_flagged]),
    u: p.unchanged,
    m: p.unmatched.map((u) => [u.seq, u.reason]),
  })
}

/** Counts for summaries and the import history. */
export function planCounts(p: Plan) {
  return {
    new: p.new.length,
    renamed: p.renamed.length,
    changed: p.changed.length,
    removed: p.removed.length,
    unchanged: p.unchanged,
    unmatched: p.unmatched.length,
  }
}

/** True when applying would write something besides the import record. */
export function planHasWork(p: Plan): boolean {
  return p.new.length + p.renamed.length + p.changed.length > 0 || p.removed.some((r) => !r.already_flagged)
}
