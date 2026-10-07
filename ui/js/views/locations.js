// Locations (#/locations): where holders are kept — crib, presetter, machine magazines, out for
// repair. Reached from Count mode and Settings. A location that has ever had a booking can't be
// deleted (the ledger refers to it); rename it instead.
import { api } from '../api.js'
import { esc, toast, toastError, confirmDialog, formDialog } from '../ui.js'
import { state, refreshSummary } from '../state.js'

const UNASSIGNED = 'Unassigned – count required'
export const KINDS = [
  { value: 'crib', label: 'Crib / store' },
  { value: 'machine', label: 'Machine magazine' },
  { value: 'external', label: 'External (vendor, repair)' },
  { value: 'holding', label: 'Holding / quarantine' },
]
const kindLabel = (k) => KINDS.find((x) => x.value === k)?.label || k || '–'

// Common places in a machining shop. A chip only pre-fills the form; the person confirms with Add.
const SUGGESTIONS = [
  { name: 'Tool crib', kind: 'crib', on: true },
  { name: 'Presetter', kind: 'crib', on: true },
  { name: 'DMG 1 magazine', kind: 'machine', on: true },
  { name: 'DMG 2 magazine', kind: 'machine', on: true },
  { name: 'Shrink-fit station', kind: 'crib', on: true },
  { name: 'Quarantine (NCR)', kind: 'holding', on: true },
  { name: 'Out for regrind/repair', kind: 'external', on: false },
]

