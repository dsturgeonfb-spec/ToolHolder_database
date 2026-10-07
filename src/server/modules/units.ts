/**
 * Serialised holder units (holder_units). Routes and shapes: docs/API.md "Serialised units".
 *
 * A unit is one physical holder the shop tracks individually — it carries its own balance/runout
 * certificate, presetter ID or RFID chip — identified by the number etched on it (`unit_id`). Units sit
 * on top of the stock ledger: adding, moving or scrapping a unit never changes stock; the UI offers the
 * matching stock booking (e.g. a SCRAP with its NCR) where one is needed, so stock stays one ledger.
 *
 * Inspection: each unit is due `unit_inspection_days` (setting, default 180) after its last inspection.
 * A failed inspection quarantines the unit; any status change needs a note. The table has no history
 * table, so every event (added, edited, inspected, status change, remark) is appended to the unit's
 * `note` as a dated line with the person's name — an append-only log the API never rewrites, which is
 * the record an AS9100 auditor asks for (who checked it, when, what they found).
 */
import type { Router, Req } from '../http.js'
import { Download, HttpError, Reply, optStr } from '../http.js'
import type { AppContext } from '../context.js'
import type { Db } from '../db.js'
import { getSetting, logEvent, qtyOnSite, requireUser, today } from '../domain.js'
import { toCsv, type Column } from '../lib/csv.js'

export const UNIT_STATUSES = ['IN_SERVICE', 'QUARANTINE', 'SCRAPPED'] as const
export type UnitStatus = (typeof UNIT_STATUSES)[number]
/** "Due" = overdue, never inspected, or due within this many days. */
export const DUE_SOON_DAYS = 30
const DEFAULT_INTERVAL = 180
const MAX_UNIT_ID = 40
const MAX_RUNOUT_UM = 1000
const MAX_NOTE = 2000
const MAX_SERIAL = 80

export type DueState = 'overdue' | 'due_soon' | 'ok' | 'never' | null

export interface UnitRow {
  unit_id: string
  holder_id: string
  serial_no: string | null
  location_id: number | null
  location: string | null
  runout_check_um: number | null
  last_inspected: string | null
  inspected_by: string | null
  status: UnitStatus
  /** Append-only log: one dated line per event. */
  note: string | null
  manufacturer: string
  order_no: string
  spec_code: string | null
  series: string | null
  product_name: string | null
  type_code: string | null
  type_name: string | null
  clamp_spec: string | null
  gauge_length_mm: number | null
  /** last_inspected + interval; null when never inspected. */
  next_due: string | null
  /** True when next_due is before today (never for scrapped units). */
  overdue: boolean
  /** overdue | due_soon (within 30 days) | ok | never (not inspected yet) | null (scrapped). */
  due_state: DueState
  /** Days until next_due (negative when overdue); null when there is no due date. */
  days_to_due: number | null
}

const UNIT_SELECT = `
  SELECT u.unit_id, u.holder_id, u.serial_no, u.location_id, l.name AS location, u.runout_check_um,
         u.last_inspected, u.inspected_by, u.status, u.note,
         m.name AS manufacturer, h.order_no, h.spec_code, h.series, h.product_name, h.type_code, ht.type_name,
         h.clamp_spec, h.gauge_length_mm
  FROM holder_units u
  JOIN holders h ON h.holder_id = u.holder_id
  JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
  LEFT JOIN holder_types ht ON ht.type_code = h.type_code
  LEFT JOIN locations l ON l.location_id = u.location_id`

