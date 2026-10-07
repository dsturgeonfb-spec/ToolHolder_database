/**
 * Want list (wishlist) and RFQ export. Routes and shapes: docs/API.md "Want list / RFQ".
 *
 * A want-list line is "we would like N of this holder, because …". It moves OPEN → QUOTED → ORDERED →
 * RECEIVED (steps may be skipped), or is CANCELLED. Lines are never deleted: the list doubles as the
 * purchasing record. Only one OPEN line per holder — adding the same holder again tops that line up,
 * so the RFQ never asks a maker twice for one article.
 *
 * Nothing here touches stock. Marking a line RECEIVED is purchasing bookkeeping; the holders go on the
 * books through a RECEIPT transaction (stock module), which the UI offers at that moment, so stock stays
 * one ledger with a PO reference.
 *
 * The RFQ (CSV, XLSX with one sheet per maker, printable HTML per maker) lists the OPEN lines grouped by
 * maker, with any open 'Purchasing' issues on those holders as notes — e.g. MAPAL listing a second order
 * no. under the same designation, which the maker should confirm before we order.
 */
import type { Router, Req } from '../http.js'
import { Download, HttpError, Reply, int, optStr } from '../http.js'
import type { AppContext } from '../context.js'
import type { Db } from '../db.js'
import { getSetting, requireUser, today } from '../domain.js'
import { toCsv, type Column } from '../lib/csv.js'
import { buildXlsx, XLSX_TYPE, type XlsxColumn, type XlsxSheet } from '../lib/xlsx.js'
import { esc, printPage } from '../lib/html.js'

export const WISH_STATUSES = ['OPEN', 'QUOTED', 'ORDERED', 'RECEIVED', 'CANCELLED'] as const
export type WishStatus = (typeof WISH_STATUSES)[number]
/** Still wanted: counts towards a holder's `on_want_list`. */
export const ACTIVE_STATUSES: WishStatus[] = ['OPEN', 'QUOTED', 'ORDERED']
const CLOSED_STATUSES: WishStatus[] = ['RECEIVED', 'CANCELLED']

const MAX_QTY = 999
const MAX_REASON = 1000
/** Issue category whose open flags are printed on the RFQ as notes for the maker. */
export const PURCHASING_CATEGORY = 'Purchasing'

export interface PurchasingNote {
  flag_id: number
  severity: string
  message: string
  action: string | null
}

export interface WishRow {
  wish_id: number
  holder_id: string
  qty_wanted: number
  reason: string | null
  status: WishStatus
  added_on: string | null
  added_by: string | null
  updated_on: string | null
  manufacturer: string
  is_distributor: number
  order_no: string
  spec_code: string | null
  product_name: string | null
  series: string | null
  type_code: string | null
  type_name: string | null
  interface_code: string | null
  clamp_spec: string | null
  clamp_dia_mm: number | null
  gauge_length_mm: number | null
  nose_dia_mm: number | null
  product_url: string | null
  cam_image: string | null
  qty_on_site: number
  /** Open 'Purchasing' issues on this holder — shown on the line and printed on the RFQ. */
  purchasing_notes: PurchasingNote[]
}

const STATUS_RANK = `CASE w.status WHEN 'OPEN' THEN 0 WHEN 'QUOTED' THEN 1 WHEN 'ORDERED' THEN 2 WHEN 'RECEIVED' THEN 3 ELSE 4 END`

const WISH_SELECT = `
  SELECT w.wish_id, w.holder_id, w.qty_wanted, w.reason, w.status, w.added_on, w.added_by, w.updated_on,
         m.name AS manufacturer, m.is_distributor, h.order_no, h.spec_code, h.product_name, h.series,
         h.type_code, ht.type_name, h.interface_code, h.clamp_spec, h.clamp_dia_mm, h.gauge_length_mm, h.nose_dia_mm,
         h.product_url, h.cam_image, s.qty_on_site
  FROM wishlist w
  JOIN holders h ON h.holder_id = w.holder_id
  JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
  LEFT JOIN holder_types ht ON ht.type_code = h.type_code
  JOIN v_stock_on_hand s ON s.holder_id = w.holder_id`

