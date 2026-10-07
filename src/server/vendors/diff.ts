/**
 * Proposal (diff) and apply — the safety net between a maker's data and the catalogue.
 *
 * Diff rules (record vs the DB row with the same maker + order no.):
 *  - numbers are equal within 0.01 mm/kg; text compares with whitespace collapsed;
 *  - a null/empty value from the source never blanks existing data (it is simply not proposed);
 *  - maker values (dimensions, mass, rpm, links, designation) are proposed whenever they differ;
 *    descriptive text the shop curates (series, clamp text, GL label, coolant, balance, notes) is only
 *    proposed when ours is empty;
 *  - dims merge: new labels are added, changed values replaced, nothing is ever removed.
 * Apply rules: only approved rows/fields; one DB transaction; inserts get the next holder id and NO stock
 * transactions (catalogue-only "can buy"); every written field is logged in holder_changes; provenance
 * (data_status, data_source, last_checked) is set; one import_runs row. Stock is never touched, nothing deleted.
 */
import type { AppContext } from '../context.js'
import type { Db, Row } from '../db.js'
import { DATA_STATUSES, logChange, nextHolderId, nowStamp, today, type DataStatus } from '../domain.js'
import { HttpError } from '../http.js'
import { FIXED_BORE } from './classify.js'
import { cleanText, interfaceMatch, labelCode } from './parse.js'
import type { FieldChange, HolderRecord, Proposal } from './types.js'

type Policy = 'value' | 'fill' | 'merge'
/** Fields compared on an existing holder, and how. */
export const UPDATE_FIELDS: Array<[string, Policy]> = [
  ['spec_code', 'value'],
  ['product_name', 'value'],
  ['clamp_dia_mm', 'value'],
  ['clamp_min_mm', 'value'],
  ['clamp_max_mm', 'value'],
  ['gauge_length_mm', 'value'],
  ['nose_dia_mm', 'value'],
  ['mass_kg', 'value'],
  ['max_rpm', 'value'],
  ['product_url', 'value'],
  ['image_url', 'value'],
  ['drawing_url', 'value'],
  ['dims', 'merge'],
  ['series', 'fill'],
  ['clamp_spec', 'fill'],
  ['gauge_length_ref', 'fill'],
  ['coolant', 'fill'],
  ['balance', 'fill'],
  ['notes', 'fill'],
]

const INSERT_FIELDS = [
  'spec_code', 'product_name', 'series', 'type_code', 'interface_code', 'clamp_dia_mm', 'clamp_min_mm', 'clamp_max_mm',
  'clamp_spec', 'gauge_length_mm', 'gauge_length_ref', 'nose_dia_mm', 'dims', 'coolant', 'balance', 'max_rpm', 'mass_kg',
  'product_url', 'image_url', 'drawing_url', 'notes',
]

const NUMERIC: Record<string, { label: string; max: number; integer?: boolean }> = {
  clamp_dia_mm: { label: 'Clamp Ø', max: 1000 },
  clamp_min_mm: { label: 'Clamp min Ø', max: 1000 },
  clamp_max_mm: { label: 'Clamp max Ø', max: 1000 },
  gauge_length_mm: { label: 'Gauge length', max: 2000 },
  nose_dia_mm: { label: 'Nose Ø', max: 1000 },
  mass_kg: { label: 'Mass', max: 500 },
  max_rpm: { label: 'Max rpm', max: 200_000, integer: true },
}
const TEXT_MAX: Record<string, number> = {
  spec_code: 200, product_name: 300, series: 200, clamp_spec: 200, gauge_length_ref: 120, coolant: 1000, balance: 300, notes: 4000,
}
const URLS = ['product_url', 'image_url', 'drawing_url']
const GEOMETRY = ['clamp_dia_mm', 'clamp_min_mm', 'clamp_max_mm', 'gauge_length_mm', 'nose_dia_mm']
const STATUS_RANK: Record<string, number> = { unverified: 0, partial: 1, distributor_only: 2, catalogue_pdf: 3, verified: 4 }

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
const normText = (v: unknown) => String(v).replace(/\s+/g, ' ').trim()
const numeric = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : null)

/** Equality used for change detection (numbers within 0.01). */
export function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (blank(a) && blank(b)) return true
  if (blank(a) || blank(b)) return false
  if (field === 'dims') return dimsEqual(a as Record<string, unknown>, b as Record<string, unknown>)
  if (NUMERIC[field]) return Math.abs(Number(a) - Number(b)) <= 0.01 + 1e-9
  return normText(a) === normText(b)
}