// ---------------------------------------------------------------- dates (local calendar days)

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
function parseIso(s: string): Date | null {
  const m = ISO_DATE.exec(s)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // Rejects 2026-02-31 and the like (Date would roll it into March).
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null
}
export function addDays(iso: string, days: number): string | null {
  const d = parseIso(iso)
  if (!d) return null
  d.setDate(d.getDate() + days)
  return today(d)
}
function daysBetween(fromIso: string, toIso: string): number | null {
  const a = parseIso(fromIso)
  const b = parseIso(toIso)
  if (!a || !b) return null
  // Round: a daylight-saving change makes a "day" 23 or 25 hours.
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

export function inspectionDays(db: Db): number {
  const n = Number(getSetting<number>(db, 'unit_inspection_days', DEFAULT_INTERVAL))
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INTERVAL
}

function hydrate(r: Record<string, unknown>, interval: number, now: string): UnitRow {
  const u = r as unknown as UnitRow
  const last = typeof u.last_inspected === 'string' ? u.last_inspected : null
  const next_due = last ? addDays(last, interval) : null
  const days_to_due = next_due ? daysBetween(now, next_due) : null
  let due_state: DueState = null
  // A quarantined unit isn't "due" on a date — it needs a passing inspection before it goes back into service.
  if (u.status === 'IN_SERVICE') {
    if (!next_due) due_state = 'never'
    else if (days_to_due! < 0) due_state = 'overdue'
    else if (days_to_due! <= DUE_SOON_DAYS) due_state = 'due_soon'
    else due_state = 'ok'
  }
  return {
    ...u,
    runout_check_um: u.runout_check_um == null ? null : Number(u.runout_check_um),
    location_id: u.location_id == null ? null : Number(u.location_id),
    next_due,
    overdue: due_state === 'overdue',
    due_state,
    days_to_due,
  }
}

// ---------------------------------------------------------------- reading

export interface UnitFilter {
  holder_id?: string | null
  statuses?: UnitStatus[] | null
  location_id?: number | null
  /** 'due' = overdue, never inspected or due within 30 days; 'overdue' = overdue only. */
  due?: 'due' | 'overdue' | null
  q?: string | null
}

export function filterFromQuery(q: URLSearchParams): UnitFilter {
  const statusRaw = (q.get('status') ?? '').trim().toUpperCase()
  let statuses: UnitStatus[] | null = null
  if (statusRaw && statusRaw !== 'ALL') {
    if (statusRaw === 'ACTIVE') statuses = ['IN_SERVICE', 'QUARANTINE']
    else {
      const list = statusRaw.split(',').map((s) => s.trim()).filter(Boolean)
      const bad = list.filter((s) => !(UNIT_STATUSES as readonly string[]).includes(s))
      if (bad.length) throw new HttpError(400, `Unknown unit status ${bad.join(', ')} — use IN_SERVICE, QUARANTINE, SCRAPPED, active or all`)
      statuses = list as UnitStatus[]
    }
  }
  const dueRaw = (q.get('due') ?? '').trim().toLowerCase()
  const overdueRaw = (q.get('overdue') ?? '').trim().toLowerCase()
  const truthy = (v: string) => v === '1' || v === 'true' || v === 'yes'
  const due = truthy(overdueRaw) || dueRaw === 'overdue' ? 'overdue' : truthy(dueRaw) ? 'due' : null
  const locRaw = (q.get('location_id') ?? '').trim()
  let location_id: number | null = null
  if (locRaw) {
    location_id = Number(locRaw)
    if (!Number.isInteger(location_id)) throw new HttpError(400, 'location_id must be a whole number')
  }
  return { holder_id: (q.get('holder_id') ?? '').trim() || null, statuses, location_id, due, q: q.get('q') }
}

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export function listUnits(db: Db, f: UnitFilter): UnitRow[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (f.holder_id) {
    where.push('u.holder_id = ?')
    params.push(f.holder_id)
  }
  if (f.statuses?.length) {
    where.push(`u.status IN (${f.statuses.map(() => '?').join(',')})`)
    params.push(...f.statuses)
  }
  if (f.location_id != null) {
    where.push('u.location_id = ?')
    params.push(f.location_id)
  }
  const interval = inspectionDays(db)
  const now = today()
  let rows = db.all(`${UNIT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params).map((r) => hydrate(r, interval, now))
  if (f.due === 'overdue') rows = rows.filter((u) => u.due_state === 'overdue')
  else if (f.due === 'due') rows = rows.filter((u) => u.due_state === 'overdue' || u.due_state === 'due_soon' || u.due_state === 'never')
  const terms = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length) {
    rows = rows.filter((u) => {
      const hay = [u.unit_id, u.serial_no, u.manufacturer, u.order_no, u.spec_code, u.series, u.clamp_spec, u.location, u.inspected_by, u.holder_id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }
  return rows.sort((a, b) => naturalOrder.compare(a.unit_id, b.unit_id))
}

export function getUnit(db: Db, unitId: string): UnitRow {
  const r = db.get(`${UNIT_SELECT} WHERE u.unit_id = ?`, [unitId])
  if (!r) throw new HttpError(404, `There is no serialised unit "${unitId}" — check the number etched on the holder, or add it first.`)
  return hydrate(r, inspectionDays(db), today())
}

// ---------------------------------------------------------------- validation

function parseUnitId(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ')
  if (!s) throw new HttpError(400, 'Enter the unit id — the number etched on the holder or on its RFID chip.')
  if (s.length > MAX_UNIT_ID) throw new HttpError(400, `Unit id is too long — keep it under ${MAX_UNIT_ID} characters.`)
  if (/[\u0000-\u001f]/.test(s)) throw new HttpError(400, 'Unit id contains characters that are not allowed.')
  return s
}

function parseRunout(v: unknown, required: boolean): number | null {
  if (v === null || v === undefined || String(v).trim() === '') {
    if (required) throw new HttpError(400, 'Enter the measured runout in µm (0 or more).')
    return null
  }
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'))
  if (!Number.isFinite(n)) throw new HttpError(400, 'Runout must be a number of µm, e.g. 3 or 2.5.')
  if (n < 0) throw new HttpError(400, 'Runout can’t be negative — enter the measured TIR in µm.')
  if (n > MAX_RUNOUT_UM) throw new HttpError(400, `Runout of ${n} µm looks wrong — runout is entered in µm (1 mm = 1000 µm).`)
  return Math.round(n * 100) / 100
}

function parseDate(v: unknown, label: string): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (!parseIso(s)) throw new HttpError(400, `${label} must be a date (YYYY-MM-DD).`)
  if (s > today()) throw new HttpError(400, `${label} can’t be in the future.`)
  return s
}

function parseLocation(db: Db, v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  if (!Number.isInteger(n)) throw new HttpError(400, 'Location must be chosen from the list.')
  if (!db.value(`SELECT 1 FROM locations WHERE location_id = ?`, [n])) throw new HttpError(404, `There is no location ${n} — reload and pick one from the list.`)
  return n
}

function requireHolder(db: Db, v: unknown): string {
  const id = String(v ?? '').trim()
  if (!id) throw new HttpError(400, 'Choose the holder this unit is.')
  if (!db.value(`SELECT 1 FROM holders WHERE holder_id = ?`, [id]))
    throw new HttpError(404, `There is no holder ${id} in the catalogue — pick it from the search list.`)
  return id
}

function unitParam(req: Req): string {
  return parseUnitId(req.params.id)
}

const has = (b: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined

// ---------------------------------------------------------------- the unit's log

/** One log line: "2026-10-07 D. Sturgeon: Inspected — runout 3 µm, passed." */
function logLine(user: string, text: string): string {
  return `${today()} ${user}: ${text.replace(/\s*\n\s*/g, ' ').trim()}`
}
function appendLog(db: Db, unitId: string, line: string): void {
  db.run(`UPDATE holder_units SET note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || char(10) || ? END WHERE unit_id = ?`, [
    line,
    line,
    unitId,
  ])
}
const um = (v: number | null) => (v == null ? '—' : `${v} µm`)
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : `"${v}"`)
const STATUS_LABEL: Record<UnitStatus, string> = { IN_SERVICE: 'in service', QUARANTINE: 'quarantine', SCRAPPED: 'scrapped' }

/** More units recorded than the stock ledger has on site usually means a missing receipt or count. */
function stockWarnings(db: Db, holderId: string): string[] {
  const units = Number(db.value(`SELECT COUNT(*) FROM holder_units WHERE holder_id = ? AND status <> 'SCRAPPED'`, [holderId]) ?? 0)
  const onSite = qtyOnSite(db, holderId)
  if (units <= onSite) return []
  const h = db.get<{ manufacturer: string; order_no: string }>(
    `SELECT m.name AS manufacturer, h.order_no FROM holders h JOIN manufacturers m USING (manufacturer_id) WHERE h.holder_id = ?`,
    [holderId],
  )!
  return [
    `${units} unit${units === 1 ? '' : 's'} of ${h.manufacturer} ${h.order_no} recorded, but the stock ledger has ${onSite} on site — book a receipt or count it so stock matches.`,
  ]
}

const UNIT_COLUMNS: Column<UnitRow>[] = [
  { header: 'unit_id', value: (u) => u.unit_id },
  { header: 'holder_id', value: (u) => u.holder_id },
  { header: 'manufacturer', value: (u) => u.manufacturer },
  { header: 'order_no', value: (u) => u.order_no },
  { header: 'designation', value: (u) => u.spec_code },
  { header: 'description', value: (u) => u.series || u.product_name },
  { header: 'serial_no', value: (u) => u.serial_no },
  { header: 'location', value: (u) => u.location },
  { header: 'runout_um', value: (u) => u.runout_check_um },
  { header: 'last_inspected', value: (u) => u.last_inspected },
  { header: 'inspected_by', value: (u) => u.inspected_by },
  { header: 'next_due', value: (u) => u.next_due },
  { header: 'overdue', value: (u) => (u.overdue ? 'yes' : '') },
  { header: 'status', value: (u) => u.status },
  { header: 'log', value: (u) => u.note },
]

// ---------------------------------------------------------------- routes

export function register(r: Router, ctx: AppContext): void {
  const db = ctx.db

  r.get('/api/units', (req) => listUnits(db, filterFromQuery(req.query)))

  r.get('/api/units/:id', (req) => getUnit(db, unitParam(req)))

  r.post('/api/units', (req) => {
    const user = requireUser(req.user)
    const b = (req.body ?? {}) as Record<string, unknown>
    const unitId = parseUnitId(b.unit_id)
    const holderId = requireHolder(db, b.holder_id)
    const serial = optStr(b.serial_no, MAX_SERIAL, "Maker's serial no.")
    const locationId = parseLocation(db, b.location_id)
    const runout = parseRunout(b.runout_check_um, false)
    const lastInspected = parseDate(b.last_inspected, 'Last inspected')
    const note = optStr(b.note, MAX_NOTE, 'Note')
    return db.tx(() => {
      // Case-insensitive: "u-12" and "U-12" etched on two holders would be the same number to a person.
      const clash = db.get<{ unit_id: string; manufacturer: string; order_no: string }>(
        `SELECT u.unit_id, m.name AS manufacturer, h.order_no FROM holder_units u JOIN holders h USING (holder_id)
         JOIN manufacturers m USING (manufacturer_id) WHERE u.unit_id = ? COLLATE NOCASE`,
        [unitId],
      )
      if (clash)
        throw new HttpError(409, `Unit id ${clash.unit_id} is already used (${clash.manufacturer} ${clash.order_no}). Each etched/RFID number must be unique — check the number on the holder.`)
      const facts = [
        serial ? `serial no. ${serial}` : '',
        runout != null ? `runout ${um(runout)}` : '',
        lastInspected ? `last inspected ${lastInspected}` : '',
      ].filter(Boolean)
      const line = logLine(user, `Added${facts.length ? ` (${facts.join(', ')})` : ''}.${note ? ` ${note}` : ''}`)
      db.run(
        `INSERT INTO holder_units(unit_id, holder_id, location_id, serial_no, runout_check_um, last_inspected, status, note, inspected_by)
         VALUES (?, ?, ?, ?, ?, ?, 'IN_SERVICE', ?, ?)`,
        // Whoever enters an inspection date vouches for it, so they are recorded as the inspector.
        [unitId, holderId, locationId, serial, runout, lastInspected, line, lastInspected ? user : null],
      )
      logEvent(db, {
        entity: 'unit',
        entity_id: unitId,
        action: 'ADD',
        detail: { holder_id: holderId, serial_no: serial, location_id: locationId, runout_check_um: runout, last_inspected: lastInspected, note },
        by_user: user,
      })
      return new Reply(201, { ...getUnit(db, unitId), warnings: stockWarnings(db, holderId) })
    })
  })

  r.patch('/api/units/:id', (req) => {
    const user = requireUser(req.user)
    const id = unitParam(req)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (has(b, 'status')) throw new HttpError(400, 'Change the status with "Change status" — a status change needs a note saying why.')
    return db.tx(() => {
      const cur = getUnit(db, id)
      if (has(b, 'unit_id') && parseUnitId(b.unit_id) !== cur.unit_id)
        throw new HttpError(400, 'The unit id is the number etched on the holder and can’t be changed. If it was entered wrongly, scrap this record with a note and add the unit again.')
      const sets: string[] = []
      const params: Array<string | number | null> = []
      const changes: string[] = []
      if (has(b, 'holder_id')) {
        const holderId = requireHolder(db, b.holder_id)
        if (holderId !== cur.holder_id) {
          const h = db.get<{ manufacturer: string; order_no: string }>(
            `SELECT m.name AS manufacturer, h.order_no FROM holders h JOIN manufacturers m USING (manufacturer_id) WHERE h.holder_id = ?`,
            [holderId],
          )!
          sets.push('holder_id = ?')
          params.push(holderId)
          changes.push(`holder ${cur.manufacturer} ${cur.order_no} → ${h.manufacturer} ${h.order_no}`)
        }
      }
      if (has(b, 'serial_no')) {
        const serial = optStr(b.serial_no, MAX_SERIAL, "Maker's serial no.")
        if (serial !== cur.serial_no) {
          sets.push('serial_no = ?')
          params.push(serial)
          changes.push(`serial no. ${show(cur.serial_no)} → ${show(serial)}`)
        }
      }
      if (has(b, 'location_id')) {
        const loc = parseLocation(db, b.location_id)
        if (loc !== cur.location_id) {
          const name = loc == null ? null : db.value<string>(`SELECT name FROM locations WHERE location_id = ?`, [loc])
          sets.push('location_id = ?')
          params.push(loc)
          changes.push(`location ${cur.location ?? '—'} → ${name ?? '—'}`)
        }
      }
      if (has(b, 'runout_check_um')) {
        const runout = parseRunout(b.runout_check_um, false)
        if (runout !== cur.runout_check_um) {
          sets.push('runout_check_um = ?')
          params.push(runout)
          changes.push(`runout ${um(cur.runout_check_um)} → ${um(runout)}`)
        }
      }
      if (has(b, 'last_inspected')) {
        const last = parseDate(b.last_inspected, 'Last inspected')
        if (last !== cur.last_inspected) {
          sets.push('last_inspected = ?', 'inspected_by = ?')
          params.push(last, last ? user : null)
          changes.push(`last inspected ${cur.last_inspected ?? '—'} → ${last ?? '—'}`)
        }
      }
      const remark = has(b, 'note') ? optStr(b.note, MAX_NOTE, 'Note') : null
      if (!sets.length && !remark) return cur
      if (sets.length) db.run(`UPDATE holder_units SET ${sets.join(', ')} WHERE unit_id = ?`, [...params, id])
      // A note sent with an edit is a remark added to the log — the log itself is never rewritten.
      const text = [changes.length ? `Edited: ${changes.join('; ')}.` : '', remark ? `Note: ${remark}` : ''].filter(Boolean).join(' ')
      appendLog(db, id, logLine(user, text))
      logEvent(db, { entity: 'unit', entity_id: id, action: sets.length ? 'EDIT' : 'NOTE', detail: { changes, note: remark }, by_user: user })
      const out = getUnit(db, id)
      return has(b, 'holder_id') ? { ...out, warnings: stockWarnings(db, out.holder_id) } : out
    })
  })

  r.post('/api/units/:id/inspect', (req) => {
    const user = requireUser(req.user)
    const id = unitParam(req)
    const b = (req.body ?? {}) as Record<string, unknown>
    const runout = parseRunout(b.runout_check_um, true)!
    if (typeof b.passed !== 'boolean') throw new HttpError(400, 'Say whether the unit passed the inspection (passed: true or false).')
    const passed = b.passed
    const note = optStr(b.note, MAX_NOTE, 'Note')
    if (!passed && !note) throw new HttpError(400, 'Say what failed (note) — it is the reason the unit goes into quarantine.')
    return db.tx(() => {
      const cur = getUnit(db, id)
      if (cur.status === 'SCRAPPED') throw new HttpError(409, `Unit ${cur.unit_id} is scrapped — a scrapped holder can't be inspected back into use.`)
      const quarantine = !passed && cur.status !== 'QUARANTINE'
      db.run(`UPDATE holder_units SET runout_check_um = ?, last_inspected = ?, inspected_by = ?, status = ? WHERE unit_id = ?`, [
        runout,
        today(),
        user,
        passed ? cur.status : 'QUARANTINE',
        id,
      ])
      const result = passed ? 'passed' : quarantine ? 'FAILED — quarantined' : 'FAILED — stays in quarantine'
      appendLog(db, id, logLine(user, `Inspected: runout ${um(runout)}, ${result}.${note ? ` ${note}` : ''}`))
      // The inspection as a quality record: measured value, result, status before/after, who, when.
      logEvent(db, {
        entity: 'unit',
        entity_id: id,
        action: 'INSPECT',
        detail: { holder_id: cur.holder_id, runout_check_um: runout, passed, status_before: cur.status, status_after: passed ? cur.status : 'QUARANTINE', note },
        by_user: user,
      })
      return { ...getUnit(db, id), passed, status_changed: quarantine }
    })
  })

  r.post('/api/units/:id/status', (req) => {
    const user = requireUser(req.user)
    const id = unitParam(req)
    const b = (req.body ?? {}) as Record<string, unknown>
    const status = String(b.status ?? '').trim().toUpperCase()
    if (!(UNIT_STATUSES as readonly string[]).includes(status))
      throw new HttpError(400, 'Status must be IN_SERVICE, QUARANTINE or SCRAPPED.')
    const note = optStr(b.note, MAX_NOTE, 'Note')
    if (!note) throw new HttpError(400, 'A status change needs a note — say why (e.g. "re-ground taper, runout 2 µm", or the NCR no.).')
    return db.tx(() => {
      const cur = getUnit(db, id)
      if (cur.status === status) throw new HttpError(409, `Unit ${cur.unit_id} is already ${STATUS_LABEL[status as UnitStatus]}.`)
      db.run(`UPDATE holder_units SET status = ? WHERE unit_id = ?`, [status, id])
      appendLog(db, id, logLine(user, `Status ${STATUS_LABEL[cur.status]} → ${STATUS_LABEL[status as UnitStatus]}: ${note}`))
      logEvent(db, { entity: 'unit', entity_id: id, action: 'STATUS', detail: { holder_id: cur.holder_id, from: cur.status, to: status, note }, by_user: user })
      return getUnit(db, id)
    })
  })

  r.get('/api/export/units.csv', (req) => {
    const rows = listUnits(db, filterFromQuery(req.query))
    return new Download(`serialised_units_${today()}.csv`, 'text/csv; charset=utf-8', toCsv(rows, UNIT_COLUMNS))
  })
}
