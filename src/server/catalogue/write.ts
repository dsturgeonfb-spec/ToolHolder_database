/**
 * Manual catalogue entry and edits (POST / PATCH /api/holders).
 *
 * Rules (BUILD_SPEC §3, CLAUDE.md):
 *  - values come from a maker page or catalogue, so every write names its data_source;
 *  - every changed field is logged in holder_changes with who, when and on whose data;
 *  - fixed-bore holders keep clamp_min = clamp_max = nominal Ø so "fits Ø d" works;
 *  - stock is never touched here (it is the transaction ledger, booked by the stock module).
 */
import type { AppContext } from '../context.js'
import type { Row } from '../db.js'
import { DATA_STATUSES, logChange, nextHolderId, requireUser, today } from '../domain.js'
import { HttpError, type Req } from '../http.js'
import { requireHolder, type Holder } from './holders.js'

/** Holder types whose clamp is one fixed bore/spigot: min = max = nominal Ø. */
export const FIXED_BORE_TYPES = ['SHRINK', 'HYDRAULIC', 'FACE_MILL_ARBOR']

type Kind = 'text' | 'posnum' | 'int' | 'url' | 'status' | 'dims' | 'type' | 'iface' | 'maker'
interface FieldSpec {
  kind: Kind
  label: string
  max?: number
  /** Column it is stored in when that differs from the field name. */
  column?: string
  required?: boolean
}

/**
 * Fields a person may set from a maker catalogue. cam_image (a file in the data folder) and stock are
 * deliberately absent; holder_id and last_checked are set by the server.
 */
export const EDITABLE: Record<string, FieldSpec> = {
  manufacturer: { kind: 'maker', label: 'Maker', column: 'manufacturer_id', required: true },
  order_no: { kind: 'text', label: 'Order no.', max: 80, required: true },
  type_code: { kind: 'type', label: 'Holder type', required: true },
  interface_code: { kind: 'iface', label: 'Interface', required: true },
  spec_code: { kind: 'text', label: 'Spec code', max: 200 },
  product_name: { kind: 'text', label: 'Product name', max: 300 },
  series: { kind: 'text', label: 'Series', max: 200 },
  clamp_dia_mm: { kind: 'posnum', label: 'Clamp Ø' },
  clamp_min_mm: { kind: 'posnum', label: 'Clamp min Ø' },
  clamp_max_mm: { kind: 'posnum', label: 'Clamp max Ø' },
  clamp_spec: { kind: 'text', label: 'Clamping text', max: 200 },
  gauge_length_mm: { kind: 'posnum', label: 'Gauge length' },
  gauge_length_ref: { kind: 'text', label: 'Gauge length reference', max: 120 },
  nose_dia_mm: { kind: 'posnum', label: 'Nose Ø' },
  dims: { kind: 'dims', label: 'Maker dimensions', column: 'dims_json' },
  coolant: { kind: 'text', label: 'Coolant', max: 1000 },
  balance: { kind: 'text', label: 'Balance', max: 300 },
  max_rpm: { kind: 'int', label: 'Max rpm' },
  mass_kg: { kind: 'posnum', label: 'Mass' },
  product_url: { kind: 'url', label: 'Maker page URL' },
  image_url: { kind: 'url', label: 'Photo URL' },
  drawing_url: { kind: 'url', label: 'Drawing URL' },
  cam_name: { kind: 'text', label: 'hyperMILL name', max: 300 },
  cam_comment: { kind: 'text', label: 'hyperMILL comment', max: 1000 },
  cam_gl_mm: { kind: 'posnum', label: 'hyperMILL gauge length' },
  data_status: { kind: 'status', label: 'Data status' },
  data_source: { kind: 'text', label: 'Data source', max: 500 },
  notes: { kind: 'text', label: 'Notes', max: 4000 },
}
// dims_json is accepted as an alias of dims (a JSON string), for callers that echo the column back.
const ALIASES: Record<string, string> = { dims_json: 'dims' }

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

