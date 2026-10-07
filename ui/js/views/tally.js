// Tally (#/tally): the prototype's tally tab made live from GET /api/tally — count progress, holders on site by
// type, maker, clamp Ø and location, the maker-vs-hyperMILL gauge-length check, and the exports.
import { esc, toast, toastError } from '../ui.js'
import { api } from '../api.js'
import { mm } from './holder.js'

let active = null
export function teardown() {
  if (active) active.dead = true
  active = null
}

export async function render(root, ctx) {
  const me = { dead: false }
  active = me
  root.innerHTML = '<div class="tv view"><div class="loading">Loading…</div></div>'
  const el = root.firstElementChild

  async function load() {
    try {
      const t = await api.get('/api/tally')
      if (me.dead) return
      el.innerHTML = pageHTML(t)
    } catch (e) {
      if (me.dead) return
      el.innerHTML = `<div class="errorbox">The tally could not be loaded: ${esc(e.message)}
        <button class="btn sm ghost" type="button" data-act="retry">Try again</button></div>`
    }
  }

  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]')
    if (!b) return
    if (b.dataset.act === 'retry') {
      el.innerHTML = '<div class="loading">Loading…</div>'
      return load()
    }
    if (b.dataset.act === 'export') {
      b.disabled = true
      b.setAttribute('aria-busy', 'true')
      try {
        const name = await api.download(b.dataset.path, b.dataset.name)
        toast(`Exported ${name}`, 'ok')
      } catch (e) {
        toastError(e)
      } finally {
        b.disabled = false
        b.removeAttribute('aria-busy')
      }
    }
  })

  await load()
}

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return `<div class="bars">${rows
    .map(
      (r) => `<div class="bar" title="${esc(r.title || '')}"><span>${esc(r.label)}${r.small ? `<small>${esc(r.small)}</small>` : ''}</span>
        <span class="t"><i style="width:${((r.value / max) * 100).toFixed(1)}%"></i></span><span class="c">${esc(r.value)}</span></div>`,
    )
    .join('')}</div>`
}

function pageHTML(t) {
  const s = t.summary || {}
  const toCount = Number(s.to_count) || 0
  const done = Number(s.counted_of_opening) || 0
  const left = Math.max(0, toCount - done)
  const pct = toCount ? Math.min(100, (done / toCount) * 100) : 0

  const typeRows = t.byType.filter((r) => r.holders_on_site > 0)
  const makerRows = t.byMaker.filter((r) => r.holders_on_site > 0 || r.articles_in_catalogue > 0)

  return `
  <div class="view-head">
    <div><h2>Tally</h2><p class="muted small">Holders on site, from the transaction ledger (locations that count as on site). Totals by type, maker,
      clamp Ø and location; exports for the count record.</p></div>
    <div class="btnrow"><a class="btn ghost" href="#/count">Go to Count</a></div>
  </div>

  <section class="card tv-progress" aria-labelledby="tv-prog-h">
    <div>
      <h3 id="tv-prog-h" class="eyebrow">Count progress</h3>
      <div class="big"><b>${esc(done)}</b> of <b>${esc(toCount)}</b> articles physically counted</div>
    </div>
    <a class="btn tv-go" href="#/count">${left ? 'Count the rest' : 'Count again'}</a>
    <div class="meter" role="progressbar" aria-label="Articles counted" aria-valuemin="0" aria-valuemax="${esc(toCount)}" aria-valuenow="${esc(done)}"><i style="width:${pct.toFixed(1)}%"></i></div>
    <p class="note" style="grid-column:1/-1">${
      left
        ? `<b>${esc(left)}</b> still unverified — their quantity is the hyperMILL opening balance (1 each) until a physical count is booked.`
        : toCount
          ? 'Every article from the opening balance has been physically counted.'
          : 'No opening balance to verify.'
    }</p>
    <div class="tv-figs"><span><b>${esc(s.holders_on_site ?? '–')}</b> holders on site</span><span><b>${esc(s.articles_on_site ?? '–')}</b> different articles on site</span>
      <span><b>${esc(s.articles_in_catalogue ?? '–')}</b> articles in the catalogue</span><span><b>${esc(s.counted ?? '–')}</b> counted in total</span></div>
  </section>

  <div class="cols">
    <section class="card" aria-labelledby="tv-type-h"><h3 id="tv-type-h">Holders on site by type</h3>
      ${typeRows.length ? bars(typeRows.map((r) => ({ label: r.type_name, value: r.holders_on_site, title: `${r.articles_on_site} different articles` }))) : '<p class="muted small">Nothing on site.</p>'}
    </section>
    <section class="card" aria-labelledby="tv-mk-h"><h3 id="tv-mk-h">Holders on site by maker</h3>
      ${
        makerRows.length
          ? bars(
              makerRows.map((r) => ({
                label: r.manufacturer,
                small: `${r.articles_in_catalogue} in catalogue`,
                value: r.holders_on_site,
                title: `${r.articles_on_site} different articles on site, ${r.articles_in_catalogue} in the catalogue`,
              })),
            )
          : '<p class="muted small">No makers yet.</p>'
      }
    </section>
    <section class="card" aria-labelledby="tv-clamp-h"><h3 id="tv-clamp-h">Fixed-bore holders by clamp Ø</h3>${clampHTML(t.byClamp)}</section>
    <section class="card" aria-labelledby="tv-loc-h"><h3 id="tv-loc-h">By location</h3>${locationHTML(t.byLocation)}</section>
  </div>

  <section class="card" aria-labelledby="tv-gl-h"><h3 id="tv-gl-h">Gauge-length check — maker vs hyperMILL</h3>${glHTML(t.glCheck)}</section>

  <section class="card tv-exports" aria-labelledby="tv-exp-h">
    <h3 id="tv-exp-h">Export</h3>
    <p class="note" style="margin:0">The count CSV has one row per article on site or counted, with its quantity and whether it was physically counted
      or is still the opening balance. The tally workbook has the articles plus every table on this page; the catalogue workbook lists every article.</p>
    <div class="btnrow">
      <button class="btn" type="button" data-act="export" data-path="/api/export/tally.csv" data-name="holder_count.csv">Count CSV</button>
      <button class="btn ghost" type="button" data-act="export" data-path="/api/export/tally.xlsx" data-name="holder_tally.xlsx">Tally workbook (XLSX)</button>
      <button class="btn ghost" type="button" data-act="export" data-path="/api/export/catalogue.xlsx?scope=all" data-name="holder_catalogue.xlsx">Catalogue workbook (XLSX)</button>
    </div>
  </section>`
}

