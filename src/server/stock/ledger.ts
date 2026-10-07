/**
 * Stock rules on top of domain.postTransaction: counts, moves, receipts/returns/scrap, and the
 * ledger read side. Every change is a stock_transactions row with date, person and reference —
 * the audit trail AS9100 auditors ask for. Nothing here ever updates or deletes a transaction.
 */
import type { Db, Row } from '../db.js'
import { HttpError } from '../http.js'
import { TXN_TYPES, UNASSIGNED_LOCATION, postTransaction, qtyAt, today, unassignedLocationId, nowStamp, type TxnType } from '../domain.js'

/** Note on the COUNT_ADJUST that clears the opening balance when a holder is first counted. */
export const SUPERSEDE_NOTE = 'opening balance superseded by physical count'
/** Note on a count that matched the books (a recorded confirmation, delta 0). */
export const CONFIRM_NOTE = 'count confirmed, no change'

/** Largest quantity accepted in one booking — a typo guard, not a business limit. */
export const MAX_QTY = 9999

export interface LocationRow {
  location_id: number
  name: string
  kind: string | null
  counts_as_on_site: number
}

export function getLocation(db: Db, id: number): LocationRow {
  const l = db.get<LocationRow>(`SELECT location_id, name, kind, counts_as_on_site FROM locations WHERE location_id = ?`, [id])
  if (!l) throw new HttpError(404, `Location ${id} does not exist — reload the page to see the current locations.`)
  return l
}

export function requireHolder(db: Db, holderId: string): void {
  if (!db.value(`SELECT 1 FROM holders WHERE holder_id = ?`, [holderId]))
    throw new HttpError(404, `No holder ${holderId} in the catalogue — reload the page and pick it again.`)
}

export const isUnassigned = (l: LocationRow) => l.name === UNASSIGNED_LOCATION

export function defaultCountReference(location: LocationRow, date = today()): string {
  return `COUNT ${date} ${location.name}`
}

// ---------------------------------------------------------------- ledger read side

const TXN_SELECT = `
SELECT t.txn_id, t.txn_date, t.created_at, t.holder_id, m.name AS manufacturer, h.order_no, h.spec_code, h.series,
       t.location_id, l.name AS location, l.kind AS location_kind, l.counts_as_on_site,
       t.txn_type, t.qty_delta, t.reference, t.by_user, t.note
FROM stock_transactions t
JOIN holders h ON h.holder_id = t.holder_id
JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
JOIN locations l ON l.location_id = t.location_id`

export function txnsByIds(db: Db, ids: number[]): Row[] {
  if (!ids.length) return []
  return db.all(`${TXN_SELECT} WHERE t.txn_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.txn_id`, ids)
}

export interface TxnFilter {
  holder_id?: string | null
  location_id?: number | null
  types?: TxnType[]
  since?: string | null
  until?: string | null
  user?: string | null
  q?: string | null
  limit: number
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export function isoDate(v: unknown, name: string): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00'))) throw new HttpError(400, `${name} must be a date written YYYY-MM-DD`)
  return s
}

export function parseTypes(v: string | null): TxnType[] {
  if (!v) return []
  const out: TxnType[] = []
  for (const part of v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    if (!(TXN_TYPES as readonly string[]).includes(part)) throw new HttpError(400, `Unknown transaction type ${part} — use one of ${TXN_TYPES.join(', ')}`)
    out.push(part as TxnType)
  }
  return out
}

