/**
 * Shared data rules. Every module goes through these so the rules in BUILD_SPEC §3 live in one place:
 *  - stock is the SUM of stock_transactions (never a column on holders)
 *  - on-site = locations with counts_as_on_site = 1
 *  - "fits a Ø d shank" = clamp_min_mm <= d <= clamp_max_mm
 *  - every catalogue change is logged with its source (holder_changes)
 */
import type { Db } from './db.js'
import { HttpError } from './http.js'

export const TXN_TYPES = ['OPENING_BALANCE', 'COUNT_ADJUST', 'RECEIPT', 'MOVE_OUT', 'MOVE_IN', 'SCRAP', 'RETURN'] as const
export type TxnType = (typeof TXN_TYPES)[number]
export const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW', 'INFO'] as const
export type Severity = (typeof SEVERITIES)[number]
export const DATA_STATUSES = ['verified', 'partial', 'distributor_only', 'catalogue_pdf', 'unverified'] as const
export type DataStatus = (typeof DATA_STATUSES)[number]

/** Name of the holding location every opening balance is booked to. */
export const UNASSIGNED_LOCATION = 'Unassigned – count required'

const pad = (n: number) => String(n).padStart(2, '0')
/** Local calendar date, YYYY-MM-DD (the shop's day, not UTC). */
export function today(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** Local timestamp, YYYY-MM-DD HH:MM:SS. */
export function nowStamp(d = new Date()): string {
  return `${today(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Quantity on site for one holder (sum over locations that count as on site). */
export function qtyOnSite(db: Db, holderId: string): number {
  return Number(
    db.value(
      `SELECT COALESCE(SUM(t.qty_delta),0) FROM stock_transactions t JOIN locations l USING (location_id)
       WHERE t.holder_id = ? AND l.counts_as_on_site = 1`,
      [holderId],
    ) ?? 0,
  )
}

/** Quantity of one holder at one location. */
export function qtyAt(db: Db, holderId: string, locationId: number): number {
  return Number(
    db.value(`SELECT COALESCE(SUM(qty_delta),0) FROM stock_transactions WHERE holder_id = ? AND location_id = ?`, [
      holderId,
      locationId,
    ]) ?? 0,
  )
}

export function unassignedLocationId(db: Db): number | undefined {
  return db.value<number>(`SELECT location_id FROM locations WHERE name = ?`, [UNASSIGNED_LOCATION])
}

export type CountStatus = 'counted' | 'unverified' | 'booked' | 'none'
export function countStatus(db: Db, holderId: string): CountStatus {
  return (db.value<string>(`SELECT count_status FROM v_count_status WHERE holder_id = ?`, [holderId]) ?? 'none') as CountStatus
}

export interface TxnInput {
  holder_id: string
  location_id: number
  qty_delta: number
  txn_type: TxnType
  reference?: string | null
  txn_date?: string | null
  by_user?: string | null
  note?: string | null
}

/** The only way stock changes. Validates and inserts one stock_transactions row. */
export function postTransaction(db: Db, t: TxnInput): number {
  if (!TXN_TYPES.includes(t.txn_type)) throw new HttpError(400, `Unknown transaction type ${t.txn_type}`)
  if (!Number.isInteger(t.qty_delta)) throw new HttpError(400, 'qty_delta must be a whole number')
  if (!db.value(`SELECT 1 FROM holders WHERE holder_id = ?`, [t.holder_id])) throw new HttpError(404, `No holder ${t.holder_id}`)
  if (!db.value(`SELECT 1 FROM locations WHERE location_id = ?`, [t.location_id]))
    throw new HttpError(404, `No location ${t.location_id}`)
  const r = db.run(
    `INSERT INTO stock_transactions(holder_id, location_id, qty_delta, txn_type, reference, txn_date, by_user, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [t.holder_id, t.location_id, t.qty_delta, t.txn_type, t.reference ?? null, t.txn_date || today(), t.by_user ?? null, t.note ?? null, nowStamp()],
  )
  return r.lastInsertRowid
}

/** Next free internal id, H0001 style. */
export function nextHolderId(db: Db): string {
  const max = db.value<number>(`SELECT MAX(CAST(SUBSTR(holder_id, 2) AS INTEGER)) FROM holders WHERE holder_id GLOB 'H[0-9]*'`) ?? 0
  return `H${String(Number(max) + 1).padStart(4, '0')}`
}

export interface ChangeInput {
  holder_id: string
  field: string
  old_value: unknown
  new_value: unknown
  source: string
  reference?: string | null
  by_user?: string | null
}
const asText = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))
export function logChange(db: Db, c: ChangeInput): void {
  db.run(
    `INSERT INTO holder_changes(holder_id, field, old_value, new_value, source, reference, by_user, changed_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [c.holder_id, c.field, asText(c.old_value), asText(c.new_value), c.source, c.reference ?? null, c.by_user ?? null, nowStamp()],
  )
}

export interface FlagInput {
  holder_id?: string | null
  severity: Severity
  category: string
  message: string
  action?: string | null
  raised_by?: string | null
  source?: string | null
}
/**
 * Raises a data flag. With `dedupe` (default) an OPEN flag with the same holder, category and
 * message is reused instead of duplicated — re-running an import must not pile up flags.
 * Returns the flag id and whether it was newly created.
 */
export function raiseFlag(db: Db, f: FlagInput, dedupe = true): { flag_id: number; created: boolean } {
  if (!SEVERITIES.includes(f.severity)) throw new HttpError(400, `Unknown severity ${f.severity}`)
  if (!f.message?.trim()) throw new HttpError(400, 'A flag needs a message')
  if (dedupe) {
    const existing = db.value<number>(
      `SELECT flag_id FROM data_flags WHERE status = 'OPEN' AND COALESCE(holder_id,'') = COALESCE(?, '')
       AND COALESCE(category,'') = COALESCE(?, '') AND message = ?`,
      [f.holder_id ?? null, f.category ?? null, f.message],
    )
    if (existing) return { flag_id: Number(existing), created: false }
  }
  const r = db.run(
    `INSERT INTO data_flags(holder_id, severity, category, message, action, status, raised_on, raised_by, source)
     VALUES (?,?,?,?,?,'OPEN',?,?,?)`,
    [f.holder_id ?? null, f.severity, f.category, f.message.trim(), f.action ?? null, today(), f.raised_by ?? null, f.source ?? null],
  )
  return { flag_id: r.lastInsertRowid, created: true }
}

export interface EventInput {
  entity: 'location' | 'wishlist' | 'unit'
  entity_id: string | number
  action: 'ADD' | 'EDIT' | 'DELETE' | 'STATUS' | 'INSPECT' | 'NOTE'
  detail?: Record<string, unknown>
  by_user: string
}
/** Append-only record of changes outside the stock ledger and the catalogue (audit_events). */
export function logEvent(db: Db, e: EventInput): void {
  db.run(`INSERT INTO audit_events(entity, entity_id, action, detail_json, by_user, at) VALUES (?,?,?,?,?,?)`, [
    e.entity,
    String(e.entity_id),
    e.action,
    e.detail ? JSON.stringify(e.detail) : null,
    e.by_user,
    nowStamp(),
  ])
}

/** The numbers in the header strip (also the tally's summary). */
export function getSummary(db: Db) {
  const site = db.get<{ holders: number; articles: number }>(
    `SELECT COALESCE(SUM(qty_on_site),0) AS holders, COUNT(CASE WHEN qty_on_site > 0 THEN 1 END) AS articles FROM v_stock_on_hand`,
  )!
  const cs = db.get<{ counted: number; to_count: number; counted_of_opening: number }>(
    `SELECT COUNT(CASE WHEN count_status='counted' THEN 1 END) AS counted,
            COUNT(CASE WHEN has_opening = 1 THEN 1 END) AS to_count,
            COUNT(CASE WHEN has_opening = 1 AND has_count = 1 THEN 1 END) AS counted_of_opening
     FROM v_count_status`,
  )!
  const fl = db.get<{ open: number; high: number; info: number }>(
    `SELECT COUNT(CASE WHEN severity <> 'INFO' THEN 1 END) AS open, COUNT(CASE WHEN severity='HIGH' THEN 1 END) AS high,
            COUNT(CASE WHEN severity='INFO' THEN 1 END) AS info
     FROM data_flags WHERE status = 'OPEN'`,
  )!
  return {
    holders_on_site: Number(site.holders),
    articles_on_site: Number(site.articles),
    articles_in_catalogue: Number(db.value(`SELECT COUNT(*) FROM holders`)),
    counted: Number(cs.counted),
    to_count: Number(cs.to_count),
    counted_of_opening: Number(cs.counted_of_opening),
    open_flags: Number(fl.open),
    open_high: Number(fl.high),
    open_info: Number(fl.info),
  }
}

/** Reads a JSON value from app_settings. */
export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const v = db.value<string>(`SELECT value FROM app_settings WHERE key = ?`, [key])
  if (v == null) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
export function setSetting(db: Db, key: string, value: unknown): void {
  db.run(`INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    key,
    JSON.stringify(value),
  ])
}

/** Requires a person's name on every write (AS9100 traceability). */
export function requireUser(user: string | null | undefined): string {
  const u = (user ?? '').trim()
  if (!u) throw new HttpError(400, 'Enter your name (top right) before booking anything — every change is recorded against a person.')
  if (u.length > 80) throw new HttpError(400, 'Name is too long')
  return u
}
