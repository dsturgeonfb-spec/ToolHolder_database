// Shared UI helpers: escaping, number formats, chips, the gauge-length ruler, dialogs and toasts.
// Views build HTML strings with esc() around every value that came from data — no exceptions.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Number with at most one decimal, '–' for null. */
export const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? '–' : String(Math.round(Number(n) * 10) / 10))
/** Date YYYY-MM-DD -> DD/MM/YYYY (shop convention, en-GB). */
export const fmtDate = (d) => {
  if (!d) return '–'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d)
}
export const todayIso = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const SEV = ['HIGH', 'MEDIUM', 'LOW', 'INFO']

export function sevChip(sev) {
  return `<span class="chip ${esc(sev)}">${esc(sev)}</span>`
}

/** Count status chip: counted / unverified (opening balance only) / booked (receipt) / not on site. */
export function statusChip(status) {
  if (status === 'counted') return `<span class="chip counted" title="A physical count has been booked">Counted</span>`
  if (status === 'unverified') return `<span class="chip unver" title="Quantity is the hyperMILL opening balance — not yet physically counted">Unverified</span>`
  if (status === 'booked') return `<span class="chip counted" title="Booked in by receipt; not yet counted">Booked in</span>`
  return `<span class="chip none">Not on site</span>`
}

export const DATA_STATUS_LABEL = {
  verified: 'Verified on maker site',
  partial: 'Partly verified',
  distributor_only: 'From distributor (maker site blocked)',
  catalogue_pdf: 'Maker catalogue / data file',
  unverified: 'Unverified',
}

export const GLMAX = 170
/** To-scale gauge-length ruler: 0 = HSK gauge line, scale 0–170 mm; dashed extension = hyperMILL GL beyond maker GL. */
export function rulerHTML(gl, cgl) {
  const w = (v) => Math.min(100, (v / GLMAX) * 100).toFixed(1) + '%'
  let s = `<div class="ruler" aria-hidden="true"><i style="width:${w(gl || 0)}"></i>`
  if (cgl && gl && cgl !== gl && cgl > gl) s += `<s style="left:${w(gl)};width:${(((cgl - gl) / GLMAX) * 100).toFixed(1)}%"></s>`
  return s + '</div>'
}

/** hyperMILL profile thumbnail (or a placeholder). `cam_image` is the DB path, e.g. images/cam/cam_01.png. */
export function profileHTML(h, opts = {}) {
  const src = h.cam_image ? '/' + String(h.cam_image).replace(/^\/+/, '') : h.vendor_image || null
  const label = `${h.manufacturer || ''} ${h.order_no || ''}`.trim()
  if (!src) return `<div class="prof none" style="display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--ink-3)">no CAM model</div>`
  const img = `<img src="${esc(src)}" alt="Profile of ${esc(label)}" loading="lazy" style="width:100%;height:100%;object-fit:contain;filter:var(--img-filter)">`
  return opts.link ? `<a class="prof" href="${esc(opts.link)}" aria-label="Open ${esc(label)}">${img}</a>` : `<div class="prof">${img}</div>`
}

// ---------------------------------------------------------------- toasts
export function toast(message, kind = '') {
  const box = document.getElementById('toasts')
  if (!box) return
  const t = document.createElement('div')
  t.className = `toast ${kind}`
  t.textContent = message
  box.appendChild(t)
  // A fast count run would otherwise stack toasts over the screen.
  while (box.children.length > 3) box.firstElementChild.remove()
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3500)
}
export const toastError = (e) => toast(e && e.message ? e.message : String(e), 'error')