/** Ledger rows, newest first (by business date, then the order they were written). */
export function listTxns(db: Db, f: TxnFilter): Row[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (f.holder_id) {
    where.push('t.holder_id = ?')
    params.push(f.holder_id)
  }
  if (f.location_id != null) {
    where.push('t.location_id = ?')
    params.push(f.location_id)
  }
  if (f.types?.length) {
    where.push(`t.txn_type IN (${f.types.map(() => '?').join(',')})`)
    params.push(...f.types)
  }
  if (f.since) {
    where.push('t.txn_date >= ?')
    params.push(f.since)
  }
  if (f.until) {
    where.push('t.txn_date <= ?')
    params.push(f.until)
  }
  if (f.user) {
    where.push(`LOWER(COALESCE(t.by_user,'')) LIKE ? ESCAPE '\\'`)
    params.push(`%${likeEscape(f.user.toLowerCase())}%`)
  }
  for (const term of (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
    where.push(
      `LOWER(t.holder_id || ' ' || m.name || ' ' || h.order_no || ' ' || COALESCE(h.spec_code,'') || ' ' || COALESCE(h.series,'') || ' ' ||
             COALESCE(t.reference,'') || ' ' || COALESCE(t.note,'')) LIKE ? ESCAPE '\\'`,
    )
    params.push(`%${likeEscape(term)}%`)
  }
  return db.all(`${TXN_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT ?`, [
    ...params,
    f.limit,
  ])
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

// ---------------------------------------------------------------- writes

export interface CountInput {
  holder_id: string
  location_id: number
  counted_qty: number
  reference?: string | null
  note?: string | null
  user: string
}
export interface CountResult {
  posted: number[]
  previous_qty: number
  counted_qty: number
  reference: string
  /** True when the same count was already recorded today and nothing new was posted. */
  duplicate: boolean
}

/**
 * Books a physical count: the counted quantity is absolute, the ledger gets the difference.
 * See docs/API.md POST /api/counts for the rules (first count supersedes the opening balance,
 * zero delta is a recorded confirmation, retry-safe for the same reference on the same day).
 */
export function postCount(db: Db, c: CountInput): CountResult {
  requireHolder(db, c.holder_id)
  const loc = getLocation(db, c.location_id)
  const reference = c.reference || defaultCountReference(loc)
  return db.tx(() => {
    const date = today()
    const previous = qtyAt(db, c.holder_id, loc.location_id)
    const delta = c.counted_qty - previous
    const result: CountResult = { posted: [], previous_qty: previous, counted_qty: c.counted_qty, reference, duplicate: false }
    if (delta === 0) {
      const already = db.value(
        `SELECT 1 FROM stock_transactions WHERE holder_id = ? AND location_id = ? AND txn_type = 'COUNT_ADJUST'
           AND reference = ? AND txn_date = ? AND COALESCE(note,'') <> ?`,
        [c.holder_id, loc.location_id, reference, date, SUPERSEDE_NOTE],
      )
      // A retried request (double-tap, network resend) must not book the confirmation twice.
      if (already) return { ...result, duplicate: true }
    }
    const firstCount = !db.value(`SELECT 1 FROM stock_transactions WHERE holder_id = ? AND txn_type = 'COUNT_ADJUST'`, [c.holder_id])
    const note = delta === 0 ? (c.note ? `${CONFIRM_NOTE} — ${c.note}` : CONFIRM_NOTE) : (c.note ?? null)
    result.posted.push(
      postTransaction(db, {
        holder_id: c.holder_id,
        location_id: loc.location_id,
        qty_delta: delta,
        txn_type: 'COUNT_ADJUST',
        reference,
        txn_date: date,
        by_user: c.user,
        note,
      }),
    )
    if (firstCount && !isUnassigned(loc)) {
      // The opening balance was only "it exists in hyperMILL"; once someone has physically
      // counted the holder, that unverified quantity must not be added on top.
      const unassigned = unassignedLocationId(db)
      const open = unassigned != null ? qtyAt(db, c.holder_id, unassigned) : 0
      if (unassigned != null && open !== 0) {
        result.posted.push(
          postTransaction(db, {
            holder_id: c.holder_id,
            location_id: unassigned,
            qty_delta: -open,
            txn_type: 'COUNT_ADJUST',
            reference,
            txn_date: date,
            by_user: c.user,
            note: SUPERSEDE_NOTE,
          }),
        )
      }
    }
    return result
  })
}

export interface MoveInput {
  holder_id: string
  from_location_id: number
  to_location_id: number
  qty: number
  reference?: string | null
  note?: string | null
  user: string
}

/** MOVE_OUT at `from` and MOVE_IN at `to` in one transaction, sharing one reference. */
export function postMove(db: Db, m: MoveInput): { posted: number[]; reference: string } {
  requireHolder(db, m.holder_id)
  const from = getLocation(db, m.from_location_id)
  const to = getLocation(db, m.to_location_id)
  if (from.location_id === to.location_id) throw new HttpError(400, 'Choose two different locations to move between.')
  if (isUnassigned(to))
    throw new HttpError(400, `Move it to a real location — "${UNASSIGNED_LOCATION}" only holds opening balances waiting for a count.`)
  // A generated reference still pairs the two rows when the person gives none.
  const reference = m.reference || `MOVE ${nowStamp()}`
  return db.tx(() => {
    const there = qtyAt(db, m.holder_id, from.location_id)
    if (m.qty > there)
      throw new HttpError(
        409,
        there > 0
          ? `Only ${there} booked at ${from.name} — you can't move ${m.qty}. If the books are wrong, count ${from.name} first.`
          : `Nothing of this holder is booked at ${from.name}. If it is there, count it first.`,
      )
    const date = today()
    const base = { holder_id: m.holder_id, reference, txn_date: date, by_user: m.user, note: m.note ?? null }
    const out = postTransaction(db, { ...base, location_id: from.location_id, qty_delta: -m.qty, txn_type: 'MOVE_OUT' })
    const inn = postTransaction(db, { ...base, location_id: to.location_id, qty_delta: m.qty, txn_type: 'MOVE_IN' })
    return { posted: [out, inn], reference }
  })
}

export const BOOKING_TYPES = ['RECEIPT', 'SCRAP', 'RETURN'] as const
export type BookingType = (typeof BOOKING_TYPES)[number]

export interface BookingInput {
  holder_id: string
  location_id: number
  txn_type: BookingType
  qty: number
  reference?: string | null
  note?: string | null
  txn_date?: string | null
  user: string
}

/** Receipt / return (+qty) or scrap (−qty) at one location. Returns warnings that don't block. */
export function postBooking(db: Db, b: BookingInput): { posted: number[]; warnings: string[] } {
  requireHolder(db, b.holder_id)
  const loc = getLocation(db, b.location_id)
  const warnings: string[] = []
  if (b.txn_type !== 'SCRAP' && isUnassigned(loc))
    throw new HttpError(400, `Book it to a real location (e.g. Tool crib) — "${UNASSIGNED_LOCATION}" only holds opening balances waiting for a count.`)
  if (b.txn_type === 'SCRAP' && !b.reference)
    throw new HttpError(400, 'Enter the NCR no. as the reference — scrapping a holder needs its non-conformance report for the audit trail.')
  if (b.txn_type === 'RECEIPT' && !b.reference)
    warnings.push('Booked without a PO number — receipts should carry the purchase order number so the holder can be traced to its order.')
  return db.tx(() => {
    if (b.txn_type === 'SCRAP') {
      const there = qtyAt(db, b.holder_id, loc.location_id)
      if (b.qty > there)
        throw new HttpError(
          409,
          there > 0
            ? `Only ${there} booked at ${loc.name} — you can't scrap ${b.qty}. If the books are wrong, count ${loc.name} first.`
            : `Nothing of this holder is booked at ${loc.name}, so there is nothing to scrap there.`,
        )
    }
    const id = postTransaction(db, {
      holder_id: b.holder_id,
      location_id: loc.location_id,
      qty_delta: b.txn_type === 'SCRAP' ? -b.qty : b.qty,
      txn_type: b.txn_type,
      reference: b.reference ?? null,
      txn_date: b.txn_date || today(),
      by_user: b.user,
      note: b.note ?? null,
    })
    return { posted: [id], warnings }
  })
}
