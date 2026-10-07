// Vendors (#/vendors): where the catalogue's maker data comes from. A card per maker; "scan a maker's site"
// and "import a maker's data file" both end in the same proposals table, where a person approves rows and
// fields. Nothing a scan or import reads is written until then — and stock is never touched here.
import { esc, toast, toastError, emptyHTML, fmtDate, DATA_STATUS_LABEL } from '../ui.js'
import { state, refreshSummary, loadMeta } from '../state.js'
import { api, newRequestKey } from '../api.js'

const POLL_MS = 1000
const MAX_FILE_BYTES = 10 * 1024 * 1024

const FIELD_LABEL = {
  spec_code: 'Spec code',
  product_name: 'Product name',
  series: 'Series',
  type_code: 'Holder type',
  interface_code: 'Interface',
  clamp_dia_mm: 'Clamp Ø',
  clamp_min_mm: 'Clamp min Ø',
  clamp_max_mm: 'Clamp max Ø',
  clamp_spec: 'Clamping text',
  gauge_length_mm: 'Gauge length',
  gauge_length_ref: 'GL label',
  nose_dia_mm: 'Nose Ø',
  dims: 'Maker dimensions',
  coolant: 'Coolant',
  balance: 'Balance',
  max_rpm: 'Max rpm',
  mass_kg: 'Mass',
  product_url: 'Maker page',
  image_url: 'Photo',
  drawing_url: 'Drawing',
  notes: 'Notes',
}
const UNIT = { clamp_dia_mm: ' mm', clamp_min_mm: ' mm', clamp_max_mm: ' mm', gauge_length_mm: ' mm', nose_dia_mm: ' mm', mass_kg: ' kg', max_rpm: ' rpm' }
const ACTION = {
  insert: ['new', 'New'],
  update: ['upd', 'Update'],
  same: ['', 'Unchanged'],
  error: ['err', 'Error'],
}
const KIND_LABEL = { VENDOR: 'Vendor scan', FILE: 'File import' }

// One live view at a time; teardown stops its polling so a closed view never touches the DOM.
let active = null
export function teardown() {
  if (active) {
    active.dead = true
    for (const t of active.timers) clearTimeout(t)
  }
  active = null
}

// Proposals already approved in this browser session (the server also refuses a second apply).
const appliedKeys = new Set()

const num = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v))
function shortUrl(u) {
  try {
    const x = new URL(u)
    const last = decodeURIComponent(x.pathname.split('/').filter(Boolean).pop() || '')
    return `${x.host}${last ? ' …/' + last : ''}`
  } catch {
    return String(u)
  }
}
function valueHTML(field, v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>'
  if (/_url$/.test(field))
    return /^https?:\/\//i.test(String(v))
      ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer" title="${esc(v)}">${esc(shortUrl(v))} ↗</a>`
      : `<span class="mono">${esc(v)}</span>`
  if (field === 'type_code') return esc(state.meta?.types?.find((t) => t.type_code === v)?.type_name || v)
  if (typeof v === 'number') return `<span class="mono">${esc(num(v) + (UNIT[field] || ''))}</span>`
  if (typeof v === 'object') return esc(Object.entries(v).map(([k, x]) => `${k}: ${x}`).join('; '))
  const s = String(v)
  return s.length > 120 ? `<span title="${esc(s)}">${esc(s.slice(0, 117))}…</span>` : esc(s)
}

