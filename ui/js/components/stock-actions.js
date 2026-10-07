// Stock booking dialogs, used from the holder page, the want list ("book receipt") and anywhere a
// holder is shown. Contract (docs/API.md):
//   openStockAction(kind, holder, opts?) -> Promise<boolean>   (true if a transaction was posted)
//     kind: 'receipt' | 'move' | 'scrap' | 'return' | 'adjust'
//     holder: { holder_id, manufacturer, order_no, ... } (any holder object from the API)
//     opts: { locationId?: number, qty?: number, reference?: string }  preselects a location / pre-fills qty and reference
// 'adjust' doesn't open a dialog: a correction is a physical count, so it opens Count mode on the holder.
import { api } from '../api.js'
import { esc, formDialog, infoDialog, toast, todayIso } from '../ui.js'
import { ensureUser, refreshSummary } from '../state.js'

const UNASSIGNED = 'Unassigned – count required'

const label = (h) => `${h.manufacturer || ''} ${h.order_no || h.holder_id}`.trim()

/** Default place for stock coming in: the asked-for location, else the tool crib, else any real location. */
function defaultInbound(locations, wanted) {
  const real = locations.filter((l) => l.name !== UNASSIGNED)
  return (
    real.find((l) => l.location_id === wanted) ||
    real.find((l) => l.name.toLowerCase() === 'tool crib') ||
    real.find((l) => l.kind === 'crib') ||
    real[0]
  )
}

