/**
 * Minimal XLSX writer (Office Open XML spreadsheet) — enough for tally, catalogue and RFQ
 * exports: several sheets, a bold frozen header row, numbers as numbers, column widths.
 * No dependency: the package is a ZIP of a few XML parts, deflated with node:zlib.
 */
import { deflateRawSync } from 'node:zlib'

export interface XlsxColumn<T> {
  header: string
  value: (row: T) => unknown
  /** Approximate width in characters. */
  width?: number
}
export interface XlsxSheet<T = any> {
  name: string
  columns: XlsxColumn<T>[]
  rows: T[]
}

const xmlEsc = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!).replace(
    // Characters not allowed in XML 1.0
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    '',
  )

function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet'
  let n = base
  for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base.slice(0, 28)} ${k}`
  used.add(n.toLowerCase())
  return n
}

function cellXml(ref: string, v: unknown, style = 0): string {
  const s = style ? ` s="${style}"` : ''
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`
}

function sheetXml<T>(sh: XlsxSheet<T>): string {
  const cols = sh.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? Math.min(60, Math.max(8, c.header.length + 2))}" customWidth="1"/>`)
    .join('')
  const head = `<row r="1">${sh.columns.map((c, i) => cellXml(`${colName(i)}1`, c.header, 1)).join('')}</row>`
  const body = sh.rows
    .map((row, r) => `<row r="${r + 2}">${sh.columns.map((c, i) => cellXml(`${colName(i)}${r + 2}`, c.value(row))).join('')}</row>`)
    .join('')
  const lastRef = `${colName(Math.max(0, sh.columns.length - 1))}${sh.rows.length + 1}`
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${head}${body}</sheetData>` +
    (sh.columns.length ? `<autoFilter ref="A1:${lastRef}"/>` : '') +
    `</worksheet>`
  )
}

export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  if (!sheets.length) throw new Error('At least one sheet is required')
  const used = new Set<string>()
  const names = sheets.map((s) => sheetName(s.name, used))
  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        `</Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      'xl/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
        `</styleSheet>`,
    ],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ]
  return zip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]))
}

// ---------------------------------------------------------------- ZIP (deflate) writer
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zip(entries: Array<[string, Buffer]>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  // Fixed DOS timestamp (1 Jan 2020) keeps output deterministic.
  const dosTime = 0
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const comp = deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, comp)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(dosTime, 12)
    cen.writeUInt16LE(dosDate, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cenBuf, end])
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
