/**
 * Parser for the OPEN MIND hyperMILL tool-database "Holder" report.
 *
 * Nobody here has seen the HTML itself — only the PDF printed from it — so the parser assumes as little
 * as possible about its markup:
 *  1. the document becomes an ordered stream of text and image events (block elements and table cells
 *     separate text; inline tags don't);
 *  2. the stream is split into holder blocks at the "Holder:" label (any case; the value may sit in the
 *     same cell or the next one);
 *  3. within a block: the name, the text after "Holder comment" (empty when the next label follows) and
 *     the coupling rows ("<type> top|bottom <class>");
 *  4. each block gets the first image in it whose source is not repeated in other blocks — a repeated
 *     image is the logo/header printed on every page.
 * A pdftotext .txt export goes through the same block logic (one event per line).
 * Anything odd (no image, image file missing, empty name) becomes a warning, never a failure.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import { collapse, nameTag, normaliseComment, normaliseName } from './classify.js'

export type ReportFormat = 'html' | 'txt'

export interface Coupling {
  type: string
  pos: 'top' | 'bottom'
  class: string
}

export interface ReportImage {
  /** Identity used to spot repeats: the resolved file path, or a hash for embedded images. */
  key: string
  /** src exactly as written in the report. */
  src: string
  /** Absolute path on disk (null for embedded data: images and web links). */
  path: string | null
  /** Where the image goes in the imports/ copy, relative to the copied report (null = nothing to copy). */
  copyAs: string | null
  bytes: Buffer | null
  sha256: string | null
  ext: string
  mime: string
  /** Why the bytes could not be read. */
  error: string | null
}

export interface ParsedHolder {
  /** 1-based position of the holder block in the report. */
  seq: number
  /** Name exactly as printed, e.g. "(HSK63) HAIMER SPIGOT ARBOR 16mm A63.050.16.KKB 67GL". */
  raw_name: string
  /** The name as stored in holders.cam_name (leading "(<tag>) " removed). */
  cam_name: string
  tag: string | null
  cam_comment: string | null
  coupling: Coupling[]
  /** Index into ParsedReport.images, or null when the block has no profile image. */
  image: number | null
}

export interface ReportWarning {
  seq: number | null
  cam_name: string | null
  message: string
}

export interface ParsedReport {
  path: string
  file: string
  format: ReportFormat
  title: string | null
  /** File modification time — the date hyperMILL wrote the report. */
  modified: Date
  bytes: Buffer
  holders: ParsedHolder[]
  images: ReportImage[]
  /** after-label: each holder's picture follows its "Holder:" label; before-label: it precedes it. */
  imageLayout: 'after-label' | 'before-label'
  warnings: ReportWarning[]
}

/**
 * `row` groups text that sits on one table row (cells of a <tr>) or one line of a text export, so the
 * coupling rows can be read without running into whatever follows them.
 */
export type ReportEvent = { kind: 'text'; text: string; row: number } | { kind: 'img'; src: string }

export const MAX_REPORT_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 300 * 1024 * 1024

// ------------------------------------------------------------------------------------------ HTML → events
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'col', 'colgroup',
])
const SKIP_TAGS = new Set(['head', 'script', 'style', 'noscript', 'template', 'title', 'meta', 'link'])

interface DomNode {
  type: string
  name?: string
  data?: string
  attribs?: Record<string, string>
  children?: DomNode[]
}

/** Ordered text/image events from an HTML document. */
export function htmlToEvents(root: DomNode): ReportEvent[] {
  const events: ReportEvent[] = []
  let buf = ''
  let row = 0
  const flush = () => {
    const t = collapse(buf)
    if (t) events.push({ kind: 'text', text: t, row })
    buf = ''
  }
  const walk = (n: DomNode) => {
    if (n.type === 'text') {
      buf += n.data ?? ''
      return
    }
    if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
      const name = (n.name ?? '').toLowerCase()
      if (SKIP_TAGS.has(name)) return
      if (name === 'img' || (name === 'input' && (n.attribs?.type ?? '').toLowerCase() === 'image')) {
        flush()
        const src = (n.attribs?.src ?? n.attribs?.['data-src'] ?? '').trim()
        if (src) events.push({ kind: 'img', src })
        return
      }
      const block = BLOCK_TAGS.has(name)
      // Cells of one table row share a row id; any other block boundary starts a new row.
      const newRow = block && name !== 'td' && name !== 'th'
      if (block) flush()
      if (newRow) row++
      for (const c of n.children ?? []) walk(c)
      if (block) flush()
      if (newRow) row++
      return
    }
    if (n.type === 'root') for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  flush()
  return splitEmbeddedLabels(events)
}

