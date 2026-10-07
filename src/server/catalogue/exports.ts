/**
 * Catalogue and tally exports (CSV for import elsewhere, XLSX for people).
 * Same rows and filters as the API, so what is exported is what the screen showed.
 */
import type { AppContext } from '../context.js'
import { getSetting, today } from '../domain.js'
import { Download } from '../http.js'
import { toCsv, type Column } from '../lib/csv.js'
import { buildXlsx, XLSX_TYPE, type XlsxColumn, type XlsxSheet } from '../lib/xlsx.js'
import { listHolders, parseFilters, type Holder } from './holders.js'
import { byClamp, byLocation, byMaker, byType, glCheck } from './tally.js'

type Col<T> = XlsxColumn<T> & Column<T>
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))

const CATALOGUE_COLUMNS: Col<Holder>[] = [
  { header: 'holder_id', value: (h) => h.holder_id, width: 9 },
  { header: 'manufacturer', value: (h) => h.manufacturer, width: 12 },
  { header: 'order_no', value: (h) => h.order_no, width: 18 },
  { header: 'spec_code', value: (h) => h.spec_code, width: 30 },
  { header: 'product_name', value: (h) => h.product_name, width: 34 },
  { header: 'series', value: (h) => h.series, width: 32 },
  { header: 'type_code', value: (h) => h.type_code, width: 16 },
  { header: 'type_name', value: (h) => h.type_name, width: 24 },
  { header: 'interface_code', value: (h) => h.interface_code, width: 10 },
  { header: 'clamp_dia_mm', value: (h) => num(h.clamp_dia_mm), width: 9 },
  { header: 'clamp_min_mm', value: (h) => num(h.clamp_min_mm), width: 9 },
  { header: 'clamp_max_mm', value: (h) => num(h.clamp_max_mm), width: 9 },
  { header: 'clamp_spec', value: (h) => h.clamp_spec, width: 24 },
  { header: 'gauge_length_mm', value: (h) => num(h.gauge_length_mm), width: 9 },
  { header: 'gauge_length_ref', value: (h) => h.gauge_length_ref, width: 14 },
  { header: 'cam_gl_mm', value: (h) => num(h.cam_gl_mm), width: 9 },
  { header: 'nose_dia_mm', value: (h) => num(h.nose_dia_mm), width: 9 },
  { header: 'coolant', value: (h) => h.coolant, width: 24 },
  { header: 'balance', value: (h) => h.balance, width: 22 },
  { header: 'max_rpm', value: (h) => num(h.max_rpm), width: 9 },
  { header: 'mass_kg', value: (h) => num(h.mass_kg), width: 8 },
  { header: 'qty_on_site', value: (h) => h.qty_on_site, width: 9 },
  { header: 'count_status', value: (h) => h.count_status, width: 11 },
  { header: 'last_count_date', value: (h) => h.last_count_date, width: 11 },
  { header: 'open_issues', value: (h) => h.open_issues, width: 8 },
  { header: 'worst_severity', value: (h) => h.worst_severity, width: 9 },
  { header: 'on_want_list', value: (h) => h.on_want_list, width: 8 },
  { header: 'data_status', value: (h) => h.data_status, width: 14 },
  { header: 'data_source', value: (h) => h.data_source, width: 30 },
  { header: 'last_checked', value: (h) => h.last_checked, width: 11 },
  { header: 'product_url', value: (h) => h.product_url, width: 40 },
  { header: 'image_url', value: (h) => h.image_url, width: 30 },
  { header: 'drawing_url', value: (h) => h.drawing_url, width: 30 },
  { header: 'cam_name', value: (h) => h.cam_name, width: 36 },
  { header: 'cam_comment', value: (h) => h.cam_comment, width: 36 },
  { header: 'dims_json', value: (h) => (Object.keys(h.dims).length ? JSON.stringify(h.dims) : null), width: 40 },
  { header: 'notes', value: (h) => h.notes, width: 40 },
]

/** The prototype's "count CSV": one row per article on site or counted. */
const TALLY_COLUMNS: Col<Holder>[] = [
  { header: 'holder_id', value: (h) => h.holder_id, width: 9 },
  { header: 'manufacturer', value: (h) => h.manufacturer, width: 12 },
  { header: 'order_no', value: (h) => h.order_no, width: 18 },
  { header: 'series', value: (h) => h.series, width: 34 },
  { header: 'clamp', value: (h) => h.clamp_spec, width: 26 },
  { header: 'gauge_length_mm', value: (h) => num(h.gauge_length_mm), width: 10 },
  { header: 'qty_on_site', value: (h) => h.qty_on_site, width: 9 },
  { header: 'count_status', value: (h) => h.count_status, width: 11 },
  { header: 'last_count_date', value: (h) => h.last_count_date, width: 12 },
]

