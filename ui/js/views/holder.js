// Holder record (#/holder/<id>): everything the catalogue knows about one article, laid out for an engineer —
// identity and provenance, hyperMILL profile vs maker data, stock by location, the ledger, issues, serialised
// units, want list and the change history. Also exports the add/edit form for catalogue data, which the
// catalogue view reuses, and small formatting helpers shared with it.
import { esc, fmtDate, sevChip, statusChip, rulerHTML, toast, toastError, kvHTML, DATA_STATUS_LABEL } from '../ui.js'
import { api } from '../api.js'
import { state } from '../state.js'
import { openStockAction } from '../components/stock-actions.js'
import { raiseFlagDialog, closeFlagDialog } from '../components/flag-actions.js'
import { addUnitDialog } from '../components/unit-actions.js'
import { addToWantListDialog } from '../components/want-actions.js'

// ---------------------------------------------------------------- shared helpers

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
/** A length in mm: up to 3 decimals (a 6.35 mm shank must not show as 6.4), '–' when empty. */
export const mm = (v) => (isNum(v) ? String(Math.round(Number(v) * 1000) / 1000) : '–')

/** Only http(s) links are ever rendered as links — anything else (javascript:, file:) is shown as text or dropped. */
export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null)
export function extLink(u, text) {
  const s = safeUrl(u)
  return s ? `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>` : ''
}

/** Provenance chip: data status, with the source and last-checked date on hover. */
export function dataStatusChip(h) {
  const label = DATA_STATUS_LABEL[h.data_status] || h.data_status || 'Unknown'
  const title = [h.data_source ? `Source: ${h.data_source}` : 'No source recorded', h.last_checked ? `last checked ${fmtDate(h.last_checked)}` : '']
    .filter(Boolean)
    .join(' · ')
  return `<span class="chip ds-${esc(h.data_status)}" title="${esc(title)}">${esc(label)}</span>`
}

/** Maker spigot length (Haimer "L length (spigot)") — explains the face-mill-arbor GL convention. */
export function spigotLength(dims) {
  for (const [k, v] of Object.entries(dims || {})) if (/spigot/i.test(k) && /(^L\b|length)/i.test(k) && isNum(v)) return Number(v)
  return null
}

/** Maker GL vs hyperMILL GL in plain English (BUILD_SPEC §3: maker GL is flange face to nose). */
export function glExplanation(h) {
  const gl = isNum(h.gauge_length_mm) ? Number(h.gauge_length_mm) : null
  const cgl = isNum(h.cam_gl_mm) ? Number(h.cam_gl_mm) : null
  if (gl == null && cgl == null) return { kind: 'none', text: 'No gauge length recorded yet.' }
  if (cgl == null) return { kind: 'nocam', text: 'Not in the hyperMILL tool database, so there is no CAM gauge length to compare.' }
  if (gl == null) return { kind: 'nomaker', text: 'No maker gauge length recorded — only the hyperMILL value is known.' }
  const d = Math.round((cgl - gl) * 1000) / 1000
  if (d === 0) return { kind: 'same', delta: 0, text: 'hyperMILL uses the same gauge length as the maker.' }
  if (h.type_code === 'FACE_MILL_ARBOR') {
    const sp = spigotLength(h.dims)
    if (sp != null && Math.abs(sp - d) < 0.01)
      return {
        kind: 'arbor',
        delta: d,
        text: `Face-mill arbor convention: the maker's A is measured to the cutter seating face; hyperMILL measures to the end of the spigot, so its GL = A + spigot length (${mm(gl)} + ${mm(sp)} = ${mm(cgl)} mm). Confirm which face hyperMILL references — otherwise clearance checks are out by ${mm(sp)} mm.`,
      }
    return { kind: 'arbor', delta: d, text: `Face-mill arbor: hyperMILL's GL differs from the maker's A by ${mm(Math.abs(d))} mm — it may measure to the end of the spigot. Check which face hyperMILL references.` }
  }
  return { kind: 'diff', delta: d, text: `hyperMILL's gauge length is ${mm(Math.abs(d))} mm ${d > 0 ? 'longer' : 'shorter'} than the maker's. Check the holder model in hyperMILL and raise an issue if it is wrong.` }
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------- add / edit form

const NUMBER_FIELDS = { clamp_dia_mm: 'Nominal Ø', clamp_min_mm: 'Clamp min Ø', clamp_max_mm: 'Clamp max Ø', gauge_length_mm: 'Gauge length', nose_dia_mm: 'Nose Ø', max_rpm: 'Max rpm', mass_kg: 'Mass' }
const TEXT_FIELDS = ['order_no', 'spec_code', 'product_name', 'series', 'clamp_spec', 'gauge_length_ref', 'coolant', 'balance', 'product_url', 'image_url', 'drawing_url', 'notes']
const SELECT_FIELDS = ['manufacturer', 'type_code', 'interface_code', 'data_status']

function dimsToText(dims) {
  return Object.entries(dims || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}
/** "label: value" per line → object. Plain numbers become numbers; codes like "0220" stay text. */
function textToDims(text) {
  const out = {}
  const lines = String(text || '').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (!line.trim()) return
    const at = line.indexOf(':')
    if (at <= 0) throw new Error(`Maker dimensions, line ${i + 1}: write it as "label: value", e.g. "D2: 44".`)
    const k = line.slice(0, at).trim()
    const v = line.slice(at + 1).trim()
    if (!v) return
    out[k] = /^-?(0|[1-9]\d*)([.,]\d+)?$/.test(v) ? Number(v.replace(',', '.')) : v
  })
  return out
}
function parseNumber(raw, label) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = Number(s.replace(',', '.'))
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number in mm (got "${s}").`)
  return n
}

function fieldHTML(f, value) {
  const id = `hf-${f.name}`
  const v = value ?? ''
  const cls = `fld${f.required ? ' req' : ''}${f.wide ? ' wide' : ''}`
  let input
  if (f.type === 'select') {
    input = `<select id="${id}" name="${f.name}">${f.blank ? `<option value="">${esc(f.blank)}</option>` : ''}${f.options
      .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select>`
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.name}" class="${f.mono ? 'mono' : ''}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>${esc(v)}</textarea>`
  } else {
    const num = f.type === 'number'
    input = `<input id="${id}" name="${f.name}" type="${num ? 'text' : f.type || 'text'}" ${num ? 'inputmode="decimal"' : ''} class="${f.mono ? 'mono' : ''}"
      value="${esc(v)}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.list ? `list="${f.list}"` : ''} autocomplete="off">`
  }
  return `<label class="${cls}" for="${id}" data-field="${f.name}"><span>${esc(f.label)}</span>${input}${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`
}

