// Want-list dialogs, used from the catalogue ("Want" on a can-buy article), the holder page and the
// Want list itself. Owned by the purchasing module. Contract (docs/API.md):
//   addToWantListDialog(holder) -> Promise<object|null>   wishlist row, or null if cancelled
//     holder: any holder object from the API ({ holder_id, manufacturer, order_no, … }).
//   The row is the server's want-list line (holder fields joined in) plus `merged: true` when the quantity
//   was added to the holder's existing OPEN line instead of starting a new one.
// The dialog posts the line and shows a toast; the caller refreshes its own view.
// Also exported (used by the Want list and Serialised views):
//   pickHolderDialog({ title, intro, scope }) -> Promise<holder|null>   search picker over GET /api/holders
import { api } from '../api.js'
import { debounce, esc, fmt, formDialog, toast } from '../ui.js'
import { ensureUser } from '../state.js'

export const WANT_STATUSES = ['OPEN', 'QUOTED', 'ORDERED', 'RECEIVED', 'CANCELLED']
export const WANT_STATUS_LABEL = {
  OPEN: 'Open',
  QUOTED: 'Quoted',
  ORDERED: 'Ordered',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
}
const MAX_QTY = 999

const label = (h) => `${h.manufacturer || ''} ${h.order_no || h.holder_id}`.trim()

