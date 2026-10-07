// Serialised (#/units?status=&due=&q=): holders tracked one by one — each with the number etched on it, its own
// balance/runout certificate, presetter ID or chip. Shows when each is next due for a runout check, flags the
// overdue ones, records inspections (a fail quarantines the unit), status changes (always with a note) and edits
// (where it is kept, serial no., a remark) — every one appended to the unit's log.
import { esc, fmt, fmtDate, toastError, debounce, emptyHTML, confirmDialog } from '../ui.js'
import { addUnitDialog, editUnitDialog, inspectUnitDialog, unitStatusDialog, unitStatusChip } from '../components/unit-actions.js'
import { pickHolderDialog } from '../components/want-actions.js'
import { openStockAction } from '../components/stock-actions.js'

const STATUS_FILTERS = [
  ['active', 'In service + quarantine'],
  ['IN_SERVICE', 'In service'],
  ['QUARANTINE', 'Quarantine'],
  ['SCRAPPED', 'Scrapped'],
  ['all', 'All'],
]
const DUE_FILTERS = [
  ['', 'Any'],
  ['1', 'Due ≤ 30 days / overdue / never'],
  ['overdue', 'Overdue only'],
]
const SOON_DAYS = 30

let renderToken = 0
export function teardown() {
  renderToken++
}

const holderLabel = (u) => `${u.manufacturer || ''} ${u.order_no || u.holder_id}`.trim()
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

function dueHTML(u) {
  if (u.status === 'SCRAPPED') return '<span class="muted">—</span>'
  if (!u.next_due) return '<span class="un-due never">Never inspected</span>'
  const d = u.days_to_due
  const when =
    d < 0 ? `${plural(-d, 'day')} overdue` : d === 0 ? 'due today' : d <= SOON_DAYS ? `in ${plural(d, 'day')}` : ''
  return `<span class="un-due ${esc(u.due_state || '')}">${esc(fmtDate(u.next_due))}${when ? `<span class="tiny"> · ${esc(when)}</span>` : ''}</span>`
}

/** Log lines are stored "YYYY-MM-DD Name: text"; shown with the shop's date format. */
function logLineHTML(line) {
  const m = /^(\d{4}-\d{2}-\d{2}) (.*)$/.exec(line)
  return m ? `<li><span class="un-logdate">${esc(fmtDate(m[1]))}</span> ${esc(m[2])}</li>` : `<li>${esc(line)}</li>`
}

