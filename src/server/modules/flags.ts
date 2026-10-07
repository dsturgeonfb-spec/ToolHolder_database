/**
 * Issues (data_flags) and the hyperMILL write-back report.
 *
 * A flag is a question about the data — "hyperMILL says 90GL, Haimer says 80" — that a person
 * answers and closes with what they did. Flags are never deleted: a closed flag is the record
 * that someone checked it (who, when, what was done), which is what an AS9100 auditor asks for.
 * Reopening keeps the earlier closure in the flag's action text for the same reason.
 *
 * The write-back report is the subset a CAM engineer acts on: open flags in the CAM-facing
 * categories, joined to the holder's current hyperMILL name, comment and gauge lengths, as a
 * checklist of edits to make in the hyperMILL tool database. Closing a flag never changes
 * catalogue or CAM data here — the fix is made in hyperMILL and picked up by the next import.
 */
import type { Router, Req } from '../http.js'
import { Download, HttpError, Reply, int, optStr, str } from '../http.js'
import type { AppContext } from '../context.js'
import type { Db } from '../db.js'
import { SEVERITIES, type Severity, raiseFlag, requireUser, today } from '../domain.js'
import { toCsv, type Column } from '../lib/csv.js'
import { esc, printPage } from '../lib/html.js'

/** Categories whose fixes are made in the hyperMILL tool database (matched case-insensitively). */
export const CAM_CATEGORIES = ['CAM model', 'Naming', 'Gauge length', 'hyperMILL'] as const
/** Categories offered when raising a flag even before any flag uses them. */
const STANDARD_CATEGORIES = [...CAM_CATEGORIES, 'Data source', 'Purchasing']

const MAX_CATEGORY = 60
const MAX_TEXT = 2000

export interface FlagRow {
  flag_id: number
  holder_id: string | null
  severity: Severity
  category: string | null
  message: string
  action: string | null
  status: 'OPEN' | 'CLOSED'
  raised_on: string | null
  raised_by: string | null
  source: string | null
  closed_on: string | null
  closed_by: string | null
  close_note: string | null
  manufacturer: string | null
  order_no: string | null
  spec_code: string | null
  series: string | null
  cam_name: string | null
  cam_comment: string | null
  cam_gl_mm: number | null
  gauge_length_mm: number | null
}

const SEV_RANK = `CASE f.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END`

const FLAG_SELECT = `
  SELECT f.flag_id, f.holder_id, f.severity, f.category, f.message, f.action, f.status,
         f.raised_on, f.raised_by, f.source, f.closed_on, f.closed_by, f.close_note,
         m.name AS manufacturer, h.order_no, h.spec_code, h.series, h.cam_name, h.cam_comment,
         h.cam_gl_mm, h.gauge_length_mm
  FROM data_flags f
  LEFT JOIN holders h ON h.holder_id = f.holder_id
  LEFT JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id`

export interface FlagFilter {
  status?: string | null
  severity?: string | null
  category?: string | null
  holder_id?: string | null
  q?: string | null
}