function dimValueEqual(a: unknown, b: unknown): boolean {
  const x = numeric(a)
  const y = numeric(b)
  if (x != null && y != null) return Math.abs(x - y) <= 0.01 + 1e-9
  return normText(a) === normText(b)
}
// "Length adjustment" and the seed's "length_adjustment" are the same dimension.
const keyNorm = (k: string) => k.toLowerCase().replace(/[\s_]+/g, ' ').trim()

function dimsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a ?? {})
  const kb = Object.keys(b ?? {})
  if (ka.length !== kb.length) return false
  const bm = new Map(kb.map((k) => [keyNorm(k), b[k]]))
  return ka.every((k) => bm.has(keyNorm(k)) && dimValueEqual(a[k], bm.get(keyNorm(k))))
}

export function parseDimsJson(v: unknown): Record<string, string | number> {
  if (typeof v !== 'string' || !v.trim()) return {}
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

const ISO_CODE = /^[A-Z][A-Z0-9_]{1,11}$/

/**
 * Our label for a bare ISO 13399 code from a data file ("DLN"): the one existing label that carries that code,
 * e.g. "DLN (diameter lock nut)" or "Lock nut diameter (DLN)". Undefined when none (or more than one) does.
 */
function labelForCode(existing: Record<string, unknown>, code: string): string | undefined {
  if (!ISO_CODE.test(code)) return undefined
  const hits = Object.keys(existing).filter((k) => labelCode(k).code === code)
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * Adds the source's dims to ours: new labels are added, differing values replaced, nothing removed.
 * Labels match ignoring case/spacing so "L length" and "L Length" are one dimension, and a bare ISO code
 * from a file ("DLN") matches our label carrying that code ("DLN (diameter lock nut)") instead of adding a
 * second entry. `refresh` values (codes that went into holder columns) only update such an existing label.
 */
export function mergeDims(
  existing: Record<string, string | number>,
  incoming: Record<string, string | number> | undefined,
  refresh?: Record<string, string | number>,
) {
  const merged: Record<string, string | number> = { ...existing }
  const changed: string[] = []
  const byNorm = new Map(Object.keys(existing).map((k) => [keyNorm(k), k]))
  const ourKey = (k: string) => byNorm.get(keyNorm(k)) ?? labelForCode(existing, k.trim())
  for (const [k, v] of Object.entries(incoming ?? {})) {
    if (blank(v)) continue
    const ours = ourKey(k)
    if (ours !== undefined) {
      if (dimValueEqual(merged[ours], v)) continue
      merged[ours] = v
      if (!changed.includes(ours)) changed.push(ours)
    } else {
      merged[k] = v
      changed.push(k)
    }
  }
  for (const [code, v] of Object.entries(refresh ?? {})) {
    if (blank(v)) continue
    const ours = ourKey(code)
    if (ours === undefined || changed.includes(ours) || dimValueEqual(merged[ours], v)) continue
    merged[ours] = v
    changed.push(ours)
  }
  return { merged, changed }
}

/** Cleans a record from the web/a file: implausible numbers, non-http links and over-long text are dropped with a warning. */
export function sanitizeRecord(db: Db, rec: HolderRecord): HolderRecord {
  const r: HolderRecord = { ...rec, warnings: [...(rec.warnings ?? [])], type_warnings: [...(rec.type_warnings ?? [])], dims: { ...(rec.dims ?? {}) } }
  const any = r as unknown as Record<string, unknown>
  for (const [f, spec] of Object.entries(NUMERIC)) {
    const v = any[f]
    if (v === null || v === undefined) continue
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0 || n > spec.max || (spec.integer && !Number.isInteger(n))) {
      r.warnings!.push(`${spec.label} "${String(v)}" is not a plausible value — ignored.`)
      any[f] = null
    } else any[f] = n
  }
  for (const f of URLS) {
    const v = any[f]
    if (blank(v)) {
      any[f] = null
      continue
    }
    const s = String(v).trim()
    if (!/^https?:\/\/\S+$/i.test(s) || s.length > 1000) {
      r.warnings!.push(`${f.replace('_url', '')} link "${s.slice(0, 60)}" is not a web address — ignored.`)
      any[f] = null
    } else any[f] = s
  }
  for (const [f, max] of Object.entries(TEXT_MAX)) any[f] = blank(any[f]) ? null : cleanText(any[f], max)
  const cleanDims = (src: Record<string, unknown> | undefined) => {
    const dims: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(src ?? {}).slice(0, 150)) {
      const key = cleanText(k, 120)
      if (!key || blank(v)) continue
      if (typeof v === 'number') {
        if (Number.isFinite(v)) dims[key] = v
      } else {
        const t = cleanText(v, 300)
        if (t) dims[key] = t
      }
    }
    return dims
  }
  r.dims = cleanDims(r.dims)
  if (rec.dims_refresh) r.dims_refresh = cleanDims(rec.dims_refresh)
  if (r.type_code && !db.value(`SELECT 1 FROM holder_types WHERE type_code = ?`, [r.type_code])) {
    // The type is only set on insert, so this note only goes on an insert proposal.
    r.type_warnings!.push(`Holder type "${r.type_code}" is not one of ours — it will be added as "Other".`)
    r.type_code = 'OTHER'
  }
  if (!(DATA_STATUSES as readonly string[]).includes(r.data_status)) r.data_status = 'unverified'
  r.data_source = cleanText(r.data_source, 500) ?? 'unknown source'
  return r
}

