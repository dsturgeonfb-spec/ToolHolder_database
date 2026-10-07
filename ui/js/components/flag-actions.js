// Raise / close dialogs for data flags (issues). Owned by the issues module. Contract:
//   raiseFlagDialog(holder|null) -> Promise<object|null>   new flag row, or null if cancelled
//   closeFlagDialog(flag)        -> Promise<object|null>   updated flag row, or null if cancelled
// The returned row is the server's flag object (holder maker/order no. joined in). raiseFlagDialog's
// row carries `created: false` when an identical open flag already existed and was returned instead.
// These only post the flag: the caller refreshes its list and the header summary.
import { esc, formDialog, sevChip } from '../ui.js'
import { api } from '../api.js'
import { ensureUser } from '../state.js'

/** Categories whose fixes are made in the hyperMILL tool database (same list as the server's write-back). */
export const CAM_CATEGORIES = ['CAM model', 'Naming', 'Gauge length', 'hyperMILL']
const STANDARD_CATEGORIES = [...CAM_CATEGORIES, 'Data source', 'Purchasing']

export const isCamCategory = (cat) => CAM_CATEGORIES.some((c) => c.toLowerCase() === String(cat || '').toLowerCase())

const SEVERITY_OPTIONS = [
  { value: 'HIGH', label: 'HIGH — wrong in CAM or on the machine: could cause a crash or scrap' },
  { value: 'MEDIUM', label: 'MEDIUM — changes what CAM or an operator would do' },
  { value: 'LOW', label: 'LOW — naming, comments, data tidy-up' },
  { value: 'INFO', label: 'INFO — a note for the record (not counted as an open issue)' },
]

/** "HAIMER A63.140.08" or the holder id, or null when the flag/holder has no holder. */
function holderLabel(h) {
  if (!h) return null
  if (h.order_no) return `${h.manufacturer || ''} ${h.order_no}`.trim()
  return h.holder_id || null
}

async function categoryList() {
  let used = []
  try {
    used = await api.get('/api/flags/categories')
  } catch {
    // The datalist is only a suggestion; typing a category still works.
  }
  const seen = new Set()
  return [...used, ...STANDARD_CATEGORIES].filter((c) => {
    const k = String(c).toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function ensureDatalist(id, values) {
  let dl = document.getElementById(id)
  if (!dl) {
    dl = document.createElement('datalist')
    dl.id = id
    document.body.appendChild(dl)
  }
  dl.innerHTML = values.map((v) => `<option value="${esc(v)}">`).join('')
  return id
}

/**
 * Raise an issue against a holder, or a general one (holder = null).
 * Severity, category (suggests the categories in use), what is wrong, and what should be done.
 */
export async function raiseFlagDialog(holder) {
  const who = await ensureUser()
  if (!who) return null
  const listId = ensureDatalist('flagCategoryList', await categoryList())
  const label = holderLabel(holder)
  const intro = `<span class="flagdlg">${
    label
      ? `For <b>${esc(label)}</b>${holder.cam_name ? ` <span class="mono tiny">(hyperMILL: ${esc(holder.cam_name)})</span>` : ''}. Recorded as raised by ${esc(who)} today.`
      : `A <b>general issue</b> — not about one holder. Recorded as raised by ${esc(who)} today.`
  }</span>`
  const res = await formDialog({
    title: 'Raise an issue',
    intro,
    fields: [
      { name: 'severity', label: 'Severity', type: 'select', options: SEVERITY_OPTIONS, blank: 'Choose…', required: true },
      {
        name: 'category',
        label: 'Category',
        required: true,
        list: listId,
        placeholder: 'e.g. Naming, Gauge length, CAM model, Data source',
        help: `CAM model, Naming, Gauge length and hyperMILL issues go on the hyperMILL write-back list for the CAM engineer.`,
      },
      { name: 'message', label: 'What is wrong', type: 'textarea', required: true, placeholder: "e.g. hyperMILL comment says 90GL; Haimer's page says 80 mm" },
      { name: 'action', label: 'What should be done', type: 'textarea', placeholder: 'e.g. Fix the comment in hyperMILL and check the holder model is the 80 mm one' },
    ],
    submitLabel: 'Raise issue',
    wide: true,
    onSubmit: (v) =>
      api.post('/api/flags', {
        holder_id: holder?.holder_id || null,
        severity: v.severity,
        category: v.category,
        message: v.message,
        action: v.action || null,
      }),
  })
  return res || null
}

/** Close an issue. The note (what was done) is required and recorded with the person and today's date. */
export async function closeFlagDialog(flag) {
  if (!flag) return null
  const who = await ensureUser()
  if (!who) return null
  const label = holderLabel(flag) || 'General issue'
  const cam = isCamCategory(flag.category)
  // formDialog puts the intro inside a <p>, so only inline elements here (styled as blocks in flags.css).
  const intro = `<span class="flagdlg flagdlg-sum">${sevChip(flag.severity)} <b>${esc(label)}</b>
      <span class="muted">· ${esc(flag.category || 'Uncategorised')} · #${esc(flag.flag_id)}</span>
      <span class="msg">${esc(flag.message)}</span>${flag.action ? `<span class="act">→ ${esc(flag.action)}</span>` : ''}</span>
    Closed by <b>${esc(who)}</b> today.${cam ? ' This is a hyperMILL fix: say what you changed in the hyperMILL tool database.' : ''}`
  const res = await formDialog({
    title: cam ? 'Mark fixed in hyperMILL' : 'Close issue',
    intro,
    fields: [
      {
        name: 'note',
        label: cam ? 'What did you change in hyperMILL?' : 'What was done',
        type: 'textarea',
        required: true,
        placeholder: cam ? 'e.g. Comment changed to "HAIMER 8mm STD SHRINK A63-140-08 80GL"' : 'e.g. Checked against the Haimer drawing — nose Ø is 22 mm, catalogue corrected',
        help: 'An auditor will read this: what was checked or changed, and against what.',
      },
    ],
    submitLabel: cam ? 'Mark fixed' : 'Close issue',
    wide: true,
    onSubmit: (v) => api.post(`/api/flags/${encodeURIComponent(flag.flag_id)}/close`, { note: v.note }),
  })
  return res || null
}