function filterFromQuery(q: URLSearchParams): FlagFilter {
  return {
    status: q.get('status'),
    severity: q.get('severity'),
    category: q.get('category'),
    holder_id: q.get('holder_id'),
    q: q.get('q'),
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

/** Fields a free-text search looks in. */
const SEARCH_FIELDS = [
  'f.message',
  'f.action',
  'f.category',
  'f.close_note',
  'f.raised_by',
  'f.closed_by',
  'f.source',
  'f.holder_id',
  'm.name',
  'h.order_no',
  'h.spec_code',
  'h.cam_name',
  'h.cam_comment',
]

export function listFlags(db: Db, filter: FlagFilter): FlagRow[] {
  const where: string[] = []
  const params: Array<string | number> = []

  const status = (filter.status ?? '').trim().toUpperCase()
  if (status && status !== 'ALL') {
    if (status !== 'OPEN' && status !== 'CLOSED') throw new HttpError(400, 'status must be OPEN, CLOSED or all')
    where.push('f.status = ?')
    params.push(status)
  }

  const sevs = (filter.severity ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  if (sevs.length) {
    const bad = sevs.filter((s) => !SEVERITIES.includes(s as Severity))
    if (bad.length) throw new HttpError(400, `Unknown severity ${bad.join(', ')} — use HIGH, MEDIUM, LOW or INFO`)
    where.push(`f.severity IN (${sevs.map(() => '?').join(',')})`)
    params.push(...sevs)
  }

  const category = (filter.category ?? '').trim()
  if (category) {
    where.push('LOWER(f.category) = LOWER(?)')
    params.push(category)
  }

  const holderId = (filter.holder_id ?? '').trim()
  if (holderId) {
    where.push('f.holder_id = ?')
    params.push(holderId)
  }

  // Every whitespace-separated term must match somewhere; "#12" finds flag 12.
  for (const term of (filter.q ?? '').trim().split(/\s+/).filter(Boolean)) {
    const idTerm = /^#?(\d+)$/.exec(term)
    const like = `%${likeEscape(term)}%`
    const ors = SEARCH_FIELDS.map((f) => `${f} LIKE ? ESCAPE '\\'`)
    params.push(...SEARCH_FIELDS.map(() => like))
    if (idTerm) {
      ors.push('f.flag_id = ?')
      params.push(Number(idTerm[1]))
    }
    where.push(`(${ors.join(' OR ')})`)
  }

  const sql = `${FLAG_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE f.status WHEN 'OPEN' THEN 0 ELSE 1 END, ${SEV_RANK}, f.flag_id`
  return db.all<FlagRow>(sql, params)
}

export function getFlag(db: Db, id: number): FlagRow {
  const row = db.get<FlagRow>(`${FLAG_SELECT} WHERE f.flag_id = ?`, [id])
  if (!row) throw new HttpError(404, `There is no issue #${id} — it may have been typed wrong. Reload the Issues list.`)
  return row
}

/** Distinct categories in use, A→Z (case-insensitive). */
export function listCategories(db: Db): string[] {
  return db
    .all<{ category: string }>(
      `SELECT DISTINCT category FROM data_flags WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY LOWER(category)`,
    )
    .map((r) => r.category)
}

/**
 * Uses the existing spelling of a category when one matches case-insensitively, so "naming" and
 * "Naming" don't become two filters (and CAM categories always reach the write-back report).
 */
function canonicalCategory(db: Db, typed: string): string {
  const known = [...listCategories(db), ...STANDARD_CATEGORIES]
  return known.find((k) => k.toLowerCase() === typed.toLowerCase()) ?? typed
}

function flagId(req: Req): number {
  const id = int(req.params.id, 'Issue number')
  if (id < 1) throw new HttpError(400, 'Issue number must be a positive whole number')
  return id
}

// ---------------------------------------------------------------- write-back

export interface WritebackItem {
  flag_id: number
  severity: Severity
  category: string
  message: string
  action: string | null
  raised_on: string | null
  raised_by: string | null
  holder_id: string | null
  manufacturer: string | null
  order_no: string | null
  spec_code: string | null
  cam_name: string | null
  cam_comment: string | null
  cam_gl_mm: number | null
  gauge_length_mm: number | null
  /** hyperMILL GL minus maker GL when both are known and differ (the Haimer arbor spigot case). */
  gl_delta_mm: number | null
}

export interface Writeback {
  generated_on: string
  categories: string[]
  count: number
  holders: number
  items: WritebackItem[]
}

export function buildWriteback(db: Db): Writeback {
  const cats = CAM_CATEGORIES.map((c) => c.toLowerCase())
  const items = db.all<WritebackItem>(
    `SELECT f.flag_id, f.severity, f.category, f.message, f.action, f.raised_on, f.raised_by,
            f.holder_id, m.name AS manufacturer, h.order_no, h.spec_code, h.cam_name, h.cam_comment,
            h.cam_gl_mm, h.gauge_length_mm,
            CASE WHEN h.cam_gl_mm IS NOT NULL AND h.gauge_length_mm IS NOT NULL AND h.cam_gl_mm <> h.gauge_length_mm
                 THEN h.cam_gl_mm - h.gauge_length_mm END AS gl_delta_mm
     FROM data_flags f
     LEFT JOIN holders h ON h.holder_id = f.holder_id
     LEFT JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
     WHERE f.status = 'OPEN' AND LOWER(f.category) IN (${cats.map(() => '?').join(',')})
     ORDER BY ${SEV_RANK}, COALESCE(h.cam_name, m.name || ' ' || h.order_no, '~'), f.flag_id`,
    cats,
  )
  return {
    generated_on: today(),
    categories: [...CAM_CATEGORIES],
    count: items.length,
    holders: new Set(items.map((i) => i.holder_id).filter(Boolean)).size,
    items,
  }
}

const num = (v: number | null | undefined) => (v == null ? '' : String(Math.round(Number(v) * 10) / 10))
const holderLabel = (r: { manufacturer: string | null; order_no: string | null; holder_id: string | null }) =>
  r.order_no ? `${r.manufacturer ?? ''} ${r.order_no}`.trim() : r.holder_id ? r.holder_id : 'General (no holder)'
const ukDate = (d: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (d ?? '')
}

const WRITEBACK_COLUMNS: Column<WritebackItem>[] = [
  { header: 'issue_no', value: (r) => r.flag_id },
  { header: 'severity', value: (r) => r.severity },
  { header: 'category', value: (r) => r.category },
  { header: 'holder_id', value: (r) => r.holder_id },
  { header: 'manufacturer', value: (r) => r.manufacturer },
  { header: 'order_no', value: (r) => r.order_no },
  { header: 'spec_code', value: (r) => r.spec_code },
  { header: 'hypermill_name', value: (r) => r.cam_name },
  { header: 'hypermill_comment', value: (r) => r.cam_comment },
  { header: 'hypermill_gl_mm', value: (r) => r.cam_gl_mm },
  { header: 'maker_gl_mm', value: (r) => r.gauge_length_mm },
  { header: 'gl_delta_mm', value: (r) => r.gl_delta_mm },
  { header: 'issue', value: (r) => r.message },
  { header: 'fix_to_make', value: (r) => r.action },
  { header: 'raised_on', value: (r) => r.raised_on },
  // Left blank for the CAM engineer working from the printed / spreadsheet copy.
  { header: 'done_by', value: () => '' },
  { header: 'done_on', value: () => '' },
]

function writebackHtml(wb: Writeback): string {
  const rows = wb.items
    .map((r) => {
      const gl =
        r.cam_gl_mm != null || r.gauge_length_mm != null
          ? `${esc(num(r.cam_gl_mm) || '–')} / ${esc(num(r.gauge_length_mm) || '–')}${r.gl_delta_mm != null ? `<br><b>Δ ${r.gl_delta_mm > 0 ? '+' : ''}${esc(num(r.gl_delta_mm))}</b>` : ''}`
          : '–'
      return `<tr>
        <td class="box"></td>
        <td class="mono">#${esc(r.flag_id)}<br>${esc(r.severity)}</td>
        <td><b>${esc(holderLabel(r))}</b><br><span class="muted">${esc(r.category)}</span></td>
        <td><span class="mono">${esc(r.cam_name ?? '—')}</span><br><span class="muted">${esc(r.cam_comment ?? '(no comment)')}</span></td>
        <td class="n mono">${gl}</td>
        <td>${esc(r.message)}</td>
        <td>${esc(r.action ?? '').replace(/\n/g, '<br>')}</td>
        <td class="box"></td>
      </tr>`
    })
    .join('')
  const body = wb.items.length
    ? `<table>
        <thead><tr><th>Done</th><th>Issue</th><th>Holder</th><th>Current hyperMILL name / comment</th>
          <th class="n">GL hM / maker (mm)</th><th>What is wrong</th><th>Fix to make in hyperMILL</th><th>Initials / date</th></tr></thead>
        <tbody>${rows}</tbody></table>`
    : `<p>No open CAM-facing issues — nothing to change in hyperMILL.</p>`
  return printPage('hyperMILL write-back', `${body}
    <p class="muted" style="margin-top:12px">Categories included: ${wb.categories.map(esc).join(', ')}. GL = gauge length from the HSK gauge line (flange face);
    "hM" is the value in the hyperMILL holder, "maker" the value from the maker's page or catalogue.
    After making a fix, close the issue in Holder Catalogue (Issues → hyperMILL write-back → Mark fixed) so it is recorded who made it and what was changed.</p>
    <div class="sign"><span>Changes made by</span><span>Date</span><span>Checked by</span></div>`, {
    subtitle: `Generated ${ukDate(wb.generated_on)} · ${wb.count} open fix${wb.count === 1 ? '' : 'es'} on ${wb.holders} holder${wb.holders === 1 ? '' : 's'}`,
    landscape: true,
  })
}

const FLAG_COLUMNS: Column<FlagRow>[] = [
  { header: 'issue_no', value: (r) => r.flag_id },
  { header: 'status', value: (r) => r.status },
  { header: 'severity', value: (r) => r.severity },
  { header: 'category', value: (r) => r.category },
  { header: 'holder_id', value: (r) => r.holder_id },
  { header: 'manufacturer', value: (r) => r.manufacturer },
  { header: 'order_no', value: (r) => r.order_no },
  { header: 'hypermill_name', value: (r) => r.cam_name },
  { header: 'message', value: (r) => r.message },
  { header: 'action', value: (r) => r.action },
  { header: 'raised_on', value: (r) => r.raised_on },
  { header: 'raised_by', value: (r) => r.raised_by },
  { header: 'source', value: (r) => r.source },
  { header: 'closed_on', value: (r) => r.closed_on },
  { header: 'closed_by', value: (r) => r.closed_by },
  { header: 'close_note', value: (r) => r.close_note },
]

// ---------------------------------------------------------------- routes

export function register(r: Router, ctx: AppContext): void {
  const db = ctx.db

  r.get('/api/flags', (req) => listFlags(db, filterFromQuery(req.query)))

  // Registered before /api/flags/:id so "categories" is not read as an id.
  r.get('/api/flags/categories', () => listCategories(db))

  r.get('/api/flags/:id', (req) => getFlag(db, flagId(req)))

  r.post('/api/flags', (req) => {
    const user = requireUser(req.user)
    const b = req.body ?? {}
    const severity = String(b.severity ?? '').trim().toUpperCase()
    if (!severity) throw new HttpError(400, 'Choose a severity: HIGH, MEDIUM, LOW or INFO')
    if (!SEVERITIES.includes(severity as Severity)) throw new HttpError(400, `Unknown severity ${severity} — use HIGH, MEDIUM, LOW or INFO`)
    const category = canonicalCategory(db, str(b.category, 'Category', MAX_CATEGORY))
    const message = str(b.message, 'What is wrong (message)', MAX_TEXT)
    const action = optStr(b.action, MAX_TEXT)
    const holderId = optStr(b.holder_id, 40)
    if (holderId && !db.value(`SELECT 1 FROM holders WHERE holder_id = ?`, [holderId]))
      throw new HttpError(404, `There is no holder ${holderId} — pick the holder from the search list, or raise a general issue.`)
    const res = db.tx(() =>
      raiseFlag(db, { holder_id: holderId, severity: severity as Severity, category, message, action, raised_by: user, source: 'manual' }),
    )
    const flag = { ...getFlag(db, res.flag_id), created: res.created }
    // 201 for a new flag; 200 when an identical open flag already existed and was returned instead.
    return new Reply(res.created ? 201 : 200, flag)
  })

  r.post('/api/flags/:id/close', (req) => {
    const user = requireUser(req.user)
    const id = flagId(req)
    const note = str(req.body?.note, 'What was done (close note)', MAX_TEXT)
    return db.tx(() => {
      const f = getFlag(db, id)
      if (f.status === 'CLOSED')
        throw new HttpError(409, `Issue #${id} was already closed on ${ukDate(f.closed_on)} by ${f.closed_by ?? 'someone'}. Reload the list to see it.`)
      db.run(`UPDATE data_flags SET status = 'CLOSED', closed_on = ?, closed_by = ?, close_note = ? WHERE flag_id = ?`, [today(), user, note, id])
      return getFlag(db, id)
    })
  })

  r.post('/api/flags/:id/reopen', (req) => {
    const user = requireUser(req.user)
    const id = flagId(req)
    const note = str(req.body?.note, 'Why it is being reopened (note)', MAX_TEXT)
    return db.tx(() => {
      const f = getFlag(db, id)
      if (f.status === 'OPEN') throw new HttpError(409, `Issue #${id} is already open.`)
      const twin = db.value<number>(
        `SELECT flag_id FROM data_flags WHERE status = 'OPEN' AND flag_id <> ? AND COALESCE(holder_id,'') = COALESCE(?,'')
         AND COALESCE(category,'') = COALESCE(?,'') AND message = ?`,
        [id, f.holder_id, f.category, f.message],
      )
      if (twin) throw new HttpError(409, `The same issue is already open as #${twin} — work on that one instead of reopening this.`)
      // The earlier closure goes into the action text so the history is not lost when the closure fields are cleared.
      const closure = f.closed_on || f.closed_by || f.close_note
        ? ` (was closed ${f.closed_on ?? '?'} by ${f.closed_by ?? '?'}${f.close_note ? `: ${f.close_note}` : ''})`
        : ''
      const entry = `Reopened ${today()} by ${user}: ${note}${closure}`
      const action = f.action ? `${f.action}\n${entry}` : entry
      db.run(`UPDATE data_flags SET status = 'OPEN', closed_on = NULL, closed_by = NULL, close_note = NULL, action = ? WHERE flag_id = ?`, [action, id])
      return getFlag(db, id)
    })
  })

  r.get('/api/writeback', () => buildWriteback(db))

  r.get('/api/export/writeback.csv', () => {
    const wb = buildWriteback(db)
    return new Download(`hypermill-writeback-${wb.generated_on}.csv`, 'text/csv; charset=utf-8', toCsv(wb.items, WRITEBACK_COLUMNS))
  })

  r.get('/api/export/writeback.html', () => {
    const wb = buildWriteback(db)
    return new Download(`hypermill-writeback-${wb.generated_on}.html`, 'text/html; charset=utf-8', writebackHtml(wb), 'inline')
  })

  r.get('/api/export/flags.csv', (req) => {
    const rows = listFlags(db, filterFromQuery(req.query))
    return new Download(`issues-${today()}.csv`, 'text/csv; charset=utf-8', toCsv(rows, FLAG_COLUMNS))
  })
}