export async function render(root, ctx) {
  const el = document.createElement('div')
  el.className = 'loc'
  root.appendChild(el)
  let rows = []

  el.innerHTML = `
    <div class="view-head">
      <div><h2>Locations</h2><p class="muted">Where holders are kept. Every count, receipt and move is booked to one of these.</p></div>
      <div class="btnrow"><a class="btn ghost" href="#/count">Count mode</a><a class="btn ghost" href="#/log">Stock ledger</a></div>
    </div>
    <div class="infobox loc-explain"><b>Counts as on site</b> decides whether holders at a location are in the site tally (the
      “holders on site” number at the top). Switch it off for places like <i>At vendor / repair</i>: the holder is still yours and stays
      on the books, but it isn’t in the building to use.</div>
    <div class="loc-grid">
      <section class="card loc-list" aria-label="Locations"><div class="loading">Loading locations…</div></section>
      <section class="card loc-add" aria-labelledby="loc-add-h">
        <h3 id="loc-add-h">Add a location</h3>
        <div class="loc-chips" data-chips aria-label="Suggestions"></div>
        <form class="form" data-addform novalidate>
          <label class="fld req"><span>Name</span><input name="name" maxlength="60" autocomplete="off" required placeholder="e.g. DMG 1 magazine"></label>
          <label class="fld"><span>Kind</span><select name="kind">${KINDS.map((k) => `<option value="${k.value}">${esc(k.label)}</option>`).join('')}</select></label>
          <label class="chk"><input type="checkbox" name="on" checked> Counts as on site</label>
          <div data-adderr role="alert"></div>
          <div class="btnrow"><button type="submit" class="btn">Add location</button></div>
        </form>
      </section>
    </div>`

  const list = el.querySelector('.loc-list')
  const form = el.querySelector('[data-addform]')

  function syncMeta() {
    // Other views read locations from state.meta (pickers); keep it current without a reload.
    if (state.meta) state.meta.locations = rows.map(({ location_id, name, kind, counts_as_on_site }) => ({ location_id, name, kind, counts_as_on_site }))
  }

  function renderChips() {
    const have = new Set(rows.map((r) => r.name.toLowerCase()))
    const free = SUGGESTIONS.filter((x) => !have.has(x.name.toLowerCase()))
    el.querySelector('[data-chips]').innerHTML = free.length
      ? `<span class="muted small">Quick add:</span> ${free
          .map((x) => `<button type="button" class="loc-chip" data-suggest="${esc(x.name)}">${esc(x.name)}</button>`)
          .join('')}`
      : ''
  }

  function renderList() {
    if (!rows.length) {
      list.innerHTML = '<div class="empty">No locations yet — add the tool crib first.</div>'
      return
    }
    list.innerHTML = `<div class="tablewrap"><table class="data loc-table">
      <thead><tr><th>Location</th><th>Kind</th><th>On site</th><th class="n">Articles</th><th class="n">Holders</th><th class="n">Bookings</th><th class="right">Actions</th></tr></thead>
      <tbody>${rows
        .map((l) => {
          const id = esc(l.location_id)
          return `<tr data-id="${id}">
            <td><b>${esc(l.name)}</b>${l.is_unassigned ? ' <span class="tag warn" title="Holds opening balances until each holder is counted">built in</span>' : ''}</td>
            <td>${esc(kindLabel(l.kind))}</td>
            <td><label class="loc-switch"><input type="checkbox" role="switch" data-onsite="${id}" ${l.counts_as_on_site ? 'checked' : ''} ${
              l.is_unassigned ? 'disabled title="Holders not yet counted are on site somewhere, so this always counts"' : ''
            } aria-label="${esc(l.name)} counts as on site"><span>${l.counts_as_on_site ? 'Yes' : 'No'}</span></label></td>
            <td class="n">${esc(l.articles)}</td>
            <td class="n">${esc(l.holders)}</td>
            <td class="n"><a href="#/log?location=${id}" title="Show this location's bookings">${esc(l.txns)}</a></td>
            <td class="actions"><div class="loc-acts">
              <a class="btn ghost sm" href="#/count?location=${id}">Count here</a>
              <button type="button" class="btn ghost sm" data-edit="${id}">Edit</button>
              ${
                l.can_delete
                  ? `<button type="button" class="btn ghost danger sm" data-del="${id}">Delete</button>`
                  : `<button type="button" class="btn ghost sm" disabled title="${esc(
                      l.is_unassigned ? 'Built in — it holds the opening balances.' : 'It has bookings in the ledger (or serialised units), so the audit trail needs it.',
                    )}">Delete</button>`
              }
            </div></td>
          </tr>`
        })
        .join('')}</tbody></table></div>
      <p class="tiny muted">A location with bookings can’t be deleted — the stock ledger refers to it. Rename it instead, or move its stock out and stop using it.</p>`
  }

  async function load() {
    try {
      rows = await api.get('/api/locations')
      syncMeta()
      renderList()
      renderChips()
    } catch (e) {
      list.innerHTML = `<div class="errorbox">Could not load the locations: ${esc(e.message)}</div>`
    }
  }

  const byId = (id) => rows.find((r) => r.location_id === Number(id))

  // The box only exists as an .errorbox while it has something to say (an empty .errorbox reads as a failed view).
  function showAddError(msg) {
    const err = el.querySelector('[data-adderr]')
    err.className = msg ? 'errorbox' : ''
    err.textContent = msg
  }

  form.elements.kind.addEventListener('change', () => {
    // Off-site places are almost always "not on site"; the person can still tick it.
    form.elements.on.checked = form.elements.kind.value !== 'external'
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    showAddError('')
    const name = form.elements.name.value.trim()
    if (!name) {
      showAddError('Give the location a name, e.g. “DMG 1 magazine”.')
      form.elements.name.focus()
      return
    }
    const who = await ctx.ensureUser()
    if (!who) return
    const btn = form.querySelector('button[type=submit]')
    btn.disabled = true
    try {
      const row = await api.post('/api/locations', { name, kind: form.elements.kind.value, counts_as_on_site: form.elements.on.checked })
      toast(`Added location “${row.name}”`, 'ok')
      form.reset()
      form.elements.on.checked = true
      await load()
    } catch (ex) {
      showAddError(ex.message)
    } finally {
      btn.disabled = false
    }
  })

  async function setOnSite(input) {
    const l = byId(input.dataset.onsite)
    const on = input.checked
    if (!l) return
    const who = await ctx.ensureUser()
    if (!who) {
      input.checked = !on
      return
    }
    if (l.holders > 0) {
      const ok = await confirmDialog(
        on ? 'Count as on site?' : 'Stop counting as on site?',
        `${l.holders} holder${l.holders === 1 ? '' : 's'} at ${l.name} will ${on ? 'be added to' : 'drop out of'} the site tally. Nothing is moved or deleted.`,
        { ok: on ? 'Count as on site' : 'Take off the site tally' },
      )
      if (!ok) {
        input.checked = !on
        return
      }
    }
    try {
      await api.patch(`/api/locations/${l.location_id}`, { counts_as_on_site: on })
      toast(`${l.name} ${on ? 'now counts' : 'no longer counts'} as on site`, 'ok')
      refreshSummary()
      await load()
    } catch (e) {
      input.checked = !on
      toastError(e)
    }
  }

  async function edit(l) {
    const who = await ctx.ensureUser()
    if (!who) return
    const fields = [
      ...(l.is_unassigned ? [] : [{ name: 'name', label: 'Name', required: true, value: l.name }]),
      { name: 'kind', label: 'Kind', type: 'select', options: KINDS, value: l.kind || 'crib' },
      ...(l.is_unassigned
        ? []
        : [{ name: 'counts_as_on_site', label: 'Counts as on site', type: 'checkbox', value: !!l.counts_as_on_site, help: 'Off for vendor / repair: those holders stay on the books but leave the site tally.' }]),
    ]
    const res = await formDialog({
      title: `Edit ${l.name}`,
      intro: l.is_unassigned ? esc(`“${UNASSIGNED}” is built in: it keeps its name and always counts as on site.`) : '',
      fields,
      submitLabel: 'Save',
      onSubmit: (v) => api.patch(`/api/locations/${l.location_id}`, v),
    })
    if (!res) return
    toast(`Saved ${res.name}`, 'ok')
    if (Number(res.counts_as_on_site) !== Number(l.counts_as_on_site)) refreshSummary()
    await load()
  }

  async function remove(l) {
    const who = await ctx.ensureUser()
    if (!who) return
    const ok = await confirmDialog('Delete location?', `Delete “${l.name}”? It has never been used, so nothing else changes.`, { ok: 'Delete', danger: true })
    if (!ok) return
    try {
      await api.del(`/api/locations/${l.location_id}`)
      toast(`Deleted ${l.name}`, 'ok')
      await load()
    } catch (e) {
      toastError(e)
      await load()
    }
  }

  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-onsite]')) setOnSite(e.target)
  })
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.suggest) {
      const x = SUGGESTIONS.find((s) => s.name === b.dataset.suggest)
      if (!x) return
      form.elements.name.value = x.name
      form.elements.kind.value = x.kind
      form.elements.on.checked = x.on
      form.elements.name.focus()
      return
    }
    if (b.dataset.edit) return edit(byId(b.dataset.edit))
    if (b.dataset.del) return remove(byId(b.dataset.del))
  })

  await load()
}
