// Issues: data flags raised between the hyperMILL tool database and the makers' own data, closed with
// what was done (who + when + note), plus the hyperMILL write-back checklist for the CAM engineer.
// Routes: #/issues?status=&severity=&category=&q=&holder=   and   #/issues/writeback
import { esc, fmt, fmtDate, sevChip, toast, toastError, debounce, emptyHTML } from '../ui.js'
import { newRequestKey } from '../api.js'
import { raiseFlagDialog, closeFlagDialog, CAM_CATEGORIES, FLAG_LIMITS } from '../components/flag-actions.js'
import { limitedFormDialog } from '../components/want-actions.js'

const STATUSES = [
  ['OPEN', 'Open'],
  ['CLOSED', 'Closed'],
  ['all', 'All'],
]
const SEVERITY_FILTERS = [
  ['', 'All severities'],
  ['HIGH,MEDIUM,LOW', 'Issues only (no INFO)'],
  ['HIGH', 'HIGH'],
  ['MEDIUM', 'MEDIUM'],
  ['LOW', 'LOW'],
  ['INFO', 'INFO notes'],
]

// Bumped on every render/teardown so late responses and debounced searches from an old render do nothing.
let renderToken = 0

export function teardown() {
  renderToken++
}

const holderLabel = (r) => (r.order_no ? `${r.manufacturer || ''} ${r.order_no}`.trim() : r.holder_id || '')
const normStatus = (s) => {
  const v = String(s || '').toUpperCase()
  return v === 'CLOSED' ? 'CLOSED' : v === 'ALL' ? 'all' : 'OPEN'
}

