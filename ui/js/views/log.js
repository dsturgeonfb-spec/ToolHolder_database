// Stock ledger (#/log): the AS9100 audit trail — every count, receipt, move, return and scrap, with
// who booked it, when, and on what reference. Read-only by design: a wrong booking is corrected
// by a new one (a count), never by editing history.
// Accepts ?holder=<id>&location=<id>&type=<TYPE[,TYPE]>&user=&since=&until=&q= so other views can link here.
import { api } from '../api.js'
import { esc, fmtDate, toastError, debounce } from '../ui.js'
import { state } from '../state.js'

export const TXN_LABEL = {
  OPENING_BALANCE: 'Opening balance',
  COUNT_ADJUST: 'Count',
  RECEIPT: 'Receipt',
  MOVE_OUT: 'Move out',
  MOVE_IN: 'Move in',
  SCRAP: 'Scrap',
  RETURN: 'Return',
}
const TAG_CLASS = { RECEIPT: 'new', RETURN: 'new', SCRAP: 'rem', COUNT_ADJUST: 'upd', OPENING_BALANCE: 'warn' }
const LIMIT = 500
const FILTER_KEYS = ['q', 'holder', 'location', 'type', 'user', 'since', 'until']

let cleanups = []
export function teardown() {
  cleanups.forEach((fn) => fn())
  cleanups = []
}

const deltaHTML = (n) =>
  n > 0 ? `<span class="lg-delta plus">+${esc(n)}</span>` : n < 0 ? `<span class="lg-delta minus">−${esc(-n)}</span>` : '<span class="lg-delta zero">0</span>'

const stamp = (ts) => {
  if (!ts) return '<span class="muted" title="Written before the app recorded times (seed data)">–</span>'
  const [d, t = ''] = String(ts).split(' ')
  return `${esc(fmtDate(d))} <span class="muted">${esc(t.slice(0, 5))}</span>`
}