function parseDimsValue(v: unknown): string | null {
  let obj: unknown = v
  if (typeof v === 'string') {
    if (!v.trim()) return null
    try {
      obj = JSON.parse(v)
    } catch {
      throw new HttpError(400, 'Maker dimensions must be a list of label: value pairs (a JSON object)')
    }
  }
  if (obj === null || obj === undefined) return null
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new HttpError(400, 'Maker dimensions must be a list of label: value pairs (a JSON object)')
  const entries = Object.entries(obj as Record<string, unknown>)
  if (entries.length > 150) throw new HttpError(400, 'Too many maker dimensions (150 at most)')
  const clean: Record<string, string | number> = {}
  for (const [k, val] of entries) {
    const key = k.trim()
    if (!key) throw new HttpError(400, 'Every maker dimension needs a label')
    if (key.length > 120) throw new HttpError(400, `Dimension label "${key.slice(0, 40)}…" is too long`)
    if (val === null || val === undefined || (typeof val === 'string' && !val.trim())) continue
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) throw new HttpError(400, `Dimension "${key}" is not a number`)
      clean[key] = val
    } else if (typeof val === 'string') {
      if (val.length > 300) throw new HttpError(400, `Dimension "${key}" is too long`)
      clean[key] = val.trim()
    } else throw new HttpError(400, `Dimension "${key}" must be a number or text`)
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null
}

/** Validates one field. Returns the value as stored in its column. */
function parseField(ctx: AppContext, name: string, spec: FieldSpec, v: unknown): unknown {
  const db = ctx.db
  if (spec.kind === 'dims') return parseDimsValue(v)
  if (isBlank(v)) {
    if (spec.required || spec.kind === 'status') throw new HttpError(400, `${spec.label} cannot be empty`)
    return null
  }
  switch (spec.kind) {
    case 'text': {
      if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${spec.label} must be text`)
      const s = String(v).trim()
      if (s.length > (spec.max ?? 2000)) throw new HttpError(400, `${spec.label} is too long (${spec.max} characters at most)`)
      // Control characters (other than line breaks in notes) only come from bad pastes and break CSV/XLSX.
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) throw new HttpError(400, `${spec.label} contains invisible control characters — retype it`)
      return s
    }
    case 'posnum':
    case 'int': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim().replace(',', '.')) : NaN
      if (!Number.isFinite(n)) throw new HttpError(400, `${spec.label} must be a number (got "${String(v).slice(0, 30)}")`)
      if (n <= 0) throw new HttpError(400, `${spec.label} must be greater than 0`)
      if (spec.kind === 'int' && !Number.isInteger(n)) throw new HttpError(400, `${spec.label} must be a whole number`)
      if (n > 1_000_000) throw new HttpError(400, `${spec.label} is too large — check the units`)
      return n
    }
    case 'url': {
      const s = String(v).trim()
      if (!/^https?:\/\/[^\s]+$/i.test(s) || s.length > 1000)
        throw new HttpError(400, `${spec.label} must be a web address starting with http:// or https://`)
      return s
    }
    case 'status': {
      const s = String(v).trim()
      if (!(DATA_STATUSES as readonly string[]).includes(s))
        throw new HttpError(400, `Data status must be one of: ${DATA_STATUSES.join(', ')}`)
      return s
    }
    case 'type': {
      const s = String(v).trim()
      if (!db.value(`SELECT 1 FROM holder_types WHERE type_code = ?`, [s]))
        throw new HttpError(400, `Unknown holder type "${s}". Pick one of the listed types.`)
      return s
    }
    case 'iface': {
      const s = String(v).trim()
      if (!db.value(`SELECT 1 FROM interfaces WHERE interface_code = ?`, [s]))
        throw new HttpError(400, `Unknown interface "${s}". Pick one of the listed interfaces.`)
      return s
    }
    case 'maker': {
      const s = String(v).trim()
      const id = db.value<number>(`SELECT manufacturer_id FROM manufacturers WHERE name = ? COLLATE NOCASE`, [s])
      if (id == null) throw new HttpError(400, `Unknown maker "${s}". Pick one of the listed makers.`)
      return Number(id)
    }
  }
  throw new HttpError(400, `${name} cannot be set here`)
}