export async function render(root, ctx) {
  const token = ++renderToken
  const live = () => token === renderToken
  const sub = ctx.params[0] === 'writeback' ? 'writeback' : 'list'
  const f = {
    status: normStatus(ctx.query.get('status')),
    // Only the choices the severity box offers; anything else in a hand-typed URL means "all".
    severity: SEVERITY_FILTERS.some(([v]) => v && v === ctx.query.get('severity')) ? ctx.query.get('severity') : '',
    category: ctx.query.get('category') || '',
    // A search pasted into the URL is cut to what the server accepts.
    q: (ctx.query.get('q') || '').slice(0, FLAG_LIMITS.search),
    holder: ctx.query.get('holder') || '',
  }
  // Flags shown on screen, by id — the close/reopen buttons look their flag up here.
  const known = new Map()
  let allFlags = []
  let listSeq = 0

  // Listeners go on this element, not on #view, which outlives the view.
  const el = document.createElement('div')
  el.className = 'iss'
  root.appendChild(el)
  el.innerHTML = `
    <div class="view-head">
      <div><h2>Issues</h2>
        <p class="muted">Data issues found between the hyperMILL tool database and the makers' own data. HIGH and MEDIUM change what CAM or an operator would do.
        Close each one with what was done — it is recorded against your name and today's date.</p></div>
      <div class="btnrow noprint"><button class="btn" type="button" data-act="raise">Raise an issue</button></div>
    </div>
    <div class="iss-sum" data-sum aria-label="Open issues by severity"><div class="loading">Loading…</div></div>
    <nav class="seg iss-sub" aria-label="Issues sections">
      <a href="#/issues${listQuery() ? '?' + esc(listQuery()) : ''}" aria-current="${sub === 'list' ? 'page' : 'false'}">All issues</a>
      <a href="#/issues/writeback" aria-current="${sub === 'writeback' ? 'page' : 'false'}" data-wbtab>hyperMILL write-back <span class="n" data-wbcount></span></a>
    </nav>
    <div data-body></div>`
  const body = el.querySelector('[data-body]')

  if (sub === 'list') {
    body.innerHTML = `
      <div class="filters iss-filters">
        <div class="seg" role="group" aria-label="Status">${STATUSES.map(([v, l]) => `<button type="button" data-status="${v}" aria-pressed="${f.status === v}">${l}</button>`).join('')}</div>
        <label class="field">Severity <select data-f="severity">${SEVERITY_FILTERS.map(([v, l]) => `<option value="${v}" ${v === f.severity ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">Category <select data-f="category"><option value="">All categories</option></select></label>
        <label class="field iss-q"><input type="search" data-f="q" value="${esc(f.q)}" maxlength="${FLAG_LIMITS.search}" placeholder="Search order no., hyperMILL name, text…" aria-label="Search issues" autocomplete="off"></label>
        <span data-holderpill></span>
        <button class="btn ghost sm" type="button" data-act="csv" title="The issues matching these filters, for Excel">Export CSV</button>
        <span class="count-line" data-count></span>
      </div>
      <section class="list iss-list" data-list aria-live="polite"><div class="loading">Loading issues…</div></section>`
  } else {
    body.innerHTML = `
      <section class="card iss-wb">
        <div class="view-head">
          <div><h2>hyperMILL write-back</h2>
            <p class="note" style="margin:0">The changes to make in the hyperMILL tool database: open issues in the ${CAM_CATEGORIES.map((c) => `<b>${esc(c)}</b>`).join(', ')} categories,
            with each holder's current hyperMILL name, comment and gauge lengths. Make the change in hyperMILL, then press <b>Mark fixed</b> and say what you changed — that records who made the fix.
            Nothing here changes the catalogue; the next hyperMILL import picks the new names up.</p></div>
          <div class="btnrow noprint">
            <button class="btn ghost sm" type="button" data-act="wb-csv">Export CSV</button>
            <button class="btn sm" type="button" data-act="wb-print">Printable checklist</button>
          </div>
        </div>
        <div data-wb aria-live="polite"><div class="loading">Loading write-back list…</div></div>
      </section>`
  }

  // ------------------------------------------------------------ data
  function listQuery(extra = {}) {
    const p = new URLSearchParams()
    if (f.status !== 'OPEN') p.set('status', f.status)
    if (f.severity) p.set('severity', f.severity)
    if (f.category) p.set('category', f.category)
    if (f.q.trim()) p.set('q', f.q.trim())
    if (f.holder) p.set('holder', f.holder)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    return p.toString()
  }
  function apiQuery() {
    const p = new URLSearchParams({ status: f.status })
    if (f.severity) p.set('severity', f.severity)
    if (f.category) p.set('category', f.category)
    if (f.q.trim()) p.set('q', f.q.trim())
    if (f.holder) p.set('holder_id', f.holder)
    return p.toString()
  }
  function syncUrl() {
    const q = listQuery()
    history.replaceState(null, '', '#/issues' + (q ? '?' + q : ''))
    const a = el.querySelector('.iss-sub a')
    if (a) a.setAttribute('href', '#/issues' + (q ? '?' + q : ''))
  }

  async function loadAll() {
    const box = el.querySelector('[data-sum]')
    try {
      allFlags = await ctx.api.get('/api/flags?status=all')
      if (!live()) return
      renderSummary(box)
      if (sub === 'list') fillCategories()
    } catch (e) {
      if (!live()) return
      box.innerHTML = `<div class="errorbox">Could not load the issue counts: ${esc(e.message)} <button class="linkbtn" type="button" data-act="retry">Try again</button></div>`
    }
  }

  async function loadList() {
    const box = el.querySelector('[data-list]')
    if (!box) return
    const seq = ++listSeq
    try {
      const rows = await ctx.api.get('/api/flags?' + apiQuery())
      if (!live() || seq !== listSeq) return
      rows.forEach((r) => known.set(String(r.flag_id), r))
      renderList(box, rows)
    } catch (e) {
      if (!live() || seq !== listSeq) return
      box.innerHTML = `<div class="errorbox">Could not load the issues: ${esc(e.message)} <button class="linkbtn" type="button" data-act="retry">Try again</button></div>`
      el.querySelector('[data-count]').textContent = ''
    }
  }

  async function loadWriteback() {
    const box = el.querySelector('[data-wb]')
    try {
      const wb = await ctx.api.get('/api/writeback')
      if (!live()) return
      el.querySelector('[data-wbcount]').textContent = wb.count
      wb.items.forEach((r) => known.set(String(r.flag_id), r))
      if (box) renderWriteback(box, wb)
    } catch (e) {
      if (!live()) return
      if (box) box.innerHTML = `<div class="errorbox">Could not load the write-back list: ${esc(e.message)} <button class="linkbtn" type="button" data-act="retry">Try again</button></div>`
    }
  }

  const reload = () => Promise.all([loadAll(), sub === 'list' ? loadList() : null, loadWriteback()])

  // ------------------------------------------------------------ rendering
  function renderSummary(box) {
    const open = allFlags.filter((x) => x.status === 'OPEN')
    const n = (sev) => open.filter((x) => x.severity === sev).length
    const issues = open.filter((x) => x.severity !== 'INFO').length
    const closed = allFlags.length - open.length
    const chip = (sev, label) =>
      `<button type="button" class="chip ${sev} iss-chip" data-sev="${sev}" title="Show open ${sev} only">${n(sev)} ${label}</button>`
    box.innerHTML = `
      <div class="iss-total"><span class="v" data-open-issues>${issues}</span><span class="k">open issue${issues === 1 ? '' : 's'}</span></div>
      <div class="iss-chips">${chip('HIGH', 'HIGH')}${chip('MEDIUM', 'MEDIUM')}${chip('LOW', 'LOW')}</div>
      <div class="iss-info">${chip('INFO', 'INFO notes')}<span class="tiny muted">notes for the record — not counted as open issues</span></div>
      <div class="iss-closed tiny muted">${closed} closed</div>`
  }

  function fillCategories() {
    const sel = el.querySelector('[data-f="category"]')
    if (!sel) return
    const seen = new Map()
    for (const x of allFlags) if (x.category && !seen.has(x.category.toLowerCase())) seen.set(x.category.toLowerCase(), x.category)
    if (f.category && !seen.has(f.category.toLowerCase())) seen.set(f.category.toLowerCase(), f.category)
    const cats = [...seen.values()].sort((a, b) => a.localeCompare(b))
    sel.innerHTML = `<option value="">All categories</option>${cats.map((c) => `<option value="${esc(c)}" ${c.toLowerCase() === f.category.toLowerCase() ? 'selected' : ''}>${esc(c)}</option>`).join('')}`
  }

  function renderHolderPill() {
    const slot = el.querySelector('[data-holderpill]')
    if (!slot) return
    if (!f.holder) {
      slot.innerHTML = ''
      return
    }
    const any = allFlags.find((x) => x.holder_id === f.holder)
    const label = any ? holderLabel(any) : f.holder
    slot.innerHTML = `<span class="pill iss-hpill">Holder: ${esc(label)} <button type="button" class="x" data-act="clear-holder" aria-label="Show issues for all holders">×</button></span>`
  }

  function filtersActive() {
    return !!(f.severity || f.category || f.q.trim() || f.holder)
  }

  function renderList(box, rows) {
    renderHolderPill()
    const issues = rows.filter((r) => r.severity !== 'INFO').length
    const info = rows.length - issues
    el.querySelector('[data-count]').textContent = rows.length
      ? `${rows.length} shown · ${issues} issue${issues === 1 ? '' : 's'}${info ? ` + ${info} INFO` : ''}`
      : ''
    if (!rows.length) {
      const msg = filtersActive()
        ? 'No issues match these filters.'
        : f.status === 'OPEN'
          ? 'No open issues — everything raised has been closed.'
          : f.status === 'CLOSED'
            ? 'No issues have been closed yet.'
            : 'No issues have been raised.'
      box.innerHTML = `${emptyHTML(msg)}${filtersActive() ? `<div class="btnrow iss-emptybtn"><button class="btn ghost sm" type="button" data-act="clear">Clear filters</button></div>` : ''}`
      return
    }
    box.innerHTML = rows.map(rowHTML).join('')
  }

  function whoHTML(r) {
    const holder = r.holder_id
      ? `<a class="iss-holder mono" href="#/holder/${encodeURIComponent(r.holder_id)}">${esc(holderLabel(r))}</a>`
      : `<span class="iss-holder">General</span>`
    return `${holder} <span class="muted">· ${esc(r.category || 'Uncategorised')} · #${esc(r.flag_id)}</span>`
  }

  function rowHTML(r) {
    const closed = r.status === 'CLOSED'
    const raised = [r.raised_on ? `Raised ${esc(fmtDate(r.raised_on))}` : 'Raised', r.raised_by ? `by ${esc(r.raised_by)}` : '', r.source && r.source !== 'manual' ? `(${esc(r.source)})` : '']
      .filter(Boolean)
      .join(' ')
    return `<article class="iss-row sev-${esc(r.severity)} ${closed ? 'is-closed' : ''}" data-id="${esc(r.flag_id)}">
      <div class="iss-sev">${sevChip(r.severity)}${closed ? '<span class="tag">Closed</span>' : ''}</div>
      <div class="iss-what">
        <div class="iss-who">${whoHTML(r)}</div>
        ${r.cam_name ? `<div class="iss-cam tiny"><span class="muted">hyperMILL:</span> <span class="mono">${esc(r.cam_name)}</span></div>` : ''}
        <div class="iss-msg">${esc(r.message)}</div>
        ${r.action ? `<div class="iss-act">→ ${esc(r.action)}</div>` : ''}
        <div class="iss-meta tiny muted">${raised}</div>
        ${closed ? `<div class="iss-done"><b>Closed ${esc(fmtDate(r.closed_on))} by ${esc(r.closed_by || '?')}:</b> ${esc(r.close_note || '')}</div>` : ''}
      </div>
      <div class="iss-btns noprint">${
        closed
          ? `<button class="btn ghost sm" type="button" data-act="reopen" data-id="${esc(r.flag_id)}">Reopen…</button>`
          : `<button class="btn sm" type="button" data-act="close" data-id="${esc(r.flag_id)}">Close…</button>`
      }</div>
    </article>`
  }

  function renderWriteback(box, wb) {
    if (!wb.items.length) {
      box.innerHTML = emptyHTML('Nothing to change in hyperMILL — there are no open CAM model, Naming, Gauge length or hyperMILL issues.')
      return
    }
    // One block per holder (the CAM engineer edits one hyperMILL holder at a time); the server's
    // order (worst severity first) decides which holder comes first.
    const groups = new Map()
    for (const it of wb.items) {
      const key = it.holder_id || `general-${it.flag_id}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(it)
    }
    box.innerHTML = `<p class="small muted" style="margin:0 0 8px">${wb.count} fix${wb.count === 1 ? '' : 'es'} on ${wb.holders} holder${wb.holders === 1 ? '' : 's'} in hyperMILL.</p>
      <div class="wb-list">${[...groups.values()].map(groupHTML).join('')}</div>`
  }

  function groupHTML(items) {
    const h = items[0]
    const gl =
      h.cam_gl_mm != null || h.gauge_length_mm != null
        ? `hyperMILL <b class="mono">${esc(fmt(h.cam_gl_mm))}</b> · maker <b class="mono">${esc(fmt(h.gauge_length_mm))}</b>${
            h.gl_delta_mm != null ? ` <span class="tag warn">Δ ${h.gl_delta_mm > 0 ? '+' : ''}${esc(fmt(h.gl_delta_mm))} mm</span>` : ''
          }`
        : ''
    const head = h.holder_id
      ? `<div class="wb-head">
          <a class="iss-holder mono" href="#/holder/${encodeURIComponent(h.holder_id)}">${esc(holderLabel(h))}</a>
          <dl class="kv wb-cam">
            <dt>hyperMILL name</dt><dd class="mono">${h.cam_name ? esc(h.cam_name) : '<span class="muted">not in hyperMILL</span>'}</dd>
            <dt>Comment</dt><dd class="mono">${h.cam_comment ? esc(h.cam_comment) : '<span class="muted">(no comment)</span>'}</dd>
            ${gl ? `<dt>Gauge length</dt><dd>${gl}</dd>` : ''}
          </dl></div>`
      : `<div class="wb-head"><span class="iss-holder">General (not one holder)</span></div>`
    return `<div class="wb-holder">${head}<ul class="wb-fixes">${items
      .map(
        (it) => `<li class="wb-fix" data-id="${esc(it.flag_id)}">
          <div class="wb-fixhead">${sevChip(it.severity)} <span class="muted">${esc(it.category)} · #${esc(it.flag_id)}</span></div>
          <div class="iss-msg">${esc(it.message)}</div>
          ${it.action ? `<div class="iss-act">→ <b>${esc(it.action)}</b></div>` : ''}
          <div class="wb-btn noprint"><button class="btn sm" type="button" data-act="close" data-id="${esc(it.flag_id)}">Mark fixed…</button></div>
        </li>`,
      )
      .join('')}</ul></div>`
  }

  // ------------------------------------------------------------ actions
  async function afterWrite() {
    ctx.refreshSummary()
    await reload()
  }

  async function raise() {
    const who = await ctx.ensureUser()
    if (!who) return
    const pick = await pickHolder(ctx.api)
    if (!pick) return
    const row = await raiseFlagDialog(pick.holder)
    if (!row) return
    if (row.created === false) toast(`That issue is already open as #${row.flag_id} — it was not added twice.`)
    else toast(`Issue #${row.flag_id} raised`, 'ok')
    await afterWrite()
  }

  async function close(id) {
    const flag = known.get(String(id))
    if (!flag) return
    const who = await ctx.ensureUser()
    if (!who) return
    const row = await closeFlagDialog(flag)
    if (!row) return
    toast(`Issue #${row.flag_id} closed by ${row.closed_by}`, 'ok')
    await afterWrite()
  }

  async function reopen(id) {
    const flag = known.get(String(id))
    if (!flag) return
    const who = await ctx.ensureUser()
    if (!who) return
    const requestKey = newRequestKey()
    const row = await limitedFormDialog({
      title: 'Reopen issue',
      intro: `${sevChip(flag.severity)} <b>${esc(flag.holder_id ? holderLabel(flag) : 'General issue')}</b> <span class="muted">· #${esc(flag.flag_id)}</span>
        <br>${esc(flag.message)}<br><span class="tiny muted">The earlier closure (${esc(fmtDate(flag.closed_on))}, ${esc(flag.closed_by || '?')}) is kept in the issue's action history.</span>`,
      fields: [
        {
          name: 'note',
          label: 'Why is it being reopened?',
          type: 'textarea',
          required: true,
          maxlength: FLAG_LIMITS.text,
          placeholder: 'e.g. Still shows 90GL in hyperMILL after the last import',
        },
      ],
      submitLabel: 'Reopen issue',
      onSubmit: (v) => ctx.api.post(`/api/flags/${encodeURIComponent(flag.flag_id)}/reopen`, { note: v.note }, { idempotencyKey: requestKey }),
    })
    if (!row) return
    toast(`Issue #${row.flag_id} reopened`, 'ok')
    await afterWrite()
  }

  const search = debounce(() => {
    if (!live()) return
    syncUrl()
    loadList()
  }, 250)

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-status],[data-sev]')
    if (!t || !el.contains(t)) return
    try {
      if (t.dataset.status) {
        f.status = t.dataset.status
        el.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)))
        syncUrl()
        return loadList()
      }
      if (t.dataset.sev) {
        // Summary chips jump to the open list for that severity.
        if (sub !== 'list') return ctx.navigate(`#/issues?severity=${t.dataset.sev}`)
        f.status = 'OPEN'
        f.severity = t.dataset.sev
        el.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === 'OPEN')))
        el.querySelector('[data-f="severity"]').value = f.severity
        syncUrl()
        return loadList()
      }
      switch (t.dataset.act) {
        case 'raise':
          return await raise()
        case 'close':
          return await close(t.dataset.id)
        case 'reopen':
          return await reopen(t.dataset.id)
        case 'retry':
          return await reload()
        case 'clear':
          f.severity = f.category = f.q = f.holder = ''
          el.querySelector('[data-f="severity"]').value = ''
          el.querySelector('[data-f="category"]').value = ''
          el.querySelector('[data-f="q"]').value = ''
          syncUrl()
          return loadList()
        case 'clear-holder':
          f.holder = ''
          syncUrl()
          return loadList()
        case 'csv':
          return await ctx.api.download('/api/export/flags.csv?' + apiQuery(), 'issues.csv')
        case 'wb-csv':
          return await ctx.api.download('/api/export/writeback.csv', 'hypermill-writeback.csv')
        case 'wb-print':
          return ctx.api.openPrintable('/api/export/writeback.html')
      }
    } catch (err) {
      toastError(err)
    }
  })

  el.addEventListener('change', (e) => {
    const t = e.target.closest('select[data-f]')
    if (!t) return
    f[t.dataset.f] = t.value
    syncUrl()
    loadList()
  })

  el.addEventListener('input', (e) => {
    const t = e.target.closest('input[data-f="q"]')
    if (!t) return
    f.q = t.value
    search()
  })

  await reload()
  if (sub === 'list' && live()) renderHolderPill()
}

