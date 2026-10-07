/**
 * Stock: locations, the transaction ledger, receipts/returns/scrap, moves, physical counts,
 * count mode's step-through list and the printable count sheet. Routes as in docs/API.md.
 *
 * Stock is only ever SUM(stock_transactions.qty_delta); the rules live in ../stock/ledger.ts and
 * go through domain.postTransaction. Every write needs the person booking it.
 */
import type { Router, Req } from '../http.js'
import { Download, HttpError, int, optStr, str } from '../http.js'
import type { AppContext } from '../context.js'
import { UNASSIGNED_LOCATION, logEvent, requireUser, today } from '../domain.js'
import { toCsv } from '../lib/csv.js'
import { holderById, holderRows } from '../stock/holders.js'
import {
  BOOKING_TYPES,
  MAX_QTY,
  getLocation,
  isUnassigned,
  isoDate,
  listTxns,
  parseTypes,
  postBooking,
  postCount,
  postMove,
  txnsByIds,
  type BookingType,
  type TxnFilter,
} from '../stock/ledger.js'
import { countList, countSheetHtml, parseScope } from '../stock/counting.js'

const LOCATION_KINDS = ['crib', 'machine', 'external', 'holding'] as const

const optInt = (v: unknown, name: string): number | null => (v === null || v === undefined || String(v).trim() === '' ? null : int(v, name))

function qty(v: unknown, name = 'Quantity'): number {
  if (v === null || v === undefined || String(v).trim() === '') throw new HttpError(400, `${name} is required`)
  const n = int(v, name)
  if (n < 1) throw new HttpError(400, `${name} must be at least 1`)
  if (n > MAX_QTY) throw new HttpError(400, `${name} must be ${MAX_QTY} or less — check for a typo`)
  return n
}

function holderIdOf(v: unknown): string {
  return str(v, 'holder_id', 40)
}

function locationRows(ctx: AppContext) {
  return ctx.db
    .all<{ location_id: number; name: string; kind: string | null; counts_as_on_site: number; articles: number; holders: number; txns: number; units: number }>(
      `SELECT l.location_id, l.name, l.kind, l.counts_as_on_site,
              COALESCE(v.articles, 0) AS articles, COALESCE(v.holders, 0) AS holders,
              (SELECT COUNT(*) FROM stock_transactions t WHERE t.location_id = l.location_id) AS txns,
              (SELECT COUNT(*) FROM holder_units u WHERE u.location_id = l.location_id) AS units
       FROM locations l LEFT JOIN v_tally_by_location v ON v.location_id = l.location_id
       ORDER BY l.location_id`,
    )
    .map((r) => {
      const unassigned = r.name === UNASSIGNED_LOCATION
      return {
        ...r,
        location_id: Number(r.location_id),
        counts_as_on_site: Number(r.counts_as_on_site),
        articles: Number(r.articles),
        holders: Number(r.holders),
        txns: Number(r.txns),
        units: Number(r.units),
        is_unassigned: unassigned,
        can_delete: !unassigned && Number(r.txns) === 0 && Number(r.units) === 0,
      }
    })
}
const locationRow = (ctx: AppContext, id: number) => locationRows(ctx).find((l) => l.location_id === id)!

function locationName(v: unknown): string {
  const name = str(v, 'Location name', 60).replace(/\s+/g, ' ')
  if (/[\u0000-\u001f]/.test(name)) throw new HttpError(400, 'Location name contains characters that are not allowed')
  return name
}
function locationKind(v: unknown): string {
  const k = String(v ?? '').trim()
  if (!(LOCATION_KINDS as readonly string[]).includes(k)) throw new HttpError(400, `Kind must be one of: ${LOCATION_KINDS.join(', ')}`)
  return k
}
function assertNameFree(ctx: AppContext, name: string, exceptId?: number) {
  const clash = ctx.db.get<{ location_id: number; name: string }>(`SELECT location_id, name FROM locations WHERE LOWER(name) = LOWER(?)`, [name])
  if (clash && clash.location_id !== exceptId) throw new HttpError(409, `A location called "${clash.name}" already exists — pick another name.`)
}