/** Reads the body into { column: value } for the fields present. Unknown fields are refused. */
function parseBody(ctx: AppContext, body: unknown): Map<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send the holder fields as a JSON object')
  const out = new Map<string, unknown>()
  const unknown: string[] = []
  for (const [rawKey, v] of Object.entries(body as Record<string, unknown>)) {
    const key = ALIASES[rawKey] ?? rawKey
    const spec = EDITABLE[key]
    if (!spec) {
      unknown.push(rawKey)
      continue
    }
    out.set(spec.column ?? key, parseField(ctx, key, spec, v))
  }
  if (unknown.length)
    throw new HttpError(
      400,
      `These fields cannot be set here: ${unknown.join(', ')}. Stock is booked through counts and transactions; ` +
        `hyperMILL images come from the hyperMILL import.`,
    )
  return out
}

/**
 * Fills/validates the clamp range on the merged record:
 * fixed-bore types get min = max = nominal; an open range must be given as both ends or neither.
 */
function settleClamp(rec: Record<string, unknown>, given: Map<string, unknown>, before?: Row): void {
  const fixed = FIXED_BORE_TYPES.includes(String(rec.type_code))
  const dia = rec.clamp_dia_mm as number | null
  if (fixed && dia != null && !given.has('clamp_min_mm') && !given.has('clamp_max_mm')) {
    const prevDia = before?.clamp_dia_mm ?? null
    const followsDia =
      !before ||
      (before.clamp_min_mm == null && before.clamp_max_mm == null) ||
      (before.clamp_min_mm === prevDia && before.clamp_max_mm === prevDia) ||
      before.type_code !== rec.type_code
    if (followsDia) {
      rec.clamp_min_mm = dia
      rec.clamp_max_mm = dia
    }
  }
  const min = rec.clamp_min_mm as number | null
  const max = rec.clamp_max_mm as number | null
  if ((min == null) !== (max == null))
    throw new HttpError(400, 'Give both clamp min and clamp max Ø, or neither (screw-in and tap chucks leave both empty).')
  if (min != null && max != null && min > max) throw new HttpError(400, `Clamp min Ø (${min}) is larger than clamp max Ø (${max}).`)
}

function assertUniqueIdentity(ctx: AppContext, manufacturerId: number, orderNo: string, exceptId?: string): void {
  const other = ctx.db.get<{ holder_id: string; name: string }>(
    `SELECT h.holder_id, m.name FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
     WHERE h.manufacturer_id = ? AND h.order_no = ? AND h.holder_id <> COALESCE(?, '')`,
    [manufacturerId, orderNo, exceptId ?? null],
  )
  if (other)
    throw new HttpError(
      409,
      `${other.name} order no. ${orderNo} is already in the catalogue (${other.holder_id}) — open that record and edit it instead.`,
      { holder_id: other.holder_id },
    )
}

const COLUMNS_ON_INSERT = [
  'manufacturer_id', 'order_no', 'spec_code', 'product_name', 'series', 'type_code', 'interface_code',
  'clamp_dia_mm', 'clamp_min_mm', 'clamp_max_mm', 'clamp_spec', 'gauge_length_mm', 'gauge_length_ref', 'cam_gl_mm',
  'nose_dia_mm', 'dims_json', 'coolant', 'balance', 'max_rpm', 'mass_kg', 'product_url', 'image_url', 'drawing_url',
  'cam_name', 'cam_comment', 'data_status', 'data_source', 'last_checked', 'notes',
]