/**
 * Step 1 of "Raise an issue": which holder is it about? Searches GET /api/holders?q= as you type.
 * Resolves { holder } (holder = null for a general issue) or null if cancelled.
 */
function pickHolder(api) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog')
    d.className = 'dlg wide iss-pick'
    d.innerHTML = `<div class="dlg-head"><h2>Raise an issue</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      <div class="dlg-body">
        <p class="note" style="margin:0 0 10px">Which holder is it about? Search by order no., maker, hyperMILL name, series or clamp — or raise a general issue that is not about one holder.</p>
        <label class="fld"><span>Find the holder</span>
          <input type="search" data-q placeholder="e.g. A63.140.08, 84719607, ER32, shrink 12" autocomplete="off"></label>
        <div class="errorbox hidden" data-err></div>
        <div class="pick-list" data-results aria-live="polite"><p class="tiny muted pick-hint">Type at least two characters.</p></div>
      </div>
      <div class="dlg-foot"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn ghost" type="button" data-general>General issue (no holder)</button></div>`
    document.body.appendChild(d)
    let result = null
    let seq = 0
    const found = new Map()
    const results = d.querySelector('[data-results]')
    const err = d.querySelector('[data-err]')
    const input = d.querySelector('[data-q]')

    const run = debounce(async () => {
      const q = input.value.trim()
      const mine = ++seq
      err.classList.add('hidden')
      if (q.length < 2) {
        results.innerHTML = `<p class="tiny muted pick-hint">Type at least two characters.</p>`
        return
      }
      results.innerHTML = `<p class="tiny muted pick-hint">Searching…</p>`
      try {
        const res = await api.get('/api/holders?scope=all&q=' + encodeURIComponent(q))
        if (mine !== seq) return
        const list = (res && res.holders) || []
        found.clear()
        list.forEach((h) => found.set(h.holder_id, h))
        results.innerHTML = list.length
          ? list
              .slice(0, 30)
              .map(
                (h) => `<button type="button" class="pick" data-pick="${esc(h.holder_id)}">
                  <span class="pick-id"><b class="mono">${esc(h.manufacturer || '')} ${esc(h.order_no || h.holder_id)}</b>
                    <span class="tiny muted">${esc(h.type_name || h.type_code || '')}${h.clamp_spec ? ' · ' + esc(h.clamp_spec) : ''}${h.gauge_length_mm != null ? ' · GL ' + esc(fmt(h.gauge_length_mm)) : ''}</span></span>
                  <span class="tiny muted pick-cam">${h.cam_name ? 'hyperMILL: ' + esc(h.cam_name) : 'not in hyperMILL'} · ${Number(h.qty_on_site) > 0 ? esc(h.qty_on_site) + ' on site' : 'not on site'}</span>
                </button>`,
              )
              .join('') + (list.length > 30 ? `<p class="tiny muted pick-hint">${list.length - 30} more — type more of the order no. to narrow it down.</p>` : '')
          : `<p class="pick-hint">No holder matches “${esc(q)}”. Check the order no., or raise a general issue.</p>`
      } catch (e) {
        if (mine !== seq) return
        results.innerHTML = ''
        err.textContent = `Holder search failed: ${e.message}`
        err.classList.remove('hidden')
      }
    }, 250)

    input.addEventListener('input', run)
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return d.close('cancel')
      if (e.target.closest('[data-general]')) {
        result = { holder: null }
        return d.close('ok')
      }
      const p = e.target.closest('[data-pick]')
      if (p && found.has(p.dataset.pick)) {
        result = { holder: found.get(p.dataset.pick) }
        d.close('ok')
      }
    })
    d.addEventListener('close', () => {
      setTimeout(() => d.remove(), 0)
      resolve(d.returnValue === 'ok' ? result : null)
    })
    d.showModal()
    input.focus()
  })
}
