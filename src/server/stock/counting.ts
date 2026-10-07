/**
 * Count mode support: the step-through list for one location and the printable count sheet.
 */
import type { AppContext } from '../context.js'
import { HttpError } from '../http.js'
import { esc, printPage } from '../lib/html.js'
import { UNASSIGNED_LOCATION, nowStamp, today, unassignedLocationId } from '../domain.js'
import { holderRows, type Holder } from './holders.js'
import { SUPERSEDE_NOTE, defaultCountReference, getLocation, isUnassigned, type LocationRow } from './ledger.js'

export const COUNT_SCOPES = ['site', 'all', 'location'] as const
export type CountScope = (typeof COUNT_SCOPES)[number]

export interface CountListItem extends Holder {
  qty_at_location: number
  counted_here_today: boolean
  /** Date of the last physical count at this location (not the opening-balance clean-up), or null. */
  last_count_here: string | null
  /** Quantity still sitting on the unverified opening balance (at Unassigned). */
  qty_unassigned: number
  /** Where the holder is booked now: non-zero quantities per location. */
  stock: Array<{ location_id: number; location: string; counts_as_on_site: number; qty: number }>
}

export interface CountListOptions {
  location_id: number
  scope: CountScope
  type?: string | null
  mk?: string | null
}

export function parseScope(v: string | null, fallback: CountScope = 'site'): CountScope {
  if (!v) return fallback
  if (!(COUNT_SCOPES as readonly string[]).includes(v)) throw new HttpError(400, `scope must be one of ${COUNT_SCOPES.join(', ')}`)
  return v as CountScope
}

/**
 * Holders for a count run at one location.
 *  site      holders expected on site (anywhere), plus anything booked or counted here today
 *  all       every holder in the catalogue (to book something found that was never on the books)
 *  location  only what is booked at this location (plus what was counted here today)
 * Holders counted here today always stay in the list, so counting one to 0 doesn't make it vanish mid-run.
 */
export function countList(ctx: AppContext, o: CountListOptions): { location: LocationRow; holders: CountListItem[] } {
  const db = ctx.db
  const location = getLocation(db, o.location_id)
  const date = today()
  const unassigned = unassignedLocationId(db)

  const stock = new Map<string, CountListItem['stock']>()
  for (const r of db.all<{ holder_id: string; location_id: number; location: string; counts_as_on_site: number; qty: number }>(
    `SELECT t.holder_id, t.location_id, l.name AS location, l.counts_as_on_site, SUM(t.qty_delta) AS qty
     FROM stock_transactions t JOIN locations l ON l.location_id = t.location_id
     GROUP BY t.holder_id, t.location_id HAVING SUM(t.qty_delta) <> 0 ORDER BY t.location_id`,
  )) {
    const list = stock.get(r.holder_id) ?? []
    list.push({ location_id: Number(r.location_id), location: r.location, counts_as_on_site: Number(r.counts_as_on_site), qty: Number(r.qty) })
    stock.set(r.holder_id, list)
  }
  const lastCount = new Map<string, string>()
  for (const r of db.all<{ holder_id: string; d: string }>(
    `SELECT holder_id, MAX(txn_date) AS d FROM stock_transactions
     WHERE location_id = ? AND txn_type = 'COUNT_ADJUST' AND COALESCE(note,'') <> ? GROUP BY holder_id`,
    [location.location_id, SUPERSEDE_NOTE],
  ))
    lastCount.set(r.holder_id, r.d)

  const where: string[] = []
  const params: string[] = []
  if (o.type) {
    where.push('h.type_code = ?')
    params.push(o.type)
  }
  if (o.mk) {
    where.push('m.name = ?')
    params.push(o.mk)
  }
  const holders: CountListItem[] = []
  for (const h of holderRows(ctx, where.join(' AND '), params)) {
    const st = stock.get(h.holder_id) ?? []
    const here = st.find((s) => s.location_id === location.location_id)?.qty ?? 0
    const last = lastCount.get(h.holder_id) ?? null
    const countedToday = last === date
    const keep =
      o.scope === 'all' ||
      countedToday ||
      here !== 0 ||
      (o.scope === 'site' && h.qty_on_site > 0)
    if (!keep) continue
    holders.push({
      ...h,
      qty_at_location: here,
      counted_here_today: countedToday,
      last_count_here: last,
      qty_unassigned: unassigned != null ? (st.find((s) => s.location_id === unassigned)?.qty ?? 0) : 0,
      stock: st,
    })
  }
  return { location, holders }
}

/**
 * Printable count sheet: one line per holder with a box to write the count, blank lines for
 * holders found that aren't listed, and a sign-off. Default list: what is booked at the location
 * plus holders whose location is still unknown (opening balance at Unassigned); for the
 * Unassigned location itself, everything on site. A scope (as in count mode) overrides that.
 * `blind`: a blind count — the sheet leaves out what the books expect (no "Booked here" column,
 * no "not located" hint), so the counter writes down what they see.
 */