function txnFilter(q: URLSearchParams, defLimit: number, maxLimit: number): TxnFilter {
  const limit = optInt(q.get('limit'), 'limit') ?? defLimit
  if (limit < 1 || limit > maxLimit) throw new HttpError(400, `limit must be between 1 and ${maxLimit}`)
  const since = isoDate(q.get('since'), 'since')
  const until = isoDate(q.get('until'), 'until')
  if (since && until && since > until) throw new HttpError(400, 'The "from" date is after the "to" date')
  return {
    holder_id: optStr(q.get('holder_id'), 40),
    location_id: optInt(q.get('location_id'), 'location_id'),
    types: parseTypes(q.get('type')),
    since,
    until,
    user: optStr(q.get('user'), 80),
    q: optStr(q.get('q'), 200),
    limit,
  }
}

/** What a stock write returns: the holder as it is now, the rows posted, and any warnings. */
function writeResult(ctx: AppContext, holderId: string, posted: number[], extra: Record<string, unknown> = {}) {
  return { holder: holderById(ctx, holderId), posted: txnsByIds(ctx.db, posted), ...extra }
}

export function register(r: Router, ctx: AppContext): void {
  const db = ctx.db

  // ------------------------------------------------------------ locations
  r.get('/api/locations', () => locationRows(ctx))

  r.post('/api/locations', (req) => {
    const user = requireUser(req.user)
    const b = req.body ?? {}
    const name = locationName(b.name)
    const kind = b.kind === undefined || b.kind === null || b.kind === '' ? 'crib' : locationKind(b.kind)
    // Somewhere off site (vendor, regrind) doesn't count in the site tally unless the person says so.
    const onSite = b.counts_as_on_site === undefined || b.counts_as_on_site === null ? kind !== 'external' : !!b.counts_as_on_site
    assertNameFree(ctx, name)
    const id = db.tx(() => {
      const newId = db.run(`INSERT INTO locations(name, kind, counts_as_on_site) VALUES (?,?,?)`, [name, kind, onSite]).lastInsertRowid
      logEvent(db, { entity: 'location', entity_id: newId, action: 'ADD', detail: { name, kind, counts_as_on_site: onSite }, by_user: user })
      return newId
    })
    ctx.log('info', `Location added by ${user}: "${name}" (${kind}, ${onSite ? 'counts' : 'does not count'} as on site)`)
    return locationRow(ctx, id)
  })

  r.patch('/api/locations/:id', (req) => {
    const user = requireUser(req.user)
    const id = int(req.params.id, 'Location id')
    const loc = getLocation(db, id)
    const b = req.body ?? {}
    const changes: string[] = []
    const set: Record<string, string | number> = {}
    if (b.name !== undefined) {
      const name = locationName(b.name)
      if (name !== loc.name) {
        if (isUnassigned(loc))
          throw new HttpError(400, `"${UNASSIGNED_LOCATION}" is built in: it holds opening balances waiting for a count, so it keeps its name.`)
        assertNameFree(ctx, name, id)
        set.name = name
        changes.push(`renamed "${loc.name}" → "${name}"`)
      }
    }
    if (b.kind !== undefined) {
      const kind = locationKind(b.kind)
      if (kind !== loc.kind) {
        set.kind = kind
        changes.push(`kind ${loc.kind ?? '–'} → ${kind}`)
      }
    }
    if (b.counts_as_on_site !== undefined && b.counts_as_on_site !== null) {
      const on = b.counts_as_on_site ? 1 : 0
      if (on !== Number(loc.counts_as_on_site)) {
        if (isUnassigned(loc) && !on)
          throw new HttpError(400, `"${UNASSIGNED_LOCATION}" always counts as on site — it holds the holders not yet counted, which are on site somewhere.`)
        set.counts_as_on_site = on
        changes.push(on ? 'now counts as on site' : 'no longer counts as on site')
      }
    }
    if (Object.keys(set).length) {
      db.tx(() => {
        db.run(`UPDATE locations SET ${Object.keys(set).map((k) => `${k} = :${k}`).join(', ')} WHERE location_id = :id`, { ...set, id })
        logEvent(db, { entity: 'location', entity_id: id, action: 'EDIT', detail: { name: loc.name, changes }, by_user: user })
      })
      ctx.log('info', `Location ${id} changed by ${user}: ${changes.join('; ')}`)
    }
    return locationRow(ctx, id)
  })

  r.delete('/api/locations/:id', (req) => {
    const user = requireUser(req.user)
    const id = int(req.params.id, 'Location id')
    const loc = getLocation(db, id)
    if (isUnassigned(loc)) throw new HttpError(400, `"${UNASSIGNED_LOCATION}" is built in and can't be deleted.`)
    const txns = Number(db.value(`SELECT COUNT(*) FROM stock_transactions WHERE location_id = ?`, [id]))
    if (txns)
      throw new HttpError(
        409,
        `${loc.name} has ${txns} booking${txns === 1 ? '' : 's'} in the stock ledger, so it can't be deleted — the audit trail needs it. Rename it instead, or move its stock out and stop using it.`,
      )
    const units = Number(db.value(`SELECT COUNT(*) FROM holder_units WHERE location_id = ?`, [id]))
    if (units) throw new HttpError(409, `${units} serialised unit${units === 1 ? ' is' : 's are'} recorded at ${loc.name} — move ${units === 1 ? 'it' : 'them'} first.`)
    db.tx(() => {
      db.run(`DELETE FROM locations WHERE location_id = ?`, [id])
      logEvent(db, { entity: 'location', entity_id: id, action: 'DELETE', detail: { name: loc.name }, by_user: user })
    })
    ctx.log('info', `Location deleted by ${user}: "${loc.name}" (never used)`)
    return { deleted: id }
  })

  // ------------------------------------------------------------ stock on hand
  r.get('/api/stock', (req) => {
    const locId = optInt(req.query.get('location_id'), 'location_id')
    const holderId = optStr(req.query.get('holder_id'), 40)
    if (locId != null) getLocation(db, locId)
    const where: string[] = []
    const params: Array<string | number> = []
    if (locId != null) {
      where.push('t.location_id = ?')
      params.push(locId)
    }
    if (holderId) {
      where.push('t.holder_id = ?')
      params.push(holderId)
    }
    const qtys = db.all<{ holder_id: string; location_id: number; location: string; kind: string; counts_as_on_site: number; qty: number }>(
      `SELECT t.holder_id, t.location_id, l.name AS location, l.kind, l.counts_as_on_site, SUM(t.qty_delta) AS qty
       FROM stock_transactions t JOIN locations l ON l.location_id = t.location_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY t.holder_id, t.location_id HAVING SUM(t.qty_delta) <> 0 ORDER BY t.location_id`,
      params,
    )
    const qtyByHolder = new Map<string, typeof qtys>()
    for (const q of qtys) qtyByHolder.set(q.holder_id, [...(qtyByHolder.get(q.holder_id) ?? []), q])
    const out = []
    for (const h of holderRows(ctx, holderId ? 'h.holder_id = ?' : '', holderId ? [holderId] : [])) {
      for (const q of qtyByHolder.get(h.holder_id) ?? [])
        out.push({
          ...h,
          location_id: Number(q.location_id),
          location: q.location,
          location_kind: q.kind,
          counts_as_on_site: Number(q.counts_as_on_site),
          qty_at_location: Number(q.qty),
        })
    }
    return out
  })

  // ------------------------------------------------------------ ledger
  r.get('/api/transactions', (req) => listTxns(db, txnFilter(req.query, 500, 5000)))

  r.get('/api/export/transactions.csv', (req) => {
    const rows = listTxns(db, txnFilter(req.query, 100_000, 100_000))
    const csv = toCsv(rows, [
      { header: 'txn_id', value: (t) => t.txn_id },
      { header: 'txn_date', value: (t) => t.txn_date },
      { header: 'written_at', value: (t) => t.created_at },
      { header: 'holder_id', value: (t) => t.holder_id },
      { header: 'manufacturer', value: (t) => t.manufacturer },
      { header: 'order_no', value: (t) => t.order_no },
      { header: 'location', value: (t) => t.location },
      { header: 'counts_as_on_site', value: (t) => t.counts_as_on_site },
      { header: 'txn_type', value: (t) => t.txn_type },
      { header: 'qty_delta', value: (t) => t.qty_delta },
      { header: 'reference', value: (t) => t.reference },
      { header: 'by_user', value: (t) => t.by_user },
      { header: 'note', value: (t) => t.note },
    ])
    return new Download(`stock-ledger-${today()}.csv`, 'text/csv; charset=utf-8', csv)
  })

  // ------------------------------------------------------------ bookings
  r.post('/api/transactions', (req: Req) => {
    const user = requireUser(req.user)
    const b = req.body ?? {}
    const type = String(b.txn_type ?? '').trim().toUpperCase()
    if (!(BOOKING_TYPES as readonly string[]).includes(type))
      throw new HttpError(
        400,
        type === 'COUNT_ADJUST' || type === 'OPENING_BALANCE'
          ? 'Counts are booked through Count mode (POST /api/counts), not as a single transaction.'
          : type === 'MOVE_IN' || type === 'MOVE_OUT'
            ? 'Moves are booked as a pair through POST /api/moves.'
            : `txn_type must be one of ${BOOKING_TYPES.join(', ')}`,
      )
    const txnDate = isoDate(b.txn_date, 'Date')
    if (txnDate && txnDate > today()) throw new HttpError(400, "The date can't be in the future.")
    if (txnDate && txnDate < '2000-01-01') throw new HttpError(400, 'Check the date — it is before 2000.')
    const holderId = holderIdOf(b.holder_id)
    const res = postBooking(db, {
      holder_id: holderId,
      location_id: int(b.location_id, 'location_id'),
      txn_type: type as BookingType,
      qty: qty(b.qty),
      reference: optStr(b.reference, 120),
      note: optStr(b.note, 1000),
      txn_date: txnDate,
      user,
    })
    return writeResult(ctx, holderId, res.posted, { warnings: res.warnings })
  })

  r.post('/api/moves', (req) => {
    const user = requireUser(req.user)
    const b = req.body ?? {}
    const holderId = holderIdOf(b.holder_id)
    const res = postMove(db, {
      holder_id: holderId,
      from_location_id: int(b.from_location_id, 'from_location_id'),
      to_location_id: int(b.to_location_id, 'to_location_id'),
      qty: qty(b.qty),
      reference: optStr(b.reference, 120),
      note: optStr(b.note, 1000),
      user,
    })
    return writeResult(ctx, holderId, res.posted, { reference: res.reference, warnings: [] })
  })

  // ------------------------------------------------------------ counts
  r.post('/api/counts', (req) => {
    const user = requireUser(req.user)
    const b = req.body ?? {}
    const holderId = holderIdOf(b.holder_id)
    if (b.counted_qty === undefined || b.counted_qty === null || String(b.counted_qty).trim() === '')
      throw new HttpError(400, 'counted_qty is required — enter the number you counted (0 if there are none).')
    const counted = int(b.counted_qty, 'counted_qty')
    if (counted < 0) throw new HttpError(400, "A count can't be negative — enter 0 if there are none.")
    if (counted > MAX_QTY) throw new HttpError(400, `A count above ${MAX_QTY} looks like a typo — check the number.`)
    const res = postCount(db, {
      holder_id: holderId,
      location_id: int(b.location_id, 'location_id'),
      counted_qty: counted,
      reference: optStr(b.reference, 120),
      note: optStr(b.note, 1000),
      user,
    })
    return writeResult(ctx, holderId, res.posted, {
      previous_qty: res.previous_qty,
      counted_qty: res.counted_qty,
      reference: res.reference,
      duplicate: res.duplicate,
    })
  })

  r.get('/api/count/list', (req) => {
    const locId = optInt(req.query.get('location_id'), 'location_id')
    if (locId == null) throw new HttpError(400, 'Choose the location you are counting (location_id).')
    const { location, holders } = countList(ctx, {
      location_id: locId,
      scope: parseScope(req.query.get('scope')),
      type: optStr(req.query.get('type'), 40),
      mk: optStr(req.query.get('mk'), 80),
    })
    return {
      location: { ...location, counts_as_on_site: Number(location.counts_as_on_site), is_unassigned: isUnassigned(location) },
      date: today(),
      holders,
      counted_today: holders.filter((h) => h.counted_here_today).length,
    }
  })

  r.get('/api/export/count-sheet', (req) => {
    const locId = optInt(req.query.get('location_id'), 'location_id')
    if (locId == null) throw new HttpError(400, 'Choose the location for the count sheet (location_id).')
    const html = countSheetHtml(ctx, {
      location_id: locId,
      scope: req.query.get('scope') ? parseScope(req.query.get('scope')) : null,
      type: optStr(req.query.get('type'), 40),
      mk: optStr(req.query.get('mk'), 80),
      reference: optStr(req.query.get('reference'), 120),
      user: req.user,
    })
    return new Download(`count-sheet-${locId}-${today()}.html`, 'text/html; charset=utf-8', html, 'inline')
  })
}