/** Options for a select, always including the record's current value — a select that silently fell back to its
 *  first option would turn "save notes" into "change maker". */
function withCurrent(options, current) {
  if (current && !options.some((o) => String(o.value) === String(current))) return [{ value: current, label: current }, ...options]
  return options
}

function formSections(meta, mode, h) {
  const makers = withCurrent((meta?.manufacturers || []).map((m) => ({ value: m.name, label: m.is_distributor ? `${m.name} (distributor)` : m.name })), h?.manufacturer)
  const types = withCurrent((meta?.types || []).map((t) => ({ value: t.type_code, label: t.type_name })), h?.type_code)
  const ifaces = withCurrent((meta?.interfaces || []).map((i) => ({ value: i.interface_code, label: i.interface_code })), h?.interface_code)
  const statuses = Object.entries(DATA_STATUS_LABEL).map(([value, label]) => ({ value, label }))
  return [
    {
      legend: 'Identity',
      fields: [
        { name: 'manufacturer', label: 'Maker', type: 'select', required: true, options: makers, blank: mode === 'add' ? 'Pick the maker…' : '' },
        { name: 'order_no', label: 'Order no.', required: true, mono: true, help: 'Exactly as the maker prints it' },
        { name: 'type_code', label: 'Holder type', type: 'select', required: true, options: types, blank: mode === 'add' ? 'Pick the type…' : '' },
        { name: 'interface_code', label: 'Interface (taper)', type: 'select', required: true, options: ifaces },
        { name: 'spec_code', label: 'Spec code / designation', mono: true },
        { name: 'product_name', label: 'Product name' },
        { name: 'series', label: 'Series' },
      ],
    },
    {
      legend: 'Clamping (tool side)',
      fields: [
        { name: 'clamp_dia_mm', label: 'Nominal Ø (mm)', type: 'number', help: 'Shrink, hydraulic, arbor spigot: min and max follow this Ø' },
        { name: 'clamp_min_mm', label: 'Clamp min Ø (mm)', type: 'number', help: 'Collet / drill chucks: the range' },
        { name: 'clamp_max_mm', label: 'Clamp max Ø (mm)', type: 'number', help: 'Screw-in and tap chucks: leave both empty' },
        { name: 'clamp_spec', label: 'Clamping text', placeholder: 'e.g. ER32 · 2–20 mm' },
      ],
    },
    {
      legend: 'Geometry',
      fields: [
        { name: 'gauge_length_mm', label: 'Gauge length (mm)', type: 'number', help: 'HSK gauge line (flange face) to the holder nose' },
        { name: 'gauge_length_ref', label: 'Maker label for GL', list: 'hf-glref', placeholder: 'A, l1, LPR' },
        { name: 'nose_dia_mm', label: 'Nose Ø (mm)', type: 'number', help: 'Front-most outer Ø — used for collision checks' },
      ],
    },
    {
      legend: 'Performance',
      fields: [
        { name: 'coolant', label: 'Coolant' },
        { name: 'balance', label: 'Balance', placeholder: 'e.g. G2.5 at 25,000 rpm' },
        { name: 'max_rpm', label: 'Max rpm', type: 'number' },
        { name: 'mass_kg', label: 'Mass (kg)', type: 'number' },
      ],
    },
    {
      legend: 'Maker links',
      fields: [
        { name: 'product_url', label: 'Maker page', type: 'url', placeholder: 'https://…', wide: true },
        { name: 'image_url', label: 'Product photo', type: 'url', placeholder: 'https://…' },
        { name: 'drawing_url', label: 'Drawing', type: 'url', placeholder: 'https://…' },
      ],
    },
    {
      legend: 'All maker dimensions',
      fields: [{ name: 'dims', label: 'One per line, label: value', type: 'textarea', mono: true, wide: true, placeholder: 'D1: 25\nD2: 44\nA: 100' }],
    },
    {
      legend: 'Provenance',
      fields: [
        { name: 'data_status', label: 'Data status', type: 'select', options: statuses },
        {
          name: 'data_source',
          label: 'Data source',
          required: mode === 'add',
          wide: true,
          placeholder: mode === 'add' ? 'Maker page URL, or catalogue + page no.' : h?.data_source ? `Now: ${h.data_source}` : 'Maker page URL, or catalogue + page no.',
          help: mode === 'add' ? 'Where these values came from — required (catalogue values come only from maker pages or catalogues).' : 'Where the new values came from. Required when you change anything except the notes.',
        },
        { name: 'notes', label: 'Notes', type: 'textarea', wide: true },
      ],
    },
  ]
}