/**
 * A label that shares a text run with the previous value ("… 67GL Holder comment HAIMER …", when the
 * report has no element boundary between them) is split off, so the block logic always sees labels at
 * the start of an event.
 */
function splitEmbeddedLabels(events: ReportEvent[]): ReportEvent[] {
  const out: ReportEvent[] = []
  for (const e of events) {
    if (e.kind !== 'text') {
      out.push(e)
      continue
    }
    const labels = /(?=(?<![A-Za-z])holder\s+comment(?![A-Za-z])|(?<![A-Za-z])holder\s*:|(?<![A-Za-z])coupling\s*:?\s+\S+\s+(?:top|bottom)(?![A-Za-z]))/i
    for (const part of e.text.split(labels)) {
      const t = part.trim()
      if (t) out.push({ kind: 'text', text: t, row: e.row })
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------ text → events
/** pdftotext output: one event per line, without the browser's print header/footer lines. */
export function textToEvents(text: string): ReportEvent[] {
  const events: ReportEvent[] = []
  let row = 0
  for (let line of text.replace(/^\uFEFF/, '').replace(/\f/g, '\n').split(/\r?\n/)) {
    row++
    // The print footer "file:///C:/…/Holder_HSK63 HOLDERS.html   5/27" can share a line with content.
    line = line.replace(/\s*file:\/\/\S.*$/i, '')
    const t = collapse(line)
    if (!t) continue
    if (/^\d+\s*\/\s*\d+$/.test(t)) continue // page counter
    if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s+\d{1,2}:\d{2}/.test(t)) continue // print header date/time
    events.push({ kind: 'text', text: t, row })
  }
  return splitEmbeddedLabels(events)
}

// ------------------------------------------------------------------------------------------ block logic
const HOLDER_LABEL = /^holder(?:\s+name)?\s*:\s*(.*)$/i
const HOLDER_BARE = /^holder(?:\s+name)?$/i
const COMMENT_LABEL = /^holder\s+comment\s*:?\s*(.*)$/i
const COUPLING_LABEL = /^couplings?\s*:?\s*(.*)$/i
const LOOKS_LIKE_NAME = /^\(|\d\s*GL\b/i

const isLabel = (t: string) => HOLDER_LABEL.test(t) || COMMENT_LABEL.test(t) || COUPLING_LABEL.test(t)

export interface RawBlock {
  seq: number
  raw_name: string
  comment: string
  coupling: Coupling[]
  /** img srcs in this block, in order. */
  imgs: string[]
}

export interface SplitResult {
  preambleImgs: string[]
  blocks: RawBlock[]
}

/**
 * Splits the event stream into holder blocks. `joinNameLines` (text exports) lets a name that wrapped
 * onto the next line(s) continue until the next label, as scripts/parse_tooldb.py did.
 */
export function splitBlocks(events: ReportEvent[], opts: { joinNameLines: boolean }): SplitResult {
  const preambleImgs: string[] = []
  const blocks: RawBlock[] = []
  let cur: RawBlock | null = null
  const textAt = (i: number) => {
    const e = events[i]
    return e && e.kind === 'text' ? e.text : null
  }
  // A bare "Holder" cell starts a block only when a holder name follows (it could be a page heading).
  const bareHolderAt = (i: number) => {
    const t = textAt(i)
    const next = textAt(i + 1)
    return t !== null && HOLDER_BARE.test(t) && next !== null && !isLabel(next) && LOOKS_LIKE_NAME.test(next)
  }
  const labelAt = (i: number) => {
    const t = textAt(i)
    return t !== null && (isLabel(t) || bareHolderAt(i))
  }
  /** The next event when it is plain text (not a label, not an image), else null. */
  const valueAt = (i: number) => (labelAt(i) ? null : textAt(i))

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.kind === 'img') {
      ;(cur ? cur.imgs : preambleImgs).push(e.src)
      continue
    }
    const t = e.text
    let holderValue: string | null = null
    let m = HOLDER_LABEL.exec(t)
    if (m) holderValue = m[1]!.trim()
    else if (bareHolderAt(i)) holderValue = ''
    if (holderValue !== null) {
      cur = { seq: blocks.length + 1, raw_name: holderValue, comment: '', coupling: [], imgs: [] }
      blocks.push(cur)
      if (!cur.raw_name) {
        const next = valueAt(i + 1)
        if (next !== null) {
          cur.raw_name = next
          i++
        }
      }
      if (opts.joinNameLines) {
        // A wrapped name continues until a label; at most two more lines, and none once the GL token is in.
        for (let k = 0; k < 2 && !/\d\s*GL\b/i.test(cur.raw_name); k++) {
          const next = valueAt(i + 1)
          if (next === null) break
          cur.raw_name = `${cur.raw_name} ${next}`.trim()
          i++
        }
      }
      continue
    }
    if (!cur) continue
    if ((m = COMMENT_LABEL.exec(t))) {
      let v = m[1]!.trim()
      if (!v) {
        const next = valueAt(i + 1)
        if (next !== null) {
          v = next
          i++
        }
      }
      cur.comment = v
      continue
    }
    if ((m = COUPLING_LABEL.exec(t))) {
      // The coupling rows follow as table rows (cells) or lines. Group what follows by row and keep the
      // rows that name a position (top/bottom): a heading row before them is skipped, and the first row
      // without a position after them ends the table — so a page header that follows is not read as a class.
      const groups: Array<{ row: number; parts: string[]; last: number }> = []
      const rest = m[1]!.trim()
      if (rest) groups.push({ row: e.row, parts: [rest], last: i })
      for (let j = i + 1; j < events.length && j <= i + 24; j++) {
        const n = events[j]!
        if (n.kind !== 'text' || labelAt(j)) break
        const g = groups.at(-1)
        if (g && g.row === n.row) {
          g.parts.push(n.text)
          g.last = j
        } else groups.push({ row: n.row, parts: [n.text], last: j })
      }
      const keep: typeof groups = []
      for (const g of groups) {
        if (POSITION.test(g.parts.join(' '))) keep.push(g)
        else if (keep.length) break
      }
      cur.coupling = keep.flatMap((g) => parseCoupling(g.parts.join(' ')))
      if (keep.length) i = Math.max(i, keep.at(-1)!.last)
    }
  }
  return { preambleImgs, blocks }
}

const POSITION = /(?<![A-Za-z])(top|bottom)(?![A-Za-z])/i

/**
 * Coupling rows "<type> top|bottom [class]", e.g. "unknown top unknown bottom" or
 * "adaptor top SPINDLE 40TAPER unknown bottom" (cells or one pdftotext line — same tokens).
 */
export function parseCoupling(text: string): Coupling[] {
  const toks = collapse(text).split(' ').filter(Boolean)
  const at: number[] = []
  toks.forEach((t, i) => {
    if (/^(top|bottom)$/i.test(t)) at.push(i)
  })
  const out: Coupling[] = []
  at.forEach((p, k) => {
    const nextP = at[k + 1]
    const end = nextP === undefined ? toks.length : nextP - 1
    const cls = toks
      .slice(p + 1, Math.max(p + 1, end))
      .join(' ')
      .replace(/\s*\b(file|https?):\/\/.*$/i, '')
      .trim()
      .slice(0, 80)
    out.push({ type: p > 0 && (k === 0 || p - 1 > at[k - 1]!) ? toks[p - 1]! : '', pos: toks[p]!.toLowerCase() as 'top' | 'bottom', class: cls })
  })
  return out
}

// ------------------------------------------------------------------------------------------ images
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
}

