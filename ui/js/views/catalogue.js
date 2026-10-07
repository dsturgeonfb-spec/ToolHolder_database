// Catalogue (#/catalogue): the prototype's catalogue tab made live. Filtering is server-side (GET /api/holders)
// and the filter state lives in the URL query (#/catalogue?scope=site&fit=12…), so back/forward and deep links
// work. Rows are grouped by holder type and read like a presetter readout: profile · identity · clamp · GL · stock.
import { esc, rulerHTML, profileHTML, toast, toastError, kvHTML, sevChip } from '../ui.js'
import { api } from '../api.js'
import { state } from '../state.js'
import { addToWantListDialog } from '../components/want-actions.js'
import { holderFormDialog, mm, extLink, dataStatusChip, countChip } from './holder.js'

const SCOPES = [
  ['site', 'On site'],
  ['cat', 'Can buy'],
  ['all', 'All'],
]
// count_status values (v_count_status). 'none' = nothing on site and not counted; a holder counted at 0 stays
// "Counted" (the count is the evidence), so the option label and the row chip always say the same thing.
const COUNT_STATUS = [
  ['counted', 'Counted'],
  ['unverified', 'Unverified (opening balance)'],
  ['booked', 'Booked in, not counted'],
  ['none', 'Not on site'],
]
const COUNT_STATUS_HELP =
  'Counted: a physical count is booked. Unverified: hyperMILL opening balance still waiting for a count. ' +
  'Booked in: on site by receipt or return, not counted yet. Not on site: nothing on site (a holder counted at 0 stays under Counted).'
const TYPING_DELAY = 200

/** Filter state from the URL query. Unknown values fall back to the defaults (On site, no filters). */
function readFilters(q) {
  const scope = SCOPES.some(([k]) => k === q.get('scope')) ? q.get('scope') : 'site'
  const fit = (q.get('fit') || '').trim()
  return {
    scope,
    q: q.get('q') || '',
    type: q.get('type') || '',
    mk: q.get('mk') || '',
    fit: fit && Number.isFinite(Number(fit.replace(',', '.'))) ? fit.replace(',', '.') : '',
    flag: q.get('flag') === '1',
    status: COUNT_STATUS.some(([k]) => k === q.get('status')) ? q.get('status') : '',
  }
}
function toQuery(f) {
  const p = new URLSearchParams()
  p.set('scope', f.scope)
  if (f.q.trim()) p.set('q', f.q.trim())
  if (f.type) p.set('type', f.type)
  if (f.mk) p.set('mk', f.mk)
  if (f.fit) p.set('fit', f.fit)
  if (f.flag) p.set('flag', '1')
  if (f.status) p.set('status', f.status)
  return p
}
const isFiltered = (f) => !!(f.q.trim() || f.type || f.mk || f.fit || f.flag || f.status)

let active = null
export function teardown() {
  if (active) {
    active.dead = true
    clearTimeout(active.timer)
  }
  active = null
}

