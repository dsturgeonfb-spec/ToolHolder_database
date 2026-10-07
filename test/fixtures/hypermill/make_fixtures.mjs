// Generates the synthetic hyperMILL "Holder" reports the import tests use. Run from the repo root:
//   node test/fixtures/hypermill/make_fixtures.mjs
// and commit the output. Nobody has seen OPEN MIND's HTML, only the PDF printed from it, so these are
// "structurally plausible": a page header with the logo repeated for every holder, a label/value table
// per holder, coupling rows in a nested table, and the profile pictures in a "<report>_files/" folder.
//
// report_54.html / .txt   the 54 holders of data/raw/cam_holders_hypermill.json, pictures byte-identical
//                         copies of images/cam/cam_NN.png — importing it into the seeded DB changes nothing.
// report_changed.html/.txt one holder renamed (H0046), one CAM GL changed (H0049 90 → 95), one removed
//                         (H0037), a new HAIMER shrink chuck A63.140.14, a new holder from a maker not in the
//                         catalogue (NIKKEN) whose type can't be classified, and one block without an order no.
//                         Unchanged holders reuse report_54_files/; the new pictures are in report_changed_files/.
// images/alt_profile.png  a different profile picture, for the image-replacement tests.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const cam = JSON.parse(readFileSync(join(REPO, 'data', 'raw', 'cam_holders_hypermill.json'), 'utf8'))
const catalogue = JSON.parse(readFileSync(join(REPO, 'data', 'holders.json'), 'utf8'))
if (cam.length !== 54) throw new Error(`expected 54 hyperMILL holders, got ${cam.length}`)

// ------------------------------------------------------------------ a tiny PNG writer (no dependencies)
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** Greyscale PNG from a w×h array of 0–255 values. */
function png(w, h, px) {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = px[y * w + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
/** A hyperMILL-style outline drawing (300×200, white, black outline, dash-dot centre line). `top` = upper half outline. */
function profile(top) {
  const w = 300, h = 200, cy = 100
  const px = new Uint8Array(w * h).fill(255)
  const dot = (x, y) => {
    if (x >= 0 && x < w && y >= 0 && y < h) px[y * w + x] = 0
  }
  const line = (x0, y0, x1, y1) => {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      dot(x0, y0)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) (err += dy), (x0 += sx)
      if (e2 <= dx) (err += dx), (y0 += sy)
    }
  }
  for (let i = 0; i + 1 < top.length; i++) {
    const [x0, y0] = top[i], [x1, y1] = top[i + 1]
    line(x0, y0, x1, y1)
    line(x0, 2 * cy - y0, x1, 2 * cy - y1)
  }
  const [fx, fy] = top[0], [lx, ly] = top.at(-1)
  line(fx, fy, fx, 2 * cy - fy)
  line(lx, ly, lx, 2 * cy - ly)
  for (let x = 0; x < w; x++) if (x % 16 < 9 || x % 16 === 12) dot(x, cy)
  return png(w, h, px)
}
// HSK taper + flange with gripper groove, then the body to the nose.
const hsk = [[20, 52], [88, 46], [88, 34], [118, 34], [121, 41], [127, 41], [130, 34], [146, 34], [146, 64]]
const shrink80 = profile([...hsk, [262, 72], [262, 100]])
const blank90 = profile([...hsk, [150, 64], [150, 40], [282, 40], [282, 100]])
const spare75 = profile([...hsk, [158, 58], [246, 58], [252, 62], [252, 100]])
const altProfile = profile([...hsk, [200, 70], [276, 76], [276, 100]])
const logo = (() => {
  const w = 120, h = 32
  const px = new Uint8Array(w * h).fill(255)
  for (let y = 4; y < 28; y++) for (let x = 4; x < 116; x++) px[y * w + x] = (x - 4) % 22 < 16 ? 40 : 255
  return png(w, h, px)
})()