export function errorProposal(manufacturer: string, order_no: string, error: string, source_url: string | null = null, warnings: string[] = []): Proposal {
  return { order_no, manufacturer, action: 'error', fields: {}, record: null, source_url, warnings, error }
}

export function findHolder(db: Db, maker: string, orderNo: string): Row | undefined {
  return db.get(
    `SELECT h.* FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
     WHERE m.name = ? COLLATE NOCASE AND h.order_no = ? COLLATE NOCASE ORDER BY (h.order_no = ?) DESC LIMIT 1`,
    [maker, orderNo, orderNo],
  )
}

/** Builds the proposal for one record against the catalogue. Reads only. */
export function proposalFor(db: Db, raw: HolderRecord, iface: string): Proposal {
  const maker = db.get<{ name: string }>(`SELECT name FROM manufacturers WHERE name = ? COLLATE NOCASE`, [raw.manufacturer])
  if (!maker) return errorProposal(raw.manufacturer, raw.order_no, `Maker "${raw.manufacturer}" is not in the catalogue's maker list.`, raw.product_url ?? null)
  const rec = sanitizeRecord(db, { ...raw, manufacturer: maker.name })
  const warnings = [...new Set(rec.warnings ?? [])]
  const src = rec.product_url ?? null

  if (rec.interface_code && rec.interface_code.trim().toUpperCase() !== iface.toUpperCase())
    return errorProposal(maker.name, rec.order_no, `This row is for ${rec.interface_code}, not ${iface} — import it with that interface chosen.`, src, warnings)
  const m = interfaceMatch(iface, rec.interface_seen)
  if (m === 'no') return errorProposal(maker.name, rec.order_no, `The source says this holder is for "${rec.interface_seen}", not ${iface} — not proposed.`, src, warnings)
  if (m === 'form-only') warnings.push(`The source only names the form ("${rec.interface_seen}"), not the size — check it is ${iface}.`)

  const existing = findHolder(db, maker.name, rec.order_no)
  const fields: Record<string, FieldChange> = {}
  const any = rec as unknown as Record<string, unknown>
  if (!existing) {
    for (const f of INSERT_FIELDS) {
      const v = f === 'interface_code' ? iface : f === 'dims' ? (Object.keys(rec.dims ?? {}).length ? rec.dims : null) : any[f]
      if (!blank(v)) fields[f] = { old: null, new: v }
    }
    // Notes about the holder type only apply here: a new holder gets the type, an existing one keeps its own.
    const ins = [...new Set([...warnings, ...(rec.type_warnings ?? [])])]
    return { order_no: rec.order_no, manufacturer: maker.name, action: 'insert', fields, record: { ...rec, warnings: ins }, source_url: src, warnings: ins }
  }
  if (existing.interface_code !== iface) warnings.push(`In the catalogue this holder is filed under ${existing.interface_code}, not ${iface}.`)
  if (existing.order_no !== rec.order_no) warnings.push(`The catalogue spells the order no. "${existing.order_no}"; the source says "${rec.order_no}".`)
  for (const [f, policy] of UPDATE_FIELDS) {
    if (policy === 'merge') {
      const ours = parseDimsJson(existing.dims_json)
      const { merged, changed } = mergeDims(ours, rec.dims, rec.dims_refresh)
      if (changed.length) fields.dims = { old: ours, new: merged, keys: changed }
      continue
    }
    const nv = any[f]
    if (blank(nv)) continue // the source did not say: never blank out what we have
    const ov = existing[f]
    if (policy === 'fill' && !blank(ov)) continue
    if (!sameValue(f, ov, nv)) fields[f] = { old: ov ?? null, new: nv }
  }
  // A new GL value brings its label with it, even though the label alone is "fill only".
  if (fields.gauge_length_mm && rec.gauge_length_ref && !sameValue('gauge_length_ref', existing.gauge_length_ref, rec.gauge_length_ref))
    fields.gauge_length_ref = { old: existing.gauge_length_ref ?? null, new: rec.gauge_length_ref }
  return {
    order_no: String(existing.order_no),
    manufacturer: maker.name,
    action: Object.keys(fields).length ? 'update' : 'same',
    holder_id: String(existing.holder_id),
    fields,
    // No holder-type notes here: the type of an existing holder is never changed by a scan or import.
    record: { ...rec, order_no: String(existing.order_no), warnings, type_warnings: undefined },
    source_url: src,
    warnings,
  }
}