export interface WishFilter {
  statuses: WishStatus[] | null
  holder_id?: string | null
  maker?: string | null
}

/**
 * Parses a status filter: blank/'all' = every status, 'active' = OPEN+QUOTED+ORDERED, otherwise a
 * comma-separated list of statuses. `fallback` is used when the parameter is absent.
 */
export function parseStatusFilter(raw: string | null, fallback: WishStatus[] | null): WishStatus[] | null {
  if (raw === null) return fallback
  const v = raw.trim().toUpperCase()
  if (!v || v === 'ALL') return null
  if (v === 'ACTIVE') return [...ACTIVE_STATUSES]
  const list = v.split(',').map((s) => s.trim()).filter(Boolean)
  const bad = list.filter((s) => !(WISH_STATUSES as readonly string[]).includes(s))
  if (bad.length) throw new HttpError(400, `Unknown want-list status ${bad.join(', ')} — use ${WISH_STATUSES.join(', ')}, active or all`)
  return [...new Set(list)] as WishStatus[]
}

function purchasingNotes(db: Db, holderIds: string[]): Map<string, PurchasingNote[]> {
  const out = new Map<string, PurchasingNote[]>()
  if (!holderIds.length) return out
  const ids = [...new Set(holderIds)]
  const rows = db.all<PurchasingNote & { holder_id: string }>(
    `SELECT flag_id, holder_id, severity, message, action FROM data_flags
     WHERE status = 'OPEN' AND LOWER(category) = LOWER(?) AND holder_id IN (${ids.map(() => '?').join(',')})
     ORDER BY flag_id`,
    [PURCHASING_CATEGORY, ...ids],
  )
  for (const { holder_id, ...note } of rows) {
    if (!out.has(holder_id)) out.set(holder_id, [])
    out.get(holder_id)!.push(note)
  }
  return out
}

function hydrate(rows: Array<Record<string, unknown>>, notes: Map<string, PurchasingNote[]>): WishRow[] {
  return rows.map((r) => ({
    ...(r as unknown as WishRow),
    qty_wanted: Number(r.qty_wanted),
    qty_on_site: Number(r.qty_on_site ?? 0),
    is_distributor: Number(r.is_distributor ?? 0),
    purchasing_notes: notes.get(String(r.holder_id)) ?? [],
  }))
}

/** Want-list lines, grouped by maker (A→Z), then status (OPEN first), order no., line no. */
export function listWishes(db: Db, f: WishFilter): WishRow[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (f.statuses) {
    where.push(`w.status IN (${f.statuses.map(() => '?').join(',')})`)
    params.push(...f.statuses)
  }
  if (f.holder_id) {
    where.push('w.holder_id = ?')
    params.push(f.holder_id)
  }
  if (f.maker) {
    where.push('m.name = ? COLLATE NOCASE')
    params.push(f.maker)
  }
  const rows = db.all(
    `${WISH_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY m.name COLLATE NOCASE, ${STATUS_RANK}, h.order_no, w.wish_id`,
    params,
  )
  return hydrate(rows, purchasingNotes(db, rows.map((r) => String(r.holder_id))))
}

export function getWish(db: Db, id: number): WishRow {
  const r = db.get(`${WISH_SELECT} WHERE w.wish_id = ?`, [id])
  if (!r) throw new HttpError(404, `There is no want-list line #${id} — reload the Want list.`)
  return hydrate([r], purchasingNotes(db, [String(r.holder_id)]))[0]!
}

function wishId(req: Req): number {
  const id = int(req.params.id, 'Want-list line number')
  if (id < 1) throw new HttpError(400, 'Want-list line number must be a positive whole number')
  return id
}

