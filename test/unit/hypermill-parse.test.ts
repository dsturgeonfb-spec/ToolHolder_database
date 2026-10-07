import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FIXTURES } from '../helpers.js'
import { findReport, parseCoupling, parseReport, readReportFile, type ParsedReport } from '../../src/server/hypermill/parse.js'

let dir: string
const PNG = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`fake image ${n}`)])
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-hm-parse-'))
  mkdirSync(join(dir, 'My Report_files'), { recursive: true })
  for (let n = 1; n <= 4; n++) writeFileSync(join(dir, 'My Report_files', `img ${n}.png`), PNG(n))
  writeFileSync(join(dir, 'My Report_files', 'logo.gif'), Buffer.from('GIF89a-logo'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

const REPORT = () => join(dir, 'My Report.html')
const parse = (html: string | Buffer, path = REPORT()) => parseReport(Buffer.isBuffer(html) ? html : Buffer.from(html, 'utf8'), path)
const imgOf = (r: ParsedReport, i: number) => {
  const idx = r.holders[i]!.image
  return idx === null ? null : r.images[idx]!
}
const header = `<table><tr><td><img src="My%20Report_files/logo.gif"></td><td>Tool Database</td><td>Holder</td><td>HSK63 HOLDERS</td></tr></table>`

test('label and value in separate cells, in one cell, any case, inline tags and &nbsp;', () => {
  const r = parse(`<html><head><title>T</title><style>td{}</style><script>var x = "Holder: (HSK63) NOT A HOLDER 1GL"</script></head><body>
    ${header}
    <table><tr><td>Holder:</td><td><font><b>(HSK63)&nbsp;HAIMER 6mm  STD SHRINK A63.140.06 80GL</b></font></td></tr>
    <tr><td>Holder comment</td><td>HAIMER 6mm STD SHRINK A63-140-06</td></tr>
    <tr><td>Coupling</td><td><table><tr><td>unknown</td><td>top</td><td></td></tr><tr><td>unknown</td><td>bottom</td><td></td></tr></table></td></tr>
    <tr><td colspan=2><img src="My%20Report_files/img%201.png"></td></tr></table>
    ${header}
    <p><span>HOLDER: (HSK63) HAIMER 8mm STD SHRINK A63.140.08 80GL</span></p><p>holder comment: lower case label</p>
    <img src="My%20Report_files/img%202.png">
  </body></html>`)
  assert.equal(r.format, 'html')
  assert.equal(r.title, 'T')
  assert.equal(r.holders.length, 2, 'the script text is not a holder')
  assert.equal(r.holders[0]!.cam_name, 'HAIMER 6mm STD SHRINK A63.140.06 80GL')
  assert.equal(r.holders[0]!.raw_name, '(HSK63) HAIMER 6mm STD SHRINK A63.140.06 80GL')
  assert.equal(r.holders[0]!.tag, 'HSK63')
  assert.equal(r.holders[0]!.cam_comment, 'HAIMER 6mm STD SHRINK A63-140-06')
  assert.deepEqual(r.holders[0]!.coupling, [
    { type: 'unknown', pos: 'top', class: '' },
    { type: 'unknown', pos: 'bottom', class: '' },
  ])
  assert.equal(r.holders[1]!.cam_name, 'HAIMER 8mm STD SHRINK A63.140.08 80GL')
  assert.equal(r.holders[1]!.cam_comment, 'lower case label')
  assert.equal(imgOf(r, 0)!.bytes!.toString('latin1').endsWith('fake image 1'), true)
  assert.equal(imgOf(r, 1)!.bytes!.toString('latin1').endsWith('fake image 2'), true)
  assert.equal(imgOf(r, 0)!.copyAs, 'My Report_files/img 1.png')
  assert.deepEqual(r.warnings, [])
  assert.equal(r.imageLayout, 'after-label')
})

test('empty comment: the next label follows, so the comment is null (not the coupling text)', () => {
  const r = parse(`${header}<table><tr><td>Holder:</td><td>(HSK63) KEMMLER A63.06.12.3 M12 ARBOR 126GL</td></tr>
    <tr><td>Holder comment</td><td></td></tr>
    <tr><td>Coupling</td><td>adaptor</td><td>top</td><td>SPINDLE 40TAPER</td></tr><tr><td></td><td>unknown</td><td>bottom</td><td></td></tr></table>
    <img src="My Report_files/img 1.png">`)
  assert.equal(r.holders[0]!.cam_comment, null)
  assert.deepEqual(r.holders[0]!.coupling, [
    { type: 'adaptor', pos: 'top', class: 'SPINDLE 40TAPER' },
    { type: 'unknown', pos: 'bottom', class: '' },
  ])
})

test('the repeated logo is never a profile; each block takes its first unique image', () => {
  const block = (n: number, img: string) =>
    `${header}<table><tr><td>Holder:</td><td>(HSK63) HAIMER X A63.140.0${n} 80GL</td></tr></table><img src="My%20Report_files/logo.gif"><img src="${img}">`
  const r = parse(block(3, 'My%20Report_files/img%201.png') + block(4, 'My%20Report_files/img%202.png') + block(6, 'My%20Report_files/img%203.png'))
  assert.deepEqual(
    r.holders.map((_, i) => imgOf(r, i)!.bytes!.toString('latin1').slice(-1)),
    ['1', '2', '3'],
  )
})

test('image src forms: backslashes, ./, file:// URL, query strings, absolute paths, data: URIs', () => {
  const abs = join(dir, 'My Report_files', 'img 4.png')
  const r = parse(
    [
      `Holder: (HSK63) A A63.140.03 80GL<img src="My Report_files\\img 1.png">`,
      `Holder: (HSK63) B A63.140.04 80GL<img src="./My%20Report_files/img%202.png?v=3#x">`,
      `Holder: (HSK63) C A63.140.06 80GL<img src="${pathToFileURL(join(dir, 'My Report_files', 'img 3.png')).href}">`,
      `Holder: (HSK63) D A63.140.08 80GL<img src="${abs}">`,
      `Holder: (HSK63) E A63.140.10 80GL<img src="data:image/png;base64,${PNG(5).toString('base64')}">`,
    ]
      .map((b) => `<div>${b}</div>`)
      .join(''),
  )
  assert.equal(r.holders.length, 5)
  for (let i = 0; i < 5; i++) assert.equal(imgOf(r, i)!.bytes!.toString('latin1').slice(-1), String(i + 1), `holder ${i + 1}`)
  assert.equal(imgOf(r, 4)!.path, null, 'embedded images are not files')
  assert.equal(imgOf(r, 4)!.mime, 'image/png')
  assert.deepEqual(r.warnings, [])
})

test('a report moved off the CAM PC: Windows paths and file:///C:/ URLs fall back to the _files folder', () => {
  const r = parse(
    `<p>Holder: (HSK63) A A63.140.03 80GL</p><img src="C:\\Users\\Public\\Documents\\OPEN MIND\\tooldbReport\\Holder_1\\My Report_files\\img 1.png">
     <p>Holder: (HSK63) B A63.140.04 80GL</p><img src="file:///C:/Users/Public/Documents/OPEN%20MIND/tooldbReport/Holder_1/My%20Report_files/img%202.png">`,
  )
  assert.equal(imgOf(r, 0)!.bytes!.toString('latin1').slice(-1), '1')
  assert.equal(imgOf(r, 1)!.bytes!.toString('latin1').slice(-1), '2')
})

test('pictures printed before their "Holder:" label are still matched to the right holder', () => {
  const r = parse(
    [1, 2, 3]
      .map((n) => `${header}<img src="My%20Report_files/img%20${n}.png"><table><tr><td>Holder:</td><td>(HSK63) HAIMER A63.140.0${n + 2} 80GL</td></tr></table>`)
      .join(''),
  )
  assert.equal(r.imageLayout, 'before-label')
  assert.deepEqual(
    r.holders.map((_, i) => imgOf(r, i)!.bytes!.toString('latin1').slice(-1)),
    ['1', '2', '3'],
  )
})

test('missing pictures and missing files are warnings, not failures', () => {
  const r = parse(`${header}<p>Holder: (HSK63) A A63.140.03 80GL</p><img src="My%20Report_files/nope.png">${header}<p>Holder: (HSK63) B A63.140.04 80GL</p>`)
  assert.equal(r.holders.length, 2)
  assert.equal(r.holders[0]!.image, null)
  assert.equal(r.holders[1]!.image, null)
  assert.match(r.warnings[0]!.message, /image not imported: image file not found/)
  assert.equal(r.warnings[0]!.seq, 1)
  assert.match(r.warnings[1]!.message, /No profile image/)
})

test('an <img> pointing at a file that is not a picture is not imported', () => {
  writeFileSync(join(dir, 'secret.png'), 'SQLite format 3\u0000 not a picture')
  const r = parse(`<p>Holder: (HSK63) A A63.140.03 80GL</p><img src="secret.png"><p>Holder: (HSK63) B A63.140.04 80GL</p><img src="data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}">`)
  assert.equal(r.holders[0]!.image, null)
  assert.equal(r.holders[1]!.image, null)
  assert.ok(r.images.every((i) => i.bytes === null), 'nothing kept in memory to serve or copy')
  assert.match(r.warnings[0]!.message, /not a PNG, JPEG, GIF, BMP or WebP picture/)
  assert.match(r.warnings[1]!.message, /embedded image is not a PNG/)
})

test('a bare "Holder" heading cell is not a holder; a bare "Holder" label before a name is', () => {
  const r = parse(`<table><tr><td>Report</td><td>Holder</td><td>HSK63 HOLDERS</td></tr></table>
    <table><tr><td>Holder</td><td>(HSK63) HAIMER A63.140.03 80GL</td></tr><tr><td>Holder comment</td><td>c</td></tr></table>`)
  assert.equal(r.holders.length, 1)
  assert.equal(r.holders[0]!.cam_name, 'HAIMER A63.140.03 80GL')
  assert.equal(r.holders[0]!.cam_comment, 'c')
})

test('labels that share one paragraph are split apart', () => {
  const r = parse(`<p>Holder: (HSK63) HAIMER A63.140.03 80GL Holder comment the comment Coupling unknown top unknown bottom</p>`)
  assert.equal(r.holders[0]!.cam_name, 'HAIMER A63.140.03 80GL')
  assert.equal(r.holders[0]!.cam_comment, 'the comment')
  assert.equal(r.holders[0]!.coupling.length, 2)
})

test('a holder label with no name is reported', () => {
  const r = parse(`<table><tr><td>Holder:</td><td></td></tr><tr><td>Holder comment</td><td>x</td></tr></table>`)
  assert.equal(r.holders.length, 1)
  assert.equal(r.holders[0]!.cam_name, '')
  assert.match(r.warnings.map((w) => w.message).join(' '), /has no name/)
})

test('encodings: Windows-1252 without a charset, and with a <meta charset>', () => {
  const body = Buffer.concat([Buffer.from('<p>Holder: (HSK63) HAIMER '), Buffer.from([0xd8]), Buffer.from('12 A63.140.12 90GL</p><p>Holder comment 4'), Buffer.from([0x96]), Buffer.from('5 mm</p>')])
  const r1 = parse(body)
  assert.equal(r1.holders[0]!.cam_name, 'HAIMER Ø12 A63.140.12 90GL')
  assert.equal(r1.holders[0]!.cam_comment, '4–5 mm')
  const r2 = parse(Buffer.concat([Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head><body>'), body]))
  assert.equal(r2.holders[0]!.cam_name, 'HAIMER Ø12 A63.140.12 90GL')
  const r3 = parse('<meta charset="utf-8"><p>Holder: (HSK63) HAIMER Ø12 A63.140.12 90GL</p>')
  assert.equal(r3.holders[0]!.cam_name, 'HAIMER Ø12 A63.140.12 90GL')
})

test('text export: wrapped names, footers on content lines, page headers, form feeds', () => {
  const txt = [
    '07/10/2026, 10:15        Holder_HSK63 HOLDERS',
    'hyperMILL Tool Database   Holder   HSK63 HOLDERS',
    'Holder:      (HSK63) CERATIZIT ER11 SLIM COLLET CHUCK',
    '             84719607 100GL',
    'Holder comment   CERATIZIT ER11 SLIM PRECISON COLLET CHUCK 84719607',
    'Coupling     adaptor    top     SPINDLE 40TAPER',
    '             unknown    bottom  file:///C:/Users/Public/Documents/OPEN MIND/tooldbReport/Holder_HSK63 HOLDERS_1/Holder_HSK63 HOLDERS.html   5/27',
    '\f07/10/2026, 10:15        Holder_HSK63 HOLDERS',
    'Holder:      (HSK63) KEMMLER A63.06.12.3 M12 ARBOR 126GL',
    'Holder comment',
    'Coupling     unknown top unknown           bottom',
    'hyperMILL Tool Database   Holder   HSK63 HOLDERS',
    '6/27',
  ].join('\r\n')
  const r = parseReport(Buffer.from(txt, 'utf8'), join(dir, 'report.txt'))
  assert.equal(r.format, 'txt')
  assert.equal(r.holders.length, 2)
  assert.equal(r.holders[0]!.cam_name, 'CERATIZIT ER11 SLIM COLLET CHUCK 84719607 100GL')
  assert.equal(r.holders[0]!.cam_comment, 'CERATIZIT ER11 SLIM PRECISON COLLET CHUCK 84719607')
  assert.deepEqual(r.holders[0]!.coupling, [
    { type: 'adaptor', pos: 'top', class: 'SPINDLE 40TAPER' },
    { type: 'unknown', pos: 'bottom', class: '' },
  ])
  assert.equal(r.holders[1]!.cam_name, 'KEMMLER A63.06.12.3 M12 ARBOR 126GL')
  assert.equal(r.holders[1]!.cam_comment, null)
  assert.deepEqual(r.holders[1]!.coupling, [
    { type: 'unknown', pos: 'top', class: '' },
    { type: 'unknown', pos: 'bottom', class: '' },
  ])
  assert.equal(r.holders[1]!.image, null)
  assert.equal(r.warnings.length, 1, 'one note that a text export has no pictures')
  // UTF-16 (Notepad "Unicode") exports read the same.
  const r16 = parseReport(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(txt, 'utf16le')]), join(dir, 'report.txt'))
  assert.equal(r16.holders[0]!.cam_name, r.holders[0]!.cam_name)
})

test('coupling rows', () => {
  assert.deepEqual(parseCoupling('unknown top unknown bottom'), [
    { type: 'unknown', pos: 'top', class: '' },
    { type: 'unknown', pos: 'bottom', class: '' },
  ])
  assert.deepEqual(parseCoupling('adaptor top SPINDLE 40TAPER unknown bottom'), [
    { type: 'adaptor', pos: 'top', class: 'SPINDLE 40TAPER' },
    { type: 'unknown', pos: 'bottom', class: '' },
  ])
  assert.deepEqual(parseCoupling('no positions here'), [])
})

test('the committed fixtures parse to 54 / 56 holders with byte-identical seed pictures', () => {
  const r54 = readReportFile(join(FIXTURES, 'hypermill', 'report_54.html'))
  assert.equal(r54.holders.length, 54)
  assert.deepEqual(r54.warnings, [])
  for (const [i, h] of r54.holders.entries()) {
    const seed = readFileSync(join(FIXTURES, '..', '..', 'images', 'cam', `cam_${String(i + 1).padStart(2, '0')}.png`))
    assert.ok(imgOf(r54, i)!.bytes!.equals(seed), `picture of holder ${h.seq}`)
  }
  assert.equal(readReportFile(join(FIXTURES, 'hypermill', 'report_changed.html')).holders.length, 56)
  const t54 = readReportFile(join(FIXTURES, 'hypermill', 'report_54.txt'))
  assert.deepEqual(
    t54.holders.map((h) => [h.cam_name, h.cam_comment]),
    r54.holders.map((h) => [h.cam_name, h.cam_comment]),
  )
})

test('findReport: quotes, folders, wrong files', () => {
  const one = join(dir, 'single')
  mkdirSync(one)
  writeFileSync(join(one, 'Holder_HSK63 HOLDERS.html'), '<p>Holder: x</p>')
  const found = findReport(`"${one}"`)
  assert.deepEqual(found, { path: join(one, 'Holder_HSK63 HOLDERS.html') })
  assert.match((findReport(join(FIXTURES, 'hypermill')) as { error: string }).error, /holds 2 reports/)
  assert.match((findReport(join(dir, 'nothing.html')) as { error: string }).error, /No file at/)
  assert.match((findReport(join(dir, 'My Report_files', 'img 1.png')) as { error: string }).error, /\.html file/)
  assert.deepEqual(findReport(pathToFileURL(join(one, 'Holder_HSK63 HOLDERS.html')).href), found)
  assert.match((findReport('Holder_HSK63 HOLDERS.html') as { error: string }).error, /full path/)
})