// ------------------------------------------------------------------------------------------- apply

export interface ApplyMeta {
  kind: 'VENDOR' | 'FILE'
  /** holder_changes.source, e.g. 'vendor sync HAIMER' or 'file import ceratizit.csv'. */
  changeSource: string
  /** import_runs.source, e.g. 'HAIMER' or 'ceratizit.csv — ISO 13399 from rep'. */
  runSource: string
  interface_code: string
  /** holder_changes.reference for one proposal (the product URL, or the file + description). */
  reference: (p: Proposal) => string | null
  /** job id or import token, kept in the run summary. */
  ref_id: string
}

export interface ApproveItem {
  order_no: string
  fields?: string[]
}

export interface ApplyResult {
  run_id: number
  inserted: Array<{ holder_id: string; order_no: string }>
  updated: Array<{ holder_id: string; order_no: string; fields: string[] }>
  confirmed: Array<{ holder_id: string; order_no: string }>
  skipped: Array<{ order_no: string; reason: string }>
  conflicts: Array<{ holder_id: string; order_no: string; field: string; reason: string }>
}

export function parseApprove(raw: unknown): ApproveItem[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Tick at least one row to approve (approve must be a list of {order_no, fields?}).')
  if (raw.length > 10_000) throw new HttpError(400, 'Too many rows in one approval — approve at most 10,000 at a time.')
  const out = new Map<string, ApproveItem>()
  for (const it of raw) {
    const order = typeof it === 'string' ? it : it && typeof it === 'object' ? (it as any).order_no : null
    if (typeof order !== 'string' || !order.trim()) throw new HttpError(400, 'Every approved row needs its order_no.')
    const fieldsRaw = it && typeof it === 'object' ? (it as any).fields : undefined
    if (fieldsRaw !== undefined && fieldsRaw !== null && (!Array.isArray(fieldsRaw) || fieldsRaw.some((f: unknown) => typeof f !== 'string')))
      throw new HttpError(400, `fields for ${order} must be a list of field names.`)
    const prev = out.get(order)
    const fields = fieldsRaw == null ? undefined : (fieldsRaw as string[])
    // No field list = every proposed field; a repeated row widens the list (or makes it "all").
    const merged = !prev ? fields : prev.fields === undefined || fields === undefined ? undefined : [...new Set([...prev.fields, ...fields])]
    out.set(order, { order_no: order, fields: merged })
  }
  return [...out.values()]
}

/** data_status after applying (see the module comment in docs: never claims more than was checked). */
export function statusAfter(cur: string, rec: HolderRecord, allApproved: boolean, applied: string[]): DataStatus {
  const current = ((DATA_STATUSES as readonly string[]).includes(cur) ? cur : 'unverified') as DataStatus
  // Declined changes: the row still differs from the source, so its status stays (an unverified row is now partly checked).
  if (!allApproved) return current === 'unverified' && applied.length ? 'partial' : current
  let incoming = rec.data_status
  // 'partial' only because of caveated fields (e.g. Kemmler LPR → GL) that this apply does not change.
  if (incoming === 'partial' && rec.partial_fields?.length && !rec.partial_fields.some((f) => applied.includes(f))) incoming = 'verified'
  // Geometry now comes from this source: its status applies. Otherwise only ever upgrade.
  if (applied.some((f) => GEOMETRY.includes(f))) return incoming
  return (STATUS_RANK[incoming] ?? 0) > (STATUS_RANK[current] ?? 0) ? incoming : current
}

