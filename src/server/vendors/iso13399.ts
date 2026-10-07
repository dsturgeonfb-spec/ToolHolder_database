/**
 * File import: a CSV from a maker's rep (ISO 13399 / GTC export, catalogue table) or a distributor list,
 * for the makers whose sites must not be scraped (CERATIZIT answers 403; SANDVIK and CUTWEL render in JS).
 *
 * Columns may be our holder column names (order_no, clamp_dia_mm, gauge_length_mm, …) or ISO 13399 codes:
 *   DCONWS → clamp Ø (a range "1-7" → clamp min/max), LPR → gauge length (label 'LPR'),
 *   DLN or BD → nose Ø — DLN wins when both are given: on a collet chuck the lock nut is the front-most
 *   diameter, which is what collision checks need; BD (body Ø) is the fallback,
 *   WT → mass (kg), RPMX → max rpm, ADINTMS → must name the chosen interface (otherwise the row is an error).
 * Order no. headers: order_no, ORDER_NO, Article, Art.-Nr. (and a few common spellings). Other ISO-style
 * codes (BD1, LB, LSCX, ADINTWS…) are kept in the maker dimensions; other columns are reported as unused.
 */
import { parseCsvObjects } from '../lib/csv.js'
import { DATA_STATUSES, type DataStatus } from '../domain.js'
import { classifyCeratizit, classifyHaimer, classifyKemmler, classifyMapal, settleRecord } from './classify.js'
import { cleanText, dimValue, interfaceMatch, normOrderNo, parseMassKg, parseNum, parseRange } from './parse.js'
import type { HolderRecord } from './types.js'

const ORDER_HEADERS = ['order_no', 'order no', 'order no.', 'order number', 'article', 'article no', 'article no.', 'article number', 'art.-nr.', 'art.-nr', 'artikelnummer', 'bestellnummer', 'item number']
const MAKER_HEADERS = ['manufacturer', 'maker', 'hersteller']
const MAKER_ORDER_HEADERS = ['maker_order_no', 'maker order no', 'maker order no.', 'manufacturer order no', 'hersteller-nr.', 'mfr part no']

/** Our own columns a file may carry directly. */
const OWN_TEXT = ['spec_code', 'product_name', 'series', 'type_code', 'clamp_spec', 'gauge_length_ref', 'coolant', 'balance', 'notes', 'product_url', 'image_url', 'drawing_url', 'interface_code', 'data_status']
const OWN_NUM = ['clamp_dia_mm', 'clamp_min_mm', 'clamp_max_mm', 'gauge_length_mm', 'nose_dia_mm', 'mass_kg', 'max_rpm']

const ISO_CODE = /^[A-Z][A-Z0-9_]{1,11}$/

export interface FileImportRow {
  line: number
  record: HolderRecord | null
  order_no: string
  error?: string
}

export interface FileImportResult {
  rows: FileImportRow[]
  unused_columns: string[]
  columns: string[]
}

