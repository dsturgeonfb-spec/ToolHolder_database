// hyperMILL import (#/import): read the tool database "Holder" report on the host PC, show what would
// change in the catalogue, and apply it only when the person approves. The server re-checks the plan at
// apply time, so what is applied is exactly what was previewed.
import { api } from '../api.js'
import { loadMeta } from '../state.js'
import { esc, fmt, fmtDate, toast, toastError, confirmDialog, infoDialog, emptyHTML } from '../ui.js'

const DEFAULT_PATH = 'C:\\Users\\Public\\Documents\\OPEN MIND\\tooldbReport\\Holder_HSK63 HOLDERS_1\\Holder_HSK63 HOLDERS.html'
const PATH_KEY = 'hc.hypermill.path'
const IFACE_KEY = 'hc.hypermill.iface'
const FIELD_LABEL = {
  cam_name: 'hyperMILL name',
  cam_comment: 'Comment',
  cam_gl_mm: 'CAM gauge length',
  cam_image: 'Profile picture',
}

const store = {
  get(k) {
    try {
      return localStorage.getItem(k) || ''
    } catch {
      return ''
    }
  },
  set(k, v) {
    try {
      if (v) localStorage.setItem(k, v)
      else localStorage.removeItem(k)
    } catch {}
  },
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`
const holderLink = (id, maker, order) =>
  `<a href="#/holder/${encodeURIComponent(id)}"><span class="mk">${esc(maker)}</span> <span class="mono">${esc(order)}</span></a>`

function thumbHTML(url, label) {
  if (!url) return `<div class="prof none hm-thumb">no picture</div>`
  return `<button type="button" class="prof hm-thumb" data-zoom="${esc(url)}" data-label="${esc(label)}" aria-label="Enlarge the profile of ${esc(label)}"><img src="${esc(url)}" alt="hyperMILL profile of ${esc(label)}"></button>`
}

/** Couplings worth showing: anything but the usual "unknown / unknown". */
function couplingHTML(list) {
  const odd = (list || []).filter((c) => (c.type && c.type !== 'unknown') || c.class)
  if (!odd.length) return ''
  return `<div class="tiny muted">Coupling: ${odd.map((c) => `${esc(c.pos)} ${esc(c.type)}${c.class ? ` (${esc(c.class)})` : ''}`).join(' · ')}</div>`
}

function valueHTML(field, v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">(none)</span>'
  if (field === 'cam_gl_mm') return `<span class="mono">${esc(fmt(v))} mm</span>`
  if (field === 'cam_image') return `<span class="mono small">${esc(String(v).split('/').pop())}</span>`
  return esc(v)
}

function changesHTML(m) {
  const rows = m.changes.map((c) => {
    if (c.field === 'cam_image')
      return `<li><b>${FIELD_LABEL.cam_image}</b> ${m.image_change === 'added' ? 'added — the catalogue has none' : 'replaced — the old picture is kept on disk'}</li>`
    return `<li><b>${esc(FIELD_LABEL[c.field] || c.field)}</b> <span class="hm-old">${valueHTML(c.field, c.old)}</span> <span class="hm-arrow" aria-label="becomes">→</span> <span class="hm-new">${valueHTML(c.field, c.new)}</span></li>`
  })
  if (m.opening_balance) rows.push('<li><b>Stock</b> none booked yet — gets an unverified opening balance of 1 at “Unassigned – count required”</li>')
  return `<ul class="hm-changes">${rows.join('')}</ul>`
}

function sectionHTML(key, title, n, help, body) {
  return `<section class="hm-sec" data-sec="${key}">
    <h4>${esc(title)} <span class="pill">${n}</span></h4>
    ${help ? `<p class="muted small">${help}</p>` : ''}
    ${n ? body : '<p class="muted small hm-none">None.</p>'}
  </section>`
}

function previewHTML(p) {
  const plan = p.plan
  const c = p.counts
  const newRows = plan.new
    .map(
      (n) => `<tr>
        <td>${thumbHTML(n.image_url, `${n.manufacturer} ${n.order_no}`)}</td>
        <td><span class="mk">${esc(n.manufacturer)}</span> <span class="mono">${esc(n.order_no)}</span>
          ${n.manufacturer_new ? '<span class="tag new" title="This maker is not in the catalogue yet; it will be added">new maker</span>' : ''}
          ${n.order_from === 'comment' ? '<div class="tiny muted">order no. taken from the comment</div>' : ''}</td>
        <td>${esc(n.type_name)}${n.type_code === 'OTHER' ? ' <span class="tag warn" title="An issue is raised so someone sets the type">not recognised</span>' : ''}
          ${n.series ? `<div class="tiny muted">${esc(n.series)}</div>` : ''}</td>
        <td><div>${esc(n.cam_name)}</div>${n.cam_comment ? `<div class="tiny muted">${esc(n.cam_comment)}</div>` : ''}${couplingHTML(n.coupling)}</td>
        <td class="n">${n.cam_gl_mm == null ? '–' : `${esc(fmt(n.cam_gl_mm))} mm`}</td>
      </tr>`,
    )
    .join('')
  const renamedRows = plan.renamed
    .map(
      (m) => `<tr>
        <td class="nowrap">${holderLink(m.holder_id, m.manufacturer, m.order_no)}</td>
        <td><span class="hm-old">${esc(m.old_name)}</span> <span class="hm-arrow" aria-label="becomes">→</span> <span class="hm-new">${esc(m.cam_name)}</span>
          ${m.changes.length > 1 ? changesHTML({ ...m, changes: m.changes.filter((x) => x.field !== 'cam_name') }) : ''}</td>
      </tr>`,
    )
    .join('')
  const changedRows = plan.changed
    .map(
      (m) => `<tr>
        <td>${m.image_url ? thumbHTML(m.image_url, `${m.manufacturer} ${m.order_no}`) : ''}</td>
        <td class="nowrap">${holderLink(m.holder_id, m.manufacturer, m.order_no)}</td>
        <td>${changesHTML(m)}</td>
      </tr>`,
    )
    .join('')
  const removedRows = plan.removed
    .map(
      (r) => `<tr>
        <td class="nowrap">${holderLink(r.holder_id, r.manufacturer, r.order_no)}</td>
        <td>${esc(r.cam_name)}</td>
        <td class="n">${esc(r.qty_on_site)}</td>
        <td>${
          r.flag_status === 'OPEN'
            ? '<span class="tag">issue already open</span>'
            : r.already_flagged
              ? '<span class="tag" title="Its issue was closed and none are on site">dealt with</span>'
              : r.flag_status === 'CLOSED'
                ? '<span class="tag warn" title="Its issue was closed but holders are still on site">issue raised again</span>'
                : '<span class="tag warn">issue will be raised</span>'
        }</td>
      </tr>`,
    )
    .join('')
  const unmatchedRows = plan.unmatched
    .map((u) => `<tr><td class="n">${esc(u.seq)}</td><td>${esc(u.cam_name || '(no name)')}${u.cam_comment ? `<div class="tiny muted">${esc(u.cam_comment)}</div>` : ''}</td><td>${esc(u.reason)}</td></tr>`)
    .join('')
  const warnings = p.warnings
    .map((w) => `<li>${w.seq ? `<span class="mono">#${esc(w.seq)}</span> ` : ''}${w.cam_name ? `<span class="muted">${esc(w.cam_name)}:</span> ` : ''}${esc(w.message)}</li>`)
    .join('')
  // Issues apply would raise (fewer if the same issue is already open).
  const newMakers = new Set(plan.new.filter((n) => n.manufacturer_new).map((n) => n.manufacturer)).size
  const flagsToRaise =
    plan.new.length +
    plan.new.filter((n) => n.type_code === 'OTHER').length +
    newMakers +
    plan.renamed.length +
    [...plan.renamed, ...plan.changed].filter((m) => m.changes.some((x) => x.field === 'cam_gl_mm')).length +
    plan.removed.filter((r) => !r.already_flagged).length

  return `<section class="card hm-preview" data-preview>
    <div class="hm-preview-head">
      <div>
        <h3>2 · Check what will change</h3>
        <p class="muted small"><span class="mono">${esc(p.report.file)}</span> · saved ${esc(p.report.date)} · ${plural(p.report.holders, 'holder')} in the report · ${esc(plan.interface_code)}${p.report.format === 'txt' ? ' · text export (no pictures)' : ''}</p>
      </div>
      <div class="hm-counts" aria-label="Summary — jump to a section">
        <button type="button" class="hm-count new" data-jump="new"><b data-count="new">${c.new}</b> new</button>
        <button type="button" class="hm-count" data-jump="renamed"><b data-count="renamed">${c.renamed}</b> renamed</button>
        <button type="button" class="hm-count" data-jump="changed"><b data-count="changed">${c.changed}</b> changed</button>
        <button type="button" class="hm-count rem" data-jump="removed"><b data-count="removed">${c.removed}</b> removed</button>
        <button type="button" class="hm-count" data-jump="unmatched"><b data-count="unmatched">${c.unmatched}</b> unmatched</button>
        ${p.warnings.length ? `<button type="button" class="hm-count warn" data-jump="warnings"><b data-count="warnings">${p.warnings.length}</b> warning${p.warnings.length === 1 ? '' : 's'}</button>` : ''}
      </div>
    </div>
    <p class="hm-unchanged" data-unchanged>Unchanged: <b>${c.unchanged}</b> ${c.unchanged === 1 ? 'holder already matches' : 'holders already match'} the catalogue.</p>
    ${p.warnings.length ? `<div class="warnbox hm-sec" data-sec="warnings"><b>Warnings</b><ul class="hm-warnings">${warnings}</ul></div>` : ''}
    ${sectionHTML('new', 'New holders', c.new, 'Added as unverified, each with an opening balance of 1 at “Unassigned – count required” and an issue asking for the maker’s data (gauge length, clamp Ø, nose Ø).',
      `<div class="tablewrap"><table class="data hm-table"><thead><tr><th>Profile</th><th>Maker / order no.</th><th>Type</th><th>hyperMILL name</th><th class="n">CAM GL</th></tr></thead><tbody>${newRows}</tbody></table></div>`)}
    ${sectionHTML('renamed', 'Renamed in hyperMILL', c.renamed, 'The name is updated and an issue is raised so someone checks it is still the same article.',
      `<div class="tablewrap"><table class="data hm-table"><thead><tr><th>Holder</th><th>Name</th></tr></thead><tbody>${renamedRows}</tbody></table></div>`)}
    ${sectionHTML('changed', 'Changed', c.changed, 'Comment, CAM gauge length or picture differ. A gauge-length change raises an issue; the others are just updated (every change is logged on the holder).',
      `<div class="tablewrap"><table class="data hm-table"><thead><tr><th></th><th>Holder</th><th>What changes</th></tr></thead><tbody>${changedRows}</tbody></table></div>`)}
    ${sectionHTML('removed', 'Not in this report', c.removed, 'Linked to hyperMILL in the catalogue but missing from the report. An issue is raised to check stock — nothing is deleted and stock is not changed.',
      `<div class="tablewrap"><table class="data hm-table"><thead><tr><th>Holder</th><th>hyperMILL name (catalogue)</th><th class="n">On site</th><th>Issue</th></tr></thead><tbody>${removedRows}</tbody></table></div>`)}
    ${sectionHTML('unmatched', 'Unmatched', c.unmatched, 'Could not be identified, so they are not imported. Fix the name in hyperMILL and import again.',
      `<div class="tablewrap"><table class="data hm-table"><thead><tr><th class="n">#</th><th>hyperMILL name</th><th>Why</th></tr></thead><tbody>${unmatchedRows}</tbody></table></div>`)}
    <div class="hm-apply">
      ${
        p.has_work
          ? `<p class="small">Apply adds ${plural(c.new, 'holder')}, updates ${plural(c.renamed + c.changed, 'holder')} and raises up to ${plural(flagsToRaise, 'issue')}, in one go. Nothing is deleted.</p>
             <button type="button" class="btn lg" data-act="apply">Apply import</button>`
          : `<div class="okbox">Nothing to apply — the catalogue already matches this report${c.removed ? ' (the missing holders already have an issue)' : ''}.</div>`
      }
    </div>
  </section>`
}

/**
 * The way into counting what the import booked. Count can start a run at one holder (#/count?holder=…) but
 * not limit it to a set, so with several new holders the button opens the first and says so — the others
 * each have their own "count it" link in the list.
 */
function countButtonHTML(r) {
  const first = r.new_holders[0]
  if (first) {
    const label = r.new_holders.length === 1 ? 'Count the new holder' : 'Count the first new holder'
    return `<a class="btn ghost" data-count-new href="#/count?holder=${encodeURIComponent(first.holder_id)}" title="Opens Count on ${esc(first.manufacturer)} ${esc(first.order_no)}">${label}</a>`
  }
  // Opening balances for holders that were already in the catalogue (now linked to hyperMILL): plain Count.
  return r.transactions ? '<a class="btn ghost" data-count-new href="#/count">Go to Count</a>' : ''
}

function resultHTML(r) {
  const c = r.counts
  const newList = r.new_holders.length
    ? `<ul class="hm-links">${r.new_holders
        .map(
          (h) =>
            `<li>${holderLink(h.holder_id, h.manufacturer, h.order_no)} <span class="muted small">${esc(h.holder_id)}</span> · <a class="small" href="#/count?holder=${encodeURIComponent(h.holder_id)}">count it</a></li>`,
        )
        .join('')}</ul>${
        r.new_holders.length > 1
          ? '<p class="muted small">Each is booked as 1 at “Unassigned – count required” until it is counted — use “count it” next to each one.</p>'
          : ''
      }`
    : ''
  return `<section class="card hm-done" data-result-done>
    <h3>Import applied</h3>
    <div class="okbox">${plural(c.new, 'new holder')}, ${plural(r.updated_holders.length, 'holder')} updated, ${plural(r.flags_raised, 'issue')} raised${
      r.transactions ? `, ${plural(r.transactions, 'opening balance')} booked (unverified until counted)` : ''
    }.</div>
    ${newList ? `<div><b>New holders</b>${newList}</div>` : ''}
    ${r.new_manufacturers.length ? `<p class="small">New maker${r.new_manufacturers.length === 1 ? '' : 's'} added: ${r.new_manufacturers.map(esc).join(', ')}.</p>` : ''}
    <p class="muted small">A copy of the report and its pictures is kept in the data folder under <span class="mono">${esc(r.folder)}</span>.</p>
    <div class="btnrow">
      ${r.flags_raised ? '<a class="btn" href="#/issues">Open issues</a>' : ''}
      ${countButtonHTML(r)}
      <button type="button" class="btn ghost" data-act="again">Preview again</button>
    </div>
  </section>`
}

function historyHTML(runs) {
  if (!runs.length) return emptyHTML('No hyperMILL imports yet.')
  return `<div class="tablewrap"><table class="data hm-history">
    <thead><tr><th>When</th><th>By</th><th>Report</th><th>Interface</th><th class="n">New</th><th class="n">Renamed</th><th class="n">Changed</th><th class="n">Removed</th><th class="n">Unchanged</th><th class="n">Unmatched</th><th class="n">Issues</th></tr></thead>
    <tbody>${runs
      .map((r) => {
        const s = r.summary || {}
        const k = s.counts || {}
        const [d, t = ''] = String(r.run_at || '').split(' ')
        const file = s.report?.file || String(r.source || '').split(/[\\/]/).pop()
        return `<tr>
          <td class="nowrap mono small">${esc(fmtDate(d))} <span class="muted">${esc(t.slice(0, 5))}</span></td>
          <td>${esc(r.by_user || '')}</td>
          <td class="hm-file" title="${esc(r.source || '')}">${esc(file || '')}</td>
          <td class="nowrap">${esc(r.interface_code || '')}</td>
          <td class="n">${esc(k.new ?? '')}</td><td class="n">${esc(k.renamed ?? '')}</td><td class="n">${esc(k.changed ?? '')}</td>
          <td class="n">${esc(k.removed ?? '')}</td><td class="n">${esc(k.unchanged ?? '')}</td><td class="n">${esc(k.unmatched ?? '')}</td>
          <td class="n">${esc(s.flags_raised ?? '')}</td>
        </tr>`
      })
      .join('')}</tbody></table></div>`
}

export async function render(root, ctx) {
  const isHost = !!ctx.state.session?.host
  const meta = ctx.state.meta || { interfaces: [], settings: {} }
  const ifaces = meta.interfaces || []
  const savedIface = store.get(IFACE_KEY)
  const iface = ifaces.some((i) => i.interface_code === savedIface) ? savedIface : meta.settings?.default_interface || ifaces[0]?.interface_code || ''
  const canPick = !!(window.desktop && typeof window.desktop.pickFile === 'function')
  let current = null // the preview on screen

  const el = document.createElement('div')
  el.className = 'hm'
  root.appendChild(el)
  el.innerHTML = `
    <div class="view-head">
      <div><h2>hyperMILL import</h2>
        <p class="muted">Keep the catalogue in step with the hyperMILL tool database: read its Holder report, see what would change, then apply.</p></div>
    </div>
    <div class="hm-top">
      <section class="card hm-explain">
        <h3>What the import does</h3>
        <ul>
          <li>Matches every holder in the report to the catalogue by <b>maker and order no.</b></li>
          <li><b>New holders</b> are added as <i>unverified</i>, each with an <b>opening balance of 1</b> at “Unassigned – count required” until someone counts it, and an issue asking for the maker’s data.</li>
          <li><b>Renamed</b> holders and changed <b>CAM gauge lengths</b> are updated and raise an issue. Comment and picture changes are updated and logged.</li>
          <li>Holders that have <b>gone from the report raise an issue</b>. The import <b>never deletes</b> a holder and never changes the stock of an existing one.</li>
          <li>Nothing is written until you press <b>Apply</b>. Importing the same report again changes nothing.</li>
        </ul>
      </section>
      <section class="card hm-form">
        <h3>1 · Choose the report</h3>
        ${
          isHost
            ? `<form class="form" data-form novalidate>
                <label class="fld req"><span>Report file</span>
                  <span class="hm-pathrow">
                    <input type="text" name="path" data-path autocomplete="off" spellcheck="false" placeholder="${esc(DEFAULT_PATH)}" value="${esc(store.get(PATH_KEY))}">
                    ${canPick ? '<button type="button" class="btn ghost" data-act="pick">Choose report…</button>' : ''}
                  </span>
                  <span class="help">The <b>Holder</b> report hyperMILL writes from the tool database, usually <span class="mono">${esc(DEFAULT_PATH)}</span>. Its pictures must stay in the folder next to it. A .txt export also works (without pictures).</span>
                </label>
                <label class="fld"><span>Interface (taper form)</span>
                  <select name="iface" data-iface>${ifaces
                    .map((i) => `<option value="${esc(i.interface_code)}" ${i.interface_code === iface ? 'selected' : ''}>${esc(i.interface_code)}${i.standard ? ` — ${esc(i.standard)}` : ''}</option>`)
                    .join('')}</select>
                  <span class="help">New holders get this interface; holders of this interface missing from the report are flagged.</span>
                </label>
                <div class="btnrow"><button type="submit" class="btn" data-act="preview">Preview</button><span class="muted small">Reads the report; changes nothing.</span></div>
              </form>`
            : `<div class="warnbox" data-not-host>The import reads the report from the disk of the PC running the catalogue, so it can only be run on that <b>host PC</b>, not over the network. Open the Holder Catalogue on the host PC to import.</div>`
        }
      </section>
    </div>
    <div data-result aria-live="polite"></div>
    <section class="card hm-runs">
      <h3>Import history</h3>
      <div data-history><div class="loading">Loading…</div></div>
    </section>`

  const resultBox = el.querySelector('[data-result]')
  const pathInput = el.querySelector('[data-path]')
  const ifaceSelect = el.querySelector('[data-iface]')

  async function loadHistory() {
    const box = el.querySelector('[data-history]')
    try {
      const runs = await api.get('/api/import/runs?kind=HYPERMILL&limit=50')
      if (!el.isConnected) return
      box.innerHTML = historyHTML(runs)
    } catch (e) {
      if (el.isConnected) box.innerHTML = `<div class="errorbox">Could not load the import history: ${esc(e.message)}</div>`
    }
  }

  function showError(message, { again = false } = {}) {
    resultBox.innerHTML = `<div class="errorbox hm-error" data-error>${esc(message)}${
      again ? ' <button type="button" class="btn sm" data-act="again">Preview again</button>' : ''
    }</div>`
  }

  async function preview() {
    const path = pathInput.value.trim()
    if (!path) {
      showError('Enter the path of the hyperMILL report (the .html file)' + (canPick ? ', or use “Choose report…”.' : '.'))
      pathInput.focus()
      return
    }
    store.set(PATH_KEY, path)
    store.set(IFACE_KEY, ifaceSelect.value)
    const btn = el.querySelector('[data-act=preview]')
    btn.disabled = true
    current = null
    resultBox.innerHTML = '<div class="loading">Reading the report…</div>'
    try {
      const p = await api.post('/api/import/hypermill/preview', { path, interface_code: ifaceSelect.value })
      if (!el.isConnected) return
      current = p
      resultBox.innerHTML = previewHTML(p)
    } catch (e) {
      if (el.isConnected) showError(e.message)
    } finally {
      btn.disabled = false
    }
  }

  async function apply(btn) {
    if (!current) return
    const who = await ctx.ensureUser()
    if (!who) return
    const c = current.counts
    const ok = await confirmDialog(
      'Apply the hyperMILL import?',
      `This adds ${plural(c.new, 'new holder')} (each with an unverified opening balance of 1), updates ${plural(c.renamed + c.changed, 'holder')} and raises issues for renamed and missing holders — recorded against ${who}. Nothing is deleted.`,
      { ok: 'Apply import' },
    )
    if (!ok) return
    btn.disabled = true
    btn.textContent = 'Applying…'
    try {
      const r = await api.post('/api/import/hypermill/apply', { token: current.token })
      current = null
      ctx.refreshSummary()
      // The import may have added makers (or a maker's first holders): reload the reference data so the
      // maker lists in Catalogue, Add holder and Count offer them now, not after a restart.
      try {
        await loadMeta()
      } catch (err) {
        console.warn('reloading the reference data failed', err)
      }
      if (!el.isConnected) return
      resultBox.innerHTML = resultHTML(r)
      toast('hyperMILL import applied', 'ok')
      loadHistory()
    } catch (e) {
      current = null
      if (!el.isConnected) return
      // 409 = the catalogue changed since the preview; 404 = the preview expired. Either way: preview again.
      showError(e.message, { again: e.status === 409 || e.status === 404 })
    }
  }

  el.addEventListener('submit', (e) => {
    if (!e.target.matches('[data-form]')) return
    e.preventDefault()
    preview()
  })
  // A preview belongs to one report and interface; editing either means it no longer applies.
  const invalidate = () => {
    if (!current) return
    current = null
    resultBox.innerHTML = '<div class="infobox">The report or interface changed — press Preview to see what it would change.</div>'
  }
  el.addEventListener('input', (e) => {
    if (e.target === pathInput) invalidate()
  })
  el.addEventListener('change', (e) => {
    if (e.target === ifaceSelect) invalidate()
  })
  el.addEventListener('click', async (e) => {
    const zoom = e.target.closest('[data-zoom]')
    if (zoom) {
      infoDialog(zoom.dataset.label || 'Profile', `<div class="hm-zoom"><img src="${esc(zoom.dataset.zoom)}" alt="hyperMILL profile of ${esc(zoom.dataset.label || '')}"></div>`)
      return
    }
    const jump = e.target.closest('[data-jump]')
    if (jump) {
      e.preventDefault()
      el.querySelector(`[data-sec="${jump.dataset.jump}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    const b = e.target.closest('button[data-act]')
    if (!b) return
    if (b.dataset.act === 'pick') {
      try {
        const picked = await window.desktop.pickFile({
          title: 'Choose the hyperMILL Holder report',
          filters: [{ name: 'hyperMILL report', extensions: ['html', 'htm', 'txt'] }],
          defaultPath: pathInput.value.trim() || DEFAULT_PATH,
        })
        if (picked) {
          pathInput.value = picked
          preview()
        }
      } catch (err) {
        toastError(err)
      }
    } else if (b.dataset.act === 'apply') apply(b)
    else if (b.dataset.act === 'again') {
      if (isHost) preview()
    }
  })

  await loadHistory()
}
