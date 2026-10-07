// Count mode (#/count, optional ?holder=<id>&location=<id>): a machinist with a tablet in the tool
// crib picks a location and steps through holders one at a time, booking what is physically there.
//
// The number on screen is local: − / + and typing only change it. Nothing is posted until
// "Confirm count & next", and each confirm is one POST /api/counts with the ABSOLUTE quantity —
// the server books the difference. Confirm is locked while a request is in flight, so a double tap
// can't post twice (and the server ignores an identical retry anyway).
import { api } from '../api.js'
import { esc, fmt, fmtDate, todayIso, statusChip, profileHTML, toast } from '../ui.js'
import { state } from '../state.js'

const UNASSIGNED = 'Unassigned – count required'
const LS_LOC = 'hc.count.location'
const KIND = { crib: 'Crib / store', machine: 'Machine', external: 'External', holding: 'Holding' }
const SCOPES = [
  { id: 'site', label: 'Expected on site', help: 'Every holder the books say is on site, wherever it is booked. The usual choice for a stock-take.' },
  { id: 'all', label: 'Everything in the catalogue', help: 'All articles, including ones never on the books — for booking a holder found that nobody recorded.' },
  { id: 'location', label: 'Only booked here', help: 'Just what the ledger says is at this location — for a quick check of one magazine or shelf.' },
]
const SHOW = [
  { id: 'all', label: 'All holders in the list' },
  { id: 'today', label: 'Only not yet counted here today' },
  { id: 'never', label: 'Only never counted here' },
]
const MAX_DIGITS = 4

let cleanups = []
export function teardown() {
  cleanups.forEach((fn) => fn())
  cleanups = []
}

const store = {
  get(k) {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v)
    } catch {
      // Private mode or storage blocked: the app works, it just won't remember the location.
    }
  },
}