/** Quantity wanted: a whole number 1–999. */
function parseQty(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  if (String(v ?? '').trim() === '' || !Number.isInteger(n) || n < 1 || n > MAX_QTY)
    throw new HttpError(400, `Quantity wanted must be a whole number from 1 to ${MAX_QTY}.`)
  return n
}

function parseStatus(v: unknown): WishStatus {
  const s = String(v ?? '').trim().toUpperCase()
  if (!(WISH_STATUSES as readonly string[]).includes(s))
    throw new HttpError(400, `Status must be one of ${WISH_STATUSES.join(', ')}.`)
  return s as WishStatus
}

function parseReason(v: unknown): string | null {
  const s = optStr(v, 100_000)
  if (s && s.length > MAX_REASON) throw new HttpError(400, `Reason is too long — keep it under ${MAX_REASON} characters.`)
  return s
}

/** Topping up an open line keeps both reasons (without repeating one that is already there). */
function mergeReason(old: string | null, add: string | null): string | null {
  if (!add) return old
  if (!old) return add
  if (old.split(/;\s*/).some((part) => part.trim().toLowerCase() === add.toLowerCase())) return old
  return `${old}; ${add}`
}

/**
 * Everyone who put quantity on a line, so a topped-up line still says who asked for it.
 * Semicolons, because a name may contain a comma ("Sturgeon, D.").
 */