export async function render(root, ctx) {
  const me = { dead: false, timers: [] }
  active = me
  const later = (fn, ms) => {
    const t = setTimeout(() => !me.dead && fn(), ms)
    me.timers.push(t)
  }
  root.innerHTML = `<div class="vn view"><div class="loading">Loading…</div></div>`
  const el = root.firstElementChild
  let ov = null // GET /api/vendors
  // The proposals currently shown: { key, kind: 'scan'|'file', title, proposals, sel: Map(i → Set(fields)|true), applied }
  let work = null

  async function loadOverview() {
    ov = await api.get('/api/vendors')
    return ov
  }

  try {
    await loadOverview()
  } catch (e) {
    if (me.dead) return
    el.innerHTML = `<div class="errorbox">The vendor overview could not be loaded: ${esc(e.message)} <button class="btn sm ghost" type="button" data-act="retry">Try again</button></div>`
    el.addEventListener('click', (ev) => ev.target.closest('[data-act="retry"]') && render(root, ctx))
    return
  }
  if (me.dead) return

  const ifaces = state.meta?.interfaces || [{ interface_code: 'HSK-A63' }]
  const defIface = state.meta?.settings?.default_interface || ifaces[0]?.interface_code || 'HSK-A63'
  const automated = ov.vendors.filter((v) => v.automated)
  const ifaceOptions = ifaces.map((i) => `<option value="${esc(i.interface_code)}" ${i.interface_code === defIface ? 'selected' : ''}>${esc(i.interface_code)}</option>`).join('')

  el.innerHTML = `
    <div class="view-head">
      <div><h2>Vendors &amp; sources</h2>
        <p class="muted">Where the catalogue's maker data comes from. Scan a maker's site or import a maker's data file: you see every difference first, and only what you approve is written — with its source, your name and today's date. Stock is never changed here.</p></div>
    </div>
    ${ov.fixtures ? `<div class="warnbox vn-fixtures"><b>Test mode:</b> vendor requests are answered from saved pages on this PC — no maker site is contacted.</div>` : ''}
    <details class="infobox vn-polite" open>
      <summary><b>How scanning stays polite and safe</b></summary>
      <ul>
        <li>The app says who it is: every request carries <span class="mono">${esc(ov.user_agent)}</span> — never a browser disguise.
          ${ov.vendor_contact_set ? '' : `<b>No contact e-mail is set</b> — add one in <a href="#/settings">Settings → Contact e-mail sent to maker websites</a> so a maker can reach you instead of blocking the app.`}</li>
        <li>It reads each site's <span class="mono">robots.txt</span> first, never requests a path it disallows, asks one page at a time and waits the site's crawl delay between pages (HAIMER asks for 10 s — about six pages a minute; at least 2 s everywhere).</li>
        <li>If a site refuses (HTTP 401, 403 or 429) the scan stops and reports <i>blocked — not retried</i>. The app never tries to get round a block. CERATIZIT refuses all automated access, so its data comes in as a file from your rep.</li>
        <li><b>Check a maker's first live scan carefully.</b> The readers were built from saved copies of each maker's pages and a maker can change its layout: compare a few values with the maker page (links in the table) before approving.</li>
      </ul>
    </details>
    <section aria-labelledby="vn-makers-h">
      <h3 id="vn-makers-h" class="vn-h">Makers</h3>
      <div class="vn-makers" data-makers></div>
    </section>
    <div class="vn-panels">
      <section class="card vn-scan" id="vnScan" aria-labelledby="vn-scan-h">
        <h3 id="vn-scan-h">Scan a maker's site</h3>
        ${automated.length ? `<form class="form" data-form="scan" novalidate>
          <div class="row2">
            <label class="fld"><span>Maker</span><select name="maker">${automated.map((v) => `<option value="${esc(v.maker)}">${esc(v.maker)}</option>`).join('')}</select></label>
            <label class="fld"><span>Interface</span><select name="iface">${ifaceOptions}</select></label>
          </div>
          <label class="fld"><span>Order nos. (optional)</span><textarea name="orders" rows="4" spellcheck="false" placeholder="One per line, e.g. A63.182.04.8"></textarea>
            <span class="help">Leave empty to re-check every holder of this maker already in the catalogue.</span></label>
          <label class="chk"><input type="checkbox" name="full"> Discover the full range</label>
          <p class="help vn-hint" data-hint></p>
          <p class="small muted" data-estimate></p>
          <div class="btnrow"><button class="btn" type="submit">Start scan</button></div>
        </form>` : emptyHTML('No maker can be scanned automatically.')}
      </section>
      <section class="card vn-import" id="vnImport" aria-labelledby="vn-import-h">
        <h3 id="vn-import-h">Import a maker's data file</h3>
        <p class="note">For makers whose sites must not or cannot be read (CERATIZIT, SANDVIK COROMANT, CUTWEL), or any ISO 13399 / catalogue export from a rep. A CSV with a header row; you approve the result just like a scan.</p>
        <form class="form" data-form="import" novalidate>
          <label class="fld req"><span>CSV file</span><input type="file" name="file" accept=".csv,text/csv"></label>
          <div class="row2">
            <label class="fld"><span>Maker</span><select name="maker">${ov.vendors.map((v) => `<option value="${esc(v.maker)}" ${v.maker === 'CERATIZIT' ? 'selected' : ''}>${esc(v.maker)}</option>`).join('')}</select></label>
            <label class="fld"><span>Interface</span><select name="iface">${ifaceOptions}</select></label>
          </div>
          <label class="fld req"><span>Where the file came from</span><input name="source" maxlength="400" placeholder="e.g. ISO 13399 package from the Ceratizit rep, 05/10/2026">
            <span class="help">Recorded on every holder the file adds or changes.</span></label>
          <label class="fld"><span>Data status of these values</span><select name="status">
            <option value="">Automatic (maker catalogue; distributor for distributors)</option>
            ${['catalogue_pdf', 'distributor_only', 'verified', 'partial', 'unverified'].map((s) => `<option value="${s}">${esc(DATA_STATUS_LABEL[s] || s)}</option>`).join('')}
          </select></label>
          <details class="small"><summary>Columns the import understands</summary>
            <ul class="vn-cols">
              <li><b>Order no.</b> (required): <span class="mono">order_no</span>, <span class="mono">ORDER_NO</span>, <span class="mono">Article</span> or <span class="mono">Art.-Nr.</span>; optional <span class="mono">manufacturer</span>.</li>
              <li><b>ISO 13399:</b> <span class="mono">DCONWS</span> clamp Ø (or range "1-7"), <span class="mono">LPR</span> gauge length, <span class="mono">DLN</span> / <span class="mono">BD</span> nose Ø (DLN wins), <span class="mono">WT</span> mass kg, <span class="mono">RPMX</span> max rpm, <span class="mono">ADINTMS</span> must name the interface chosen above. These fill the holder's own fields and are not repeated in the maker dimensions (an existing entry with the same code, e.g. "DLN (diameter lock nut)", is updated). Other ISO codes go to the maker dimensions.</li>
              <li><b>Our columns:</b> spec_code, product_name, type_code, clamp_dia_mm, clamp_min_mm, clamp_max_mm, gauge_length_mm, nose_dia_mm, mass_kg, max_rpm, product_url, image_url, drawing_url, notes… For distributor lists put the maker's own number in <span class="mono">maker_order_no</span>.</li>
            </ul>
          </details>
          <div class="btnrow"><button class="btn" type="submit">Read file</button></div>
        </form>
      </section>
    </div>
    <section class="vn-work" data-work aria-live="polite"></section>
    <div class="vn-panels">
      <section class="card vn-images" aria-labelledby="vn-img-h">
        <h3 id="vn-img-h">Maker photos</h3>
        <p class="note">Downloads each holder's maker photo into this PC's data folder (<span class="mono">images/vendor/</span>) so the catalogue shows it offline without linking to maker sites. Same polite rules; only from the sites of makers the app can scan, and only real JPEG/PNG/WebP/GIF images up to 5 MB are kept.</p>
        <p data-imgstats></p>
        <div class="btnrow"><button class="btn" type="button" data-act="images">Cache maker photos</button>
          <button class="btn ghost" type="button" data-act="images-force" title="Download every photo again, replacing the copies already saved">Download all again</button></div>
        <div data-imgjob></div>
      </section>
      <section class="card vn-runs" aria-labelledby="vn-runs-h">
        <h3 id="vn-runs-h">Applied scans and imports</h3>
        <div data-runs><div class="loading">Loading…</div></div>
      </section>
    </div>`

  const $ = (s) => el.querySelector(s)
  const workEl = $('[data-work]')
  const scanForm = $('[data-form="scan"]')
  const importForm = $('[data-form="import"]')

  // ---------------------------------------------------------------- maker cards
  function renderMakers() {
    $('[data-makers]').innerHTML = ov.vendors
      .map(
        (v) => `<article class="card vn-maker" data-maker="${esc(v.maker)}">
        <div class="vn-maker-top"><h3>${esc(v.maker)}</h3>
          ${v.automated ? '<span class="tag upd">Automated scan</span>' : '<span class="tag warn">Manual route</span>'}
          ${v.is_distributor ? '<span class="tag">Distributor</span>' : ''}</div>
        <span class="method">${esc(v.method)}</span>
        <p>${esc(v.why)}</p>
        <p class="small muted"><b>Robots / politeness:</b> ${esc(v.robots_live?.summary || v.robots)}${v.robots_live ? ` <span class="tiny">(read ${esc(new Date(v.robots_live.checked_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))})</span>` : ''}</p>
        ${v.blocked ? `<div class="errorbox small">${esc(v.blocked)}</div>` : ''}
        ${v.link_note ? `<p class="small muted"><b>Note on the original link:</b> ${esc(v.link_note)}</p>` : ''}
        <p class="vn-counts small"><b class="mono">${esc(v.articles_on_site)}</b> on site · <b class="mono">${esc(v.articles_in_catalogue)}</b> in catalogue</p>
        <div class="btnrow">
          ${v.automated ? `<button class="btn sm" type="button" data-act="pick-scan" data-maker="${esc(v.maker)}">Scan…</button>` : ''}
          <button class="btn sm ${v.automated ? 'ghost' : ''}" type="button" data-act="pick-import" data-maker="${esc(v.maker)}">Import file…</button>
          ${v.source_url ? `<a class="btn sm ghost" href="${esc(v.source_url)}" target="_blank" rel="noopener noreferrer">Maker site ↗</a>` : ''}
        </div>
      </article>`,
      )
      .join('')
  }

  function renderImageStats() {
    const s = ov.images || { with_url: 0, downloadable: 0, cached: 0 }
    const other = s.with_url - (s.downloadable ?? s.with_url)
    $('[data-imgstats]').innerHTML = s.with_url
      ? `<b class="mono">${esc(s.with_url)}</b> holders have a maker photo address; <b class="mono">${esc(s.cached)}</b> of them are saved on this PC.` +
        (other > 0 ? ` <span class="muted">${esc(other)} ${other === 1 ? 'is' : 'are'} on a site the app has no reader for (e.g. a distributor) and ${other === 1 ? 'is' : 'are'} not downloaded.</span>` : '')
      : 'No holder has a maker photo address yet — scans fill these in when the maker page shows a photo.'
  }

  async function loadRuns() {
    const box = $('[data-runs]')
    try {
      const runs = await api.get('/api/vendors/runs?limit=8')
      if (me.dead) return
      box.innerHTML = runs.length
        ? `<div class="tablewrap"><table class="data small"><thead><tr><th>When</th><th>What</th><th>By</th><th>Result</th></tr></thead><tbody>
          ${runs
            .map((r) => {
              const s = r.summary || {}
              return `<tr><td class="nowrap">${esc(fmtDate(r.run_at))} <span class="muted">${esc(String(r.run_at).slice(11, 16))}</span></td>
                <td>${esc(KIND_LABEL[r.kind] || r.kind)} · ${esc(r.source)}</td><td>${esc(r.by_user || '')}</td>
                <td class="nowrap">${esc(s.inserted ?? 0)} new · ${esc(s.updated ?? 0)} updated · ${esc(s.confirmed ?? 0)} checked</td></tr>`
            })
            .join('')}</tbody></table></div>`
        : '<p class="muted small" style="margin:0">Nothing applied yet. Every approval is recorded here and on each holder\'s change history.</p>'
    } catch (e) {
      if (!me.dead) box.innerHTML = `<div class="errorbox small">${esc(e.message)}</div>`
    }
  }

  function scanHint() {
    if (!scanForm) return
    const maker = scanForm.maker.value
    const v = ov.vendors.find((x) => x.maker === maker)
    const full = scanForm.full.checked
    const orders = scanForm.orders.value.split(/[\r\n,;\t]+/).map((s) => s.trim()).filter(Boolean)
    const hint = {
      HAIMER: 'Full range: reads HAIMER\'s sitemap and lists every product page for the interface (new ones are proposed as catalogue-only "can buy" holders).',
      MAPAL: 'MAPAL has no full-range discovery — its listings mix every HSK size. Enter the order nos. of new holders to add them.',
      KEMMLER: 'Kemmler has no full-range discovery here — enter the order nos. of new holders; each is found with the shop search.',
    }[maker]
    scanForm.querySelector('[data-hint]').textContent = hint || ''
    const delay = v?.delay_s || 2
    const n = orders.length || (full ? null : v?.articles_in_catalogue || 0)
    const est = n == null ? `Depends on the range found — about ${Math.max(1, Math.round(60 / delay))} pages a minute.` : n ? `About ${n} page${n === 1 ? '' : 's'} at ${delay} s each — roughly ${Math.max(1, Math.ceil((n * delay) / 60))} min.` : 'No holders of this maker in the catalogue yet — enter order nos.'
    scanForm.querySelector('[data-estimate]').textContent = est
  }

  renderMakers()
  renderImageStats()
  scanHint()
  loadRuns()

  // ---------------------------------------------------------------- jobs (scan / photos)
  /** Shows a job's progress in `box` and polls it until it finishes; calls onDone(job). */
  function watchJob(jobId, box, onDone) {
    let cancelling = false
    const draw = (j) => {
      // Keep the log open/closed as the person left it while the job runs; fold it away when done.
      const prev = box.querySelector('.vn-job details')
      const logOpen = j.status === 'running' && (prev ? prev.open : true)
      const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : j.status === 'running' ? 4 : 100
      const statusTag = { running: '<span class="tag upd">Running</span>', done: '<span class="tag new">Finished</span>', failed: '<span class="tag err">Failed</span>', cancelled: '<span class="tag warn">Cancelled</span>' }[j.status] || ''
      box.innerHTML = `<div class="vn-job" data-job="${esc(j.id)}">
        <div class="vn-job-head"><b>${esc(j.title)}</b> ${statusTag}<span class="spacer"></span>
          ${j.status === 'running' ? `<button class="btn sm ghost danger" type="button" data-act="cancel-job" ${cancelling ? 'disabled' : ''}>${cancelling ? 'Cancelling…' : 'Cancel'}</button>` : ''}</div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Progress"><i style="width:${pct}%"></i></div>
        <div class="small muted">${esc(j.message || '')}${j.total ? ` · ${esc(j.done)} of ${esc(j.total)}` : ''}</div>
        ${j.error ? `<div class="errorbox small">${esc(j.error)}</div>` : ''}
        <details ${logOpen ? 'open' : ''}><summary class="small">Log</summary><pre class="joblog">${esc((j.log || []).join('\n'))}</pre></details>
      </div>`
      const log = box.querySelector('.joblog')
      if (log) log.scrollTop = log.scrollHeight
    }
    box.onclick = async (ev) => {
      if (!ev.target.closest('[data-act="cancel-job"]')) return
      cancelling = true
      ev.target.disabled = true
      try {
        await api.post(`/api/jobs/${encodeURIComponent(jobId)}/cancel`)
      } catch (e) {
        toastError(e)
      }
    }
    const tick = async () => {
      let j
      try {
        j = await api.get(`/api/jobs/${encodeURIComponent(jobId)}`)
      } catch (e) {
        if (me.dead) return
        box.innerHTML = `<div class="errorbox">Lost track of the job: ${esc(e.message)}</div>`
        return
      }
      if (me.dead) return
      draw(j)
      if (j.status === 'running') later(tick, POLL_MS)
      else onDone(j)
    }
    tick()
  }

  // ---------------------------------------------------------------- proposals
  function defaultSelection(proposals) {
    const sel = new Map()
    proposals.forEach((p, i) => {
      // Rows with warnings are left for the person to tick deliberately.
      if ((p.action === 'insert' || p.action === 'update') && !(p.warnings || []).length) sel.set(i, p.action === 'update' ? new Set(Object.keys(p.fields)) : true)
    })
    return sel
  }

  function showProposals(w) {
    work = w
    // One retry key per set of proposals: if an approval reached the server but its answer was lost, sending
    // it again returns that first result instead of an "already applied" error.
    w.reqKey = w.reqKey || newRequestKey()
    w.sel = w.sel || defaultSelection(w.proposals)
    w.filter = w.filter || 'all'
    w.confirmSame = w.confirmSame ?? true
    drawProposals()
  }

  function fieldsHTML(p, i, w) {
    const sel = w.sel.get(i)
    const locked = w.applied
    if (p.action === 'error') return `<span class="vn-err">${esc(p.error || 'Could not be read')}</span>`
    if (p.action === 'same') return '<span class="muted">No change — matches the catalogue.</span>'
    if (p.action === 'insert') {
      const f = p.fields
      const key = ['type_code', 'clamp_spec', 'gauge_length_mm', 'nose_dia_mm', 'mass_kg']
      const main = key.filter((k) => f[k]).map((k) => `<span class="vn-kv"><span class="muted">${esc(FIELD_LABEL[k])}</span> ${valueHTML(k, f[k].new)}</span>`).join('')
      const rest = Object.keys(f).filter((k) => !key.includes(k))
      return `<div class="vn-ins">${main || '<span class="muted">Catalogue-only (can buy) — no stock is booked.</span>'}</div>
        ${rest.length ? `<details class="small"><summary>All ${Object.keys(f).length} values</summary><dl class="kv">${Object.keys(f).map((k) => `<dt>${esc(FIELD_LABEL[k] || k)}</dt><dd>${valueHTML(k, f[k].new)}</dd>`).join('')}</dl></details>` : ''}`
    }
    return `<ul class="vn-fields">${Object.entries(p.fields)
      .map(([k, ch]) => {
        const checked = sel instanceof Set ? sel.has(k) : false
        let change
        if (k === 'dims') {
          const keys = ch.keys || Object.keys(ch.new || {})
          change = keys
            .map((d) => {
              const o = ch.old && Object.keys(ch.old).find((x) => x.toLowerCase() === d.toLowerCase())
              return `<span class="vn-dim">${esc(d)}: ${o != null ? `<s class="vn-old">${esc(num(ch.old[o]))}</s> → ` : '<span class="tag new">new</span> '}<span class="vn-new">${esc(num(ch.new[d]))}</span></span>`
            })
            .join('')
        } else {
          const empty = ch.old === null || ch.old === undefined || ch.old === ''
          change = `${empty ? '<span class="muted">(empty)</span>' : `<s class="vn-old">${valueHTML(k, ch.old)}</s>`} → <span class="vn-new">${valueHTML(k, ch.new)}</span>`
        }
        return `<li><label class="vn-field"><input type="checkbox" data-field="${i}" value="${esc(k)}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          <span class="vn-fname">${esc(FIELD_LABEL[k] || k)}</span></label> <span class="vn-change">${change}</span></li>`
      })
      .join('')}</ul>`
  }

  function drawProposals() {
    const w = work
    if (!w) return
    const ps = w.proposals
    const counts = { insert: 0, update: 0, same: 0, error: 0 }
    ps.forEach((p) => counts[p.action]++)
    const visible = ps.map((p, i) => [p, i]).filter(([p]) => w.filter === 'all' || p.action === w.filter)
    const selectable = visible.filter(([p]) => p.action === 'insert' || p.action === 'update')
    const allOn = selectable.length && selectable.every(([, i]) => w.sel.has(i))
    const box = workEl.querySelector('[data-props]') || workEl.appendChild(Object.assign(document.createElement('div'), { className: 'card vn-props' }))
    box.setAttribute('data-props', '')
    // Keep the reader's place in a long list across redraws (filter, select all, approve).
    const prevScroll = box.querySelector('.vn-tablewrap')?.scrollTop || 0
    const filterBtn = (k, label) => `<button type="button" data-filter="${k}" aria-pressed="${w.filter === k}">${esc(label)}</button>`
    box.innerHTML = `
      <div class="vn-props-head">
        <div><h3>${esc(w.title)}</h3><p class="small muted" style="margin:2px 0 0">${esc(w.subtitle || '')}</p></div>
        <div class="vn-tally">
          <span class="tag new">${counts.insert} new</span><span class="tag upd">${counts.update} to update</span>
          <span class="tag">${counts.same} unchanged</span><span class="tag err">${counts.error} error${counts.error === 1 ? '' : 's'}</span>
        </div>
      </div>
      ${w.notice ? `<div class="${w.noticeClass || 'warnbox'} small">${esc(w.notice)}</div>` : ''}
      ${w.kind === 'scan' && !w.applied ? `<div class="infobox small">Check a few values against the maker page (link in each row) before approving — especially on a maker's first live scan. New holders are added as catalogue-only ("can buy"): no stock is booked. Rows with a <span class="tag warn">check</span> note are not ticked for you.</div>` : ''}
      ${ps.length ? `
      <div class="filters"><div class="seg" role="group" aria-label="Show">${filterBtn('all', 'All')}${filterBtn('insert', 'New')}${filterBtn('update', 'Updates')}${filterBtn('same', 'Unchanged')}${filterBtn('error', 'Errors')}</div></div>
      <div class="tablewrap vn-tablewrap"><table class="data vn-table">
        <thead><tr><th class="vn-c-sel"><input type="checkbox" data-all aria-label="Select all new and updated rows shown" ${allOn ? 'checked' : ''} ${w.applied || !selectable.length ? 'disabled' : ''}></th>
          <th>Action</th><th>Order no.</th><th>What changes</th><th>Source</th></tr></thead>
        <tbody>${
          visible.length
            ? visible
                .map(([p, i]) => {
                  const [cls, label] = ACTION[p.action]
                  const can = p.action === 'insert' || p.action === 'update'
                  const holder = p.holder_id ? `<a href="#/holder/${encodeURIComponent(p.holder_id)}" class="small">${esc(p.holder_id)}</a>` : ''
                  return `<tr class="vn-row act-${esc(p.action)}" data-row="${i}" data-order="${esc(p.order_no)}">
                    <td class="vn-c-sel">${can ? `<input type="checkbox" data-sel="${i}" aria-label="Approve ${esc(p.order_no)}" ${w.sel.has(i) ? 'checked' : ''} ${w.applied ? 'disabled' : ''}>` : ''}</td>
                    <td><span class="tag ${cls}">${esc(label)}</span></td>
                    <td><span class="mono vn-order">${esc(p.order_no)}</span><br>${holder}</td>
                    <td>${fieldsHTML(p, i, w)}${(p.warnings || []).length ? `<ul class="vn-warn">${p.warnings.map((x) => `<li><span class="tag warn">check</span> ${esc(x)}</li>`).join('')}</ul>` : ''}</td>
                    <td>${p.source_url ? `<a class="vn-src" href="${esc(p.source_url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.source_url)}">Maker page ↗</a>` : '<span class="muted">—</span>'}</td>
                  </tr>`
                })
                .join('')
            : `<tr><td colspan="5">${emptyHTML('Nothing in this group.')}</td></tr>`
        }</tbody></table></div>` : emptyHTML(w.emptyText || 'Nothing was found to compare.')}
      ${w.applied ? '' : `<div class="vn-apply">
        ${counts.same ? `<label class="chk"><input type="checkbox" data-confirm-same ${w.confirmSame ? 'checked' : ''}> Also record today's check on the ${counts.same} unchanged article${counts.same === 1 ? '' : 's'}</label>` : ''}
        <span class="spacer"></span><span class="small muted" data-selcount></span>
        <button class="btn ok" type="button" data-act="approve">Approve selected</button></div>`}
      <div data-result>${w.resultHTML || ''}</div>`
    const wrap = box.querySelector('.vn-tablewrap')
    if (wrap) wrap.scrollTop = prevScroll
    updateSelCount()
  }

  function approveList() {
    const w = work
    const out = []
    w.proposals.forEach((p, i) => {
      if (p.action === 'same' && w.confirmSame) out.push({ order_no: p.order_no })
      const s = w.sel.get(i)
      if (!s) return
      if (p.action === 'insert') out.push({ order_no: p.order_no })
      else if (p.action === 'update' && s instanceof Set && s.size) {
        const all = Object.keys(p.fields).every((k) => s.has(k))
        out.push(all ? { order_no: p.order_no } : { order_no: p.order_no, fields: [...s] })
      }
    })
    return out
  }

  function updateSelCount() {
    const c = workEl.querySelector('[data-selcount]')
    if (!c || !work) return
    const rows = approveList().filter((a) => work.proposals.find((p) => p.order_no === a.order_no)?.action !== 'same').length
    c.textContent = `${rows} row${rows === 1 ? '' : 's'} selected`
  }

  async function approve(btn) {
    const w = work
    const list = approveList()
    if (!list.length) return toast('Tick at least one row (or the unchanged-articles check) to approve.', 'error')
    const who = await ctx.ensureUser()
    if (!who) return
    btn.disabled = true
    btn.textContent = 'Saving…'
    try {
      const res = await api.post('/api/vendors/apply', w.kind === 'scan' ? { job_id: w.key, approve: list } : { token: w.key, approve: list }, { idempotencyKey: w.reqKey })
      w.applied = true
      appliedKeys.add(w.key)
      const link = (x) => `<a href="#/holder/${encodeURIComponent(x.holder_id)}">${esc(x.holder_id)}</a> <span class="mono small">${esc(x.order_no)}</span>`
      w.resultHTML = `<div class="okbox vn-result"><b>Approved by ${esc(who)}</b> — recorded as import run #${esc(res.run_id)}.
          <ul>
            ${res.inserted.length ? `<li>${res.inserted.length} added to the catalogue (can buy, no stock): ${res.inserted.map(link).join(', ')}</li>` : ''}
            ${res.updated.length ? `<li>${res.updated.length} updated: ${res.updated.map((u) => `${link(u)} (${u.fields.map((f) => esc(FIELD_LABEL[f] || f)).join(', ')})`).join('; ')}</li>` : ''}
            ${res.confirmed.length ? `<li>${res.confirmed.length} checked unchanged (last-checked date set to today)</li>` : ''}
          </ul></div>
        ${res.skipped.length || res.conflicts.length ? `<div class="warnbox small"><b>Not written:</b><ul>${[...res.skipped.map((s) => `${s.order_no}: ${s.reason}`), ...res.conflicts.map((c) => `${c.order_no} ${FIELD_LABEL[c.field] || c.field}: ${c.reason}`)].map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}`
      drawProposals()
      toast(`Approved: ${res.inserted.length} added, ${res.updated.length} updated`, 'ok')
      refreshSummary()
      // New holders change the reference data other screens filter on (per-maker article counts in the
      // Catalogue / Count / Add-holder maker lists): reload it so they show without restarting the app.
      if (res.inserted.length) loadMeta().catch(() => null)
      await loadOverview().catch(() => null)
      if (me.dead) return
      renderMakers()
      renderImageStats()
      scanHint()
      loadRuns()
    } catch (e) {
      btn.disabled = false
      btn.textContent = 'Approve selected'
      toastError(e)
    }
  }

  function startScanWatch(jobId) {
    workEl.innerHTML = `<div class="card" data-jobbox></div>`
    watchJob(jobId, workEl.querySelector('[data-jobbox]'), (j) => {
      const r = j.result
      if (!r) return
      const notice = r.blocked
        ? `Stopped: ${r.blocked}`
        : r.cancelled
          ? `Cancelled after ${r.scanned} of ${r.total} products — you can still approve what was read.`
          : null
      showProposals({
        key: j.id,
        kind: 'scan',
        title: `${r.maker} · ${r.interface_code}`,
        subtitle: `${r.scanned} of ${r.total} products read · ${r.requests} requests as "${r.user_agent}" · started by ${r.started_by}`,
        proposals: r.proposals,
        notice,
        noticeClass: r.blocked ? 'errorbox' : 'warnbox',
        applied: appliedKeys.has(j.id) || !!r.applied_run_id,
        resultHTML: r.applied_run_id ? `<div class="okbox small">These proposals were already approved (import run #${esc(r.applied_run_id)}). Run a new scan to pick up later changes.</div>` : '',
        emptyText: 'No products found for this maker and interface.',
      })
      loadOverview()
        .then(() => !me.dead && renderMakers())
        .catch(() => null)
    })
  }

  // ---------------------------------------------------------------- events
  if (scanForm) {
    scanForm.addEventListener('input', scanHint)
    scanForm.addEventListener('change', scanHint)
    scanForm.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const who = await ctx.ensureUser()
      if (!who) return
      const f = scanForm
      const btn = f.querySelector('button[type=submit]')
      btn.disabled = true
      try {
        const orders = f.orders.value.split(/[\r\n,;\t]+/).map((s) => s.trim()).filter(Boolean)
        const res = await api.post(`/api/vendors/${encodeURIComponent(f.maker.value)}/scan`, { interface_code: f.iface.value, order_nos: orders, discover: f.full.checked })
        startScanWatch(res.job_id)
        workEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } catch (e) {
        if (e.status === 409 && e.details?.job_id) {
          toast(e.message)
          startScanWatch(e.details.job_id)
        } else toastError(e)
      } finally {
        btn.disabled = false
      }
    })
  }

  importForm.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const f = importForm
    const file = f.file.files[0]
    if (!file) return toast('Choose the CSV file first.', 'error')
    if (file.size > MAX_FILE_BYTES) return toast('That file is larger than 10 MB — split it into smaller files.', 'error')
    if (!f.source.value.trim()) {
      f.source.focus()
      return toast('Say where the file came from — it is recorded on every holder it changes.', 'error')
    }
    const who = await ctx.ensureUser()
    if (!who) return
    const btn = f.querySelector('button[type=submit]')
    btn.disabled = true
    btn.textContent = 'Reading…'
    try {
      const buf = await file.arrayBuffer()
      let text = new TextDecoder('utf-8').decode(buf)
      // Excel on a European Windows PC often saves CSV as Windows-1252, not UTF-8.
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf)
      const qs = new URLSearchParams({ maker: f.maker.value, interface_code: f.iface.value, source: f.source.value.trim(), file: file.name })
      if (f.status.value) qs.set('data_status', f.status.value)
      const res = await api.postText(`/api/vendors/import-file?${qs}`, text, 'text/csv; charset=utf-8')
      showProposals({
        key: res.token,
        kind: 'file',
        title: `${res.file} · ${res.maker} · ${res.interface_code}`,
        subtitle: `Source: ${res.source} · values marked "${DATA_STATUS_LABEL[res.data_status] || res.data_status}"`,
        proposals: res.proposals,
        notice: res.unused_columns.length ? `Columns not used: ${res.unused_columns.join(', ')}` : null,
        noticeClass: 'infobox',
        emptyText: 'The file has no rows to compare.',
      })
      workEl.querySelectorAll('[data-jobbox]').forEach((x) => x.remove())
      workEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (e) {
      toastError(e)
    } finally {
      btn.disabled = false
      btn.textContent = 'Read file'
    }
  })

  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act], [data-filter]')
    if (!b) return
    if (b.dataset.filter && work) {
      work.filter = b.dataset.filter
      return drawProposals()
    }
    const act = b.dataset.act
    if (act === 'pick-scan' && scanForm) {
      scanForm.maker.value = b.dataset.maker
      scanHint()
      $('#vnScan').scrollIntoView({ behavior: 'smooth', block: 'start' })
      scanForm.orders.focus({ preventScroll: true })
    } else if (act === 'pick-import') {
      importForm.maker.value = b.dataset.maker
      $('#vnImport').scrollIntoView({ behavior: 'smooth', block: 'start' })
      importForm.file.focus({ preventScroll: true })
    } else if (act === 'approve') approve(b)
    else if (act === 'images' || act === 'images-force') {
      const who = await ctx.ensureUser()
      if (!who) return
      b.disabled = true
      try {
        const res = await api.post('/api/vendors/images', { force: act === 'images-force' })
        const box = $('[data-imgjob]')
        watchJob(res.job_id, box, async (j) => {
          const r = j.result
          if (r) {
            const cached = r.skipped.filter((x) => (x.kind || 'cached') === 'cached')
            const notHere = r.skipped.filter((x) => x.kind && x.kind !== 'cached')
            const li = (id, text) => `<li><a href="#/holder/${encodeURIComponent(id)}">${esc(id)}</a>: ${esc(text)}</li>`
            box.insertAdjacentHTML(
              'beforeend',
              `<div class="${r.failed.length ? 'warnbox' : 'okbox'} small">${r.downloaded.length} saved, ${cached.length} already saved, ${notHere.length} not downloaded (no reader for that site), ${r.failed.length} could not be downloaded.
              ${notHere.length ? `<details data-skipped><summary>Not downloaded</summary><p class="muted">Photos are only downloaded from the sites of makers the app can scan (${esc(ov.vendors.filter((v) => v.automated).map((v) => v.maker).join(', '))}).</p><ul>${notHere.map((x) => li(x.holder_id, x.reason)).join('')}</ul></details>` : ''}
              ${r.failed.length ? `<details><summary>Why</summary><ul>${r.failed.map((x) => li(x.holder_id, x.error)).join('')}</ul></details>` : ''}</div>`,
            )
          }
          await loadOverview().catch(() => null)
          if (!me.dead) renderImageStats()
        })
      } catch (e) {
        toastError(e)
      } finally {
        b.disabled = false
      }
    }
  })

  el.addEventListener('change', (ev) => {
    const t = ev.target
    if (!work || work.applied) return
    if (t.matches('[data-sel]')) {
      // Updated in place (no redraw) so ticking rows in a long list keeps the place and focus.
      const i = Number(t.dataset.sel)
      const p = work.proposals[i]
      if (t.checked) work.sel.set(i, p.action === 'update' ? new Set(Object.keys(p.fields)) : true)
      else work.sel.delete(i)
      t.closest('tr')?.querySelectorAll('[data-field]').forEach((f) => (f.checked = t.checked))
      updateSelCount()
    } else if (t.matches('[data-field]')) {
      const i = Number(t.dataset.field)
      let s = work.sel.get(i)
      if (!(s instanceof Set)) s = new Set()
      if (t.checked) s.add(t.value)
      else s.delete(t.value)
      if (s.size) work.sel.set(i, s)
      else work.sel.delete(i)
      const row = t.closest('tr')
      const box = row && row.querySelector('[data-sel]')
      if (box) box.checked = s.size > 0
      updateSelCount()
    } else if (t.matches('[data-all]')) {
      work.proposals.forEach((p, i) => {
        if (work.filter !== 'all' && p.action !== work.filter) return
        if (p.action !== 'insert' && p.action !== 'update') return
        if (t.checked) work.sel.set(i, p.action === 'update' ? new Set(Object.keys(p.fields)) : true)
        else work.sel.delete(i)
      })
      drawProposals()
    } else if (t.matches('[data-confirm-same]')) {
      work.confirmSame = t.checked
      updateSelCount()
    }
  })

  // Re-attach to a scan or photo job that is still running (e.g. after looking at a holder mid-scan).
  try {
    const jobs = await api.get('/api/jobs')
    if (me.dead) return
    const scan = jobs.find((j) => j.kind === 'vendor-scan' && j.status === 'running')
    if (scan) startScanWatch(scan.id)
    else {
      const last = jobs.find((j) => j.kind === 'vendor-scan' && j.status !== 'failed' && !appliedKeys.has(j.id))
      if (last)
        workEl.innerHTML = `<div class="infobox small">Last scan: ${esc(last.title)} (${esc(last.status)}). <button class="linkbtn" type="button" data-act="reopen" data-job="${esc(last.id)}">Show its proposals</button></div>`
    }
    const img = jobs.find((j) => j.kind === 'vendor-images' && j.status === 'running')
    if (img) watchJob(img.id, $('[data-imgjob]'), () => loadOverview().then(() => !me.dead && renderImageStats()).catch(() => null))
  } catch {
    // The job list is a convenience; the page works without it.
  }
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act="reopen"]')
    if (b) startScanWatch(b.dataset.job)
  })
}