// ------------------------------------------------------------------ report content
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const pad2 = (n) => String(n).padStart(2, '0')
const imgSrc = (folder, file) => `${folder}/${encodeURIComponent(file)}`

// Coupling rows as the PDF shows them: "<type> top|bottom <class>".
const couplingOf = (c) => {
  const rows = [
    { type: 'unknown', pos: 'top', cls: '' },
    { type: 'unknown', pos: 'bottom', cls: '' },
  ]
  const odd = c.cam_coupling?.find((x) => x.type !== 'unknown')
  if (odd) rows[0] = { type: odd.type, pos: odd.pos, cls: odd.class }
  return rows
}

const base = cam.map((c) => ({
  name: c.cam_name,
  comment: c.cam_comment || '',
  coupling: couplingOf(c),
  img: { folder: 'report_54_files', file: `holder ${pad2(c.seq)}.png`, bytes: readFileSync(join(REPO, 'images', 'cam', c.cam_image)) },
}))

const inCatalogue = (order) => catalogue.some((h) => h.order_no === order)
for (const o of ['A63.140.14', '41234567']) if (inCatalogue(o)) throw new Error(`${o} is already in the catalogue — pick a free order no.`)

// Copies, so the edits below don't leak into report_54.
const changed = base.filter((h) => !h.name.includes('A63.144.08 ')).map((h) => ({ ...h })) // H0037 removed from hyperMILL
const byName = (needle) => {
  const h = changed.find((x) => x.name.includes(needle))
  if (!h) throw new Error(`no holder ${needle}`)
  return h
}
byName('A63.140.06 ').name = '(HSK63) HAIMER 6mm STD SHRINK FIT CHUCK A63.140.06 80GL' // H0046 renamed
byName('A63.140.12 ').name = '(HSK63) HAIMER 12mm STD SHRINK A63.140.12 95GL' // H0049 CAM GL 90 → 95
const unknownCoupling = [
  { type: 'unknown', pos: 'top', cls: '' },
  { type: 'unknown', pos: 'bottom', cls: '' },
]
changed.splice(changed.indexOf(byName('A63.140.12 ')) + 1, 0, {
  name: '(HSK63) HAIMER 14mm STD SHRINK A63.140.14 80GL',
  comment: 'HAIMER 14mm STD SHRINK A63-140-14',
  coupling: unknownCoupling,
  img: { folder: 'report_changed_files', file: 'holder 55.png', bytes: shrink80 },
})
changed.push(
  {
    name: '(HSK63) NIKKEN BLANK ADAPTOR 41234567 90GL',
    comment: 'NIKKEN HSK63A blank for special tools',
    coupling: unknownCoupling,
    img: { folder: 'report_changed_files', file: 'holder 56.png', bytes: blank90 },
  },
  {
    name: '(HSK63) SPARE HOLDER CELL 3 75GL',
    comment: '',
    coupling: unknownCoupling,
    img: { folder: 'report_changed_files', file: 'holder 57.png', bytes: spare75 },
  },
)

