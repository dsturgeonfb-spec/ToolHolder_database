// Want list (#/want?status=active|OPEN|…|all): holders the shop would like to buy, grouped by maker so each
// maker gets one RFQ. Lines move OPEN → QUOTED → ORDERED → RECEIVED (or CANCELLED) and are never deleted.
// Marking a line RECEIVED doesn't touch stock: the view offers to book the receipt (with its PO no.) right away.
import { esc, fmt, fmtDate, toast, toastError, confirmDialog, emptyHTML } from '../ui.js'
import { addToWantListDialog, pickHolderDialog, WANT_STATUSES, WANT_STATUS_LABEL } from '../components/want-actions.js'
import { openStockAction } from '../components/stock-actions.js'

const FILTERS = [
  ['active', 'Still wanted'],
  ['OPEN', 'Open'],
  ['QUOTED', 'Quoted'],
  ['ORDERED', 'Ordered'],
  ['RECEIVED', 'Received'],
  ['CANCELLED', 'Cancelled'],
  ['all', 'All'],
]
const CLOSED = ['RECEIVED', 'CANCELLED']
const MAX_QTY = 999

// Bumped on every render/teardown so late responses from an old render do nothing.
let renderToken = 0
export function teardown() {
  renderToken++
}

const holderLabel = (r) => `${r.manufacturer || ''} ${r.order_no || r.holder_id}`.trim()
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