/** Current form values, parsed: numbers as numbers (or null), dims as an object. Throws a plain message. */
function readHolderForm(form) {
  const v = {}
  const get = (n) => form.elements.namedItem(n)?.value ?? ''
  for (const n of SELECT_FIELDS) v[n] = get(n).trim()
  for (const n of TEXT_FIELDS) v[n] = get(n).trim()
  for (const [n, label] of Object.entries(NUMBER_FIELDS)) v[n] = parseNumber(get(n), label)
  if (v.max_rpm != null && !Number.isInteger(v.max_rpm)) throw new Error('Max rpm must be a whole number.')
  v.dimsText = get('dims')
  v.dims = textToDims(v.dimsText)
  v.data_source = get('data_source').trim()
  return v
}

const sameLines = (a, b) => {
  const norm = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n')
  return norm(a) === norm(b)
}

/** Fields that differ from the holder as loaded. Values are what PATCH should receive (null clears). */
function diffHolder(h, v) {
  const out = {}
  const txt = (x) => (x === null || x === undefined ? '' : String(x).trim())
  if (v.manufacturer !== h.manufacturer) out.manufacturer = v.manufacturer
  for (const n of ['type_code', 'interface_code', 'data_status']) if (v[n] !== txt(h[n])) out[n] = v[n]
  for (const n of TEXT_FIELDS) if (v[n] !== txt(h[n])) out[n] = v[n] || null
  for (const n of Object.keys(NUMBER_FIELDS)) {
    const was = isNum(h[n]) ? Number(h[n]) : null
    if (was !== v[n]) out[n] = v[n]
  }
  // Compare the text as shown, so untouched dimensions are never re-typed (e.g. "25" text vs 25 number).
  if (!sameLines(v.dimsText, dimsToText(h.dims))) out.dims = Object.keys(v.dims).length ? v.dims : null
  return out
}

/**
 * Add a holder from a maker catalogue, or edit one's catalogue data.
 * mode 'add': POST /api/holders. mode 'edit': PATCH with only the changed fields, plus the data source.
 * Resolves with the saved Holder, or null if cancelled. The caller makes sure a user is chosen first.
 */