export async function render(root, ctx) {
  teardown()
  // Listeners go on this element, not on `root`: #view outlives the view, this element doesn't.
  const el = document.createElement('div')
  el.className = 'cm'
  root.appendChild(el)
  el.innerHTML = '<div class="loading">Loading locations…</div>'

  const q = ctx.query
  const s = {
    locations: [],
    locId: null,
    loc: null, // location row from the count list (has counts_as_on_site, is_unassigned)
    scope: SCOPES.some((x) => x.id === q.get('scope')) ? q.get('scope') : 'site',
    type: q.get('type') || '',
    mk: q.get('mk') || '',
    show: 'all',
    reference: q.get('ref') || '',
    list: [], // count list for the current choices
    listKey: '',
    listError: '',
    run: [], // the holders being stepped through
    idx: 0, // position in run; run.length = end-of-list panel
    qty: 0, // the number on screen (null while the input is empty)
    fresh: true, // next digit typed replaces the number instead of appending
    busy: false,
    step: 1,
  }
  let seq = 0

  const locById = (id) => s.locations.find((l) => l.location_id === id)
  const locName = () => locById(s.locId)?.name || s.loc?.name || ''
  const atUnassigned = () => locName() === UNASSIGNED
  const defaultRef = () => `COUNT ${todayIso()} ${locName()}`
  const listKey = () => [s.locId, s.scope, s.type, s.mk].join('|')
  const current = () => s.run[s.idx]

  function defaultLocation() {
    const real = s.locations.filter((l) => !l.is_unassigned)
    return (real.find((l) => l.name.toLowerCase() === 'tool crib') || real.find((l) => l.kind === 'crib') || real[0] || s.locations[0])?.location_id ?? null
  }
  const validLoc = (id) => (id && locById(Number(id)) ? Number(id) : null)

  /** The quantity a counter should expect here: what's booked here, plus the opening balance of a holder nobody has located yet. */
  function expected(h) {
    const pending = !atUnassigned() && h.count_status !== 'counted' ? Math.max(0, h.qty_unassigned) : 0
    return Math.max(0, h.qty_at_location) + pending
  }

  async function loadList() {
    const my = ++seq
    const p = new URLSearchParams({ location_id: String(s.locId), scope: s.scope })
    if (s.type) p.set('type', s.type)
    if (s.mk) p.set('mk', s.mk)
    const res = await api.get(`/api/count/list?${p}`)
    if (my !== seq) return false
    s.list = res.holders
    s.loc = res.location
    s.listKey = listKey()
    s.listError = ''
    return true
  }

  function syncUrl() {
    // A count that finishes after the person has left this view must not rewrite the other view's URL.
    if (!el.isConnected) return
    const p = new URLSearchParams()
    if (s.step === 2) {
      p.set('location', String(s.locId))
      if (current()) p.set('holder', current().holder_id)
      if (s.scope !== 'site') p.set('scope', s.scope)
      if (s.type) p.set('type', s.type)
      if (s.mk) p.set('mk', s.mk)
      if (s.reference) p.set('ref', s.reference)
    }
    const hash = '#/count' + (p.toString() ? `?${p}` : '')
    // replaceState: a reload resumes on the same holder, without re-running the router on every step.
    if (location.hash !== hash) history.replaceState(null, '', hash)
  }

  function printSheet() {
    const p = new URLSearchParams({ location_id: String(s.locId), scope: s.scope })
    if (s.type) p.set('type', s.type)
    if (s.mk) p.set('mk', s.mk)
    p.set('reference', s.reference || defaultRef())
    api.openPrintable(`/api/export/count-sheet?${p}`)
  }

  // ---------------------------------------------------------------- step 1: location and list
  function locButtons() {
    const sorted = [...s.locations].sort((a, b) => Number(a.is_unassigned) - Number(b.is_unassigned) || a.location_id - b.location_id)
    return sorted
      .map(
        (l) => `<button type="button" class="cm-loc${l.is_unassigned ? ' unassigned' : ''}" role="radio" aria-checked="${l.location_id === s.locId}" data-loc="${l.location_id}">
        <b>${esc(l.name)}</b>
        <span>${esc(KIND[l.kind] || l.kind || '')} · ${esc(l.holders)} holder${l.holders === 1 ? '' : 's'} booked${l.counts_as_on_site ? '' : ' · not in site tally'}</span>
        ${l.is_unassigned ? '<span class="cm-loc-help">Holders not yet located. Count here only if you can’t say where a holder is.</span>' : ''}
      </button>`,
      )
      .join('')
  }

  function renderSetup() {
    s.step = 1
    syncUrl()
    const types = state.meta?.types || []
    const makers = (state.meta?.manufacturers || []).filter((m) => Number(m.articles) > 0)
    el.innerHTML = `
      <div class="view-head">
        <div><h2>Count</h2><p class="muted">Book what is physically there, one holder at a time. Every confirmed count is recorded against your name and today’s date.</p></div>
        <div class="btnrow"><a class="btn ghost" href="#/locations">Manage locations</a><a class="btn ghost" href="#/log?type=COUNT_ADJUST">Count history</a></div>
      </div>
      <section class="card cm-setup" aria-label="Choose what to count">
        <h3><span class="cm-stepno">1</span> Where are you counting?</h3>
        <div class="cm-locs" role="radiogroup" aria-label="Location">${locButtons()}</div>
        <h3><span class="cm-stepno">2</span> What to count</h3>
        <div class="seg cm-scope" role="group" aria-label="Which holders">${SCOPES.map(
          (x) => `<button type="button" data-scope="${x.id}" aria-pressed="${s.scope === x.id}">${esc(x.label)}</button>`,
        ).join('')}</div>
        <p class="note" data-scope-help>${esc(SCOPES.find((x) => x.id === s.scope).help)}</p>
        <div class="filters">
          <label class="field">Type <select data-f="type"><option value="">All types</option>${types
            .map((t) => `<option value="${esc(t.type_code)}" ${t.type_code === s.type ? 'selected' : ''}>${esc(t.type_name)}</option>`)
            .join('')}</select></label>
          <label class="field">Maker <select data-f="mk"><option value="">All makers</option>${makers
            .map((m) => `<option value="${esc(m.name)}" ${m.name === s.mk ? 'selected' : ''}>${esc(m.name)}</option>`)
            .join('')}</select></label>
          <label class="field">Show <select data-f="show">${SHOW.map((x) => `<option value="${x.id}" ${x.id === s.show ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
        </div>
        <label class="fld cm-ref"><span>Count sheet reference (optional)</span>
          <input data-f="ref" maxlength="120" autocomplete="off" value="${esc(s.reference)}" placeholder="${esc(defaultRef())}">
          <span class="help">Leave blank to use the one shown. If you counted on a printed sheet, use its number.</span></label>
        <div class="btnrow cm-go">
          <button type="button" class="btn lg" data-act="start">Start counting</button>
          <button type="button" class="btn ghost" data-act="print">Print count sheet</button>
          <span class="muted" data-preview role="status" aria-live="polite"></span>
        </div>
      </section>`
    updatePreview()
  }

  const showFilter = (h) => (s.show === 'today' ? !h.counted_here_today : s.show === 'never' ? !h.last_count_here : true)

  function previewText() {
    if (s.listError) return s.listError
    if (s.listKey !== listKey()) return 'Loading the list…'
    const n = s.list.length
    const done = s.list.filter((h) => h.counted_here_today).length
    const inRun = s.list.filter(showFilter).length
    if (!n) return 'No holders match — try “Everything in the catalogue”, or clear the type and maker.'
    return `${n} holder${n === 1 ? '' : 's'} in the list · ${done} counted here today${s.show !== 'all' ? ` · ${inRun} to step through` : ''}`
  }

  async function updatePreview() {
    // An error from loading other choices doesn't apply to a list that is already loaded.
    if (s.listKey === listKey()) s.listError = ''
    const out = el.querySelector('[data-preview]')
    if (out) out.textContent = previewText()
    if (s.listKey === listKey()) return
    try {
      if (!(await loadList())) return
    } catch (e) {
      s.listError = `Could not load the list: ${e.message}`
    }
    const o = el.querySelector('[data-preview]')
    if (o && s.step === 1) o.textContent = previewText()
  }

  async function start() {
    const btn = el.querySelector('[data-act=start]')
    if (btn) btn.disabled = true
    try {
      if (s.listKey !== listKey()) await loadList()
      else s.listError = ''
    } catch (e) {
      s.listError = `Could not load the list: ${e.message}`
    } finally {
      if (btn) btn.disabled = false
    }
    const out = el.querySelector('[data-preview]')
    if (s.listError) {
      if (out) out.textContent = s.listError
      return
    }
    const run = s.list.filter(showFilter)
    if (!run.length) {
      if (out)
        out.textContent = s.list.length
          ? 'Everything in this list is already counted — choose “All holders in the list” to recount.'
          : 'No holders match — try “Everything in the catalogue”, or clear the type and maker.'
      return
    }
    s.run = run
    store.set(LS_LOC, String(s.locId))
    const firstOpen = run.findIndex((h) => !h.counted_here_today)
    enterRun(firstOpen >= 0 ? firstOpen : 0)
  }

  /** Deep link (#/count?holder=…): count that holder where it is booked, else in the tool crib. */
  async function startForHolder(holderId, locParam) {
    let loc = validLoc(locParam)
    if (!loc) {
      try {
        const rows = await api.get(`/api/stock?holder_id=${encodeURIComponent(holderId)}`)
        const best = rows
          .filter((r) => r.qty_at_location > 0 && r.location !== UNASSIGNED)
          .sort((a, b) => b.counts_as_on_site - a.counts_as_on_site || b.qty_at_location - a.qty_at_location)[0]
        loc = best ? best.location_id : null
      } catch {
        // Fall back to the default location; the count list below reports any real problem.
      }
    }
    s.locId = loc ?? defaultLocation()
    try {
      await loadList()
      let i = s.list.findIndex((h) => h.holder_id === holderId)
      if (i < 0 && s.scope !== 'all') {
        s.scope = 'all'
        await loadList()
        i = s.list.findIndex((h) => h.holder_id === holderId)
      }
      if (i < 0) {
        renderSetup()
        toast(`Holder ${holderId} is not in the catalogue — pick what to count instead.`, 'error')
        return
      }
      s.run = s.list.slice()
      store.set(LS_LOC, String(s.locId))
      enterRun(i)
    } catch (e) {
      el.innerHTML = `<div class="errorbox">Could not load the count list: ${esc(e.message)}</div>
        <div class="btnrow"><button type="button" class="btn" data-act="setup">Choose a location</button></div>`
    }
  }

  // ---------------------------------------------------------------- step 2: one holder at a time
  function enterRun(i) {
    s.step = 2
    el.innerHTML = `
      <div class="view-head cm-head">
        <div>
          <h2>Counting at <span class="cm-where">${esc(locName())}</span></h2>
          <p class="muted small">Reference <span class="mono">${esc(s.reference || defaultRef())}</span> ·
            <button type="button" class="linkbtn" data-act="setup">Change location or list</button></p>
        </div>
        <div class="btnrow"><button type="button" class="btn ghost" data-act="print">Print count sheet</button></div>
      </div>
      <div class="cm-progress"><div class="meter"><i data-meter></i></div><span data-progress role="status" aria-live="polite"></span></div>
      <div class="cm-run">
        <section class="card cm-card" data-card tabindex="-1" aria-label="Holder to count"></section>
        <aside class="card cm-side" aria-label="Holders in this run">
          <h3>This run <span class="muted small" data-runcount></span></h3>
          <ol class="cm-list" data-list>${s.run.map(itemHTML).join('')}</ol>
        </aside>
      </div>`
    goTo(i)
  }

  function badge(h) {
    if (h.counted_here_today) return `<span class="cm-badge ok" title="Counted here today">✓ ${esc(h.qty_at_location)}</span>`
    if (h.count_status === 'unverified') return '<span class="cm-badge unver" title="Opening balance only — never physically counted">Unverified</span>'
    if (h.count_status === 'booked') return '<span class="cm-badge booked" title="Booked in by receipt, not yet counted">Booked</span>'
    if (h.qty_on_site > 0) return `<span class="cm-badge booked" title="Last counted ${esc(fmtDate(h.last_count_date))}">Counted ${esc(fmtDate(h.last_count_date))}</span>`
    return '<span class="cm-badge none">Not on site</span>'
  }

  function itemHTML(h, i) {
    const cur = i === s.idx && s.step === 2
    return `<li><button type="button" class="cm-item${cur ? ' current' : ''}${h.counted_here_today ? ' done' : ''}" data-jump="${i}"${cur ? ' aria-current="true"' : ''}>
      <span class="cm-item-id"><span class="mk">${esc(h.manufacturer)}</span> <span class="mono">${esc(h.order_no)}</span></span>
      <span class="cm-item-sub">${esc(h.clamp_spec || h.type_name || '')}${h.gauge_length_mm != null ? ` · GL ${esc(fmt(h.gauge_length_mm))}` : ''}${h.qty_at_location ? ` · ${esc(h.qty_at_location)} here` : ''}</span>
      ${badge(h)}
    </button></li>`
  }

  function updateItem(i) {
    const li = el.querySelector(`[data-jump="${i}"]`)?.parentElement
    if (li && s.run[i]) li.outerHTML = itemHTML(s.run[i], i)
  }

  function updateProgress() {
    const done = s.run.filter((h) => h.counted_here_today).length
    const p = el.querySelector('[data-progress]')
    if (p) p.textContent = `${done} of ${s.run.length} counted at ${locName()} today`
    const m = el.querySelector('[data-meter]')
    if (m) m.style.width = `${s.run.length ? (done / s.run.length) * 100 : 0}%`
    const rc = el.querySelector('[data-runcount]')
    if (rc) rc.textContent = `· ${s.run.length}`
  }

  function goTo(i) {
    const prev = s.idx
    s.idx = Math.max(0, Math.min(i, s.run.length))
    const h = current()
    if (h) {
      s.qty = expected(h)
      s.fresh = true
    }
    updateItem(prev)
    updateItem(s.idx)
    updateProgress()
    renderCard()
    syncUrl()
    const card = el.querySelector('[data-card]')
    // Focus the card, not the number field: on a tablet, focusing an input pops the keyboard up every step.
    card?.focus({ preventScroll: true })
    // On a phone the card is taller than the screen: bring its top (the holder's identity) back into view.
    const top = card?.getBoundingClientRect().top ?? 0
    if (top < 0) window.scrollBy(0, top - 8)
    // Scroll only the run list, never the page — on narrow screens the list sits below the card.
    const list = el.querySelector('[data-list]')
    const item = list?.querySelector('.cm-item.current')
    if (list && item) {
      const lr = list.getBoundingClientRect()
      const ir = item.getBoundingClientRect()
      if (ir.top < lr.top || ir.bottom > lr.bottom) list.scrollTop += ir.top - lr.top - lr.height / 3
    }
  }

  function whereText(h) {
    if (!h.stock?.length) return 'Not booked anywhere'
    return h.stock.map((st) => `${st.location} ${st.qty}${st.location === UNASSIGNED ? ' (not yet located)' : st.counts_as_on_site ? '' : ' (off site)'}`).join(' · ')
  }

  function renderCard() {
    const card = el.querySelector('[data-card]')
    if (!card) return
    const h = current()
    if (!h) {
      renderEnd(card)
      return
    }
    const gl = h.gauge_length_mm != null ? `${fmt(h.gauge_length_mm)} mm${h.cam_gl_mm != null && h.cam_gl_mm !== h.gauge_length_mm ? ` (hyperMILL ${fmt(h.cam_gl_mm)})` : ''}` : '–'
    card.innerHTML = `
      <div class="cm-top">
        <span class="cm-pos">Holder ${s.idx + 1} of ${s.run.length}</span>
        <span class="cm-chips">${statusChip(h.count_status)}${h.counted_here_today ? ` <span class="chip counted">✓ Counted here today</span>` : ''}${
          h.open_issues ? ` <a class="chip ${esc(h.worst_severity || 'LOW')}" href="#/holder/${encodeURIComponent(h.holder_id)}">${esc(h.open_issues)} issue${h.open_issues === 1 ? '' : 's'}</a>` : ''
        }</span>
      </div>
      <div class="cm-body">
        <div class="cm-img">${profileHTML(h)}</div>
        <div class="cm-ident">
          <span class="mk">${esc(h.manufacturer)}</span>
          <div class="cm-ord mono">${esc(h.order_no)}</div>
          <div class="series">${esc(h.series || h.product_name || '')}</div>
          <dl class="kv cm-kv">
            <dt>Clamping</dt><dd class="mono">${esc(h.clamp_spec || '–')}</dd>
            <dt>Type</dt><dd>${esc(h.type_name || h.type_code)}</dd>
            <dt>Gauge length</dt><dd class="mono">${esc(gl)}</dd>
            <dt>Nose Ø</dt><dd class="mono">${h.nose_dia_mm != null ? esc(fmt(h.nose_dia_mm)) + ' mm' : '–'}</dd>
            <dt>Holder</dt><dd><a href="#/holder/${encodeURIComponent(h.holder_id)}">${esc(h.holder_id)} details</a></dd>
          </dl>
        </div>
      </div>
      <div class="cm-booked">
        <div><span class="k">Booked here</span><span class="v mono">${esc(h.qty_at_location)}</span></div>
        <div><span class="k">Total on site</span><span class="v mono">${esc(h.qty_on_site)}</span></div>
        <div class="cm-where-all"><span class="k">Booked at</span><span>${esc(whereText(h))}</span></div>
      </div>
      <div class="cm-entry">
        <label class="cm-q-label" for="cm-qty">How many are physically at ${esc(locName())}?</label>
        <div class="cm-stepper">
          <button type="button" class="cm-pm" data-act="dec" aria-label="One less">−</button>
          <input id="cm-qty" class="cm-qty mono" data-qty type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="${MAX_DIGITS}" aria-describedby="cm-hint">
          <button type="button" class="cm-pm" data-act="inc" aria-label="One more">+</button>
        </div>
        <p class="cm-hint" id="cm-hint" data-hint aria-live="polite"></p>
        <label class="fld cm-note"><span>Note (optional)</span><input data-note maxlength="500" autocomplete="off" placeholder="e.g. found in DMG 2 magazine, nut missing"></label>
        <div data-err role="alert"></div>
      </div>
      <div class="cm-actions">
        <button type="button" class="btn ghost lg" data-act="back" ${s.idx === 0 ? 'disabled' : ''}>← Back</button>
        <button type="button" class="btn ghost lg" data-act="skip">Skip →</button>
        <button type="button" class="btn ok lg cm-confirm" data-act="confirm">Confirm count &amp; next</button>
      </div>
      <p class="tiny muted cm-keys">Keyboard: type the number · + / − adjust · Enter confirm · → skip · ← back</p>`
    showQty()
    if (s.busy) setBusy(true)
  }

  function renderEnd(card) {
    const left = s.run.filter((h) => !h.counted_here_today).length
    card.innerHTML = `
      <div class="cm-end">
        ${
          left
            ? `<h3>End of the list</h3><p>${s.run.length - left} of ${s.run.length} counted at ${esc(locName())} today — ${left} not counted yet.</p>`
            : `<h3 class="cm-alldone">✓ All ${s.run.length} holder${s.run.length === 1 ? '' : 's'} in this list are counted at ${esc(locName())} today</h3>`
        }
        <div class="btnrow">
          ${left ? '<button type="button" class="btn lg" data-act="first-open">Go to the first one not counted</button>' : ''}
          <button type="button" class="btn ghost" data-act="setup">Count another location or list</button>
          <a class="btn ghost" href="#/log?type=COUNT_ADJUST&location=${esc(s.locId)}&since=${todayIso()}">Today’s counts in the ledger</a>
        </div>
      </div>`
  }

  function showQty() {
    const input = el.querySelector('[data-qty]')
    const text = s.qty == null ? '' : String(s.qty)
    if (input && input.value !== text) input.value = text
    const dec = el.querySelector('[data-act=dec]')
    if (dec) dec.disabled = !s.qty
    const hint = el.querySelector('[data-hint]')
    const h = current()
    if (hint && h) hint.textContent = hintText(h)
  }

  function hintText(h) {
    if (s.qty == null) return 'Enter the number you counted — 0 if there are none here.'
    const delta = s.qty - h.qty_at_location
    const clears = !atUnassigned() && h.count_status !== 'counted' && h.qty_unassigned > 0
    const parts = []
    if (delta === 0) parts.push(h.counted_here_today ? 'Same as already counted here today' : 'Matches the books — confirming records the check')
    else parts.push(`Books ${delta > 0 ? '+' : '−'}${Math.abs(delta)} at ${locName()}`)
    if (clears) parts.push(`replaces the unverified opening balance (${h.qty_unassigned})`)
    const onSite = s.loc?.counts_as_on_site ? delta : 0
    const after = h.qty_on_site + onSite - (clears ? h.qty_unassigned : 0)
    return `${parts.join(' and ')}. Site total after: ${after}.`
  }

  function setQty(n, fresh) {
    s.qty = n == null ? null : Math.max(0, Math.min(10 ** MAX_DIGITS - 1, n))
    s.fresh = fresh
    showQty()
  }
  const bump = (d) => setQty((s.qty ?? 0) + d, true)

  function typeDigit(d) {
    const next = s.fresh || s.qty == null || s.qty === 0 ? d : Number(`${s.qty}${d}`)
    if (String(next).length > MAX_DIGITS) return
    setQty(Number(next), false)
  }

  function showError(msg) {
    const box = el.querySelector('[data-err]')
    if (!box) return
    box.className = msg ? 'errorbox' : ''
    box.textContent = msg
  }

  function setBusy(on) {
    s.busy = on
    const b = el.querySelector('[data-act=confirm]')
    if (b) {
      b.disabled = on
      b.textContent = on ? 'Saving…' : 'Confirm count & next'
    }
  }

  function nextOpen(from) {
    for (let i = from + 1; i < s.run.length; i++) if (!s.run[i].counted_here_today) return i
    for (let i = 0; i <= from && i < s.run.length; i++) if (!s.run[i].counted_here_today) return i
    return s.run.length
  }

  async function confirmCount() {
    if (s.busy) return
    const h = current()
    if (!h) return
    if (s.qty == null || !Number.isInteger(s.qty)) {
      showError('Enter the number you counted — 0 if there are none here.')
      return
    }
    s.busy = true // before any await: a second tap must not get past this point
    setBusy(true)
    showError('')
    const counted = s.qty
    const holderId = h.holder_id
    try {
      const who = await ctx.ensureUser()
      if (!who) return
      const note = el.querySelector('[data-note]')?.value.trim() || undefined
      const res = await api.post('/api/counts', {
        holder_id: holderId,
        location_id: s.locId,
        counted_qty: counted,
        reference: s.reference || undefined,
        note,
      })
      // Keep the run in step with the ledger without reloading the whole list.
      for (const t of res.posted) {
        const st = h.stock.find((x) => x.location_id === t.location_id)
        if (st) st.qty += t.qty_delta
        else h.stock.push({ location_id: t.location_id, location: t.location, counts_as_on_site: t.counts_as_on_site, qty: t.qty_delta })
        if (t.location === UNASSIGNED) h.qty_unassigned += t.qty_delta
      }
      h.stock = h.stock.filter((x) => x.qty !== 0)
      Object.assign(h, res.holder, { qty_at_location: counted, counted_here_today: true, last_count_here: todayIso(), stock: h.stock, qty_unassigned: h.qty_unassigned })
      toast(res.duplicate ? `Already recorded: ${counted} × ${h.order_no} at ${locName()} today` : `Counted ${counted} × ${h.order_no} at ${locName()}`, 'ok')
      ctx.refreshSummary()
      // The person may have jumped elsewhere while the request was in flight; only advance if not.
      if (current()?.holder_id === holderId) {
        updateItem(s.idx)
        goTo(nextOpen(s.idx))
      } else {
        const i = s.run.indexOf(h)
        if (i >= 0) updateItem(i)
        updateProgress()
      }
    } catch (e) {
      if (current()?.holder_id === holderId) showError(e.message)
      else toast(`Count for ${h.order_no} was not saved: ${e.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- events
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button, [data-loc]')
    if (!b || !el.contains(b)) return
    if (b.dataset.loc) {
      s.locId = Number(b.dataset.loc)
      el.querySelectorAll('.cm-loc').forEach((x) => x.setAttribute('aria-checked', String(x === b)))
      const ref = el.querySelector('[data-f=ref]')
      if (ref) ref.placeholder = `COUNT ${todayIso()} ${locById(s.locId)?.name || ''}`
      updatePreview()
      return
    }
    if (b.dataset.scope) {
      s.scope = b.dataset.scope
      el.querySelectorAll('[data-scope]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      const help = el.querySelector('[data-scope-help]')
      if (help) help.textContent = SCOPES.find((x) => x.id === s.scope).help
      updatePreview()
      return
    }
    if (b.dataset.jump !== undefined) {
      goTo(Number(b.dataset.jump))
      return
    }
    switch (b.dataset.act) {
      case 'start':
        return start()
      case 'print':
        return printSheet()
      case 'setup':
        s.listKey = '' // counts may have changed: reload the preview
        return renderSetup()
      case 'inc':
        return bump(1)
      case 'dec':
        return bump(-1)
      case 'confirm':
        return confirmCount()
      case 'skip':
        return goTo(s.idx + 1)
      case 'back':
        return goTo(s.idx - 1)
      case 'first-open':
        return goTo(nextOpen(-1))
      case 'retry':
        return ctx.navigate('#/count')
    }
  })

  el.addEventListener('change', (e) => {
    const f = e.target.dataset?.f
    if (!f || s.step !== 1) return
    if (f === 'type') s.type = e.target.value
    if (f === 'mk') s.mk = e.target.value
    if (f === 'show') s.show = e.target.value
    updatePreview()
  })

  el.addEventListener('input', (e) => {
    if (e.target.dataset?.f === 'ref') {
      s.reference = e.target.value.trim()
      return
    }
    if (e.target.matches('[data-qty]')) {
      const digits = e.target.value.replace(/\D/g, '').slice(0, MAX_DIGITS)
      if (digits !== e.target.value) e.target.value = digits
      s.qty = digits === '' ? null : Number(digits)
      s.fresh = false
      const dec = el.querySelector('[data-act=dec]')
      if (dec) dec.disabled = !s.qty
      const hint = el.querySelector('[data-hint]')
      if (hint && current()) hint.textContent = hintText(current())
    }
  })
  // Selecting the whole number on focus makes typing replace it, like the keyboard path.
  el.addEventListener('focusin', (e) => {
    if (e.target.matches?.('[data-qty]')) e.target.select()
  })

  const onKey = (e) => {
    if (s.step !== 2 || !el.isConnected) return
    if (document.querySelector('dialog[open]')) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target instanceof HTMLElement ? e.target : null
    const k = e.key
    const inQty = !!t?.matches('[data-qty]')
    // The note field keeps its keys, except that Enter confirms like everywhere else on the card.
    if (t?.matches('[data-note]')) {
      if (k === 'Enter' && !e.repeat && current()) {
        e.preventDefault()
        confirmCount()
      }
      return
    }
    if (!inQty && t?.closest('input, textarea, select, [contenteditable="true"]')) return
    if (k === 'Enter') {
      // Links, the run list and buttons outside the card (Print, Change location) keep Enter for themselves.
      // Inside the card Enter always confirms — after tapping +, Enter must not press + again.
      if (!current() || t?.closest('a[href], [data-jump]') || (t?.closest('button') && !t.closest('.cm-card'))) return
      e.preventDefault()
      if (!e.repeat) confirmCount()
    } else if (k === 'ArrowRight') {
      e.preventDefault()
      goTo(s.idx + 1)
    } else if (k === 'ArrowLeft') {
      e.preventDefault()
      goTo(s.idx - 1)
    } else if (!current()) {
      return
    } else if (k === '+' || k === '=' || k === 'ArrowUp') {
      e.preventDefault()
      bump(1)
    } else if (k === '-' || k === '_' || k === 'ArrowDown') {
      e.preventDefault()
      bump(-1)
    } else if (/^[0-9]$/.test(k) && !inQty) {
      e.preventDefault()
      typeDigit(Number(k))
    } else if (k === 'Backspace' && !inQty) {
      e.preventDefault()
      const str = s.qty == null ? '' : String(s.qty).slice(0, -1)
      setQty(str === '' ? null : Number(str), false)
    } else if (k === 'Escape' && !inQty) {
      setQty(expected(current()), true)
    }
  }
  document.addEventListener('keydown', onKey)
  cleanups.push(() => document.removeEventListener('keydown', onKey))

  // ---------------------------------------------------------------- start
  try {
    s.locations = await api.get('/api/locations')
  } catch (e) {
    el.innerHTML = `<div class="view-head"><h2>Count</h2></div><div class="errorbox">Could not load the locations: ${esc(e.message)}</div>
      <div class="btnrow"><button type="button" class="btn" data-act="retry">Try again</button></div>`
    return
  }
  const holderParam = q.get('holder')
  if (holderParam) {
    await startForHolder(holderParam, q.get('location'))
    return
  }
  s.locId = validLoc(q.get('location')) ?? validLoc(store.get(LS_LOC)) ?? defaultLocation()
  renderSetup()
}