// ---------------------------------------------------------------- dialogs
function makeDialog(title, bodyHTML, footHTML, wide) {
  const d = document.createElement('dialog')
  d.className = 'dlg' + (wide ? ' wide' : '')
  d.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
    <div class="dlg-body">${bodyHTML}</div><div class="dlg-foot">${footHTML}</div>`
  document.body.appendChild(d)
  d.addEventListener('close', () => setTimeout(() => d.remove(), 0))
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close('cancel')))
  return d
}

/** Yes/no confirmation. Resolves true/false. */
export function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const d = makeDialog(title, `<p style="margin:0">${esc(message)}</p>`,
      `<button class="btn ghost" type="button" data-close>Cancel</button><button class="btn ${danger ? 'danger' : ''}" type="button" data-ok>${esc(ok)}</button>`)
    d.querySelector('[data-ok]').addEventListener('click', () => d.close('ok'))
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'))
    d.showModal()
  })
}

/** Shows arbitrary HTML in a dialog (read-only info). */
export function infoDialog(title, bodyHTML, { wide = false } = {}) {
  const d = makeDialog(title, bodyHTML, `<button class="btn" type="button" data-close>Close</button>`, wide)
  d.showModal()
  return d
}

/**
 * Form dialog. fields: [{name, label, type: text|number|date|select|textarea|checkbox, options:[{value,label}]|[string],
 *   required, value, help, step, min, max, placeholder, full}]
 * onSubmit(values) may be async; throw to keep the dialog open (the error message is shown in it).
 * Resolves with onSubmit's result (or the values), or null if cancelled.
 */
export function formDialog({ title, intro = '', fields, submitLabel = 'Save', onSubmit, wide = false, danger = false }) {
  return new Promise((resolve) => {
    const fid = 'f' + Math.random().toString(36).slice(2)
    const body = `${intro ? `<p class="note" style="margin:0 0 10px">${intro}</p>` : ''}<form class="form" id="${fid}" novalidate>
      ${fields.map((f) => fieldHTML(f)).join('')}<div class="errorbox hidden" data-err></div></form>`
    const d = makeDialog(title, body,
      `<button class="btn ghost" type="button" data-close>Cancel</button><button class="btn ${danger ? 'danger' : ''}" type="submit" form="${fid}">${esc(submitLabel)}</button>`, wide)
    const form = d.querySelector('form')
    const err = d.querySelector('[data-err]')
    let result = null
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const values = readForm(form, fields)
      const missing = fields.filter((f) => f.required && (values[f.name] === '' || values[f.name] == null))
      if (missing.length) {
        err.textContent = `Fill in: ${missing.map((f) => f.label).join(', ')}`
        err.classList.remove('hidden')
        return
      }
      const btn = d.querySelector('button[type=submit]')
      btn.disabled = true
      try {
        result = onSubmit ? await onSubmit(values) : values
        if (result === undefined) result = values
        d.close('ok')
      } catch (e) {
        err.textContent = e && e.message ? e.message : String(e)
        err.classList.remove('hidden')
      } finally {
        btn.disabled = false
      }
    })
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? result : null))
    d.showModal()
    const first = form.querySelector('input:not([type=hidden]),select,textarea')
    if (first) first.focus()
  })
}

function fieldHTML(f) {
  const id = 'fld-' + f.name + '-' + Math.random().toString(36).slice(2, 7)
  const v = f.value ?? ''
  const common = `id="${id}" name="${esc(f.name)}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}`
  let input
  if (f.type === 'select') {
    const opts = (f.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o }))
    input = `<select ${common}>${f.blank ? `<option value="">${esc(f.blank)}</option>` : ''}${opts.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
  } else if (f.type === 'textarea') {
    input = `<textarea ${common} ${f.maxlength != null ? `maxlength="${Number(f.maxlength)}"` : ''}>${esc(v)}</textarea>`
  } else if (f.type === 'checkbox') {
    return `<label class="chk"><input type="checkbox" ${common} ${v ? 'checked' : ''}> ${esc(f.label)}</label>${f.help ? `<span class="help tiny muted">${esc(f.help)}</span>` : ''}`
  } else {
    const extra = [f.step != null ? `step="${f.step}"` : '', f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : '', f.list ? `list="${esc(f.list)}"` : '', f.maxlength != null ? `maxlength="${Number(f.maxlength)}"` : ''].join(' ')
    input = `<input type="${f.type || 'text'}" ${common} value="${esc(v)}" ${extra} ${f.type === 'number' ? 'inputmode="decimal"' : ''}>`
  }
  return `<label class="fld ${f.required ? 'req' : ''}" for="${id}"><span>${esc(f.label)}</span>${input}${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`
}

function readForm(form, fields) {
  const out = {}
  for (const f of fields) {
    const el = form.elements.namedItem(f.name)
    if (!el) continue
    if (f.type === 'checkbox') out[f.name] = el.checked
    else if (f.type === 'number') out[f.name] = el.value.trim() === '' ? '' : Number(el.value.replace(',', '.'))
    else out[f.name] = el.value.trim()
  }
  return out
}

// ---------------------------------------------------------------- misc
export function debounce(fn, ms = 300) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

/** Sets the little "Saving… / Saved" status in the header. */
export function setSaveStatus(text) {
  const el = document.getElementById('save')
  if (el) el.textContent = text || ''
}

/** Renders a key/value list, skipping empty values. rows: [[label, value(, html=false)]] */
export function kvHTML(rows) {
  const r = rows.filter(([, v]) => v !== null && v !== undefined && v !== '')
  return `<dl class="kv">${r.map(([k, v, html]) => `<dt>${esc(k)}</dt><dd>${html ? v : esc(v)}</dd>`).join('')}</dl>`
}

export function emptyHTML(text) {
  return `<div class="empty">${esc(text)}</div>`
}