export async function render(root, ctx) {
  const me = { dead: false, timer: 0 }
  active = me
  const meta = ctx.state.meta || (await api.get('/api/meta').catch(() => null))
  if (me.dead) return
  const f = readFilters(ctx.query)
  let holders = []
  let total = 0
  let seq = 0
  const expanded = new Set()
  const details = new Map() // holder_id -> detail record | Error (for the open issues in the inline detail)

  const types = meta?.types || []
  // All makers, not only those with articles: meta is read once at start-up and a holder may have been added since.
  const makers = meta?.manufacturers || []
  root.innerHTML = `<div class="cat-view view">
    <div class="view-head">
      <div><h2>Catalogue</h2>
        <p class="muted small">Every article for the taper form, from the hyperMILL tool database and maker catalogues. Quantities are the sum of booked
        transactions — <em>Unverified</em> means its hyperMILL opening balance is still waiting for a physical count.</p></div>
      <div class="btnrow">
        <button class="btn ghost" type="button" data-act="export" data-fmt="csv" title="The articles shown, with the current filters">Export CSV</button>
        <button class="btn ghost" type="button" data-act="export" data-fmt="xlsx" title="The articles shown, with the current filters">Export XLSX</button>
        <button class="btn" type="button" data-act="add">Add holder</button>
      </div>
    </div>
    <div class="cat-toolbar">
      <div class="filters cat-filters">
        <div class="seg" role="group" aria-label="Scope">${SCOPES.map(([k, l]) => `<button type="button" data-scope="${k}" aria-pressed="${f.scope === k}">${l}</button>`).join('')}</div>
        <label class="field">Search <input id="q" type="search" placeholder="Order no., series, gl80, d12…" value="${esc(f.q)}" autocomplete="off"></label>
        <label class="field">Type <select id="ftype"><option value="">All types</option>${types
          .map((t) => `<option value="${esc(t.type_code)}" ${t.type_code === f.type ? 'selected' : ''}>${esc(t.type_name)}</option>`)
          .join('')}</select></label>
        <label class="field">Maker <select id="fmk"><option value="">All makers</option>${makers
          .map((m) => `<option value="${esc(m.name)}" ${m.name === f.mk ? 'selected' : ''}>${esc(m.name)}</option>`)
          .join('')}</select></label>
        <label class="field">Fits shank Ø <input id="fit" type="number" min="0.1" max="100" step="any" inputmode="decimal" placeholder="mm" value="${esc(f.fit)}"></label>
        <label class="field"><input id="fflag" type="checkbox" ${f.flag ? 'checked' : ''}> With issues</label>
        <label class="field" title="${esc(COUNT_STATUS_HELP)}">Count status <select id="fstatus"><option value="">Any status</option>${COUNT_STATUS.map(
          ([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`,
        ).join('')}</select></label>
        <span class="count-line" id="countLine" aria-live="polite"></span>
      </div>
    </div>
    <div class="list cat-list" id="catList"><div class="loading">Loading…</div></div>
  </div>`
  const view = root.firstElementChild
  const list = view.querySelector('#catList')
  const countLine = view.querySelector('#countLine')
  const byId = (id) => holders.find((h) => h.holder_id === id)

  // ------------------------------------------------------------ URL + fetching
  function syncUrl(push) {
    const hash = '#/catalogue?' + toQuery(f).toString()
    if (location.hash === hash) return
    // pushState/replaceState change the URL without a hashchange, so the shell does not re-render this view;
    // back/forward still fire hashchange and re-render it from the URL.
    const url = location.pathname + location.search + hash
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
  }
  function changed({ push = true, typing = false } = {}) {
    clearTimeout(me.timer)
    if (typing) {
      me.timer = setTimeout(() => {
        syncUrl(false)
        load()
      }, TYPING_DELAY)
      return
    }
    syncUrl(push)
    load()
  }

  async function load() {
    const my = ++seq
    list.classList.add('is-loading')
    list.setAttribute('aria-busy', 'true')
    try {
      const data = await api.get('/api/holders?' + toQuery(f).toString())
      if (me.dead || my !== seq) return
      holders = data.holders
      total = data.total
      paint()
    } catch (e) {
      if (me.dead || my !== seq) return
      holders = []
      list.innerHTML = `<div class="errorbox">The catalogue could not be loaded: ${esc(e.message)}
        <button class="btn sm ghost" type="button" data-act="retry">Try again</button></div>`
      countLine.textContent = ''
    } finally {
      if (my === seq && !me.dead) {
        list.classList.remove('is-loading')
        list.removeAttribute('aria-busy')
      }
    }
  }

  // ------------------------------------------------------------ rendering
  function paint() {
    if (!holders.length) {
      const hint =
        f.scope === 'site' && isFiltered(f)
          ? 'Nothing on site matches. Try <b>All</b> to include articles you can buy, or clear the filters.'
          : isFiltered(f)
            ? 'No holders match these filters.'
            : f.scope === 'cat'
              ? 'Every catalogue article is on site — nothing listed to buy.'
              : 'No holders yet. Import the hyperMILL report or add one from a maker catalogue.'
      list.innerHTML = `<div class="empty cat-empty"><span>${hint}</span>${
        isFiltered(f) ? '<button class="btn sm ghost" type="button" data-act="clear">Clear filters</button>' : ''
      }</div>`
    } else {
      const groups = []
      for (const h of holders) {
        const g = groups[groups.length - 1]
        if (g && g.type === h.type_code) g.items.push(h)
        else groups.push({ type: h.type_code, name: h.type_name || h.type_code, items: [h] })
      }
      list.innerHTML = groups
        .map((g) => {
          const qty = g.items.reduce((a, h) => a + Math.max(0, Number(h.qty_on_site) || 0), 0)
          return `<div class="grp"><h3>${esc(g.name)}</h3><span class="eyebrow">${g.items.length} article${g.items.length === 1 ? '' : 's'} · <span class="mono">${qty}</span> on site</span></div>${g.items
            .map(rowHTML)
            .join('')}`
        })
        .join('')
    }
    countLine.textContent = `${holders.length} of ${total} articles shown`
  }

  function rowHTML(h) {
    const id = esc(h.holder_id)
    const open = expanded.has(h.holder_id)
    const label = `${h.manufacturer} ${h.order_no}`
    const href = `#/holder/${encodeURIComponent(h.holder_id)}`
    const issues = h.open_issues
      ? `<span class="chip ${esc(h.worst_severity)} cat-issues" title="Open issues (INFO notes not counted)">${h.open_issues} issue${h.open_issues === 1 ? '' : 's'}</span>`
      : ''
    const gl = h.gauge_length_mm != null ? Number(h.gauge_length_mm) : null
    const cgl = h.cam_gl_mm != null ? Number(h.cam_gl_mm) : null
    const camNote = cgl != null && gl != null && cgl !== gl ? `<small> · CAM ${mm(cgl)}</small>` : ''
    const qty = Number(h.qty_on_site) || 0
    const want =
      qty <= 0
        ? `<button class="want" type="button" data-act="want" data-id="${id}" aria-pressed="${h.on_want_list > 0}" title="${
            h.on_want_list > 0 ? `${h.on_want_list} already wanted — add more` : 'Add to the want list'
          }">${h.on_want_list > 0 ? `Wanted · ${esc(h.on_want_list)}` : 'Want'}</button>`
        : ''
    const toggleAttrs = `data-act="toggle" data-id="${id}" aria-expanded="${open}" aria-controls="cat-d-${id}"`
    return `<div class="row" data-row="${id}">
      <button class="cat-prof" type="button" ${toggleAttrs} aria-label="${open ? 'Hide' : 'Show'} details for ${esc(label)}">${profileHTML(h)}</button>
      <div class="ident"><div class="top">
          <button class="cat-toggle" type="button" ${toggleAttrs} aria-label="${open ? 'Hide' : 'Show'} details for ${esc(label)}"><span aria-hidden="true">▸</span></button>
          <span class="mk">${esc(h.manufacturer)}</span><a class="ord" href="${href}" title="Open the full record">${esc(h.order_no)}</a>${issues}${
            h.is_distributor ? '<span class="tag warn cat-dist" title="Distributor SKU">distributor</span>' : ''
          }</div>
        <span class="series">${esc(h.series || h.product_name || '')}</span></div>
      <div class="clamp"><span class="big">${esc(h.clamp_spec || '–')}</span><span class="sm">${esc(h.type_name || h.type_code)}</span></div>
      <div class="gl"><span class="num">GL ${mm(gl)} mm${camNote}</span>${rulerHTML(gl || 0, cgl || 0)}</div>
      <div class="nose">${h.nose_dia_mm != null ? 'Ø' + mm(h.nose_dia_mm) : '–'}<small>nose Ø</small></div>
      <div class="stock">
        <span class="cat-qty"><b class="${qty > 0 ? '' : 'zero'}">${esc(qty)}</b>on site ${countChip(h)}</span>
        <span class="cat-acts"><a class="btn sm ghost" href="#/count?holder=${encodeURIComponent(h.holder_id)}" title="Count this holder">Count</a>${want}</span>
      </div>
      ${open ? detailHTML(h) : ''}
    </div>`
  }

  function detailHTML(h) {
    const id = esc(h.holder_id)
    const label = `${h.manufacturer} ${h.order_no}`
    const src = h.cam_image ? '/' + String(h.cam_image).replace(/^\/+/, '') : null
    const dims = Object.entries(h.dims || {})
      .map(([k, v]) => `${esc(k)}: ${esc(v)}`)
      .join(' · ')
    const kv = kvHTML([
      ['Product', h.product_name],
      ['Spec code', h.spec_code],
      ['Clamping', h.clamp_spec],
      [
        'Gauge length',
        h.gauge_length_mm != null
          ? `${mm(h.gauge_length_mm)} mm${h.gauge_length_ref ? ` (maker '${h.gauge_length_ref}')` : ''}${h.cam_gl_mm != null ? ` · hyperMILL ${mm(h.cam_gl_mm)} mm` : ''}`
          : null,
      ],
      ['Nose Ø', h.nose_dia_mm != null ? `${mm(h.nose_dia_mm)} mm` : null],
      ['Coolant', h.coolant],
      ['Balance', h.balance],
      ['Max rpm', h.max_rpm != null ? Number(h.max_rpm).toLocaleString('en-GB') : null],
      ['Mass', h.mass_kg != null ? `${mm(h.mass_kg)} kg` : null],
      ['hyperMILL name', h.cam_name],
      ['hyperMILL comment', h.cam_comment],
      ['Data', `${dataStatusChip(h)} <span class="small muted">${esc(h.data_source || '')}</span>`, true],
    ])
    let flags = ''
    if (h.open_flags > 0) {
      const d = details.get(h.holder_id)
      if (!d) flags = '<p class="muted small" style="margin:0">Loading issues…</p>'
      else if (d instanceof Error) flags = `<p class="small" style="margin:0">Issues could not be loaded (${esc(d.message)}). Open the full record to see them.</p>`
      else {
        const open = (d.flags || []).filter((x) => x.status === 'OPEN')
        flags = open.length
          ? `<div class="fl"><span class="eyebrow">Open issues</span>${open
              .map((x) => `<div class="f">${sevChip(x.severity)}<div><p>${esc(x.message)}</p>${x.action ? `<p class="act">→ ${esc(x.action)}</p>` : ''}</div></div>`)
              .join('')}</div>`
          : ''
      }
    }
    return `<div class="detail" id="cat-d-${id}">
      <div class="cat-detail-side">
        ${src ? `<div class="bigprof"><img src="${esc(src)}" alt="hyperMILL holder profile of ${esc(label)}" loading="lazy"></div><span class="eyebrow">hyperMILL holder profile</span>` : '<span class="muted small">No hyperMILL model for this article.</span>'}
        <div class="links">${extLink(h.product_url, 'Maker page')}${extLink(h.image_url, 'Maker photo')}${extLink(h.drawing_url, 'Drawing')}</div>
        <a class="cat-open" href="#/holder/${encodeURIComponent(h.holder_id)}">Open full record →</a>
      </div>
      <div class="cat-detail-main">${kv}${dims ? `<div><span class="eyebrow">All maker dimensions</span><div class="dims">${dims}</div></div>` : ''}${flags}</div>
    </div>`
  }

  function repaintRow(id, focusSel) {
    const el = list.querySelector(`[data-row="${CSS.escape(id)}"]`)
    const h = byId(id)
    if (!el || !h) return
    el.outerHTML = rowHTML(h)
    if (focusSel) list.querySelector(`[data-row="${CSS.escape(id)}"] ${focusSel}`)?.focus()
  }

  function toggle(id, focusSel) {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    repaintRow(id, focusSel)
    const h = byId(id)
    if (expanded.has(id) && h && h.open_flags > 0 && !details.has(id)) {
      details.set(id, null)
      api
        .get('/api/holders/' + encodeURIComponent(id))
        .then((d) => details.set(id, d))
        .catch((e) => details.set(id, e instanceof Error ? e : new Error(String(e))))
        .finally(() => {
          if (!me.dead && expanded.has(id)) repaintRow(id)
        })
    }
  }

  // ------------------------------------------------------------ events
  view.addEventListener('click', async (ev) => {
    const seg = ev.target.closest('[data-scope]')
    if (seg) {
      if (f.scope === seg.dataset.scope) return
      f.scope = seg.dataset.scope
      view.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b === seg)))
      changed()
      return
    }
    const b = ev.target.closest('[data-act]')
    if (!b) return
    const act = b.dataset.act
    if (act === 'toggle') toggle(b.dataset.id, b.classList.contains('cat-prof') ? '.cat-prof' : '.cat-toggle')
    else if (act === 'retry') load()
    else if (act === 'clear') {
      Object.assign(f, { q: '', type: '', mk: '', fit: '', flag: false, status: '' })
      view.querySelector('#q').value = ''
      view.querySelector('#ftype').value = ''
      view.querySelector('#fmk').value = ''
      view.querySelector('#fit').value = ''
      view.querySelector('#fflag').checked = false
      view.querySelector('#fstatus').value = ''
      changed()
    } else if (act === 'want') {
      const h = byId(b.dataset.id)
      if (!h) return
      const who = await ctx.ensureUser()
      if (!who) return
      try {
        if (await addToWantListDialog(h)) await load()
      } catch (e) {
        toastError(e)
      }
    } else if (act === 'export') {
      const path = `/api/export/catalogue.${b.dataset.fmt === 'xlsx' ? 'xlsx' : 'csv'}?${toQuery(f).toString()}`
      b.disabled = true
      try {
        const name = await api.download(path, `holder_catalogue.${b.dataset.fmt}`)
        toast(`Exported ${holders.length} articles to ${name}`, 'ok')
      } catch (e) {
        toastError(e)
      } finally {
        b.disabled = false
      }
    } else if (act === 'add') {
      const who = await ctx.ensureUser()
      if (!who) return
      try {
        const saved = await holderFormDialog({ mode: 'add', meta: meta || state.meta, preset: { manufacturer: f.mk, type_code: f.type } })
        if (!saved) return
        toast(`Added ${saved.manufacturer} ${saved.order_no} (${saved.holder_id}) to the catalogue`, 'ok')
        ctx.refreshSummary()
        ctx.navigate('#/holder/' + encodeURIComponent(saved.holder_id))
      } catch (e) {
        toastError(e)
      }
    }
  })

  view.querySelector('#q').addEventListener('input', (e) => {
    f.q = e.target.value
    changed({ typing: true })
  })
  view.querySelector('#fit').addEventListener('input', (e) => {
    // A half-typed or invalid number reads as '' — treated as "no filter" rather than an error mid-typing.
    const v = e.target.value.trim()
    const next = v && Number.isFinite(Number(v)) && Number(v) > 0 ? v : ''
    if (next === f.fit) return
    f.fit = next
    changed({ typing: true })
  })
  view.querySelector('#ftype').addEventListener('change', (e) => {
    f.type = e.target.value
    changed()
  })
  view.querySelector('#fmk').addEventListener('change', (e) => {
    f.mk = e.target.value
    changed()
  })
  view.querySelector('#fflag').addEventListener('change', (e) => {
    f.flag = e.target.checked
    changed()
  })
  view.querySelector('#fstatus').addEventListener('change', (e) => {
    f.status = e.target.value
    changed()
  })

  await load()
}
