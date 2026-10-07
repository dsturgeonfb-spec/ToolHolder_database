// Serialised-unit dialogs, used from the holder page and the Serialised view. Owned by the units module.
// Contract (docs/API.md):
//   addUnitDialog(holder) -> Promise<object|null>   holder_units row (holder fields joined), or null if cancelled
// Also exported for the Serialised view (and anyone showing units):
//   inspectUnitDialog(unit)            -> Promise<object|null>   updated unit after an inspection
//   unitStatusDialog(unit, status?)    -> Promise<object|null>   updated unit after a status change
// Each dialog posts, shows a toast and resolves the server's row; the caller refreshes its own view.
import { api } from '../api.js'
import { esc, fmt, fmtDate, formDialog, toast, todayIso } from '../ui.js'
import { ensureUser, state } from '../state.js'

export const UNIT_STATUS = {
  IN_SERVICE: { chip: 'counted', label: 'In service' },
  QUARANTINE: { chip: 'HIGH', label: 'Quarantine' },
  SCRAPPED: { chip: 'none', label: 'Scrapped' },
}
export const unitStatusChip = (s) => {
  const x = UNIT_STATUS[s] || { chip: 'none', label: s || '–' }
  return `<span class="chip ${x.chip}">${esc(x.label)}</span>`
}

const holderLabel = (h) => `${h.manufacturer || ''} ${h.order_no || h.holder_id}`.trim()
const UNASSIGNED = 'Unassigned – count required'

async function locationOptions() {
  let locs = []
  try {
    locs = await api.get('/api/locations')
  } catch {
    // The stock module's list is the fresh one; the start-up copy will do if it can't be read.
    locs = state.meta?.locations || []
  }
  return locs.filter((l) => l.name !== UNASSIGNED).map((l) => ({ value: l.location_id, label: l.name }))
}

// No `help` on required fields: app.css marks every direct <span> of a required .fld with " *", help included.
const runoutField = (value, required) => ({
  name: 'runout_check_um',
  label: 'Runout TIR (µm)',
  type: 'number',
  required,
  value: value ?? '',
  min: 0,
  step: 0.1,
  placeholder: 'e.g. 3 (µm = 0.001 mm)',
})

/** Add a serialised unit of `holder` — the number etched on it, serial, where it lives, last runout check. */
export async function addUnitDialog(holder) {
  if (!holder || !holder.holder_id) throw new Error('addUnitDialog needs a holder with a holder_id')
  const who = await ensureUser()
  if (!who) return null
  const locations = await locationOptions()
  const facts = [holder.spec_code, holder.series || holder.product_name, holder.clamp_spec].filter(Boolean)
  const intro = `<span class="un-dlg"><span><b class="mono">${esc(holderLabel(holder))}</b>${facts.length ? ` <span class="muted">${esc(facts.join(' · '))}</span>` : ''}</span>
    <span>For a holder you track individually — its own balance/runout certificate, presetter ID or chip. The unit id is the number
    etched on the holder or on its RFID chip, and must be unique. Adding a unit doesn't change stock.</span>
    <span class="tiny muted">Recorded as added by ${esc(who)} today.</span></span>`
  const row = await formDialog({
    title: 'Add serialised unit',
    intro,
    wide: true,
    fields: [
      { name: 'unit_id', label: 'Unit id (etched / RFID no.)', required: true, placeholder: 'e.g. U-0142' },
      { name: 'serial_no', label: "Maker's serial no.", placeholder: 'From the holder or its certificate' },
      { name: 'location_id', label: 'Kept at', type: 'select', options: locations, blank: 'Not recorded' },
      runoutField('', false),
      { name: 'last_inspected', label: 'Last inspected', type: 'date', max: todayIso(), help: 'Date of the last runout/balance check, if known. Leave blank if never.' },
      { name: 'note', label: 'Note', type: 'textarea', placeholder: 'e.g. Balanced G2.5 @ 25 000 rpm, certificate 1234' },
    ],
    submitLabel: 'Add unit',
    onSubmit: (v) =>
      api.post('/api/units', {
        unit_id: v.unit_id,
        holder_id: holder.holder_id,
        serial_no: v.serial_no || null,
        location_id: v.location_id ? Number(v.location_id) : null,
        runout_check_um: v.runout_check_um === '' ? null : v.runout_check_um,
        last_inspected: v.last_inspected || null,
        note: v.note || null,
      }),
  })
  if (!row) return null
  toast(`Unit ${row.unit_id} added (${holderLabel(row)})`, 'ok')
  for (const w of row.warnings || []) toast(w)
  return row
}