/**
 * The real picture type from its first bytes (report files are not always named by type), or null when
 * the file is not a PNG/JPEG/GIF/BMP/WebP picture — an <img> pointing at anything else is not imported,
 * so a report can't pull an arbitrary file from the host's disk into the catalogue.
 */
export function sniffImage(bytes: Buffer): { ext: string; mime: string } | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return { ext: '.png', mime: 'image/png' }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'GIF8') return { ext: '.gif', mime: 'image/gif' }
  if (bytes.length >= 2 && bytes.toString('latin1', 0, 2) === 'BM') return { ext: '.bmp', mime: 'image/bmp' }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
    return { ext: '.webp', mime: 'image/webp' }
  return null
}
const NOT_A_PICTURE = 'not a PNG, JPEG, GIF, BMP or WebP picture'

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const isWindowsAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)

/**
 * Resolves an <img src> relative to the report file: relative paths, file:// URLs, %20 escapes and
 * Windows backslashes. When the written path does not exist (a report copied off the CAM PC still
 * pointing at C:\Users\Public\…), the same file name is looked for next to the report and in its
 * "<report>_files" folder. Returns candidate paths in the order to try.
 */
export function imageCandidates(src: string, reportPath: string): string[] {
  const dir = dirname(reportPath)
  let s = src.trim().replace(/[?#].*$/, '')
  const out: string[] = []
  const add = (p: string) => {
    if (p && !out.includes(p)) out.push(p)
  }
  if (/^file:/i.test(s)) {
    try {
      add(fileURLToPath(s))
    } catch {
      /* not a valid file URL on this OS — fall through to the manual form */
    }
    s = safeDecode(s.replace(/^file:\/*/i, '')).replace(/^localhost\//i, '')
    // file:///C:/x → C:/x ; file:///home/x → /home/x
    add(isWindowsAbsolute(s) ? s : '/' + s)
  } else {
    for (const v of [safeDecode(s), s]) {
      const p = v.replace(/\\/g, '/')
      if (isWindowsAbsolute(v)) add(sep === '\\' ? normalize(v) : v)
      else if (isAbsolute(p)) add(p)
      else add(resolve(dir, p))
    }
  }
  // Fallbacks by file name, for reports moved off the PC that wrote them.
  const name = basename(safeDecode(s).replace(/\\/g, '/'))
  const stem = basename(reportPath, extname(reportPath))
  if (name) {
    add(join(dir, name))
    add(join(dir, `${stem}_files`, name))
    add(join(dir, `${stem}-Dateien`, name))
    const parent = basename(dirname(safeDecode(s).replace(/\\/g, '/')))
    if (parent && parent !== '.' && parent !== '/') add(join(dir, parent, name))
  }
  return out
}

interface ImageLoadBudget {
  total: number
}

function loadImage(src: string, reportPath: string, budget: ImageLoadBudget): ReportImage {
  const trimmed = src.trim()
  const dataUri = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(trimmed)
  if (dataUri) {
    let bytes: Buffer
    try {
      bytes = dataUri[2] ? Buffer.from(dataUri[3]!, 'base64') : Buffer.from(safeDecode(dataUri[3]!), 'latin1')
    } catch {
      bytes = Buffer.alloc(0)
    }
    const hash = sha256(bytes)
    const t = sniffImage(bytes)
    const shortSrc = trimmed.slice(0, 60) + (trimmed.length > 60 ? '…' : '')
    if (!t) return { key: `data:${hash}`, src: shortSrc, path: null, copyAs: null, bytes: null, sha256: null, ext: '.png', mime: 'image/png', error: `embedded image is ${NOT_A_PICTURE}` }
    return { key: `data:${hash}`, src: shortSrc, path: null, copyAs: null, bytes, sha256: hash, ...t, error: null }
  }
  if (/^(https?:)?\/\//i.test(trimmed)) {
    return { key: `url:${trimmed}`, src: trimmed, path: null, copyAs: null, bytes: null, sha256: null, ext: '.png', mime: 'image/png', error: 'image is a web link — not downloaded' }
  }
  const candidates = imageCandidates(trimmed, reportPath)
  const found = candidates.find((p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  })
  const path = found ?? candidates[0] ?? trimmed
  const key = `file:${sep === '\\' ? path.toLowerCase() : path}`
  const fallbackExt = extname(path) || '.png'
  if (!found) return { key, src: trimmed, path, copyAs: null, bytes: null, sha256: null, ext: fallbackExt.toLowerCase(), mime: MIME_BY_EXT[fallbackExt.toLowerCase()] ?? 'image/png', error: `image file not found (${path})` }
  const size = statSync(found).size
  if (size > MAX_IMAGE_BYTES || budget.total + size > MAX_TOTAL_IMAGE_BYTES)
    return { key, src: trimmed, path: found, copyAs: null, bytes: null, sha256: null, ext: fallbackExt, mime: 'image/png', error: 'image file is too large to import' }
  const bytes = readFileSync(found)
  const type = sniffImage(bytes)
  if (!type) return { key, src: trimmed, path: found, copyAs: null, bytes: null, sha256: null, ext: '.png', mime: 'image/png', error: `${found} is ${NOT_A_PICTURE}` }
  budget.total += bytes.length
  const rel = relative(dirname(reportPath), found)
  const inside = rel && !rel.startsWith('..') && !isAbsolute(rel)
  return {
    key,
    src: trimmed,
    path: found,
    copyAs: inside ? rel.split(sep).join('/') : null,
    bytes,
    sha256: sha256(bytes),
    ...type,
    error: null,
  }
}

// ------------------------------------------------------------------------------------------ the report
/** Decodes an HTML report: BOM / <meta charset> first, else UTF-8 if it is valid UTF-8, else Windows-1252. */
function loadHtml(bytes: Buffer) {
  let defaultEncoding = 'windows-1252'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    defaultEncoding = 'utf-8'
  } catch {
    /* not UTF-8: an older Windows export */
  }
  return cheerio.loadBuffer(bytes, { encoding: { defaultEncoding } })
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F (€, quotes, dashes); Node's decoder treats it as Latin-1.
const CP1252_HIGH =
  '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž�' +
  '�‘’“”•–—˜™š›œ�žŸ'

/** Decodes a text export: UTF-16 or UTF-8 (BOM or valid), else Windows-1252 (an older Windows export). */
function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    let s = ''
    for (const b of bytes) s += b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b)
    return s
  }
}

/** Parses report bytes. `reportPath` locates the images; nothing else is read from disk except them. */
export function parseReport(bytes: Buffer, reportPath: string, modified = new Date()): ParsedReport {
  const ext = extname(reportPath).toLowerCase()
  const format: ReportFormat = ext === '.txt' ? 'txt' : 'html'
  let events: ReportEvent[]
  let title: string | null = null
  if (format === 'html') {
    const $ = loadHtml(bytes)
    title = collapse($('title').first().text()) || null
    events = htmlToEvents($.root()[0] as unknown as DomNode)
  } else {
    events = textToEvents(decodeText(bytes))
  }
  const split = splitBlocks(events, { joinNameLines: format === 'txt' })
  const warnings: ReportWarning[] = []

  // Images: load each distinct src once, then work out which one is each holder's profile.
  const budget: ImageLoadBudget = { total: 0 }
  const images: ReportImage[] = []
  const indexBySrc = new Map<string, number>()
  const indexByKey = new Map<string, number>()
  const imageIndex = (src: string): number => {
    const known = indexBySrc.get(src)
    if (known !== undefined) return known
    const img = loadImage(src, reportPath, budget)
    let idx = indexByKey.get(img.key)
    if (idx === undefined) {
      idx = images.length
      images.push(img)
      indexByKey.set(img.key, idx)
    }
    indexBySrc.set(src, idx)
    return idx
  }
  const segments = [split.preambleImgs, ...split.blocks.map((b) => b.imgs)].map((srcs) => srcs.map(imageIndex))
  const inSegments = new Map<number, number>()
  for (const seg of segments) for (const idx of new Set(seg)) inSegments.set(idx, (inSegments.get(idx) ?? 0) + 1)
  const unique = segments.map((seg) => seg.filter((idx) => inSegments.get(idx) === 1))
  // Normally a holder's picture follows its "Holder:" label. If instead every picture precedes its label,
  // the first one sits before the first label and the last block has none — then take the previous segment's.
  const after = split.blocks.map((_, i) => unique[i + 1]![0] ?? null)
  const before = split.blocks.map((_, i) => unique[i]!.at(-1) ?? null)
  const count = (a: Array<number | null>) => a.filter((x) => x !== null).length
  const imageLayout = count(before) > count(after) ? 'before-label' : 'after-label'
  const assigned = imageLayout === 'before-label' ? before : after

  const holders: ParsedHolder[] = split.blocks.map((b, i) => {
    const raw = collapse(b.raw_name)
    const h: ParsedHolder = {
      seq: b.seq,
      raw_name: raw,
      cam_name: normaliseName(raw),
      tag: nameTag(raw),
      cam_comment: normaliseComment(b.comment),
      coupling: b.coupling,
      image: assigned[i] ?? null,
    }
    const who = { seq: h.seq, cam_name: h.cam_name || null }
    if (!h.cam_name) warnings.push({ ...who, message: `Holder block ${h.seq} has no name — skipped.` })
    if (h.image === null) {
      if (format === 'html') warnings.push({ ...who, message: 'No profile image found for this holder in the report.' })
    } else {
      const img = images[h.image]!
      if (img.error) {
        warnings.push({ ...who, message: `Profile image not imported: ${img.error}.` })
        h.image = null
      }
    }
    return h
  })
  if (format === 'txt' && holders.length)
    warnings.push({ seq: null, cam_name: null, message: 'A text export has no pictures — profile images are left as they are. Import the .html report to bring images in.' })

  return {
    path: reportPath,
    file: basename(reportPath),
    format,
    title,
    modified,
    bytes,
    holders,
    images,
    imageLayout,
    warnings,
  }
}

/**
 * Finds the report a person pointed at: strips the quotes Explorer's "Copy as path" adds, accepts a
 * file:// URL, and accepts the report's folder when it holds exactly one .html report.
 * Returns the absolute file path, or a plain-English reason it can't be used.
 */
export function findReport(input: string): { path: string } | { error: string } {
  let p = input.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim()
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p)
    } catch {
      p = safeDecode(p.replace(/^file:\/*/i, ''))
    }
  }
  // A relative path would resolve against wherever the app is installed — never what the person meant.
  if (!isAbsolute(p) && !isWindowsAbsolute(p)) return { error: 'Enter the full path of the report, starting with the drive letter (e.g. C:\\Users\\Public\\…).' }
  const full = resolve(p)
  let st
  try {
    st = statSync(full)
  } catch {
    return { error: `No file at ${full}. Check the path — the report is normally in C:\\Users\\Public\\Documents\\OPEN MIND\\tooldbReport\\<report name>\\.` }
  }
  if (st.isDirectory()) {
    const reports = readdirSync(full).filter((f) => /\.html?$/i.test(f))
    if (reports.length === 1) return findReport(join(full, reports[0]!))
    return {
      error: reports.length
        ? `That folder holds ${reports.length} reports (${reports.slice(0, 5).join(', ')}${reports.length > 5 ? '…' : ''}) — pick one file.`
        : 'That folder has no .html report in it — pick the report file itself.',
    }
  }
  if (!st.isFile()) return { error: `${full} is not a file.` }
  if (!/\.(html?|txt)$/i.test(full)) return { error: 'Pick the hyperMILL report itself: the .html file (or a .txt text export of it).' }
  if (st.size > MAX_REPORT_BYTES) return { error: 'That file is too large to be a hyperMILL holder report (over 50 MB).' }
  if (st.size === 0) return { error: 'That file is empty.' }
  return { path: full }
}

/** Reads and parses a report file found by findReport. */
export function readReportFile(path: string): ParsedReport {
  const st = statSync(path)
  return parseReport(readFileSync(path), path, st.mtime)
}