/** Open 'Purchasing' issues for a holder (e.g. "MAPAL also lists another order no.") — a hint, so failures are ignored. */
async function purchasingNotes(holder) {
  if (Array.isArray(holder.purchasing_notes)) return holder.purchasing_notes
  if (Array.isArray(holder.flags)) return holder.flags.filter((f) => f.status === 'OPEN' && String(f.category || '').toLowerCase() === 'purchasing')
  try {
    const rows = await api.get(`/api/flags?status=OPEN&category=Purchasing&holder_id=${encodeURIComponent(holder.holder_id)}`)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export async function addToWantListDialog(holder) {
  if (!holder || !holder.holder_id) throw new Error('addToWantListDialog needs a holder with a holder_id')
  const who = await ensureUser()
  if (!who) return null
  const notes = await purchasingNotes(holder)
  const onSite = Number(holder.qty_on_site) || 0
  const wanted = Number(holder.on_want_list) || 0
  const facts = [
    holder.spec_code,
    holder.series || holder.product_name,
    holder.clamp_spec,
    holder.gauge_length_mm != null ? `GL ${fmt(holder.gauge_length_mm)} mm` : '',
  ].filter(Boolean)
  // formDialog wraps the intro in a <p>, so only inline elements here (laid out as blocks in purchasing.css).
  const intro = `<span class="wl-dlg">
      <b class="mono">${esc(label(holder))}</b>
      ${facts.length ? `<span class="muted">${esc(facts.join(' · '))}</span>` : ''}
      <span>${onSite > 0 ? `${esc(onSite)} on site now.` : 'None on site now.'}${
        wanted ? ` <b>${esc(wanted)} already on the want list</b> — the quantity is added to its open line.` : ''
      }</span>
      ${notes
        .map((n) => `<span class="wl-dlg-note"><span class="tag warn">Check</span> ${esc(n.message)}${n.action ? ` → ${esc(n.action)}` : ''}</span>`)
        .join('')}
      <span class="tiny muted">Recorded as added by ${esc(who)} today. Nothing is ordered until someone sends the RFQ.</span>
    </span>`
  const row = await formDialog({
    title: 'Add to want list',
    intro,
    fields: [
      { name: 'qty_wanted', label: 'Quantity wanted', type: 'number', required: true, value: 1, min: 1, max: MAX_QTY, step: 1 },
      {
        name: 'reason',
        label: 'Reason',
        type: 'textarea',
        placeholder: 'e.g. Job 4711 needs Ø32 at 110 GL · second holder for DMG cell 2 · replacement for scrapped unit',
        help: 'Printed on the RFQ notes, so the maker and whoever orders can see why.',
      },
    ],
    submitLabel: 'Add to want list',
    onSubmit: async (v) => {
      if (!Number.isInteger(v.qty_wanted) || v.qty_wanted < 1 || v.qty_wanted > MAX_QTY)
        throw new Error(`Quantity wanted must be a whole number from 1 to ${MAX_QTY}.`)
      return api.post('/api/wishlist', { holder_id: holder.holder_id, qty_wanted: v.qty_wanted, reason: v.reason || null })
    },
  })
  if (!row) return null
  toast(
    row.merged
      ? `Added ${row.added_qty} to the open line for ${label(row)} — ${row.qty_wanted} wanted now.`
      : `On the want list: ${row.qty_wanted} × ${label(row)}`,
    'ok',
  )
  return row
}

const PICK_SCOPES = [
  ['cat', 'Can buy'],
  ['site', 'On site'],
  ['all', 'All'],
]
const PICK_LIMIT = 40

/**
 * Holder search picker: type an order no., maker, designation, clamp or hyperMILL name; filter by
 * can-buy / on-site. Each result shows how many are on site and how many are already wanted.
 * Resolves the chosen holder (a Holder object from GET /api/holders) or null if cancelled.
 */
export function pickHolderDialog({ title = 'Choose a holder', intro = '', scope = 'all' } = {}) {
  return new Promise((resolve) => {
    let sc = PICK_SCOPES.some(([k]) => k === scope) ? scope : 'all'
    const d = document.createElement('dialog')
    d.className = 'dlg wide wl-pick'
    d.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      <div class="dlg-body">
        ${intro ? `<p class="note" style="margin:0 0 10px">${intro}</p>` : ''}
        <div class="wl-pick-bar">
          <label class="fld wl-pick-q"><span>Find the holder</span>
            <input type="search" data-q placeholder="e.g. 31396171, MHC-HSK-A063-32, shrink 12, ER32" autocomplete="off"></label>
          <div class="seg" role="group" aria-label="Which holders">${PICK_SCOPES.map(
            ([k, l]) => `<button type="button" data-scope="${k}" aria-pressed="${k === sc}">${l}</button>`,
          ).join('')}</div>
        </div>
        <div class="errorbox hidden" data-err></div>
        <div class="wl-pick-list" data-results aria-live="polite"><p class="wl-pick-hint">Loading…</p></div>
      </div>
      <div class="dlg-foot"><button class="btn ghost" type="button" data-close>Cancel</button></div>`
    document.body.appendChild(d)
    let result = null
    let seq = 0
    const found = new Map()
    const results = d.querySelector('[data-results]')
    const err = d.querySelector('[data-err]')
    const input = d.querySelector('[data-q]')

    async function run() {
      const q = input.value.trim()
      const mine = ++seq
      err.classList.add('hidden')
      try {
        const res = await api.get(`/api/holders?scope=${sc}&q=${encodeURIComponent(q)}`)
        if (mine !== seq) return
        const list = (res && res.holders) || []
        found.clear()
        list.forEach((h) => found.set(h.holder_id, h))
        if (!list.length) {
          const where = sc === 'cat' ? 'can-buy ' : sc === 'site' ? 'on-site ' : ''
          results.innerHTML = `<p class="wl-pick-hint">${
            q ? `No ${where}holder matches “${esc(q)}”. Check the order no.${sc !== 'all' ? ', or look in All' : ''}.` : 'No holders here.'
          }</p>`
          return
        }
        results.innerHTML =
          list
            .slice(0, PICK_LIMIT)
            .map((h) => {
              const onSite = Number(h.qty_on_site) || 0
              const wanted = Number(h.on_want_list) || 0
              const facts = [h.clamp_spec, h.gauge_length_mm != null ? `GL ${fmt(h.gauge_length_mm)} mm` : ''].filter(Boolean).join(' · ')
              return `<button type="button" class="wl-pick-item" data-pick="${esc(h.holder_id)}">
                <span class="wl-pick-id"><b class="mono">${esc(h.manufacturer || '')} ${esc(h.order_no || h.holder_id)}</b>
                  <span class="tiny muted">${esc([h.spec_code, h.type_name || h.type_code].filter(Boolean).join(' · '))}</span></span>
                <span class="tiny wl-pick-facts">${esc(facts)}</span>
                <span class="wl-pick-tags">${onSite > 0 ? `<span class="chip counted">${esc(onSite)} on site</span>` : '<span class="chip none">Can buy</span>'}${
                  wanted ? ` <span class="chip unver">${esc(wanted)} wanted</span>` : ''
                }</span>
              </button>`
            })
            .join('') + (list.length > PICK_LIMIT ? `<p class="wl-pick-hint">${list.length - PICK_LIMIT} more — type more of the order no. to narrow it down.</p>` : '')
      } catch (e) {
        if (mine !== seq) return
        results.innerHTML = ''
        err.textContent = `Holder search failed: ${e.message}`
        err.classList.remove('hidden')
      }
    }
    const runSoon = debounce(run, 200)

    input.addEventListener('input', runSoon)
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return d.close('cancel')
      const s = e.target.closest('[data-scope]')
      if (s) {
        sc = s.dataset.scope
        d.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b === s)))
        return run()
      }
      const p = e.target.closest('[data-pick]')
      if (p && found.has(p.dataset.pick)) {
        result = found.get(p.dataset.pick)
        d.close('ok')
      }
    })
    d.addEventListener('close', () => {
      setTimeout(() => d.remove(), 0)
      resolve(d.returnValue === 'ok' ? result : null)
    })
    d.showModal()
    input.focus()
    run()
  })
}