function mergeNames(old: string | null, user: string): string {
  const names = (old ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  if (!names.some((n) => n.toLowerCase() === user.toLowerCase())) names.push(user)
  return names.join('; ')
}

const has = (b: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined

// ---------------------------------------------------------------- RFQ

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
const description = (r: WishRow) => r.series || r.product_name || ''
const flagNote = (n: PurchasingNote) => [n.message, n.action].filter(Boolean).join(' → ')
/** Notes column of the RFQ: our reason, then any open purchasing questions for the maker. */
export const rfqNotes = (r: WishRow) => [r.reason, ...r.purchasing_notes.map(flagNote)].filter(Boolean).join(' | ')

type Col<T> = XlsxColumn<T> & Column<T>
const RFQ_COLUMNS: Col<WishRow>[] = [
  { header: 'maker', value: (r) => r.manufacturer, width: 12 },
  { header: 'order_no', value: (r) => r.order_no, width: 18 },
  { header: 'designation', value: (r) => r.spec_code, width: 30 },
  { header: 'description', value: (r) => description(r), width: 36 },
  { header: 'interface', value: (r) => r.interface_code, width: 10 },
  { header: 'clamp', value: (r) => r.clamp_spec, width: 24 },
  { header: 'gauge_length_mm', value: (r) => num(r.gauge_length_mm), width: 10 },
  { header: 'qty', value: (r) => r.qty_wanted, width: 6 },
  { header: 'notes', value: (r) => rfqNotes(r), width: 60 },
  { header: 'maker_url', value: (r) => r.product_url, width: 44 },
  { header: 'line_status', value: (r) => r.status, width: 10 },
  { header: 'want_line', value: (r) => r.wish_id, width: 9 },
  { header: 'holder_id', value: (r) => r.holder_id, width: 9 },
  { header: 'added_on', value: (r) => r.added_on, width: 11 },
  { header: 'added_by', value: (r) => r.added_by, width: 16 },
]

function rfqRows(db: Db, q: URLSearchParams): WishRow[] {
  return listWishes(db, {
    // The RFQ is for what has not been asked for yet: OPEN lines, unless the caller says otherwise.
    statuses: parseStatusFilter(q.get('status'), ['OPEN']),
    maker: (q.get('maker') ?? '').trim() || null,
  })
}

function byMaker(rows: WishRow[]): Map<string, WishRow[]> {
  const out = new Map<string, WishRow[]>()
  for (const r of rows) {
    if (!out.has(r.manufacturer)) out.set(r.manufacturer, [])
    out.get(r.manufacturer)!.push(r)
  }
  return out
}

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'all'
const stamp = () => today().replace(/-/g, '')
export const rfqRef = (maker: string) => `RFQ-${stamp()}-${fileSafe(maker).toUpperCase()}`
const ukDate = (d: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (d ?? '')
}
const mmText = (v: number | null) => (v == null ? '' : String(Math.round(Number(v) * 10) / 10))

function rfqHtml(db: Db, rows: WishRow[], makerFilter: string | null): string {
  const groups = byMaker(rows)
  const contactEmail = getSetting<string>(db, 'vendor_contact', '')
  const fill = (wide = false) => `<span class="rfq-fill${wide ? ' wide' : ''}"></span>`
  const section = (maker: string, list: WishRow[], first: boolean) => {
    const holders = list.reduce((n, r) => n + r.qty_wanted, 0)
    const ifaces = [...new Set(list.map((r) => r.interface_code).filter(Boolean))].join(', ')
    const body = list
      .map((r, i) => {
        const notes = [
          r.reason ? `<div>${esc(r.reason)}</div>` : '',
          ...r.purchasing_notes.map((n) => `<div class="rfq-q"><b>Please confirm:</b> ${esc(n.message)}${n.action ? ` <span class="muted">(${esc(n.action)})</span>` : ''}</div>`),
        ].join('')
        return `<tr>
          <td class="n">${i + 1}</td>
          <td class="mono"><b>${esc(r.order_no)}</b></td>
          <td class="mono">${esc(r.spec_code ?? '')}</td>
          <td>${esc(description(r))}</td>
          <td>${esc(r.clamp_spec ?? '')}</td>
          <td class="n">${esc(mmText(r.gauge_length_mm))}</td>
          <td class="n"><b>${esc(r.qty_wanted)}</b></td>
          <td>${notes}</td>
          <td class="mono rfq-url">${r.product_url ? esc(r.product_url) : ''}</td>
          <td class="box"></td><td class="box"></td>
        </tr>`
      })
      .join('')
    return `<section class="rfq${first ? '' : ' rfq-break'}" data-maker="${esc(maker)}">
      ${makerFilter ? '' : `<h2>${esc(maker)}</h2>`}
      <table class="rfq-head"><tr>
        <td><b>From</b><br>${fill(true)} <span class="muted">(company name)</span><br>
          Contact ${fill()} Tel. ${fill()}<br>E-mail ${contactEmail ? `<span class="mono">${esc(contactEmail)}</span>` : fill(true)}</td>
        <td><b>To</b><br>${esc(maker)} — sales / quotations<br>
          RFQ ref. <span class="mono"><b>${esc(rfqRef(maker))}</b></span><br>Date ${esc(ukDate(today()))}${ifaces ? `<br>Tool holders, ${esc(ifaces)}` : ''}</td>
      </tr></table>
      <p>Please quote for the following ${list.length} line${list.length === 1 ? '' : 's'} (${holders} holder${holders === 1 ? '' : 's'} in total).</p>
      <table>
        <thead><tr><th class="n">#</th><th>Order no.</th><th>Designation</th><th>Description</th><th>Clamp</th><th class="n">GL mm</th>
          <th class="n">Qty</th><th>Notes</th><th>Maker page</th><th>Unit price</th><th>Lead time</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="rfq-foot">
        <p><b>For each line please state:</b> unit price and currency, delivery lead time, and confirm that the order no. above is the
        current one for this designation — tell us if it has been superseded or if you would supply a different article.
        Lines marked “Please confirm” have a specific question. Quote reference <b class="mono">${esc(rfqRef(maker))}</b> on your reply.</p>
        <p class="muted">GL = gauge length from the HSK gauge line (flange face) to the holder nose, as in your catalogue.</p>
      </div>
      <div class="sign"><span>Requested by</span><span>Date</span></div>
    </section>`
  }
  const sections = [...groups.entries()].map(([maker, list], i) => section(maker, list, i === 0)).join('')
  const extraCss = `<style>
    .rfq-head{margin:0 0 10px} .rfq-head td{width:50%;border:1px solid #C9D2DA;line-height:1.9}
    .rfq-fill{display:inline-block;min-width:38mm;border-bottom:1px solid #15202A;height:1em;vertical-align:baseline}
    .rfq-fill.wide{min-width:70mm}
    .rfq-url{font-size:8pt;word-break:break-all;max-width:48mm}
    .rfq-q{margin-top:3px}
    .rfq-foot{margin-top:12px;font-size:10pt}
    .rfq-break{page-break-before:always;break-before:page}
  </style>`
  const empty = `<p>There are no ${makerFilter ? `open lines for ${esc(makerFilter)}` : 'open lines'} on the want list — nothing to ask a maker for.
    Add holders on the Want list (or Catalogue → Can buy → Want) first.</p>`
  const title = makerFilter ? `Request for quotation — ${groups.keys().next().value ?? makerFilter}` : 'Request for quotation'
  return printPage(title, extraCss + (rows.length ? sections : empty), {
    subtitle: makerFilter ? undefined : `${groups.size} maker${groups.size === 1 ? '' : 's'} · one page per maker · ${ukDate(today())}`,
    landscape: true,
  })
}

// ---------------------------------------------------------------- routes

export function register(r: Router, ctx: AppContext): void {
  const db = ctx.db

  r.get('/api/wishlist', (req) =>
    listWishes(db, {
      statuses: parseStatusFilter(req.query.get('status'), null),
      holder_id: (req.query.get('holder_id') ?? '').trim() || null,
      maker: (req.query.get('maker') ?? req.query.get('mk') ?? '').trim() || null,
    }),
  )

  r.post('/api/wishlist', (req) => {
    const user = requireUser(req.user)
    const b = req.body ?? {}
    const holderId = String(b.holder_id ?? '').trim()
    if (!holderId) throw new HttpError(400, 'Choose the holder to add to the want list.')
    if (!db.value(`SELECT 1 FROM holders WHERE holder_id = ?`, [holderId]))
      throw new HttpError(404, `There is no holder ${holderId} in the catalogue — pick it from the search list.`)
    // Absent means one (the schema default); anything given must be a sensible quantity.
    const qty = b.qty_wanted === undefined || b.qty_wanted === null ? 1 : parseQty(b.qty_wanted)
    const reason = parseReason(b.reason)
    return db.tx(() => {
      const open = db.get<{ wish_id: number; qty_wanted: number; reason: string | null; added_by: string | null }>(
        `SELECT wish_id, qty_wanted, reason, added_by FROM wishlist WHERE holder_id = ? AND status = 'OPEN' ORDER BY wish_id LIMIT 1`,
        [holderId],
      )
      if (open) {
        const total = Number(open.qty_wanted) + qty
        if (total > MAX_QTY) throw new HttpError(400, `That would make ${total} wanted on one line — the most is ${MAX_QTY}.`)
        db.run(`UPDATE wishlist SET qty_wanted = ?, reason = ?, added_by = ?, updated_on = ? WHERE wish_id = ?`, [
          total,
          mergeReason(open.reason, reason),
          mergeNames(open.added_by, user),
          today(),
          open.wish_id,
        ])
        return new Reply(200, { ...getWish(db, open.wish_id), merged: true, added_qty: qty })
      }
      const res = db.run(
        `INSERT INTO wishlist(holder_id, qty_wanted, reason, added_on, status, added_by, updated_on) VALUES (?, ?, ?, ?, 'OPEN', ?, NULL)`,
        [holderId, qty, reason, today(), user],
      )
      return new Reply(201, { ...getWish(db, res.lastInsertRowid), merged: false, added_qty: qty })
    })
  })

  r.patch('/api/wishlist/:id', (req) => {
    requireUser(req.user)
    const id = wishId(req)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!has(b, 'qty_wanted') && !has(b, 'reason') && !has(b, 'status'))
      throw new HttpError(400, 'Nothing to change — send qty_wanted, reason or status.')
    const qty = has(b, 'qty_wanted') ? parseQty(b.qty_wanted) : null
    const reason = has(b, 'reason') ? parseReason(b.reason) : undefined
    const status = has(b, 'status') ? parseStatus(b.status) : null
    return db.tx(() => {
      const cur = getWish(db, id)
      const next = status ?? cur.status
      if (status === 'OPEN' && cur.status !== 'OPEN') {
        const other = db.value<number>(`SELECT wish_id FROM wishlist WHERE holder_id = ? AND status = 'OPEN' AND wish_id <> ?`, [cur.holder_id, id])
        if (other)
          throw new HttpError(409, `${cur.manufacturer} ${cur.order_no} already has an open want-list line (#${other}) — change the quantity on that line instead.`)
      }
      if (qty !== null && qty !== cur.qty_wanted && CLOSED_STATUSES.includes(next))
        throw new HttpError(409, `Line #${id} is ${next} — its quantity is part of the purchasing record and can't change. Add a new line for more.`)
      const changed: Record<string, string | number | null> = {}
      if (qty !== null && qty !== cur.qty_wanted) changed.qty_wanted = qty
      if (reason !== undefined && reason !== cur.reason) changed.reason = reason
      if (status && status !== cur.status) changed.status = status
      const sets = Object.keys(changed).map((k) => `${k} = ?`)
      const params = Object.values(changed)
      if (!sets.length) return cur
      db.run(`UPDATE wishlist SET ${sets.join(', ')}, updated_on = ? WHERE wish_id = ?`, [...params, today(), id])
      return getWish(db, id)
    })
  })

  // "Delete" cancels: the line stays as part of the purchasing record.
  r.delete('/api/wishlist/:id', (req) => {
    requireUser(req.user)
    const id = wishId(req)
    return db.tx(() => {
      const cur = getWish(db, id)
      if (cur.status === 'CANCELLED') return cur
      if (cur.status === 'RECEIVED')
        throw new HttpError(409, `Line #${id} was already received — it can't be cancelled. If holders went back to the maker, book that in the stock ledger.`)
      db.run(`UPDATE wishlist SET status = 'CANCELLED', updated_on = ? WHERE wish_id = ?`, [today(), id])
      return getWish(db, id)
    })
  })

  r.get('/api/export/rfq.csv', (req) => {
    const rows = rfqRows(db, req.query)
    const maker = (req.query.get('maker') ?? '').trim()
    return new Download(`rfq_${maker ? fileSafe(maker) + '_' : ''}${today()}.csv`, 'text/csv; charset=utf-8', toCsv(rows, RFQ_COLUMNS))
  })

  r.get('/api/export/rfq.xlsx', (req) => {
    const rows = rfqRows(db, req.query)
    const maker = (req.query.get('maker') ?? '').trim()
    const sheets: XlsxSheet<WishRow>[] = [...byMaker(rows).entries()].map(([name, list]) => ({ name, columns: RFQ_COLUMNS, rows: list }))
    // A workbook needs at least one sheet; an empty RFQ still opens and shows the columns.
    if (!sheets.length) sheets.push({ name: 'RFQ', columns: RFQ_COLUMNS, rows: [] })
    return new Download(`rfq_${maker ? fileSafe(maker) + '_' : ''}${today()}.xlsx`, XLSX_TYPE, buildXlsx(sheets))
  })

  r.get('/api/export/rfq.html', (req) => {
    const rows = rfqRows(db, req.query)
    const maker = (req.query.get('maker') ?? '').trim() || null
    return new Download(`${maker ? rfqRef(maker) : `rfq_${today()}`}.html`, 'text/html; charset=utf-8', rfqHtml(db, rows, maker), 'inline')
  })
}
