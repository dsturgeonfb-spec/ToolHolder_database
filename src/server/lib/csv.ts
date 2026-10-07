/**
 * CSV in and out. Output is UTF-8 with a BOM and CRLF line ends so it opens cleanly in Excel
 * (same convention as data/holders.csv). Input accepts comma, semicolon or tab, quoted fields,
 * embedded newlines and a leading BOM.
 */
export interface Column<T> {
  header: string
  value: (row: T) => unknown
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  // Guard against spreadsheet formula injection from data that came off the web.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s
  return /[",\r\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')]
  for (const r of rows) lines.push(columns.map((c) => cell(c.value(r))).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Parses CSV text into rows of strings. Detects the delimiter from the header line. */
export function parseCsv(text: string): string[][] {
  let s = text.replace(/^﻿/, '')
  const firstLine = s.slice(0, s.search(/\r?\n|$/))
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<string, number>
  let inQ = false
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ
    else if (!inQ && ch in counts) counts[ch]!++
  }
  const delim = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0] : ',') as string
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  inQ = false
  while (i < s.length) {
    const ch = s[i]!
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQ = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      inQ = true
      i++
      continue
    }
    if (ch === delim) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

/** Parses CSV with a header row into objects keyed by the (trimmed) header. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text)
  if (!rows.length) return []
  const head = rows[0]!.map((h) => h.trim())
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])))
}