/** POST /api/holders */
export function createHolder(ctx: AppContext, req: Req): Holder {
  const user = requireUser(req.user)
  const given = parseBody(ctx, req.body)
  for (const f of ['manufacturer', 'order_no', 'type_code', 'interface_code'] as const) {
    const col = EDITABLE[f]!.column ?? f
    if (!given.has(col) || given.get(col) == null) throw new HttpError(400, `${EDITABLE[f]!.label} is required`)
  }
  const source = given.get('data_source')
  if (source == null)
    throw new HttpError(400, 'Data source is required: say where these values came from (maker page URL, catalogue and page no.).')
  const rec: Record<string, unknown> = {}
  for (const c of COLUMNS_ON_INSERT) rec[c] = given.has(c) ? given.get(c) : null
  rec.data_status = rec.data_status ?? 'unverified'
  rec.last_checked = today()
  settleClamp(rec, given)
  return ctx.db.tx(() => {
    assertUniqueIdentity(ctx, rec.manufacturer_id as number, rec.order_no as string)
    const id = nextHolderId(ctx.db)
    ctx.db.run(
      `INSERT INTO holders(holder_id, ${COLUMNS_ON_INSERT.join(', ')}) VALUES (?, ${COLUMNS_ON_INSERT.map(() => '?').join(', ')})`,
      [id, ...COLUMNS_ON_INSERT.map((c) => rec[c] as string | number | null)],
    )
    const maker = ctx.db.value<string>(`SELECT name FROM manufacturers WHERE manufacturer_id = ?`, [rec.manufacturer_id as number])
    const logged: Record<string, unknown> = { manufacturer: maker }
    for (const c of COLUMNS_ON_INSERT) if (c !== 'manufacturer_id' && rec[c] != null) logged[c] = rec[c]
    logChange(ctx.db, { holder_id: id, field: '*', old_value: null, new_value: logged, source: 'manual', reference: String(source), by_user: user })
    return requireHolder(ctx, id)
  })
}

/** Value equality for change detection: 12 == 12.0, '' == null, trimmed text. */
function same(column: string, a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v)
  let x = norm(a)
  let y = norm(b)
  if (column === 'dims_json') {
    // The seed wrote dims with Python's json.dumps ('{"d1": 6.0}'); compare content, not formatting.
    const canon = (v: unknown) => {
      try {
        return v == null ? null : parseDimsValue(v)
      } catch {
        return String(v) // an unreadable stored value simply compares as text
      }
    }
    x = canon(x)
    y = canon(y)
  }
  if (x === null || y === null) return x === y
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y)
  return String(x) === String(y)
}

/** PATCH /api/holders/:id */
export function updateHolder(ctx: AppContext, req: Req): Holder {
  const user = requireUser(req.user)
  const id = String(req.params.id)
  const before = ctx.db.get(`SELECT * FROM holders WHERE holder_id = ?`, [id])
  if (!before) throw new HttpError(404, `There is no holder ${id} in the catalogue.`)
  const given = parseBody(ctx, req.body)
  const rec: Record<string, unknown> = { ...before }
  for (const [c, v] of given) rec[c] = v
  settleClamp(rec, given, before)

  const changed = Object.keys(rec).filter((c) => c !== 'last_checked' && !same(c, rec[c], before[c]))
  if (!changed.length) return requireHolder(ctx, id)
  const catalogueChange = changed.some((c) => c !== 'notes')
  const source = given.get('data_source') as string | null | undefined
  if (catalogueChange && !source)
    throw new HttpError(
      400,
      'Data source is required for catalogue changes: say where the new values came from (maker page URL, catalogue and page no.). Only notes can be changed without one.',
    )
  if (catalogueChange) rec.last_checked = today()
  if (changed.includes('manufacturer_id') || changed.includes('order_no'))
    assertUniqueIdentity(ctx, rec.manufacturer_id as number, rec.order_no as string, id)

  const makerName = (mid: unknown) => ctx.db.value<string>(`SELECT name FROM manufacturers WHERE manufacturer_id = ?`, [mid as number])
  const sets = catalogueChange ? [...changed, 'last_checked'] : changed
  return ctx.db.tx(() => {
    ctx.db.run(`UPDATE holders SET ${sets.map((c) => `${c} = ?`).join(', ')} WHERE holder_id = ?`, [
      ...sets.map((c) => rec[c] as string | number | null),
      id,
    ])
    for (const c of changed) {
      const isMaker = c === 'manufacturer_id'
      logChange(ctx.db, {
        holder_id: id,
        field: isMaker ? 'manufacturer' : c,
        old_value: isMaker ? makerName(before[c]) : before[c],
        new_value: isMaker ? makerName(rec[c]) : rec[c],
        source: 'manual',
        reference: source ?? null,
        by_user: user,
      })
    }
    return requireHolder(ctx, id)
  })
}