/** Record an inspection: runout, pass/fail, note. A fail puts the unit in quarantine. */
export async function inspectUnitDialog(unit) {
  if (!unit || !unit.unit_id) throw new Error('inspectUnitDialog needs a unit')
  const who = await ensureUser()
  if (!who) return null
  const last = unit.last_inspected
    ? `Last inspected ${esc(fmtDate(unit.last_inspected))}${unit.inspected_by ? ` by ${esc(unit.inspected_by)}` : ''}${
        unit.runout_check_um != null ? ` · runout ${esc(fmt(unit.runout_check_um))} µm` : ''
      }.`
    : 'Not inspected before.'
  const intro = `<span class="un-dlg"><span><b class="mono">${esc(unit.unit_id)}</b> <span class="muted">${esc(holderLabel(unit))}</span> ${unitStatusChip(unit.status)}</span>
    <span>${last}</span>
    <span class="tiny muted">Recorded as inspected today by ${esc(who)}. A fail puts the unit in quarantine until someone releases it.</span></span>`
  const res = await formDialog({
    title: 'Record inspection',
    intro,
    fields: [
      runoutField('', true),
      {
        name: 'result',
        label: 'Result',
        type: 'select',
        required: true,
        blank: 'Choose…',
        options: [
          { value: 'pass', label: 'Passed — fit for use' },
          { value: 'fail', label: 'Failed — quarantine it' },
        ],
      },
      { name: 'note', label: 'Note', type: 'textarea', placeholder: 'e.g. Checked on presetter with Ø20 mandrel. Required if it failed: what is wrong.' },
    ],
    submitLabel: 'Record inspection',
    onSubmit: async (v) => {
      if (v.result === 'fail' && !v.note) throw new Error('Say what failed in the note — it is the reason the unit goes into quarantine.')
      return api.post(`/api/units/${encodeURIComponent(unit.unit_id)}/inspect`, {
        runout_check_um: v.runout_check_um,
        passed: v.result === 'pass',
        note: v.note || null,
      })
    },
  })
  if (!res) return null
  if (res.status === 'QUARANTINE' && res.status_changed) toast(`Unit ${res.unit_id} failed inspection — now in quarantine.`, 'error')
  else toast(`Inspection recorded for ${res.unit_id}: ${fmt(res.runout_check_um)} µm`, 'ok')
  return res
}

/** Change a unit's status (in service / quarantine / scrapped). The note is required: it is the record of why. */
export async function unitStatusDialog(unit, status) {
  if (!unit || !unit.unit_id) throw new Error('unitStatusDialog needs a unit')
  const who = await ensureUser()
  if (!who) return null
  const options = Object.entries(UNIT_STATUS)
    .filter(([k]) => k !== unit.status)
    .map(([k, v]) => ({ value: k, label: v.label }))
  const intro = `<span class="un-dlg"><span><b class="mono">${esc(unit.unit_id)}</b> <span class="muted">${esc(holderLabel(unit))}</span> now ${unitStatusChip(unit.status)}</span>
    ${unit.status === 'QUARANTINE' ? '<span>Return it to service only after it has passed an inspection.</span>' : ''}
    <span class="tiny muted">Scrapping a unit doesn't take it off the stock books — book the scrap with its NCR in the stock ledger as well.
    Recorded against ${esc(who)} today.</span></span>`
  const res = await formDialog({
    title: 'Change unit status',
    intro,
    fields: [
      { name: 'status', label: 'New status', type: 'select', required: true, options, value: status && status !== unit.status ? status : options[0]?.value },
      { name: 'note', label: 'Why', type: 'textarea', required: true, placeholder: 'e.g. Re-ground taper, runout now 2 µm · NCR-2026-014 taper damaged' },
    ],
    submitLabel: 'Change status',
    onSubmit: (v) => api.post(`/api/units/${encodeURIComponent(unit.unit_id)}/status`, { status: v.status, note: v.note }),
  })
  if (!res) return null
  toast(`Unit ${res.unit_id} is now ${(UNIT_STATUS[res.status] || {}).label || res.status}`, 'ok')
  return res
}