/** Shrink and hydraulic side by side per Ø (the prototype's table); other fixed-bore types (arbor spigots) below it. */
function clampHTML(rows) {
  if (!rows.length) return '<p class="muted small">No fixed-bore holders on site.</p>'
  const main = rows.filter((r) => r.type_code === 'SHRINK' || r.type_code === 'HYDRAULIC')
  const other = rows.filter((r) => r.type_code !== 'SHRINK' && r.type_code !== 'HYDRAULIC')
  const dias = [...new Set(main.map((r) => r.clamp_dia_mm))].sort((a, b) => a - b)
  const cell = (d, type) => {
    const r = main.find((x) => x.clamp_dia_mm === d && x.type_code === type)
    return r ? esc(r.holders_on_site) : ''
  }
  const table = dias.length
    ? `<div class="tablewrap"><table class="data"><thead><tr><th>Ø mm</th><th class="n">Shrink</th><th class="n">Hydraulic</th><th>Gauge lengths (mm)</th></tr></thead><tbody>
      ${dias
        .map((d) => {
          const gls = [...new Set(main.filter((r) => r.clamp_dia_mm === d).flatMap((r) => r.gauge_lengths))].sort((a, b) => a - b)
          return `<tr><td class="mono">${esc(mm(d))}</td><td class="n">${cell(d, 'SHRINK')}</td><td class="n">${cell(d, 'HYDRAULIC')}</td><td class="mono">${gls.map(mm).join(' · ')}</td></tr>`
        })
        .join('')}</tbody></table></div>`
    : ''
  const byType = new Map()
  for (const r of other) {
    if (!byType.has(r.type_name)) byType.set(r.type_name, [])
    byType.get(r.type_name).push(r)
  }
  const notes = [...byType]
    .map(
      ([name, rs]) =>
        `<p class="tv-arbors"><b>${esc(name)}</b>: ${rs
          .map((r) => `Ø${esc(mm(r.clamp_dia_mm))} × ${esc(r.holders_on_site)} (GL ${r.gauge_lengths.map(mm).join(', ')})`)
          .join(' · ')}</p>`,
    )
    .join('')
  return table + notes
}

function locationHTML(rows) {
  if (!rows.length) return '<p class="muted small">No locations set up.</p>'
  const site = rows.filter((r) => r.counts_as_on_site)
  const sum = (rs, k) => rs.reduce((a, r) => a + (Number(r[k]) || 0), 0)
  return `<div class="tablewrap"><table class="data"><thead><tr><th>Location</th><th>On site?</th><th class="n">Articles</th><th class="n">Holders</th></tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr><td>${esc(r.location)}${r.kind ? ` <span class="tiny muted">${esc(r.kind)}</span>` : ''}</td><td>${r.counts_as_on_site ? 'yes' : '<span class="muted">no</span>'}</td>
        <td class="n">${esc(r.articles)}</td><td class="n">${esc(r.holders)}</td></tr>`,
      )
      .join('')}</tbody>
    <tfoot><tr><td colspan="3">Holders on site</td><td class="n">${sum(site, 'holders')}</td></tr></tfoot></table></div>`
}

function glHTML(rows) {
  const convention = `<p class="note" style="margin:0">Maker GL is measured from the HSK gauge line (flange face) to the holder nose — Haimer <i>A</i>,
    MAPAL <i>l1</i>, ISO 13399 <i>LPR</i>. For Haimer face-mill arbors hyperMILL measures to the end of the spigot, so its GL = A + spigot length;
    which convention the catalogue keeps is an open decision (BUILD_SPEC §8.1).</p>`
  if (!rows.length) return `${convention}<div class="okbox">Maker and hyperMILL gauge lengths agree for every holder that has both.</div>`
  return `${convention}<div class="tablewrap"><table class="data"><thead><tr><th>Maker</th><th>Order no.</th><th>Type</th><th class="n">Maker GL</th><th class="n">hyperMILL GL</th><th class="n">Δ mm</th><th>Why</th></tr></thead><tbody>
    ${rows
      .map(
        (g) => `<tr><td>${esc(g.manufacturer)}</td><td class="mono"><a href="#/holder/${encodeURIComponent(g.holder_id)}">${esc(g.order_no)}</a></td><td>${esc(g.type_name || g.type_code)}</td>
        <td class="n">${esc(mm(g.gauge_length_mm))}</td><td class="n">${esc(mm(g.cam_gl_mm))}</td><td class="n">${g.delta_mm > 0 ? '+' : ''}${esc(mm(g.delta_mm))}</td>
        <td class="small">${esc(g.note || 'Check the holder model in hyperMILL.')}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
}