function filePrefix(ctx: AppContext, iface: string | null): string {
  const code = iface || getSetting<string>(ctx.db, 'default_interface', 'HSK-A63')
  return code.replace(/[^A-Za-z0-9._-]+/g, '-')
}

export function catalogueCsv(ctx: AppContext, q: URLSearchParams): Download {
  const f = parseFilters(q)
  const rows = listHolders(ctx, f)
  return new Download(`${filePrefix(ctx, f.iface)}_holder_catalogue_${today()}.csv`, 'text/csv; charset=utf-8', toCsv(rows, CATALOGUE_COLUMNS))
}

export function catalogueXlsx(ctx: AppContext, q: URLSearchParams): Download {
  const f = parseFilters(q)
  const rows = listHolders(ctx, f)
  const xlsx = buildXlsx([{ name: 'Catalogue', columns: CATALOGUE_COLUMNS, rows }])
  return new Download(`${filePrefix(ctx, f.iface)}_holder_catalogue_${today()}.xlsx`, XLSX_TYPE, xlsx)
}

/** Articles on site, or counted (a counted zero is still a result the auditor wants to see). */
function tallyArticles(ctx: AppContext): Holder[] {
  return listHolders(ctx, parseFilters(new URLSearchParams())).filter((h) => h.qty_on_site > 0 || h.count_status === 'counted')
}

export function tallyCsv(ctx: AppContext): Download {
  return new Download(`${filePrefix(ctx, null)}_holder_count_${today()}.csv`, 'text/csv; charset=utf-8', toCsv(tallyArticles(ctx), TALLY_COLUMNS))
}

export function tallyXlsx(ctx: AppContext): Download {
  const sheets: XlsxSheet[] = [
    { name: 'Articles', columns: TALLY_COLUMNS, rows: tallyArticles(ctx) },
    {
      name: 'By type',
      columns: [
        { header: 'type_code', value: (r) => r.type_code, width: 18 },
        { header: 'type_name', value: (r) => r.type_name, width: 28 },
        { header: 'articles_on_site', value: (r) => r.articles_on_site, width: 14 },
        { header: 'holders_on_site', value: (r) => r.holders_on_site, width: 14 },
      ],
      rows: byType(ctx),
    },
    {
      name: 'By maker',
      columns: [
        { header: 'manufacturer', value: (r) => r.manufacturer, width: 20 },
        { header: 'articles_on_site', value: (r) => r.articles_on_site, width: 14 },
        { header: 'holders_on_site', value: (r) => r.holders_on_site, width: 14 },
        { header: 'articles_in_catalogue', value: (r) => r.articles_in_catalogue, width: 18 },
      ],
      rows: byMaker(ctx),
    },
    {
      name: 'By clamp Ø',
      columns: [
        { header: 'clamp_dia_mm', value: (r) => r.clamp_dia_mm, width: 12 },
        { header: 'type_name', value: (r) => r.type_name, width: 28 },
        { header: 'holders_on_site', value: (r) => r.holders_on_site, width: 14 },
        { header: 'gauge_lengths_mm', value: (r) => r.gauge_lengths.join(' · '), width: 24 },
      ],
      rows: byClamp(ctx),
    },
    {
      name: 'By location',
      columns: [
        { header: 'location', value: (r) => r.location, width: 30 },
        { header: 'kind', value: (r) => r.kind, width: 10 },
        { header: 'counts_as_on_site', value: (r) => (r.counts_as_on_site ? 'yes' : 'no'), width: 16 },
        { header: 'articles', value: (r) => r.articles, width: 10 },
        { header: 'holders', value: (r) => r.holders, width: 10 },
      ],
      rows: byLocation(ctx),
    },
    {
      name: 'GL check',
      columns: [
        { header: 'holder_id', value: (r) => r.holder_id, width: 9 },
        { header: 'manufacturer', value: (r) => r.manufacturer, width: 12 },
        { header: 'order_no', value: (r) => r.order_no, width: 18 },
        { header: 'type_name', value: (r) => r.type_name, width: 24 },
        { header: 'maker_gl_mm', value: (r) => r.gauge_length_mm, width: 11 },
        { header: 'hypermill_gl_mm', value: (r) => r.cam_gl_mm, width: 14 },
        { header: 'delta_mm', value: (r) => r.delta_mm, width: 9 },
        { header: 'note', value: (r) => r.note, width: 70 },
      ],
      rows: glCheck(ctx),
    },
  ]
  return new Download(`${filePrefix(ctx, null)}_holder_tally_${today()}.xlsx`, XLSX_TYPE, buildXlsx(sheets))
}