function sourceAfter(cur: unknown, incoming: string, replace: boolean): string {
  const c = blank(cur) ? '' : normText(cur)
  if (replace || !c) return incoming
  if (c.toLowerCase().includes(incoming.toLowerCase())) return c
  const s = `${c} + ${incoming}`
  return s.length > 500 ? s.slice(0, 499) + '…' : s
}

const COLUMN = (f: string) => (f === 'dims' ? 'dims_json' : f)
const store = (f: string, v: unknown) => (f === 'dims' ? (v && Object.keys(v as object).length ? JSON.stringify(v) : null) : (v as string | number | null))

/** Writes the approved part of a set of proposals. One transaction; returns what happened row by row. */
export function applyProposals(ctx: AppContext, user: string, proposals: Proposal[], approve: ApproveItem[], meta: ApplyMeta): ApplyResult {
  const db = ctx.db
  const byOrder = new Map(proposals.map((p) => [p.order_no.toUpperCase(), p]))
  const res: ApplyResult = { run_id: 0, inserted: [], updated: [], confirmed: [], skipped: [], conflicts: [] }
  const unknown = approve.filter((a) => !byOrder.has(a.order_no.toUpperCase())).map((a) => a.order_no)
  if (unknown.length) throw new HttpError(400, `Not in this scan/import: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? '…' : ''}. Refresh the proposals and approve again.`)

  return db.tx(() => {
    for (const a of approve) {
      const p = byOrder.get(a.order_no.toUpperCase())!
      const rec = p.record
      if (p.action === 'error' || !rec) {
        res.skipped.push({ order_no: p.order_no, reason: p.error ?? 'Error rows cannot be approved.' })
        continue
      }
      const reference = meta.reference(p)
      if (p.action === 'insert') {
        const existing = findHolder(db, p.manufacturer, p.order_no)
        if (existing) {
          res.skipped.push({ order_no: p.order_no, reason: `Already in the catalogue as ${existing.holder_id} (added since the proposal was made) — scan again to compare.` })
          continue
        }
        const id = nextHolderId(db)
        const mid = db.value<number>(`SELECT manufacturer_id FROM manufacturers WHERE name = ?`, [p.manufacturer])
        const vals: Record<string, unknown> = {}
        for (const f of INSERT_FIELDS) vals[COLUMN(f)] = f === 'interface_code' ? meta.interface_code : store(f, (rec as any)[f] ?? null)
        vals.type_code = rec.type_code || 'OTHER'
        if ((vals.clamp_min_mm == null) !== (vals.clamp_max_mm == null)) vals.clamp_min_mm = vals.clamp_max_mm = null
        vals.data_status = rec.data_status
        vals.data_source = rec.data_source
        vals.last_checked = today()
        const cols = Object.keys(vals)
        db.run(`INSERT INTO holders(holder_id, manufacturer_id, order_no, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`, [
          id,
          Number(mid),
          p.order_no,
          ...cols.map((c) => vals[c] as string | number | null),
        ])
        const logged: Record<string, unknown> = { manufacturer: p.manufacturer, order_no: p.order_no }
        for (const c of cols) if (vals[c] != null) logged[c] = c === 'dims_json' ? rec.dims : vals[c]
        logChange(db, { holder_id: id, field: '*', old_value: null, new_value: logged, source: meta.changeSource, reference, by_user: user })
        res.inserted.push({ holder_id: id, order_no: p.order_no })
        continue
      }

      // update / same: re-read the row — someone may have edited it since the scan.
      const cur = db.get(`SELECT * FROM holders WHERE holder_id = ?`, [p.holder_id!])
      if (!cur) {
        res.skipped.push({ order_no: p.order_no, reason: `Holder ${p.holder_id} no longer exists.` })
        continue
      }
      const proposed = Object.keys(p.fields)
      let wanted = a.fields ? a.fields.filter((f) => proposed.includes(f)) : proposed
      // Fixed-bore holders keep min = max = Ø: the three clamp fields move together.
      if (FIXED_BORE.includes(String(cur.type_code)) && wanted.includes('clamp_dia_mm'))
        wanted = [...new Set([...wanted, ...['clamp_min_mm', 'clamp_max_mm'].filter((f) => proposed.includes(f))])]
      const sets: Record<string, unknown> = {}
      const applied: Array<{ field: string; old: unknown; new: unknown }> = []
      for (const f of wanted) {
        const col = COLUMN(f)
        const curVal = f === 'dims' ? parseDimsJson(cur.dims_json) : cur[col]
        if (!sameValue(f, curVal, p.fields[f]!.old)) {
          res.conflicts.push({ holder_id: String(cur.holder_id), order_no: p.order_no, field: f, reason: 'Changed in the catalogue since the proposal was made — not overwritten.' })
          continue
        }
        const nv = f === 'dims' ? mergeDims(curVal as Record<string, string | number>, rec.dims, rec.dims_refresh).merged : p.fields[f]!.new
        if (sameValue(f, curVal, nv)) continue
        sets[col] = store(f, nv)
        applied.push({ field: f, old: curVal, new: nv })
      }
      // Never leave a half-open or reversed clamp range.
      const min = 'clamp_min_mm' in sets ? sets.clamp_min_mm : cur.clamp_min_mm
      const max = 'clamp_max_mm' in sets ? sets.clamp_max_mm : cur.clamp_max_mm
      if ((min == null) !== (max == null) || (min != null && max != null && Number(min) > Number(max))) {
        for (const f of ['clamp_min_mm', 'clamp_max_mm']) {
          if (f in sets) {
            delete sets[f]
            const i = applied.findIndex((x) => x.field === f)
            if (i >= 0) applied.splice(i, 1)
            res.conflicts.push({ holder_id: String(cur.holder_id), order_no: p.order_no, field: f, reason: 'Would leave the clamp range half-open or reversed — approve min and max together.' })
          }
        }
      }
      const appliedNames = applied.map((x) => x.field)
      if (p.action === 'update' && !appliedNames.length) {
        res.skipped.push({ order_no: p.order_no, reason: 'Nothing left to change — the approved fields changed in the catalogue meanwhile (see conflicts) or already match.' })
        continue
      }
      if (p.action === 'same' && proposalFor(db, rec, meta.interface_code).action !== 'same') {
        res.skipped.push({ order_no: p.order_no, reason: 'Edited in the catalogue since the scan, so it no longer matches the source — scan again before confirming it.' })
        continue
      }
      const write = (values: Record<string, unknown>) => {
        const cols = Object.keys(values)
        if (cols.length)
          db.run(`UPDATE holders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE holder_id = ?`, [...cols.map((c) => values[c] as string | number | null), cur.holder_id as string])
      }
      write(sets)
      // Does the row now match the source in every field the source gives? (Declined fields, or edits made
      // since the scan, leave differences — then the status must not claim the source verified the row.)
      const allApproved = proposalFor(db, rec, meta.interface_code).action === 'same'
      const status = statusAfter(String(cur.data_status), rec, allApproved, appliedNames)
      const replaceSource = allApproved && appliedNames.some((f) => GEOMETRY.includes(f))
      const source = sourceAfter(cur.data_source, rec.data_source, replaceSource)
      const prov: Record<string, unknown> = { last_checked: today() }
      if (status !== cur.data_status) {
        prov.data_status = status
        applied.push({ field: 'data_status', old: cur.data_status, new: status })
      }
      if (source !== (cur.data_source ?? '')) {
        prov.data_source = source
        applied.push({ field: 'data_source', old: cur.data_source ?? null, new: source })
      }
      write(prov)
      for (const ch of applied)
        logChange(db, { holder_id: String(cur.holder_id), field: COLUMN(ch.field), old_value: ch.old, new_value: ch.new, source: meta.changeSource, reference, by_user: user })
      const fieldChanges = appliedNames
      if (fieldChanges.length) res.updated.push({ holder_id: String(cur.holder_id), order_no: p.order_no, fields: fieldChanges })
      else res.confirmed.push({ holder_id: String(cur.holder_id), order_no: p.order_no })
    }
    const summary = {
      ref: meta.ref_id,
      inserted: res.inserted.length,
      updated: res.updated.length,
      confirmed: res.confirmed.length,
      skipped: res.skipped.length,
      conflicts: res.conflicts.length,
      holders: [...res.inserted, ...res.updated, ...res.confirmed].map((x) => x.holder_id),
    }
    const run = db.run(`INSERT INTO import_runs(kind, source, interface_code, run_at, by_user, summary_json) VALUES (?,?,?,?,?,?)`, [
      meta.kind,
      meta.runSource,
      meta.interface_code,
      nowStamp(),
      user,
      JSON.stringify(summary),
    ])
    res.run_id = run.lastInsertRowid
    return res
  })
}