/** Header → its ISO code (first token, written in capitals as ISO 13399 does): "DCONWS (clamping Ø)" → DCONWS. "Price" is not a code. */
function isoOf(header: string): string | null {
  const tok = header.trim().split(/[\s(:\[]/)[0]!
  return ISO_CODE.test(tok) ? tok : null
}

export function parseFileImport(
  text: string,
  opts: { maker: string; iface: string; source: string; dataStatus: DataStatus; isDistributor: boolean; knownMakers: string[] },
): FileImportResult {
  const objs = parseCsvObjects(text)
  if (!objs.length) return { rows: [], unused_columns: [], columns: [] }
  const columns = Object.keys(objs[0]!)
  const lower = new Map(columns.map((c) => [c.trim().toLowerCase(), c]))
  const pick = (names: string[]) => names.map((n) => lower.get(n)).find((c) => c !== undefined)
  const orderCol = pick(ORDER_HEADERS)
  const makerCol = pick(MAKER_HEADERS)
  const makerOrderCol = pick(MAKER_ORDER_HEADERS)
  const used = new Set<string>([orderCol, makerCol, makerOrderCol].filter((c): c is string => !!c))
  const own = new Map<string, string>()
  for (const f of [...OWN_TEXT, ...OWN_NUM, 'dims', 'dims_json']) {
    const c = lower.get(f)
    if (c) {
      own.set(f, c)
      used.add(c)
    }
  }
  const iso = new Map<string, string>()
  for (const c of columns) {
    if (used.has(c)) continue
    const code = isoOf(c)
    if (code) {
      iso.set(c, code)
      used.add(c)
    }
  }
  const unused = columns.filter((c) => !used.has(c) && c.trim())
  if (!orderCol)
    return {
      rows: [{ line: 1, record: null, order_no: '', error: `No order no. column — name one of: order_no, ORDER_NO, Article, Art.-Nr. (found: ${columns.slice(0, 12).join(', ')}).` }],
      unused_columns: unused,
      columns,
    }

  const rows: FileImportRow[] = []
  objs.forEach((o, i) => {
    const line = i + 2 // header is line 1
    const order = normOrderNo(o[orderCol])
    if (!order) {
      if (Object.values(o).some((v) => v.trim())) rows.push({ line, record: null, order_no: '', error: `Line ${line}: no order no.` })
      return
    }
    try {
      rows.push({ line, order_no: order, record: rowToRecord(o, order, opts, own, iso, makerCol, makerOrderCol) })
    } catch (e) {
      rows.push({ line, record: null, order_no: order, error: `Line ${line}: ${(e as Error).message}` })
    }
  })
  return { rows, unused_columns: unused, columns }
}

function rowToRecord(
  o: Record<string, string>,
  order: string,
  opts: { maker: string; iface: string; source: string; dataStatus: DataStatus; isDistributor: boolean; knownMakers: string[] },
  own: Map<string, string>,
  iso: Map<string, string>,
  makerCol: string | undefined,
  makerOrderCol: string | undefined,
): HolderRecord {
  let maker = opts.maker
  const rowMaker = makerCol ? cleanText(o[makerCol]) : null
  if (rowMaker) {
    const hit = opts.knownMakers.find((m) => m.toUpperCase() === rowMaker.toUpperCase())
    if (!hit) throw new Error(`maker "${rowMaker}" is not in the catalogue's maker list.`)
    maker = hit
  }
  const rec: HolderRecord = {
    manufacturer: maker,
    order_no: order,
    dims: {},
    data_status: opts.dataStatus,
    data_source: opts.source,
    warnings: [],
  }
  const any = rec as unknown as Record<string, unknown>
  const num = (field: string, v: string) => {
    if (!v.trim()) return
    const n = field === 'max_rpm' ? parseNum(v, { integer: true }) : field === 'mass_kg' ? parseMassKg(v) : parseNum(v)
    if (n == null) throw new Error(`${field} "${v}" is not a number.`)
    any[field] = n
  }
  // ISO 13399 codes first; our own column names (when both are present) win.
  let dln: number | null = null
  let bd: number | null = null
  for (const [col, code] of iso) {
    const v = (o[col] ?? '').trim()
    if (!v) continue
    switch (code) {
      case 'DCONWS': {
        const range = parseRange(v)
        if (range) [rec.clamp_min_mm, rec.clamp_max_mm] = range
        else num('clamp_dia_mm', v)
        rec.dims![col] = dimValue(v)
        break
      }
      case 'LPR':
        num('gauge_length_mm', v)
        rec.gauge_length_ref = 'LPR'
        break
      case 'DLN':
        dln = parseNum(v)
        rec.dims![col] = dimValue(v)
        break
      case 'BD':
        bd = parseNum(v)
        rec.dims![col] = dimValue(v)
        break
      case 'WT':
        num('mass_kg', v)
        break
      case 'RPMX':
        num('max_rpm', v)
        break
      case 'ADINTMS': {
        const m = interfaceMatch(opts.iface, v)
        if (m === 'no') throw new Error(`ADINTMS "${v}" is not ${opts.iface} — not imported. Pick the right interface or remove the row.`)
        if (m === 'unknown') throw new Error(`ADINTMS "${v}" could not be read as an interface — expected ${opts.iface}.`)
        rec.interface_seen = v
        if (m === 'form-only') rec.warnings!.push(`ADINTMS "${v}" names the form only, not the size — check it is ${opts.iface}.`)
        break
      }
      default:
        rec.dims![col] = dimValue(v)
    }
  }
  if (dln != null || bd != null) rec.nose_dia_mm = dln ?? bd
  for (const [field, col] of own) {
    const v = (o[col] ?? '').trim()
    if (!v) continue
    if (OWN_NUM.includes(field)) num(field, v)
    else if (field === 'dims' || field === 'dims_json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(v)
      } catch {
        throw new Error(`${col} must be a JSON object of label: value pairs.`)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${col} must be a JSON object of label: value pairs.`)
      Object.assign(rec.dims!, parsed)
    } else if (field === 'data_status') {
      if (!(DATA_STATUSES as readonly string[]).includes(v)) throw new Error(`data_status "${v}" must be one of ${DATA_STATUSES.join(', ')}.`)
      rec.data_status = v as DataStatus
    } else if (field === 'type_code') rec.type_code = v.toUpperCase()
    else any[field] = v
  }
  if (makerOrderCol) {
    const mo = cleanText(o[makerOrderCol], 120)
    if (mo) {
      if (!rec.spec_code) rec.spec_code = mo
      else rec.notes = [rec.notes, `Maker order no.: ${mo}`].filter(Boolean).join('\n')
    }
  }
  if (opts.isDistributor && !rec.spec_code && !/maker order no/i.test(rec.notes ?? ''))
    rec.warnings!.push("Distributor part no. — add the maker's own order no. (spec_code or a maker_order_no column) when you know it.")
  if (rec.gauge_length_mm == null) rec.warnings!.push('No gauge length in this row — an existing value is kept; a new holder is added without one.')

  const m = maker.toUpperCase()
  const typeSeries =
    m === 'HAIMER' ? classifyHaimer(order) : m === 'CERATIZIT' ? classifyCeratizit(order, rec.spec_code, rec.product_name) : m === 'MAPAL' ? classifyMapal(rec.spec_code, rec.product_name) : m === 'KEMMLER' ? classifyKemmler(order) : null
  settleRecord(rec, typeSeries)
  return rec
}