// ------------------------------------------------------------------ HTML
function html(title, holders) {
  const blocks = holders.map(
    (h) => `<div class="item">
<table class="header" width="100%" cellspacing="0" cellpadding="2">
  <tr><td class="logo"><img src="report_54_files/openmind_logo.png" width="120" height="32" alt="OPEN MIND"></td>
      <td class="title">hyperMILL&reg; Tool Database</td><td class="kind">Holder</td><td class="db">HSK63 HOLDERS</td></tr>
</table>
<table class="data" cellspacing="0" cellpadding="3">
  <tr><td class="label">Holder:</td><td class="value"><b>${esc(h.name)}</b></td></tr>
  <tr><td class="label">Holder comment</td><td class="value">${esc(h.comment)}</td></tr>
  <tr><td class="label">Coupling</td><td class="value">
    <table class="coupling" cellspacing="0" cellpadding="1">
${h.coupling.map((c) => `      <tr><td>${esc(c.type)}</td><td>${esc(c.pos)}</td><td>${esc(c.cls)}</td></tr>`).join('\n')}
    </table></td></tr>
  <tr><td class="graphic" colspan="2"><img src="${imgSrc(h.img.folder, h.img.file)}" width="300" height="200" alt=""></td></tr>
</table>
</div>`,
  )
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<!-- Synthetic test fixture shaped like the OPEN MIND hyperMILL tool database "Holder" report. Generated by make_fixtures.mjs. -->
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${esc(title)}</title>
<style type="text/css">
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; }
  table.header { border-bottom: 2px solid #1a3d6d; margin-top: 12px; }
  td.title { font-size: 14pt; font-weight: bold; }
  td.label { font-weight: bold; width: 140px; vertical-align: top; }
  .item { page-break-inside: avoid; }
</style>
<script type="text/javascript">/* Holder: not a holder — scripts are ignored */</script>
</head>
<body>
${blocks.join('\n')}
</body>
</html>
`
}

// ------------------------------------------------------------------ pdftotext-style text export
function text(holders) {
  const pages = []
  const footer = (n, of) => `file:///C:/Users/Public/Documents/OPEN MIND/tooldbReport/Holder_HSK63 HOLDERS_1/Holder_HSK63 HOLDERS.html   ${n}/${of}`
  const of = Math.ceil(holders.length / 2)
  for (let p = 0; p < of; p++) {
    const lines = ['07/10/2026, 10:15                                         Holder_HSK63 HOLDERS', '']
    for (const [k, h] of holders.slice(p * 2, p * 2 + 2).entries()) {
      lines.push('hyperMILL® Tool Database                Holder              HSK63 HOLDERS', '')
      // Long names wrap in the PDF; the parser joins the continuation line.
      if (h.name.length > 46) {
        const cut = h.name.lastIndexOf(' ', 40)
        lines.push(`Holder:              ${h.name.slice(0, cut)}`, `                     ${h.name.slice(cut + 1)}`)
      } else lines.push(`Holder:              ${h.name}`)
      lines.push(`Holder comment       ${h.comment}`)
      const [top, bottom] = h.coupling
      lines.push(`Coupling             ${top.type}           ${top.pos}         ${top.cls}`.trimEnd())
      const last = `                     ${bottom.type}           ${bottom.pos}         ${bottom.cls}`.trimEnd()
      // As in the real PDF, the page footer can land on the same line as the last coupling row.
      lines.push(k === 1 && p % 5 === 2 ? `${last}  ${footer(p + 1, of)}` : last, '', '')
    }
    if (p % 5 !== 2) lines.push(footer(p + 1, of))
    pages.push(lines.join('\n'))
  }
  return pages.join('\n\f')
}

// ------------------------------------------------------------------ write
for (const d of ['report_54_files', 'report_changed_files', 'images']) {
  rmSync(join(HERE, d), { recursive: true, force: true })
  mkdirSync(join(HERE, d), { recursive: true })
}
writeFileSync(join(HERE, 'report_54_files', 'openmind_logo.png'), logo)
for (const h of [...base, ...changed]) writeFileSync(join(HERE, h.img.folder, h.img.file), h.img.bytes)
for (const h of base) {
  const src = readFileSync(join(HERE, h.img.folder, h.img.file))
  if (!src.equals(h.img.bytes)) throw new Error('image copy is not byte-identical')
}
writeFileSync(join(HERE, 'images', 'alt_profile.png'), altProfile)
writeFileSync(join(HERE, 'report_54.html'), html('Holder_HSK63 HOLDERS', base))
writeFileSync(join(HERE, 'report_changed.html'), html('Holder_HSK63 HOLDERS', changed))
writeFileSync(join(HERE, 'report_54.txt'), text(base))
writeFileSync(join(HERE, 'report_changed.txt'), text(changed))
console.log(`report_54: ${base.length} holders · report_changed: ${changed.length} holders`)