export async function render(root, ctx) {
  teardown()
  const el = document.createElement('div')
  el.className = 'lg'
  root.appendChild(el)

  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, ctx.query.get(k) || '']))
  let locations = []
  try {
    locations = await api.get('/api/locations')
  } catch {
    locations = state.meta?.locations || []
  }
  const users = [...new Set([...(state.meta?.settings?.users || []), 'system'])]
  const userListId = 'lg-users'
  let rows = []
  let seq = 0
  let holderLabel = ''

  el.innerHTML = `
    <div class="view-head">
      <div><h2>Stock ledger</h2>
        <p class="muted">Every count, receipt, move and scrap: who booked it, when, and on what reference. Entries are never edited or deleted — a mistake is put right by a new booking (usually a count).</p></div>
      <div class="btnrow"><a class="btn ghost" href="#/count">Count mode</a><button type="button" class="btn" data-act="csv">Export CSV</button></div>
    </div>
    <div class="filters lg-filters" role="search">
      <label class="field">Search <input type="search" data-f="q" placeholder="Order no., maker, reference, note" value="${esc(f.q)}"></label>
      <label class="field">Location <select data-f="location"><option value="">All locations</option>${locations
        .map((l) => `<option value="${esc(l.location_id)}" ${String(l.location_id) === f.location ? 'selected' : ''}>${esc(l.name)}</option>`)
        .join('')}</select></label>
      <label class="field">Type <select data-f="type"><option value="">All types</option>${Object.entries(TXN_LABEL)
        .map(([k, v]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${esc(v)}</option>`)
        .join('')}${
        f.type && !TXN_LABEL[f.type] ? `<option value="${esc(f.type)}" selected>${esc(f.type)}</option>` : ''
      }</select></label>
      <label class="field">By <input data-f="user" list="${userListId}" placeholder="Anyone" value="${esc(f.user)}" size="12"></label>
      <datalist id="${userListId}">${users.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
      <label class="field">From <input type="date" data-f="since" value="${esc(f.since)}"></label>
      <label class="field">To <input type="date" data-f="until" value="${esc(f.until)}"></label>
      <button type="button" class="btn ghost sm" data-act="clear">Clear filters</button>
    </div>
    <div class="lg-holder" data-holder></div>
    <div class="lg-status muted small" data-status role="status" aria-live="polite"></div>
    <div class="tablewrap scrollbox lg-wrap" data-table><div class="loading">Loading the ledger…</div></div>
    <details class="card lg-audit" data-audit>
      <summary><h3 style="display:inline">Other changes</h3> <span class="muted small">locations, want-list lines, serialised units (inspections, status) — who and when</span></summary>
      <div data-audit-body><p class="muted small">Loading…</p></div>
    </details>`

  const params = (withLimit) => {
    const p = new URLSearchParams()
    if (f.q) p.set('q', f.q)
    if (f.holder) p.set('holder_id', f.holder)
    if (f.location) p.set('location_id', f.location)
    if (f.type) p.set('type', f.type)
    if (f.user) p.set('user', f.user)
    if (f.since) p.set('since', f.since)
    if (f.until) p.set('until', f.until)
    if (withLimit) p.set('limit', String(LIMIT))
    return p
  }

  function syncUrl() {
    const p = new URLSearchParams()
    for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k])
    const hash = '#/log' + (p.toString() ? `?${p}` : '')
    if (location.hash !== hash) history.replaceState(null, '', hash)
  }

  function renderHolderChip() {
    const box = el.querySelector('[data-holder]')
    box.innerHTML = f.holder
      ? `<span class="pill lg-chip">Holder <a href="#/holder/${encodeURIComponent(f.holder)}">${esc(holderLabel || f.holder)}</a>
          <button type="button" class="x" data-act="unholder" aria-label="Show all holders">×</button></span>`
      : ''
  }

  function renderTable() {
    const box = el.querySelector('[data-table]')
    if (!rows.length) {
      box.innerHTML = `<div class="empty">${
        FILTER_KEYS.some((k) => f[k]) ? 'Nothing in the ledger matches these filters. Clear a filter to see more.' : 'The ledger is empty.'
      }</div>`
      return
    }
    box.innerHTML = `<table class="data lg-table">
      <thead><tr><th>Date</th><th>Written</th><th>Holder</th><th>Location</th><th>Type</th><th class="n">Qty</th><th>Reference</th><th>By</th><th>Note</th></tr></thead>
      <tbody>${rows
        .map(
          (t) => `<tr>
          <td class="nowrap mono">${esc(fmtDate(t.txn_date))}</td>
          <td class="nowrap mono small">${stamp(t.created_at)}</td>
          <td class="lg-h"><a href="#/holder/${encodeURIComponent(t.holder_id)}"><span class="mk">${esc(t.manufacturer)}</span> <span class="mono">${esc(t.order_no)}</span></a>
            ${f.holder ? '' : `<button type="button" class="linkbtn tiny" data-holder-filter="${esc(t.holder_id)}" title="Show only this holder">only this</button>`}</td>
          <td>${esc(t.location)}${t.counts_as_on_site ? '' : ' <span class="tag" title="Not counted in the site tally">off site</span>'}</td>
          <td><span class="tag ${TAG_CLASS[t.txn_type] || ''}">${esc(TXN_LABEL[t.txn_type] || t.txn_type)}</span></td>
          <td class="n">${deltaHTML(Number(t.qty_delta))}</td>
          <td class="mono small">${esc(t.reference || '')}</td>
          <td class="nowrap">${esc(t.by_user || '')}</td>
          <td class="small lg-note">${esc(t.note || '')}</td>
        </tr>`,
        )
        .join('')}</tbody></table>`
  }

  async function load() {
    // A debounced search can fire after the person has left this view; don't touch the URL then.
    if (!el.isConnected) return
    const my = ++seq
    const status = el.querySelector('[data-status]')
    status.textContent = 'Loading…'
    syncUrl()
    try {
      const data = await api.get(`/api/transactions?${params(true)}`)
      if (my !== seq || !el.isConnected) return
      rows = data
      if (f.holder && rows[0]?.holder_id === f.holder) holderLabel = `${rows[0].manufacturer} ${rows[0].order_no}`
      renderHolderChip()
      renderTable()
      status.textContent =
        rows.length >= LIMIT
          ? `Showing the newest ${LIMIT} entries — narrow the filters, or export CSV for all of them.`
          : `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}, newest first.`
    } catch (e) {
      if (my !== seq || !el.isConnected) return
      status.textContent = ''
      el.querySelector('[data-table]').innerHTML = `<div class="errorbox">Could not load the ledger: ${esc(e.message)}</div>`
    }
  }
  const loadSoon = debounce(load, 250)

  el.addEventListener('input', (e) => {
    const k = e.target.dataset?.f
    if (k === 'q' || k === 'user') {
      f[k] = e.target.value.trim()
      loadSoon()
    }
  })
  el.addEventListener('change', (e) => {
    const k = e.target.dataset?.f
    if (!k || k === 'q' || k === 'user') return
    f[k] = e.target.value
    load()
  })
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.holderFilter) {
      f.holder = b.dataset.holderFilter
      holderLabel = ''
      return load()
    }
    if (b.dataset.act === 'unholder') {
      f.holder = ''
      return load()
    }
    if (b.dataset.act === 'clear') {
      for (const k of FILTER_KEYS) f[k] = ''
      el.querySelectorAll('[data-f]').forEach((i) => (i.value = ''))
      return load()
    }
    if (b.dataset.act === 'csv') {
      b.disabled = true
      try {
        await api.download(`/api/export/transactions.csv?${params(false)}`, 'stock-ledger.csv')
      } catch (err) {
        toastError(err)
      } finally {
        b.disabled = false
      }
    }
  })

  // Changes outside the stock ledger (audit_events), loaded when opened.
  const ENTITY = { location: 'Location', wishlist: 'Want list', unit: 'Serialised unit', setting: 'Setting' }
  // Plain words for what the audit records store (a machinist or an auditor reads this, not a programmer).
  const LABEL = {
    holder_id: 'Holder', serial_no: 'Serial no.', location_id: 'Kept at', runout_check_um: 'Runout µm', last_inspected: 'Last inspected',
    qty_wanted: 'Qty wanted', added_qty: 'Added', reason: 'Reason', status: 'Status', note: 'Note', name: 'Name', kind: 'Kind',
    counts_as_on_site: 'Counts as on site', users: 'People who book', unit_inspection_days: 'Inspection interval (days)',
    vendor_contact: 'Vendor contact e-mail', default_interface: 'Taper form', share: 'Network sharing',
  }
  const STATUS = { IN_SERVICE: 'In service', QUARANTINE: 'Quarantine', SCRAPPED: 'Scrapped', OPEN: 'Open', QUOTED: 'Quoted', ORDERED: 'Ordered', RECEIVED: 'Received', CANCELLED: 'Cancelled' }
  const locName = (id) => locations.find((l) => String(l.location_id) === String(id))?.name || `location ${id}`
  const val = (k, v) => {
    if (v === null || v === undefined || v === '') return '–'
    if (Array.isArray(v)) return v.length ? v.join(', ') : '–'
    if (typeof v === 'boolean') return v ? 'yes' : 'no'
    if (k === 'location_id') return locName(v)
    if (k === 'status' || k === 'from' || k === 'to') return STATUS[v] || String(v)
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  const label = (k) => LABEL[k] || k
  const describe = (e) => {
    const d = e.detail || {}
    if (e.entity === 'unit' && e.action === 'INSPECT')
      return `Runout ${d.runout_check_um ?? '–'} µm — ${d.passed ? 'passed' : 'FAILED'}${d.status_after !== d.status_before ? ` (${val('status', d.status_before)} → ${val('status', d.status_after)})` : ''}${d.note ? ` · ${d.note}` : ''}`
    if (e.entity === 'setting') return `${val(e.entity_id, d.from)} → ${val(e.entity_id, d.to)}`
    if (d.from && d.to && typeof d.from === 'object')
      return Object.keys(d.to).map((k) => `${label(k)}: ${val(k, d.from[k])} → ${val(k, d.to[k])}`).join(' · ')
    if (d.from !== undefined && d.to !== undefined) return `${val('status', d.from)} → ${val('status', d.to)}${d.note ? ` · ${d.note}` : ''}`
    if (Array.isArray(d.changes) && d.changes.length) return d.changes.join(' · ') + (d.note ? ` · ${d.note}` : '')
    return Object.entries(d)
      .filter(([k, v]) => v !== null && v !== '' && v !== undefined && k !== 'holder_id')
      .map(([k, v]) => `${label(k)}: ${val(k, v)}`)
      .join(' · ')
  }
  const which = (e) => {
    if (e.entity === 'setting') return label(e.entity_id)
    if (e.entity === 'location') return e.detail?.name || locName(e.entity_id)
    if (e.entity === 'wishlist') return `Line #${e.entity_id}${e.detail?.holder_id ? ` · ${e.detail.holder_id}` : ''}`
    return e.entity_id
  }
  const audit = el.querySelector('[data-audit]')
  audit.addEventListener('toggle', async () => {
    if (!audit.open || audit.dataset.loaded) return
    const body = audit.querySelector('[data-audit-body]')
    try {
      const events = await api.get('/api/audit?limit=500')
      audit.dataset.loaded = '1'
      body.innerHTML = events.length
        ? `<div class="btnrow" style="margin:6px 0"><button type="button" class="btn ghost sm" data-act="audit-csv">Export CSV</button></div>
           <div class="tablewrap scrollbox"><table class="data small"><thead><tr><th>When</th><th>What</th><th>Which</th><th>Change</th><th>By</th></tr></thead><tbody>
           ${events
             .map(
               (e) => `<tr><td class="nowrap">${stamp(e.at)}</td><td>${esc(ENTITY[e.entity] || e.entity)} · ${esc(e.action.toLowerCase())}</td>
               <td>${e.entity === 'unit' ? `<a class="mono" href="#/units?q=${encodeURIComponent(e.entity_id)}">${esc(e.entity_id)}</a>` : e.detail?.holder_id && e.entity === 'wishlist' ? `<a href="#/holder/${encodeURIComponent(e.detail.holder_id)}">${esc(which(e))}</a>` : esc(which(e))}</td>
               <td>${esc(describe(e))}</td><td>${esc(e.by_user || '')}</td></tr>`,
             )
             .join('')}</tbody></table></div>`
        : '<div class="empty">No changes recorded yet.</div>'
    } catch (err) {
      body.innerHTML = `<div class="errorbox">${esc(err.message)}</div>`
    }
  })
  audit.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act=audit-csv]')) api.download('/api/export/audit.csv', 'audit-events.csv').catch(toastError)
  })

  await load()
}