export function countSheetHtml(
  ctx: AppContext,
  o: {
    location_id: number
    scope?: CountScope | null
    type?: string | null
    mk?: string | null
    reference?: string | null
    user?: string | null
    blind?: boolean
  },
): string {
  const location = getLocation(ctx.db, o.location_id)
  const blind = !!o.blind
  const atUnassigned = isUnassigned(location)
  let holders: CountListItem[]
  let scopeText: string
  if (o.scope) {
    holders = countList(ctx, { location_id: location.location_id, scope: o.scope, type: o.type, mk: o.mk }).holders
    scopeText = { site: 'holders expected on site', all: 'every holder in the catalogue', location: `holders booked at ${location.name}` }[o.scope]
  } else if (atUnassigned) {
    holders = countList(ctx, { location_id: location.location_id, scope: 'site', type: o.type, mk: o.mk }).holders
    scopeText = 'every holder on site'
  } else {
    // A holder still on the opening balance could be anywhere on site, so it belongs on every sheet until it is found.
    holders = countList(ctx, { location_id: location.location_id, scope: 'site', type: o.type, mk: o.mk }).holders.filter(
      (h) => h.qty_at_location !== 0 || h.qty_unassigned > 0,
    )
    scopeText = `holders booked at ${location.name}, and holders not yet located (still on the opening balance)`
  }
  const reference = o.reference || defaultCountReference(location)
  // Blind: no "Booked here" cell at all, so the sheet gives nothing away.
  const booked = (h: CountListItem) =>
    blind
      ? ''
      : `<td class="n">${h.qty_at_location !== 0 ? esc(h.qty_at_location) : h.qty_unassigned > 0 ? '<span class="muted">not located</span>' : '0'}</td>`
  const rows = holders
    .map(
      (h, i) => `<tr>
  <td class="n">${i + 1}</td>
  <td class="mono">${esc(h.holder_id)}</td>
  <td>${esc(h.manufacturer)}</td>
  <td class="mono"><b>${esc(h.order_no)}</b></td>
  <td>${esc([h.series, h.clamp_spec].filter(Boolean).join(' · '))}</td>
  <td class="n">${h.gauge_length_mm != null ? esc(h.gauge_length_mm) : '–'}</td>
  ${booked(h)}
  <td class="box"></td>
  <td style="width:30mm"></td>
</tr>`,
    )
    .join('')
  const blanks = Array.from(
    { length: 6 },
    () => `<tr><td class="n">+</td>${'<td></td>'.repeat(blind ? 5 : 6)}<td class="box"></td><td></td></tr>`,
  ).join('')
  // What a number means here (docs/API.md, the count rule).
  const how = atUnassigned
    ? `“${esc(UNASSIGNED_LOCATION)}” is not a place on the shop floor: on each line write how many are <b>still not located</b> — not found at any location. ` +
      `0 writes the opening balance off (the holder leaves the site tally as not found anywhere), so count every real location first.`
    : `Write the quantity physically at <b>${esc(location.name)}</b> on every line — including 0. A 0 for a holder that is not yet located only ` +
      `means it is not here: it stays on the other sheets until it is found (or written off at “${esc(UNASSIGNED_LOCATION)}”).`
  const body = `
<p class="sub">Reference <b class="mono">${esc(reference)}</b> · ${esc(holders.length)} line${holders.length === 1 ? '' : 's'}: ${esc(scopeText)}.${
    blind ? ' <b>Blind count</b> — the booked quantities are not printed.' : ''
  }</p>
<p class="sub">${how} Add holders you find that are not listed on the blank lines (maker + order no. as engraved). Book the counts in the app's Count mode with the same reference.</p>
<table>
<thead><tr><th class="n">#</th><th>ID</th><th>Maker</th><th>Order no.</th><th>Series · clamping</th><th class="n">GL mm</th>${
    blind ? '' : '<th class="n">Booked here</th>'
  }<th>Counted</th><th>Note</th></tr></thead>
<tbody>${rows}${blanks}</tbody>
</table>
<div class="sign"><span>Counted by (name)</span><span>Signature</span><span>Date</span></div>
<div class="sign"><span>Booked in app by</span><span>Checked by</span><span>Date</span></div>
<p class="sub" style="margin-top:14px">Printed ${esc(nowStamp())}${o.user ? ` by ${esc(o.user)}` : ''}.</p>`
  return printPage(`Count sheet — ${location.name}`, body, { subtitle: `Holder count · ${location.name}${blind ? ' · blind count' : ''}` })
}