export function holderFormDialog({ mode = 'add', holder = null, meta = state.meta, preset = {} } = {}) {
  return new Promise((resolve) => {
    const h = holder
    const init =
      mode === 'edit'
        ? { ...h, dims: dimsToText(h.dims), data_source: '' }
        : { interface_code: meta?.settings?.default_interface || 'HSK-A63', data_status: 'unverified', ...preset }
    const sections = formSections(meta, mode, h)
    const fid = 'hf' + Math.random().toString(36).slice(2, 8)
    const title = mode === 'edit' ? `Edit catalogue data — ${h.manufacturer} ${h.order_no}` : 'Add a holder from a maker catalogue'
    const intro =
      mode === 'edit'
        ? 'Change only what the maker page or catalogue says. Every changed field is logged with your name and the data source; stock is not affected.'
        : 'For an article that is not in the catalogue yet. Enter the values from the maker page or catalogue — stock is booked separately (receipt or count).'
    const d = document.createElement('dialog')
    d.className = 'dlg wide hf-dlg'
    d.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      <div class="dlg-body"><form class="form hf-form" id="${fid}" novalidate>
        <p class="note" style="margin:0">${esc(intro)}</p>
        ${sections
          .map((s) => `<fieldset class="hf-sec"><legend>${esc(s.legend)}</legend><div class="hf-grid">${s.fields.map((f) => fieldHTML(f, init[f.name])).join('')}</div></fieldset>`)
          .join('')}
        <datalist id="hf-glref"><option value="A"><option value="l1"><option value="LPR"></datalist>
        <div class="errorbox hidden" data-err role="alert"></div>
      </form></div>
      <div class="dlg-foot"><span class="spacer tiny muted" data-diff></span><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="submit" form="${fid}">${mode === 'edit' ? 'Save changes' : 'Add holder'}</button></div>`
    document.body.appendChild(d)
    const form = d.querySelector('form')
    const err = d.querySelector('[data-err]')
    const diffLine = d.querySelector('[data-diff]')
    const submit = d.querySelector('button[type=submit]')
    let result = null
    const showErr = (html) => {
      err.innerHTML = html
      err.classList.remove('hidden')
      err.scrollIntoView({ block: 'nearest' })
    }

    // Edit: mark changed fields as they are edited, so the person sees exactly what will be logged.
    const markChanges = () => {
      if (mode !== 'edit') return
      let changed = {}
      try {
        changed = diffHolder(h, readHolderForm(form))
      } catch {
        return
      }
      d.querySelectorAll('[data-field]').forEach((el) => el.classList.toggle('changed', el.dataset.field in changed))
      const n = Object.keys(changed).length
      diffLine.textContent = n ? `${plural(n, 'field')} changed` : ''
      const needSource = Object.keys(changed).some((k) => k !== 'notes')
      d.querySelector('[data-field="data_source"]').classList.toggle('req', needSource)
    }
    form.addEventListener('input', markChanges)
    form.addEventListener('change', markChanges)

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      err.classList.add('hidden')
      let payload
      try {
        const v = readHolderForm(form)
        if (mode === 'add') {
          const missing = [['manufacturer', 'Maker'], ['order_no', 'Order no.'], ['type_code', 'Holder type'], ['interface_code', 'Interface'], ['data_source', 'Data source']]
            .filter(([n]) => !v[n])
            .map(([, l]) => l)
          if (missing.length) throw new Error(`Fill in: ${missing.join(', ')}.`)
          payload = {}
          for (const [k, val] of Object.entries(v)) {
            if (k === 'dimsText') continue
            if (k === 'dims') {
              if (Object.keys(val).length) payload.dims = val
            } else if (val !== null && val !== '') payload[k] = val
          }
        } else {
          payload = diffHolder(h, v)
          const keys = Object.keys(payload)
          if (!keys.length && !v.data_source) throw new Error('Nothing has changed — edit a value first, or press Cancel.')
          if (keys.some((k) => k !== 'notes') && !v.data_source)
            throw new Error('Say where the new values came from (Data source) — every catalogue change is recorded with its source. Only notes can change without one.')
          if (v.data_source) payload.data_source = v.data_source
        }
      } catch (e) {
        showErr(esc(e.message))
        return
      }
      submit.disabled = true
      try {
        result =
          mode === 'add' ? await api.post('/api/holders', payload) : await api.patch('/api/holders/' + encodeURIComponent(h.holder_id), payload)
        d.close('ok')
      } catch (e) {
        const other = e.details && e.details.holder_id
        showErr(esc(e.message) + (other ? ` <a href="#/holder/${encodeURIComponent(other)}" data-open-existing>Open ${esc(other)}</a>` : ''))
      } finally {
        submit.disabled = false
      }
    })
    d.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-close]')) d.close('cancel')
      if (ev.target.closest('[data-open-existing]')) d.close('cancel')
    })
    d.addEventListener('close', () => {
      setTimeout(() => d.remove(), 0)
      resolve(d.returnValue === 'ok' ? result : null)
    })
    d.showModal()
    const first = mode === 'edit' ? form.querySelector('[name="gauge_length_mm"]') : form.querySelector('select,input')
    if (first) first.focus()
  })
}

// ---------------------------------------------------------------- the record view

const TXN_LABEL = {
  OPENING_BALANCE: 'Opening balance',
  COUNT_ADJUST: 'Count',
  RECEIPT: 'Receipt',
  MOVE_OUT: 'Move out',
  MOVE_IN: 'Move in',
  SCRAP: 'Scrap',
  RETURN: 'Return',
}
const FIELD_LABEL = {
  '*': 'Record created',
  manufacturer: 'Maker',
  order_no: 'Order no.',
  spec_code: 'Spec code',
  product_name: 'Product name',
  series: 'Series',
  type_code: 'Holder type',
  interface_code: 'Interface',
  clamp_dia_mm: 'Nominal Ø',
  clamp_min_mm: 'Clamp min Ø',
  clamp_max_mm: 'Clamp max Ø',
  clamp_spec: 'Clamping text',
  gauge_length_mm: 'Gauge length',
  gauge_length_ref: 'GL label',
  cam_gl_mm: 'hyperMILL GL',
  nose_dia_mm: 'Nose Ø',
  dims_json: 'Maker dimensions',
  coolant: 'Coolant',
  balance: 'Balance',
  max_rpm: 'Max rpm',
  mass_kg: 'Mass',
  product_url: 'Maker page',
  image_url: 'Photo URL',
  drawing_url: 'Drawing URL',
  cam_image: 'hyperMILL image',
  cam_name: 'hyperMILL name',
  cam_comment: 'hyperMILL comment',
  data_status: 'Data status',
  data_source: 'Data source',
  notes: 'Notes',
}
const UNIT_CHIP = { IN_SERVICE: ['counted', 'In service'], QUARANTINE: ['HIGH', 'Quarantine'], SCRAPPED: ['none', 'Scrapped'] }

let active = null
export function teardown() {
  if (active) active.dead = true
  active = null
}

export async function render(root, ctx) {
  const me = { dead: false }
  active = me
  const id = ctx.params[0]
  root.innerHTML = '<div class="hv"><div class="loading">Loading…</div></div>'
  const el = root.firstElementChild
  if (!id) {
    el.innerHTML = `<div class="warnbox">No holder chosen. <a href="#/catalogue">Go to the catalogue</a> and pick one.</div>`
    return
  }
  let h = null
  let busy = false

  async function load() {
    try {
      const data = await api.get('/api/holders/' + encodeURIComponent(id))
      if (me.dead) return
      h = data
      const y = window.scrollY
      el.innerHTML = pageHTML(h)
      window.scrollTo(0, y)
    } catch (e) {
      if (me.dead) return
      el.innerHTML =
        e.status === 404
          ? `<div class="warnbox"><strong>Holder ${esc(id)} is not in the catalogue.</strong> The link may be old or mistyped.
             <a href="#/catalogue">Back to the catalogue</a> to search by order no.</div>`
          : `<div class="errorbox">The holder record could not be loaded: ${esc(e.message)}
             <button class="btn sm ghost" type="button" data-act="retry">Try again</button></div>`
    }
  }

  /** Runs a write (a dialog owned by this or another module); a truthy result reloads the record and the header. */
  async function write(fn) {
    if (busy || !h) return
    const who = await ctx.ensureUser()
    if (!who) return
    busy = true
    try {
      const res = await fn()
      if (res && !me.dead) {
        await load()
        ctx.refreshSummary()
      }
    } catch (e) {
      toastError(e)
    } finally {
      busy = false
    }
  }

  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]')
    if (!b || !el.contains(b)) return
    const act = b.dataset.act
    if (act === 'retry') {
      el.innerHTML = '<div class="loading">Loading…</div>'
      load()
    } else if (act === 'edit')
      write(async () => {
        const saved = await holderFormDialog({ mode: 'edit', holder: h, meta: state.meta || (await api.get('/api/meta')) })
        if (saved) toast('Catalogue data saved — changes are in the history below.', 'ok')
        return saved
      })
    else if (act === 'raise-flag') write(() => raiseFlagDialog(h))
    else if (act === 'close-flag') {
      const flag = (h.flags || []).find((f) => String(f.flag_id) === b.dataset.flag)
      if (flag) write(() => closeFlagDialog({ ...flag, manufacturer: h.manufacturer, order_no: h.order_no }))
    } else if (act === 'want') write(() => addToWantListDialog(h))
    else if (act === 'add-unit') write(() => addUnitDialog(h))
    else if (act === 'stock') {
      const opts = b.dataset.loc ? { locationId: Number(b.dataset.loc) } : {}
      write(() => openStockAction(b.dataset.kind, h, opts))
    } else if (act === 'goto') document.getElementById(b.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  await load()
}

function pageHTML(h) {
  const hid = encodeURIComponent(h.holder_id)
  const label = `${h.manufacturer} ${h.order_no}`
  const issuesChip = h.open_issues
    ? `<button type="button" class="chip ${esc(h.worst_severity)} flagbtn" data-act="goto" data-target="hv-flags">${plural(h.open_issues, 'open issue')}</button>`
    : ''
  const counted = h.last_count_date ? `<span class="chip src" title="Last physical count">counted ${esc(fmtDate(h.last_count_date))}</span>` : ''
  const sub = [h.series, h.product_name && h.product_name !== h.series ? h.product_name : null].filter(Boolean)
  return `
  <nav class="hv-crumbs"><a href="#/catalogue">← Catalogue</a></nav>
  <header class="card hv-head">
    <div class="hv-title">
      <span class="eyebrow">${esc(h.manufacturer)}${h.is_distributor ? ' (distributor)' : ''} · ${esc(h.type_name || h.type_code)} · ${esc(h.interface_code)}</span>
      <h2>${esc(h.order_no)}</h2>
      ${sub.length ? `<p class="hv-sub">${sub.map(esc).join(' — ')}</p>` : ''}
      ${h.spec_code ? `<p class="hv-spec">${esc(h.spec_code)}</p>` : ''}
      <div class="hv-chips">${dataStatusChip(h)}${statusChip(h.count_status)}${counted}
        ${h.is_distributor ? '<span class="tag warn" title="Distributor SKU — the maker order no. may differ">Distributor SKU</span>' : ''}
        ${issuesChip}${h.on_want_list ? `<span class="chip src">${h.on_want_list} on want list</span>` : ''}</div>
      <p class="tiny muted" style="margin:2px 0 0">Data: ${esc(h.data_source || 'no source recorded')}${h.last_checked ? ` · last checked ${esc(fmtDate(h.last_checked))}` : ''} · ${esc(h.holder_id)}</p>
    </div>
    <div class="hv-stock"><span class="v">${esc(h.qty_on_site)}</span><span class="k">on site</span></div>
    <div class="hv-actions">
      <a class="btn" href="#/count?holder=${hid}">Count</a>
      <button class="btn ghost" type="button" data-act="edit">Edit catalogue data</button>
      <button class="btn ghost" type="button" data-act="raise-flag">Raise issue</button>
      <button class="btn ghost" type="button" data-act="want">Add to want list</button>
    </div>
  </header>

  <div class="hv-grid">
    <section class="card hv-media" aria-label="Pictures and links">
      ${
        h.cam_image
          ? `<div class="hv-prof"><img src="/${esc(String(h.cam_image).replace(/^\/+/, ''))}" alt="hyperMILL holder profile of ${esc(label)}"></div><span class="eyebrow">hyperMILL holder profile</span>`
          : `<div class="hv-prof none">No hyperMILL model — this article is not in the CAM tool database.</div>`
      }
      ${h.vendor_image ? `<div class="hv-photo"><img src="${esc(h.vendor_image)}" alt="Maker photo of ${esc(label)}"></div><span class="eyebrow">Maker photo (cached copy)</span>` : ''}
      <div class="links">${extLink(h.product_url, 'Maker page')}${extLink(h.image_url, 'Photo')}${extLink(h.drawing_url, 'Drawing')}${
        !safeUrl(h.product_url) && !safeUrl(h.image_url) && !safeUrl(h.drawing_url) ? '<span class="muted small">No maker links recorded.</span>' : ''
      }</div>
    </section>
    <section class="card" aria-label="Catalogue data">
      ${glHTML(h)}
      ${kvHTML(detailRows(h))}
    </section>
  </div>

  <section class="card" aria-labelledby="hv-dims-h">
    <div class="hv-sec-head"><h3 id="hv-dims-h">All maker dimensions</h3><span class="tiny muted">as printed by the maker (labels kept)</span></div>
    ${dimsHTML(h.dims)}
  </section>

  <section class="card" aria-labelledby="hv-stock-h">
    <div class="hv-sec-head"><h3 id="hv-stock-h">Stock by location</h3>
      <div class="btnrow">
        <button class="btn sm" type="button" data-act="stock" data-kind="receipt">Book receipt</button>
        <button class="btn sm ghost" type="button" data-act="stock" data-kind="return">Return</button>
        <a class="btn sm ghost" href="#/count?holder=${hid}">Count</a>
      </div></div>
    ${stockHTML(h)}
  </section>

  <section class="card" id="hv-flags" aria-labelledby="hv-flags-h">
    <div class="hv-sec-head"><h3 id="hv-flags-h">Issues</h3><button class="btn sm ghost" type="button" data-act="raise-flag">Raise issue</button></div>
    ${flagsHTML(h.flags || [])}
  </section>

  <section class="card" aria-labelledby="hv-txn-h">
    <div class="hv-sec-head"><h3 id="hv-txn-h">Transaction history</h3><span class="tiny muted">every stock change, newest first</span></div>
    ${txnHTML(h)}
  </section>

  <div class="grid2">
    <section class="card" aria-labelledby="hv-units-h">
      <div class="hv-sec-head"><h3 id="hv-units-h">Serialised units</h3><button class="btn sm ghost" type="button" data-act="add-unit">Add unit</button></div>
      ${unitsHTML(h.units || [])}
    </section>
    <section class="card" aria-labelledby="hv-want-h">
      <div class="hv-sec-head"><h3 id="hv-want-h">Want list</h3><button class="btn sm ghost" type="button" data-act="want">Add to want list</button></div>
      ${wantHTML(h.wishlist || [])}
    </section>
  </div>

  <section class="card" aria-labelledby="hv-chg-h">
    <div class="hv-sec-head"><h3 id="hv-chg-h">Change history</h3><span class="tiny muted">catalogue data — who changed what, from which source</span></div>
    ${changesHTML(h.changes || [])}
  </section>`
}

function glHTML(h) {
  const x = glExplanation(h)
  const gl = isNum(h.gauge_length_mm) ? Number(h.gauge_length_mm) : null
  const cgl = isNum(h.cam_gl_mm) ? Number(h.cam_gl_mm) : null
  const delta = x.delta ? `<span class="chip ${x.kind === 'arbor' || x.kind === 'diff' ? 'MEDIUM' : 'src'}">${x.delta > 0 ? '+' : '−'}${mm(Math.abs(x.delta))} mm</span>` : ''
  return `<div class="hv-glcmp" aria-label="Gauge length">
    <div class="hv-glrow"><span>Maker gauge length${h.gauge_length_ref ? ` <span class="muted small">(${esc(h.gauge_length_ref)})</span>` : ''}</span><span class="num">${gl != null ? `${mm(gl)} mm` : '–'}</span></div>
    ${rulerHTML(gl || 0, cgl || 0)}
    <div class="hv-glrow"><span>hyperMILL gauge length</span><span class="num">${cgl != null ? `${mm(cgl)} mm` : '–'} ${delta}</span></div>
    <p class="note ${x.kind === 'same' ? 'ok' : ''}">${esc(x.text)}</p>
    <span class="tiny muted">Ruler: 0–170 mm from the HSK gauge line (flange face); dashed = hyperMILL beyond the maker value.</span>
  </div>`
}

function detailRows(h) {
  const min = h.clamp_min_mm
  const max = h.clamp_max_mm
  const arbor = h.type_code === 'FACE_MILL_ARBOR'
  const range =
    isNum(min) && isNum(max)
      ? Number(min) === Number(max)
        ? arbor
          ? `Ø${mm(min)} mm spigot (fixed)`
          : `Ø${mm(min)} mm fixed bore — fits a Ø${mm(min)} shank`
        : `${mm(min)}–${mm(max)} mm`
      : 'No range — see the clamping text (screw-in / tap)'
  return [
    ['Clamping', h.clamp_spec],
    [arbor ? 'Spigot Ø' : 'Clamp range', range],
    ['Gauge length', isNum(h.gauge_length_mm) ? `${mm(h.gauge_length_mm)} mm${h.gauge_length_ref ? ` (maker '${h.gauge_length_ref}')` : ''}` : null],
    ['Nose Ø', isNum(h.nose_dia_mm) ? `${mm(h.nose_dia_mm)} mm` : null],
    ['Coolant', h.coolant],
    ['Balance', h.balance],
    ['Max rpm', isNum(h.max_rpm) ? Number(h.max_rpm).toLocaleString('en-GB') : null],
    ['Mass', isNum(h.mass_kg) ? `${mm(h.mass_kg)} kg` : null],
    ['Interface', h.interface_code],
    ['Holder type', h.type_name || h.type_code],
    ['hyperMILL name', h.cam_name],
    ['hyperMILL comment', h.cam_comment],
    ['Data', `${DATA_STATUS_LABEL[h.data_status] || h.data_status}${h.data_source ? ' — ' + h.data_source : ''}`],
    ['Last checked', h.last_checked ? fmtDate(h.last_checked) : null],
    ['Notes', h.notes],
  ]
}

function dimsHTML(dims) {
  const rows = Object.entries(dims || {})
  if (!rows.length) return '<p class="muted small" style="margin:0">No other maker dimensions recorded.</p>'
  return `<div class="tablewrap"><table class="data hv-dims"><thead><tr><th>Maker label</th><th>Value</th></tr></thead><tbody>
    ${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join('')}</tbody></table></div>`
}

function stockHTML(h) {
  const rows = h.stock || []
  if (!rows.length)
    return `<p class="muted small" style="margin:0">Not held anywhere. When one arrives, book a receipt (with the PO no.) or count it where it is.</p>`
  const total = rows.filter((r) => r.counts_as_on_site).reduce((a, r) => a + Number(r.qty), 0)
  return `<div class="tablewrap"><table class="data"><thead><tr><th>Location</th><th>Kind</th><th>Counts as on site</th><th class="n">Qty</th><th class="actions"><span class="hidden">Actions</span></th></tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr><td>${esc(r.location)}</td><td>${esc(r.kind || '')}</td><td>${r.counts_as_on_site ? 'yes' : '<span class="muted">no</span>'}</td>
        <td class="n">${esc(r.qty)}</td>
        <td class="actions">${
          Number(r.qty) > 0
            ? `<button class="btn sm ghost" type="button" data-act="stock" data-kind="move" data-loc="${esc(r.location_id)}">Move</button>
               <button class="btn sm ghost danger" type="button" data-act="stock" data-kind="scrap" data-loc="${esc(r.location_id)}">Scrap</button>`
            : ''
        }</td></tr>`,
      )
      .join('')}
    </tbody><tfoot><tr><td colspan="3">On site</td><td class="n">${total}</td><td></td></tr></tfoot></table></div>`
}

function txnHTML(h) {
  const rows = h.transactions || []
  if (!rows.length) return '<p class="muted small" style="margin:0">No stock has ever been booked for this holder.</p>'
  const more = h.transactions_total > rows.length ? `<p class="hv-more">Latest ${rows.length} of ${h.transactions_total} shown — the full ledger is in the <a href="#/log">Log</a>.</p>` : ''
  return `<div class="tablewrap"><table class="data"><thead><tr><th>Date</th><th>Type</th><th class="n">Qty</th><th>Location</th><th>Reference</th><th>By</th><th>Note</th></tr></thead><tbody>
    ${rows
      .map((t) => {
        const q = Number(t.qty_delta)
        return `<tr><td class="nowrap">${esc(fmtDate(t.txn_date))}</td><td class="nowrap">${esc(TXN_LABEL[t.txn_type] || t.txn_type)}</td>
          <td class="n"><span class="${q > 0 ? 'hv-delta-pos' : q < 0 ? 'hv-delta-neg' : ''}">${q > 0 ? '+' : ''}${esc(q)}</span></td>
          <td>${esc(t.location)}</td><td>${esc(t.reference || '')}</td><td>${esc(t.by_user || '')}</td><td>${esc(t.note || '')}</td></tr>`
      })
      .join('')}</tbody></table></div>${more}`
}

function flagsHTML(flags) {
  if (!flags.length) return '<p class="muted small" style="margin:0">No issues recorded for this holder.</p>'
  return `<div>${flags
    .map((f) => {
      const open = f.status === 'OPEN'
      const raised = [f.raised_on ? `raised ${fmtDate(f.raised_on)}` : '', f.raised_by ? `by ${f.raised_by}` : f.source ? `by ${f.source}` : ''].filter(Boolean).join(' ')
      return `<div class="issue ${open ? '' : 'is-closed'}"><span>${sevChip(f.severity)}</span><div class="what">
        <span class="who">${esc(f.category || 'General')} <span class="muted" style="font-family:var(--f-body)">· ${esc(raised)}</span></span>
        <span>${esc(f.message)}</span>
        ${f.action ? `<span class="act">→ ${esc(f.action)}</span>` : ''}
        ${
          open
            ? `<span><button class="btn sm ghost" type="button" data-act="close-flag" data-flag="${esc(f.flag_id)}">Close issue…</button></span>`
            : `<span class="closed">Closed ${esc(fmtDate(f.closed_on))}${f.closed_by ? ` by ${esc(f.closed_by)}` : ''}${f.close_note ? ` — ${esc(f.close_note)}` : ''}</span>`
        }
      </div></div>`
    })
    .join('')}</div>`
}

function unitsHTML(units) {
  if (!units.length) return '<p class="muted small" style="margin:0">No serialised units. Add one for a holder with its own balance/runout record or etched number.</p>'
  return `<div class="tablewrap"><table class="data"><thead><tr><th>Unit</th><th>Serial</th><th>Location</th><th class="n">Runout µm</th><th>Inspected</th><th>Status</th></tr></thead><tbody>
    ${units
      .map((u) => {
        const [cls, text] = UNIT_CHIP[u.status] || ['none', u.status || '–']
        return `<tr><td class="mono">${esc(u.unit_id)}</td><td class="mono">${esc(u.serial_no || '')}</td><td>${esc(u.location || '')}</td>
          <td class="n">${esc(isNum(u.runout_check_um) ? mm(u.runout_check_um) : '')}</td><td>${esc(fmtDate(u.last_inspected))}${u.inspected_by ? ` <span class="muted small">${esc(u.inspected_by)}</span>` : ''}</td>
          <td><span class="chip ${cls}">${esc(text)}</span></td></tr>`
      })
      .join('')}</tbody></table></div>`
}

function wantHTML(rows) {
  if (!rows.length) return '<p class="muted small" style="margin:0">Not on the want list.</p>'
  return `<div class="tablewrap"><table class="data"><thead><tr><th class="n">Qty</th><th>Reason</th><th>Status</th><th>Added</th></tr></thead><tbody>
    ${rows
      .map(
        (w) => `<tr><td class="n">${esc(w.qty_wanted)}</td><td>${esc(w.reason || '')}</td><td><span class="tag">${esc(w.status)}</span></td>
        <td>${esc(fmtDate(w.added_on))}${w.added_by ? ` <span class="muted small">${esc(w.added_by)}</span>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
}

function changeValue(v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">(empty)</span>'
  const s = String(v)
  return esc(s.length > 160 ? s.slice(0, 157) + '…' : s)
}

function changesHTML(changes) {
  if (!changes.length) return '<p class="muted small" style="margin:0">No catalogue changes recorded since the app took over this record.</p>'
  return `<div class="tablewrap"><table class="data hv-change"><thead><tr><th>When</th><th>Field</th><th>Change</th><th>Source</th><th>By</th></tr></thead><tbody>
    ${changes
      .map((c) => {
        let what
        if (c.field === '*') {
          let pretty = c.new_value || ''
          try {
            pretty = JSON.stringify(JSON.parse(c.new_value), null, 1)
          } catch {}
          what = `<details><summary>values entered</summary><pre>${esc(pretty)}</pre></details>`
        } else what = `<span class="old">${changeValue(c.old_value)}</span> → <span class="new">${changeValue(c.new_value)}</span>`
        const ref = c.reference ? (safeUrl(c.reference) ? extLink(c.reference, c.reference) : esc(c.reference)) : ''
        return `<tr><td class="nowrap">${esc(fmtDate(c.changed_at))}<br><span class="tiny muted">${esc(String(c.changed_at || '').slice(11, 16))}</span></td>
          <td>${esc(FIELD_LABEL[c.field] || c.field)}</td><td>${what}</td>
          <td>${esc(c.source)}${ref ? `<br><span class="small">${ref}</span>` : ''}</td><td>${esc(c.by_user || '')}</td></tr>`
      })
      .join('')}</tbody></table></div>`
}