export async function openStockAction(kind, holder, opts = {}) {
  if (!holder || !holder.holder_id) throw new Error('openStockAction needs a holder with a holder_id')
  if (kind === 'adjust') {
    const p = new URLSearchParams({ holder: holder.holder_id })
    if (opts.locationId) p.set('location', String(opts.locationId))
    location.hash = `#/count?${p}`
    return false
  }
  if (!['receipt', 'move', 'scrap', 'return'].includes(kind)) throw new Error(`Unknown stock action ${kind}`)
  const who = await ensureUser()
  if (!who) return false

  let locations, stock
  try {
    ;[locations, stock] = await Promise.all([api.get('/api/locations'), api.get(`/api/stock?holder_id=${encodeURIComponent(holder.holder_id)}`)])
  } catch (e) {
    toast(`Could not load locations: ${e.message}`, 'error')
    return false
  }
  const held = stock.filter((r) => r.qty_at_location > 0)
  const name = label(holder)
  const heldOptions = held.map((r) => ({ value: r.location_id, label: `${r.location} — ${r.qty_at_location} here${r.counts_as_on_site ? '' : ' (off site)'}` }))
  const realOptions = locations.filter((l) => l.name !== UNASSIGNED).map((l) => ({ value: l.location_id, label: l.name }))
  const preHeld = (held.find((r) => r.location_id === opts.locationId) || [...held].sort((a, b) => b.qty_at_location - a.qty_at_location)[0])?.location_id

  if ((kind === 'move' || kind === 'scrap') && !held.length) {
    infoDialog(
      kind === 'move' ? 'Nothing to move' : 'Nothing to scrap',
      `<p style="margin:0">No stock of <b>${esc(name)}</b> is booked anywhere. If you have one in your hand, count it first (Count mode) or book a receipt.</p>`,
    )
    return false
  }

  const qtyField = (help) => ({ name: 'qty', label: 'Quantity', type: 'number', required: true, value: Number.isInteger(opts.qty) && opts.qty > 0 ? opts.qty : 1, min: 1, step: 1, help })
  const noteField = (labelText = 'Note', placeholder = '') => ({ name: 'note', label: labelText, type: 'textarea', placeholder })
  const intro = (text) => `<b>${esc(name)}</b>${holder.series ? ` · ${esc(holder.series)}` : ''}<br>${esc(text)}`

  let dlg
  if (kind === 'receipt') {
    dlg = {
      title: 'Book a receipt',
      intro: intro('New holders arriving on site, e.g. from a purchase order.'),
      submitLabel: 'Book receipt',
      fields: [
        { name: 'location_id', label: 'Put away at', type: 'select', required: true, options: realOptions, value: defaultInbound(locations, opts.locationId)?.location_id },
        qtyField(),
        { name: 'reference', label: 'PO no.', value: opts.reference || '', placeholder: 'e.g. PO 4500123', help: 'The purchase order it came on — leave blank only if there is none.' },
        { name: 'txn_date', label: 'Date received', type: 'date', required: true, value: todayIso(), max: todayIso() },
        noteField('Note', 'e.g. delivery note no., condition'),
      ],
      body: (v) => ({ txn_type: 'RECEIPT', location_id: Number(v.location_id), qty: v.qty, reference: v.reference, txn_date: v.txn_date, note: v.note }),
      path: '/api/transactions',
      done: (v, r) => `Booked receipt: ${v.qty} × ${holder.order_no} at ${r.posted[0]?.location ?? ''}`,
    }
  } else if (kind === 'return') {
    // A holder back from repair is still on the books at the vendor location: that's a move, not a return.
    const away = held.filter((r) => !r.counts_as_on_site)
    const awayNote = away.length
      ? `<br><span class="sa-warn">${esc(
          `${away.map((r) => `${r.qty_at_location} at ${r.location}`).join(', ')} is still booked off site — if that is what came back, use Move instead so it isn't counted twice.`,
        )}</span>`
      : ''
    dlg = {
      title: 'Book a return',
      intro: intro('A holder coming back into stock from outside the books (loaned out, returned by another site).') + awayNote,
      submitLabel: 'Book return',
      fields: [
        { name: 'location_id', label: 'Put away at', type: 'select', required: true, options: realOptions, value: defaultInbound(locations, opts.locationId)?.location_id },
        qtyField(),
        { name: 'reference', label: 'Reference', placeholder: 'e.g. RMA / delivery note no.' },
        { name: 'txn_date', label: 'Date returned', type: 'date', required: true, value: todayIso(), max: todayIso() },
        noteField('Note', 'Where it came back from'),
      ],
      body: (v) => ({ txn_type: 'RETURN', location_id: Number(v.location_id), qty: v.qty, reference: v.reference, txn_date: v.txn_date, note: v.note }),
      path: '/api/transactions',
      done: (v, r) => `Booked return: ${v.qty} × ${holder.order_no} at ${r.posted[0]?.location ?? ''}`,
    }
  } else if (kind === 'move') {
    const firstOther = realOptions.find((o) => o.value !== preHeld)
    dlg = {
      title: 'Move stock',
      intro: intro('Moves holders between locations — e.g. into a machine magazine, or out to the vendor for repair. The total doesn’t change; the site tally does if one side is off site.'),
      submitLabel: 'Move',
      fields: [
        { name: 'from_location_id', label: 'From', type: 'select', required: true, options: heldOptions, value: preHeld },
        { name: 'to_location_id', label: 'To', type: 'select', required: true, options: realOptions, value: firstOther?.value },
        qtyField('Can’t be more than is booked at the “from” location.'),
        { name: 'reference', label: 'Reference', placeholder: 'e.g. RMA no., job no.', help: 'Optional — a reference is generated that ties the two ledger lines together.' },
        noteField(),
      ],
      body: (v) => ({ from_location_id: Number(v.from_location_id), to_location_id: Number(v.to_location_id), qty: v.qty, reference: v.reference, note: v.note }),
      path: '/api/moves',
      done: (v, r) => `Moved ${v.qty} × ${holder.order_no}: ${r.posted[0]?.location ?? ''} → ${r.posted[1]?.location ?? ''}`,
    }
  } else {
    dlg = {
      title: 'Scrap a holder',
      intro: intro('Takes holders out of stock for good. Needs the NCR (non-conformance report) number for the audit trail.'),
      submitLabel: 'Scrap',
      danger: true,
      fields: [
        { name: 'location_id', label: 'From', type: 'select', required: true, options: heldOptions, value: preHeld },
        qtyField('Can’t be more than is booked there.'),
        { name: 'reference', label: 'NCR no.', required: true, placeholder: 'e.g. NCR-2026-014' },
        noteField('Reason', 'What is wrong with it, e.g. taper damaged, runout 12 µm'),
      ],
      body: (v) => ({ txn_type: 'SCRAP', location_id: Number(v.location_id), qty: v.qty, reference: v.reference, note: v.note }),
      path: '/api/transactions',
      done: (v, r) => `Scrapped ${v.qty} × ${holder.order_no} at ${r.posted[0]?.location ?? ''} (${v.reference})`,
    }
  }

  const result = await formDialog({
    title: dlg.title,
    intro: dlg.intro,
    fields: dlg.fields,
    submitLabel: dlg.submitLabel,
    danger: !!dlg.danger,
    onSubmit: async (v) => {
      if (!Number.isInteger(v.qty) || v.qty < 1) throw new Error('Quantity must be a whole number, 1 or more.')
      const res = await api.post(dlg.path, { holder_id: holder.holder_id, ...dlg.body(v) })
      return { v, res }
    },
  })
  if (!result) return false
  toast(dlg.done(result.v, result.res), 'ok')
  for (const w of result.res.warnings || []) toast(w)
  refreshSummary()
  return true
}