export async function render(root, ctx) {
  const token = ++renderToken
  const live = () => token === renderToken
  const f = { status: FILTERS.some(([k]) => k === ctx.query.get('status')) ? ctx.query.get('status') : 'active' }
  let rows = [] // lines shown
  let all = [] // every line (for the counts and the empty state)
  let queue = Promise.resolve()

  const el = document.createElement('div')
  el.className = 'wl'
  root.appendChild(el)
  el.innerHTML = `
    <div class="view-head">
      <div><h2>Want list</h2>
        <p class="muted small">Holders to buy, grouped by maker. Send each maker the RFQ for its <b>open</b> lines, then move each line on as the
        quote, order and delivery come in. Lines are kept when received or cancelled — this is the purchasing record.</p></div>
      <div class="btnrow noprint">
        <button class="btn" type="button" data-act="add">Add a holder</button>
        <button class="btn ghost" type="button" data-act="csv" data-rfq>RFQ CSV</button>
        <button class="btn ghost" type="button" data-act="xlsx" data-rfq>RFQ XLSX</button>
      </div>
    </div>
    <div class="filters wl-filters">
      <div class="seg wl-seg" role="group" aria-label="Which lines">${FILTERS.map(
        ([k, l]) => `<button type="button" data-status="${k}" aria-pressed="${k === f.status}">${l}<span class="n" data-n="${k}"></span></button>`,
      ).join('')}</div>
      <span class="count-line" data-count></span>
    </div>
    <div data-list aria-live="polite"><div class="loading">Loading the want list…</div></div>`
  const box = el.querySelector('[data-list]')

  // ------------------------------------------------------------ data
  function syncUrl() {
    history.replaceState(null, '', '#/want' + (f.status !== 'active' ? `?status=${encodeURIComponent(f.status)}` : ''))
  }

  async function load() {
    try {
      const [shown, every] = await Promise.all([
        ctx.api.get(`/api/wishlist?status=${encodeURIComponent(f.status)}`),
        ctx.api.get('/api/wishlist?status=all'),
      ])
      if (!live()) return
      rows = shown
      all = every
      renderCounts()
      renderList()
    } catch (e) {
      if (!live()) return
      box.innerHTML = `<div class="errorbox">Could not load the want list: ${esc(e.message)} <button class="linkbtn" type="button" data-act="retry">Try again</button></div>`
      el.querySelector('[data-count]').textContent = ''
    }
  }

  // ------------------------------------------------------------ rendering
  function renderCounts() {
    const n = (pred) => all.filter(pred).length
    const counts = {
      active: n((r) => !CLOSED.includes(r.status)),
      all: all.length,
      ...Object.fromEntries(WANT_STATUSES.map((s) => [s, n((r) => r.status === s)])),
    }
    el.querySelectorAll('[data-n]').forEach((s) => (s.textContent = counts[s.dataset.n] ? ` ${counts[s.dataset.n]}` : ''))
    const open = all.filter((r) => r.status === 'OPEN')
    const makers = new Set(open.map((r) => r.manufacturer)).size
    el.querySelectorAll('[data-rfq]').forEach((b) => {
      b.disabled = !open.length
      b.title = open.length
        ? `${plural(open.length, 'open line')} from ${plural(makers, 'maker')}, one ${b.dataset.act === 'xlsx' ? 'sheet' : 'block'} per maker`
        : 'No open lines to ask for a quote — add holders first'
    })
    const qty = open.reduce((s, r) => s + r.qty_wanted, 0)
    el.querySelector('[data-count]').textContent = open.length
      ? `${plural(open.length, 'open line')} · ${plural(qty, 'holder')} to quote from ${plural(makers, 'maker')}`
      : ''
  }

  function renderList() {
    if (!all.length) {
      box.innerHTML = `<div class="card wl-empty">${emptyHTML('Nothing on the want list yet.')}
        <p class="note">In the <a href="#/catalogue?scope=cat">Catalogue → Can buy</a>, press <b>Want</b> on a holder you'd like to order,
        or use <b>Add a holder</b> above to search the whole catalogue. Each maker then gets one RFQ for its open lines.</p></div>`
      return
    }
    if (!rows.length) {
      const name = (FILTERS.find(([k]) => k === f.status) || [])[1] || f.status
      box.innerHTML = `<div class="card wl-empty">${emptyHTML(f.status === 'active' ? 'Nothing is still wanted — every line was received or cancelled.' : `No lines are “${name}”.`)}
        <div class="btnrow wl-emptybtn"><button class="btn ghost sm" type="button" data-status="all">Show all ${esc(all.length)} lines</button></div></div>`
      return
    }
    const groups = new Map()
    for (const r of rows) {
      if (!groups.has(r.manufacturer)) groups.set(r.manufacturer, [])
      groups.get(r.manufacturer).push(r)
    }
    box.innerHTML = [...groups.entries()].map(([maker, list]) => groupHTML(maker, list)).join('')
  }

  function groupHTML(maker, list) {
    const openLines = all.filter((r) => r.manufacturer === maker && r.status === 'OPEN')
    const qty = list.reduce((s, r) => s + r.qty_wanted, 0)
    const printTitle = openLines.length
      ? `Printable RFQ for ${maker}: ${plural(openLines.length, 'open line')}`
      : `No open ${maker} lines to ask a quote for`
    return `<section class="list wl-group" data-maker="${esc(maker)}" aria-label="${esc(maker)}">
      <div class="grp wl-grp">
        <h3>${esc(maker)}</h3>
        <span class="muted small">${plural(list.length, 'line')} · ${plural(qty, 'holder')}${openLines.length ? ` · ${openLines.length} open` : ''}</span>
        <span class="spacer"></span>
        <button class="btn sm" type="button" data-act="print" data-maker="${esc(maker)}" ${openLines.length ? '' : 'disabled'} title="${esc(printTitle)}">Print RFQ</button>
      </div>
      <div class="wl-head" aria-hidden="true"><span>Holder</span><span>Clamp · GL</span><span class="n">On site</span><span>Qty wanted</span><span>Reason</span><span>Status</span><span>Added</span></div>
      ${list.map(rowHTML).join('')}
    </section>`
  }

  function rowHTML(r) {
    const id = esc(r.wish_id)
    const closed = CLOSED.includes(r.status)
    const notes = (r.purchasing_notes || [])
      .map((n) => `<span class="wl-note"><span class="tag warn">Check</span> ${esc(n.message)}${n.action ? ` → ${esc(n.action)}` : ''}</span>`)
      .join('')
    const desc = [r.spec_code, r.series || r.product_name].filter(Boolean)
    const onSite = Number(r.qty_on_site) || 0
    return `<div class="wl-row st-${esc(r.status)}" data-id="${id}">
      <div class="wl-holder">
        <span class="wl-ident"><span class="mk">${esc(r.manufacturer)}</span>
          <a class="ord" href="#/holder/${encodeURIComponent(r.holder_id)}" title="Open the holder record">${esc(r.order_no)}</a>
          <span class="tiny muted">#${id}</span></span>
        ${desc.length ? `<span class="wl-desc small">${esc(desc.join(' · '))}</span>` : ''}
        ${r.product_url ? `<a class="tiny wl-url" href="${esc(r.product_url)}" target="_blank" rel="noopener">Maker page ↗</a>` : ''}
        ${notes}
      </div>
      <div class="wl-clamp"><span class="cell-label">Clamp · GL</span><span class="mono">${esc(r.clamp_spec || '–')}</span>
        <span class="tiny muted">GL ${esc(fmt(r.gauge_length_mm))} mm${r.type_name ? ` · ${esc(r.type_name)}` : ''}</span></div>
      <div class="wl-site"><span class="cell-label">On site</span><b class="mono ${onSite > 0 ? '' : 'zero'}">${esc(onSite)}</b></div>
      <label class="wl-qty"><span class="cell-label">Qty wanted</span>
        <input type="number" inputmode="numeric" min="1" max="${MAX_QTY}" step="1" value="${esc(r.qty_wanted)}" data-f="qty" data-id="${id}"
          aria-label="Quantity wanted for ${esc(holderLabel(r))}" ${closed ? 'disabled title="Received and cancelled lines keep their quantity"' : ''}></label>
      <label class="wl-reason"><span class="cell-label">Reason</span>
        <input type="text" value="${esc(r.reason || '')}" maxlength="1000" data-f="reason" data-id="${id}" placeholder="Why it's wanted"
          title="${esc(r.reason || '')}" aria-label="Reason for ${esc(holderLabel(r))}"></label>
      <label class="wl-status"><span class="cell-label">Status</span>
        <select data-f="status" data-id="${id}" aria-label="Status of ${esc(holderLabel(r))}"
          title="Open = still to ask for a quote · Quoted = price received · Ordered · Received · Cancelled">${WANT_STATUSES.map(
          (s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${esc(WANT_STATUS_LABEL[s] || s)}</option>`,
        ).join('')}</select>
        ${r.status === 'RECEIVED' ? `<button class="linkbtn tiny" type="button" data-act="receipt" data-id="${id}">Book receipt…</button>` : ''}</label>
      <div class="wl-added tiny"><span class="cell-label">Added</span>${esc(fmtDate(r.added_on))}${r.added_by ? ` · ${esc(r.added_by)}` : ''}
        ${r.updated_on ? `<span class="muted">changed ${esc(fmtDate(r.updated_on))}</span>` : ''}</div>
    </div>`
  }

  // ------------------------------------------------------------ actions
  const byId = (id) => rows.find((r) => String(r.wish_id) === String(id))

  async function afterWrite() {
    ctx.refreshSummary()
    await load()
  }

  // Edits run one after another: typing a reason and then picking a status fires two changes back to back,
  // and both must be saved, in order.
  function write(fn) {
    queue = queue.then(async () => {
      if (!live()) return
      const who = await ctx.ensureUser()
      if (!who) return renderList()
      try {
        await fn()
      } catch (e) {
        toastError(e)
        // Put the edited control back to what the server holds.
        if (live()) await load()
      }
    })
    return queue
  }

  async function bookReceipt(r) {
    const go = await confirmDialog(
      'Book the receipt now?',
      `Marking the line received doesn't put the holders on the books. Book a receipt for ${r.qty_wanted} × ${holderLabel(r)} with its PO no. so the stock tally shows them.`,
      { ok: 'Book receipt now' },
    )
    if (!go) return
    const posted = await openStockAction('receipt', r)
    if (posted) await afterWrite()
  }

  async function changeStatus(r, status) {
    if (status === 'CANCELLED') {
      const ok = await confirmDialog('Cancel this line?', `${r.qty_wanted} × ${holderLabel(r)} comes off the want list. The line is kept (as cancelled) for the purchasing record.`, {
        ok: 'Cancel line',
        danger: true,
      })
      if (!ok) return renderList()
      await ctx.api.del(`/api/wishlist/${encodeURIComponent(r.wish_id)}`)
      toast(`Line #${r.wish_id} cancelled`, 'ok')
      return afterWrite()
    }
    const row = await ctx.api.patch(`/api/wishlist/${encodeURIComponent(r.wish_id)}`, { status })
    toast(`${holderLabel(row)}: ${WANT_STATUS_LABEL[row.status] || row.status}`, 'ok')
    await afterWrite()
    if (row.status === 'RECEIVED') await bookReceipt(row)
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-status]')
    if (!t || !el.contains(t)) return
    if (t.dataset.status && t.tagName === 'BUTTON') {
      f.status = t.dataset.status
      el.querySelectorAll('.wl-seg [data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === f.status)))
      syncUrl()
      box.innerHTML = '<div class="loading">Loading…</div>'
      return load()
    }
    try {
      switch (t.dataset.act) {
        case 'retry':
          box.innerHTML = '<div class="loading">Loading…</div>'
          return await load()
        case 'add': {
          const who = await ctx.ensureUser()
          if (!who) return
          const h = await pickHolderDialog({
            title: 'Add a holder to the want list',
            intro: 'Search the catalogue by order no., designation, maker, clamp or hyperMILL name. <b>Can buy</b> shows holders not on site.',
            scope: 'cat',
          })
          if (!h) return
          if (await addToWantListDialog(h)) await afterWrite()
          return
        }
        case 'csv':
          return await ctx.api.download('/api/export/rfq.csv', 'rfq.csv')
        case 'xlsx':
          return await ctx.api.download('/api/export/rfq.xlsx', 'rfq.xlsx')
        case 'print':
          return ctx.api.openPrintable(`/api/export/rfq.html?maker=${encodeURIComponent(t.dataset.maker)}`)
        case 'receipt': {
          const r = byId(t.dataset.id)
          if (r) await write(() => bookReceipt(r))
          return
        }
      }
    } catch (err) {
      toastError(err)
    }
  })

  el.addEventListener('change', (e) => {
    const t = e.target.closest('[data-f][data-id]')
    if (!t || !el.contains(t)) return
    const r = byId(t.dataset.id)
    if (!r) return
    if (t.dataset.f === 'status') {
      if (t.value === r.status) return
      write(() => changeStatus(r, t.value))
    } else if (t.dataset.f === 'qty') {
      const qty = Number(t.value)
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
        toast(`Quantity wanted must be a whole number from 1 to ${MAX_QTY}.`, 'error')
        t.value = r.qty_wanted
        return
      }
      if (qty === r.qty_wanted) return
      write(async () => {
        const row = await ctx.api.patch(`/api/wishlist/${encodeURIComponent(r.wish_id)}`, { qty_wanted: qty })
        toast(`${holderLabel(row)}: ${row.qty_wanted} wanted`, 'ok')
        await afterWrite()
      })
    } else if (t.dataset.f === 'reason') {
      const reason = t.value.trim()
      if (reason === (r.reason || '')) return
      write(async () => {
        await ctx.api.patch(`/api/wishlist/${encodeURIComponent(r.wish_id)}`, { reason: reason || null })
        toast(`Reason saved for ${holderLabel(r)}`, 'ok')
        await load()
      })
    }
  })

  // Enter in the reason box saves it (the change event), like the quantity.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[data-f]')) e.target.blur()
  })

  await load()
}