export async function render(root, ctx) {
  const token = ++renderToken
  const live = () => token === renderToken
  const f = {
    status: STATUS_FILTERS.some(([k]) => k === ctx.query.get('status')) ? ctx.query.get('status') : 'active',
    due: DUE_FILTERS.some(([k]) => k && k === ctx.query.get('due')) ? ctx.query.get('due') : '',
    q: ctx.query.get('q') || '',
  }
  let units = []
  let every = []
  let interval = ctx.state.meta?.settings?.unit_inspection_days ?? 180
  const expanded = new Set()
  let listSeq = 0

  const el = document.createElement('div')
  el.className = 'un'
  root.appendChild(el)
  el.innerHTML = `
    <div class="view-head">
      <div><h2>Serialised holders</h2>
        <p class="muted small">Holders tracked one by one — those with their own balance/runout certificate, presetter ID or RFID chip,
        identified by the number etched on them. Each is due a runout check every <b data-interval>${esc(interval)}</b> days
        (<a href="#/settings">Settings</a>); a failed check puts it in quarantine until someone returns it to service with a note.
        Units sit on top of the stock tally: adding or scrapping one doesn't change stock.</p></div>
      <div class="btnrow noprint">
        <button class="btn" type="button" data-act="add">Add unit</button>
        <button class="btn ghost" type="button" data-act="csv" title="The units matching these filters, for Excel">Export CSV</button>
      </div>
    </div>
    <div class="un-sum" data-sum aria-label="Units by status"></div>
    <div class="filters un-filters">
      <label class="field">Status <select data-f="status">${STATUS_FILTERS.map(([k, l]) => `<option value="${k}" ${k === f.status ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field">Inspection <select data-f="due">${DUE_FILTERS.map(([k, l]) => `<option value="${k}" ${k === f.due ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field un-q"><input type="search" data-f="q" value="${esc(f.q)}" placeholder="Unit id, serial, order no., location…" aria-label="Search units" autocomplete="off"></label>
      <span class="count-line" data-count></span>
    </div>
    <div data-list aria-live="polite"><div class="loading">Loading units…</div></div>`
  const box = el.querySelector('[data-list]')

  // ------------------------------------------------------------ data
  function query() {
    const p = new URLSearchParams()
    if (f.status !== 'active') p.set('status', f.status)
    if (f.due) p.set('due', f.due)
    if (f.q.trim()) p.set('q', f.q.trim())
    return p
  }
  function apiQuery() {
    const p = query()
    if (f.status === 'active') p.set('status', 'active')
    return p.toString()
  }
  function syncUrl() {
    const q = query().toString()
    history.replaceState(null, '', '#/units' + (q ? '?' + q : ''))
  }

  async function loadAll() {
    try {
      const [all, settings] = await Promise.all([ctx.api.get('/api/units?status=all'), ctx.api.get('/api/settings').catch(() => null)])
      if (!live()) return
      every = all
      if (settings && settings.unit_inspection_days) {
        interval = settings.unit_inspection_days
        el.querySelector('[data-interval]').textContent = interval
      }
      renderSummary()
    } catch (e) {
      if (!live()) return
      el.querySelector('[data-sum]').innerHTML = `<span class="small muted">Counts unavailable: ${esc(e.message)}</span>`
    }
  }

  async function loadList() {
    const seq = ++listSeq
    try {
      const rows = await ctx.api.get('/api/units?' + apiQuery())
      if (!live() || seq !== listSeq) return
      units = rows
      renderList()
    } catch (e) {
      if (!live() || seq !== listSeq) return
      box.innerHTML = `<div class="errorbox">Could not load the units: ${esc(e.message)} <button class="linkbtn" type="button" data-act="retry">Try again</button></div>`
      el.querySelector('[data-count]').textContent = ''
    }
  }

  const reload = () => Promise.all([loadAll(), loadList()])

  // ------------------------------------------------------------ rendering
  function renderSummary() {
    const n = (pred) => every.filter(pred).length
    const chip = (cls, count, label, set) =>
      `<button type="button" class="chip ${cls} un-chip" data-set='${esc(JSON.stringify(set))}' ${count ? '' : 'disabled'}>${count} ${esc(label)}</button>`
    el.querySelector('[data-sum]').innerHTML = every.length
      ? [
          chip('counted', n((u) => u.status === 'IN_SERVICE'), 'in service', { status: 'IN_SERVICE', due: '' }),
          chip('HIGH', n((u) => u.status === 'QUARANTINE'), 'in quarantine', { status: 'QUARANTINE', due: '' }),
          chip('HIGH', n((u) => u.due_state === 'overdue'), 'overdue', { status: 'active', due: 'overdue' }),
          chip('unver', n((u) => u.due_state === 'due_soon'), `due within ${SOON_DAYS} days`, { status: 'active', due: '1' }),
          chip('unver', n((u) => u.due_state === 'never'), 'never inspected', { status: 'active', due: '1' }),
          chip('none', n((u) => u.status === 'SCRAPPED'), 'scrapped', { status: 'SCRAPPED', due: '' }),
        ].join('')
      : ''
  }

  function filtersActive() {
    return f.status !== 'active' || !!f.due || !!f.q.trim()
  }

  function renderList() {
    el.querySelector('[data-count]').textContent = units.length ? `${plural(units.length, 'unit')} shown` : ''
    if (!units.length) {
      if (!every.length) {
        box.innerHTML = `<div class="card un-empty">${emptyHTML('No serialised units yet.')}
          <p class="note">Add a unit for each holder you track individually: press <b>Add unit</b>, pick the holder, and enter the number etched on it.
          You can also add one from a holder's page (Serialised units → Add unit).</p></div>`
      } else {
        box.innerHTML = `<div class="card un-empty">${emptyHTML(f.due === 'overdue' ? 'No unit is overdue for inspection.' : 'No units match these filters.')}
          ${filtersActive() ? '<div class="btnrow un-emptybtn"><button class="btn ghost sm" type="button" data-act="clear">Clear filters</button></div>' : ''}</div>`
      }
      return
    }
    box.innerHTML = `<div class="un-wrap"><table class="data un-table">
      <thead><tr><th>Unit</th><th>Holder</th><th>Serial no.</th><th>Location</th><th class="n">Runout µm</th><th>Last inspected</th><th>Next due</th><th>Status</th><th class="actions"><span class="sr">Actions</span></th></tr></thead>
      <tbody>${units.map(rowHTML).join('')}</tbody></table></div>`
  }

  function rowHTML(u) {
    const id = esc(u.unit_id)
    const open = expanded.has(u.unit_id)
    const scrapped = u.status === 'SCRAPPED'
    const desc = [u.spec_code, u.clamp_spec].filter(Boolean).join(' · ')
    const log = (u.note || '').split('\n').filter(Boolean)
    return `<tr class="un-row due-${esc(u.due_state || 'none')} st-${esc(u.status)}" data-id="${id}">
        <td data-label="Unit"><b class="mono un-id">${id}</b></td>
        <td data-label="Holder"><a class="mono" href="#/holder/${encodeURIComponent(u.holder_id)}">${esc(holderLabel(u))}</a>${desc ? `<span class="tiny muted un-desc">${esc(desc)}</span>` : ''}</td>
        <td data-label="Serial no." class="mono">${esc(u.serial_no || '–')}</td>
        <td data-label="Location">${esc(u.location || '–')}</td>
        <td data-label="Runout µm" class="n">${u.runout_check_um != null ? esc(fmt(u.runout_check_um)) : '–'}</td>
        <td data-label="Last inspected">${u.last_inspected ? `${esc(fmtDate(u.last_inspected))}${u.inspected_by ? `<span class="tiny muted un-by">${esc(u.inspected_by)}</span>` : ''}` : '<span class="muted">–</span>'}</td>
        <td data-label="Next due">${dueHTML(u)}</td>
        <td data-label="Status">${unitStatusChip(u.status)}</td>
        <td class="actions un-acts">
          ${scrapped ? '' : `<button class="btn sm" type="button" data-act="inspect" data-id="${id}">Inspect…</button>`}
          <button class="btn sm ghost" type="button" data-act="edit" data-id="${id}" title="Where it is kept, serial no., a note for its log">Edit…</button>
          <button class="btn sm ghost" type="button" data-act="status" data-id="${id}">Status…</button>
          <button class="btn sm ghost" type="button" data-act="log" data-id="${id}" aria-expanded="${open}" aria-controls="un-log-${id}">Log ${open ? '▾' : '▸'}</button>
        </td>
      </tr>${
        open
          ? `<tr class="un-logrow" id="un-log-${id}"><td colspan="9"><ol class="un-log">${
              log.length ? log.map(logLineHTML).join('') : '<li class="muted">Nothing recorded yet.</li>'
            }</ol></td></tr>`
          : ''
      }`
  }

  // ------------------------------------------------------------ actions
  const byId = (id) => units.find((u) => u.unit_id === id)

  async function afterWrite() {
    await reload()
  }

  async function changeStatus(u, preset) {
    const res = await unitStatusDialog(u, preset)
    if (!res) return
    await afterWrite()
    // The unit record doesn't move stock; a scrapped holder also has to come off the books, with its NCR.
    if (res.status === 'SCRAPPED') {
      const go = await confirmDialog(
        'Book the scrap in stock?',
        `Unit ${res.unit_id} is marked scrapped, but the stock tally still counts the holder. Book the scrap (with the NCR no.) so ${holderLabel(res)} comes off the books.`,
        { ok: 'Book scrap now', danger: true },
      )
      // Preselect where this unit is, not wherever most of the holder's stock happens to be.
      if (go && (await openStockAction('scrap', res, { locationId: res.location_id ?? undefined }))) ctx.refreshSummary()
    }
  }

  async function add() {
    const who = await ctx.ensureUser()
    if (!who) return
    const h = await pickHolderDialog({
      title: 'Add a serialised unit',
      intro: 'Which holder is it? Search by order no., designation, clamp or hyperMILL name.',
      scope: 'site',
    })
    if (!h) return
    const row = await addUnitDialog(h)
    if (!row) return
    expanded.clear()
    await afterWrite()
  }

  const search = debounce(() => {
    if (!live()) return
    syncUrl()
    loadList()
  }, 250)

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-set]')
    if (!t || !el.contains(t)) return
    try {
      if (t.dataset.set) {
        Object.assign(f, JSON.parse(t.dataset.set))
        el.querySelector('[data-f="status"]').value = f.status
        el.querySelector('[data-f="due"]').value = f.due
        syncUrl()
        return await loadList()
      }
      const u = t.dataset.id ? byId(t.dataset.id) : null
      switch (t.dataset.act) {
        case 'add':
          return await add()
        case 'csv':
          return await ctx.api.download('/api/export/units.csv?' + apiQuery(), 'serialised_units.csv')
        case 'retry':
          return await reload()
        case 'clear':
          Object.assign(f, { status: 'active', due: '', q: '' })
          el.querySelector('[data-f="status"]').value = 'active'
          el.querySelector('[data-f="due"]').value = ''
          el.querySelector('[data-f="q"]').value = ''
          syncUrl()
          return await loadList()
        case 'log':
          if (!u) return
          if (expanded.has(u.unit_id)) expanded.delete(u.unit_id)
          else expanded.add(u.unit_id)
          return renderList()
        case 'inspect': {
          if (!u) return
          const res = await inspectUnitDialog(u)
          if (!res) return
          await afterWrite()
          // A quarantined unit that has just passed can go back into service — offer it straight away.
          if (res.passed && res.status === 'QUARANTINE') await changeStatus(res, 'IN_SERVICE')
          return
        }
        case 'status':
          if (u) await changeStatus(u)
          return
        case 'edit':
          if (u && (await editUnitDialog(u))) await afterWrite()
          return
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
}
