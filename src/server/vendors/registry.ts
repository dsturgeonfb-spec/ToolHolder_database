/**
 * Every maker the app knows how to get data for, plus the manual routes for the sites that must not be
 * scraped. The source cards are the prototype's "Sources" tab (scripts/make_page.py SOURCES) with the
 * counts computed live from the catalogue.
 */
import type { AppContext } from '../context.js'
import { getSetting } from '../domain.js'
import { describePolicy } from './robots.js'
import { haimer } from './haimer.js'
import { mapal } from './mapal.js'
import { kemmler } from './kemmler.js'
import { gatesFor, currentUserAgent, usingFixtures } from './hooks.js'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { VendorAdapter } from './types.js'

/**
 * Decision for the JavaScript-rendered sites (BUILD_SPEC §5 named Playwright for CUTWEL and as SANDVIK's
 * fallback): they stay on the manual file-import route. A browser engine (Playwright) is not bundled with
 * the app, and these sites could not be tested from the build environment, so an automated reader could
 * not be checked before it wrote catalogue data.
 */
export const JS_SITE_DECISION =
  'Decision: this maker stays on the manual file-import route — its site only shows products once JavaScript runs, reading it would need a browser engine (Playwright) that is not bundled with the app, and the site could not be tested from the build environment.'

/** Sites that refuse automated access or only render with JavaScript: data comes in by file import. */
export const ceratizit: VendorAdapter = {
  maker: 'CERATIZIT',
  method: 'File import: ISO 13399 / catalogue data from your rep',
  automated: false,
  notes:
    'cuttingtools.ceratizit.com answers 403 to any automated request (even robots.txt), so the app does not scrape it — and never tries to get round the block. Ask the Ceratizit rep for an ISO 13399 / GTC package or catalogue table and import it as CSV. The seeded Ceratizit data came from the distributor Zedaro, which quotes the Ceratizit article numbers.',
  robots: '403 to every automated request, robots.txt included — not scanned.',
  source_url: null,
}

export const sandvik: VendorAdapter = {
  maker: 'SANDVIK COROMANT',
  method: 'File import: ISO 13399 / GTC via CoroPlus Tool Library',
  automated: false,
  notes: `${JS_SITE_DECISION} Sandvik's tool-data channel (CoroPlus Tool Library, ISO 13399 / GTC export) is the dependable route: export the HSK-A63 holders and import the CSV here.`,
  robots: 'JavaScript single-page site — not scanned (manual file-import route).',
  source_url: 'https://www.sandvik.coromant.com/en-gb/tools/tool-data',
}

export const cutwel: VendorAdapter = {
  maker: 'CUTWEL',
  method: 'File import (distributor list)',
  automated: false,
  notes: `${JS_SITE_DECISION} Cutwel is a UK distributor (Dine, EZChange) whose part numbers are its own, not maker order numbers: import its list as CSV and put the maker's own order no. in spec_code or a maker_order_no column when known.`,
  robots: 'JavaScript product grid — not scanned (manual file-import route).',
  source_url: 'https://www.cutwel.co.uk/landing-pages/shop-by/shop-by-taper/hsk-din69893-spindle-tooling/hsk63-spindle-tooling',
}

export const ADAPTERS: VendorAdapter[] = [haimer, mapal, kemmler, ceratizit, sandvik, cutwel]

export function adapterFor(maker: string): VendorAdapter | undefined {
  const m = maker.trim().toUpperCase()
  return ADAPTERS.find((a) => a.maker === m)
}

/** Sites a maker's photos may be downloaded from: its automated adapter's photo (or page) origins. */
export function photoOriginsOf(a: VendorAdapter | undefined): string[] {
  return a?.automated ? (a.imageOrigins ?? a.origins ?? []) : []
}

/** Every site the photo cache may contact (the union over the automated adapters). */
export function allPhotoOrigins(): string[] {
  return [...new Set(ADAPTERS.flatMap(photoOriginsOf))]
}

/**
 * May the photo cache download this holder's image_url? Only for a maker with an automated adapter, and only
 * from that adapter's own site — never a distributor's CDN or an address typed into a holder or a CSV file.
 */
export function photoSource(maker: string, url: string): { ok: true; origins: string[] } | { ok: false; reason: string } {
  const a = adapterFor(maker)
  const origins = photoOriginsOf(a)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, reason: 'not a web address' }
  }
  if (!origins.length)
    return { ok: false, reason: `${maker} has no automated reader, so its photos are not downloaded (no adapter for ${u.host}) — the catalogue keeps linking to the address.` }
  if (!origins.includes(u.origin) || u.username || u.password)
    return { ok: false, reason: `${u.host} is not ${a!.maker}'s own site (${origins.map((o) => new URL(o).host).join(', ')}) — no adapter for this host, not downloaded.` }
  return { ok: true, origins }
}

/** The prototype's source cards (make_page.py SOURCES): why each method, and the best entry point. */
export const SOURCES: Array<{ maker: string; method: string; why: string; link_note: string | null; url: string | null }> = [
  {
    maker: 'HAIMER',
    method: 'Static HTML scrape (product pages)',
    why: 'Product pages are plain HTML with a DIN 4000 / ISO 13399 spec table and photo URLs. Category pages refuse non-browser requests, so find products through shop.haimer.com/sitemap.xml and keep to the 10-second crawl delay in robots.txt.',
    link_note: 'Points at HSK-A50, not HSK-A63.',
    url: 'https://shop.haimer.com/en/Tool-Holders/HSK-Hollow-shank-DIN-69893/HSK-A63/',
  },
  {
    maker: 'MAPAL',
    method: 'PDF catalogue parse + shop listings',
    why: 'The UNIQ catalogue in this project was parsed directly (38 HSK-A63 chucks). Every MAPAL product opens at shop.mapal.com/en/p/0000000000<order no.>, and the designation encodes the geometry: MHC-HSK-A063-12-075 is Ø12, GL 75.',
    link_note: 'Spannfutter-HSK-C-HSK-E-EN.pdf covers HSK-C and HSK-E, not form A, so it is left out. The MQL catalogue lists 388 HSK-A63 MQL holders; not loaded unless you run MQL.',
    url: 'https://shop.mapal.com/Spannen/Spannfutter/c/chucks?q=%3Adiameter-asc%3AClampingConnectionCodeMachineSide%3AHSK0506',
  },
  {
    maker: 'CERATIZIT',
    method: 'PDF catalogue or ISO 13399 data from your rep',
    // The holder count and where their data came from are filled in live (ceratizitWhy).
    why: 'cuttingtools.ceratizit.com answers 403 to any automated request, so the app should not scrape it. The seeded Ceratizit data came from the distributor Zedaro, which quotes the Ceratizit article numbers.',
    link_note: 'Hash-routed search page; it can only be read inside a browser.',
    url: null,
  },
  {
    maker: 'KEMMLER',
    method: 'Static HTML scrape (product pages)',
    why: 'Product pages carry ISO 13399 properties, photos and free DXF/STEP downloads. Shop search works: kemmler-shop.de/search?search=<order no.>.',
    link_note: "Path should be /ISO-12164-HSK-A/ (no '-1'), and it only covered ER collet chucks.",
    url: 'https://www.kemmler-shop.de/en/Products-Shop/ISO-12164-HSK-A/',
  },
  {
    maker: 'SANDVIK COROMANT',
    method: 'File import: ISO 13399 / GTC via CoroPlus Tool Library',
    why: `${JS_SITE_DECISION} Sandvik's tool-data channel (CoroPlus, ISO 13399 / GTC export) is the dependable route for holder geometry.`,
    link_note: 'Filter value could not be confirmed without a browser.',
    url: 'https://www.sandvik.coromant.com/en-gb/tools/tool-data',
  },
  {
    maker: 'CUTWEL',
    method: 'File import (distributor list)',
    why: `${JS_SITE_DECISION} Cutwel is a UK distributor (Dine, EZChange): its part numbers are its own, not maker order numbers.`,
    link_note: 'Covers every HSK size; the HSK63 page is linked below.',
    url: 'https://www.cutwel.co.uk/landing-pages/shop-by/shop-by-taper/hsk-din69893-spindle-tooling/hsk63-spindle-tooling',
  },
]

interface MakerCount {
  manufacturer: string
  is_distributor: number
  articles_on_site: number
  holders_on_site: number
  articles_in_catalogue: number
}

/** The CERATIZIT card text with live numbers: how many of its holders still carry the distributor's data. */
export function ceratizitWhy(db: AppContext['db']): string {
  const r = db.get<{ total: number; zedaro: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(h.data_source LIKE '%zedaro%'), 0) AS zedaro
     FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id WHERE m.name = 'CERATIZIT'`,
  )
  const total = Number(r?.total ?? 0)
  const zedaro = Number(r?.zedaro ?? 0)
  const base = 'cuttingtools.ceratizit.com answers 403 to any automated request, so the app should not scrape it.'
  if (!total) return `${base} No Ceratizit holder is in the catalogue yet — import the rep's ISO 13399 data as a file.`
  const holders = `Ceratizit holder${total === 1 ? '' : 's'} in the catalogue`
  if (!zedaro) return `${base} None of the ${total} ${holders} relies on the distributor Zedaro's data any more.`
  const who = zedaro === total ? (total === 1 ? `The only ${holders} carries` : `All ${total} ${holders} carry`) : `${zedaro} of the ${total} ${holders} ${zedaro === 1 ? 'carries' : 'carry'}`
  return `${base} ${who} data from the distributor Zedaro, which quotes the Ceratizit article numbers — replace it with the rep's ISO 13399 data when you have it.`
}

/** GET /api/vendors */
export function vendorOverview(ctx: AppContext) {
  const db = ctx.db
  const counts = db.all<MakerCount>(
    `SELECT m.name AS manufacturer, m.is_distributor, v.articles_on_site, v.holders_on_site, v.articles_in_catalogue
     FROM v_tally_by_manufacturer v JOIN manufacturers m ON m.name = v.manufacturer ORDER BY m.manufacturer_id`,
  )
  const byMaker = new Map(counts.map((c) => [c.manufacturer.toUpperCase(), c]))
  const gates = gatesFor(ctx)
  const now = Date.now()
  const card = (a: VendorAdapter) => {
    const c = byMaker.get(a.maker)
    const src = SOURCES.find((s) => s.maker === a.maker)
    const origin = a.origins?.[0]
    const live = origin ? gates.robotsOf(origin) : null
    const block = origin ? gates.blockOf(origin, now) : null
    return {
      maker: a.maker,
      method: a.method,
      automated: a.automated,
      notes: a.notes,
      robots: a.robots,
      robots_live: live ? { summary: describePolicy(live.policy), checked_at: new Date(live.fetchedAt).toISOString() } : null,
      // Seconds between requests: the site's Crawl-delay once read, never below the app's 2 s floor.
      delay_s: a.automated ? Math.max(2, live?.policy?.crawlDelay ?? a.delay_hint_s ?? 2) : null,
      blocked: block ? block.reason : null,
      source_url: a.source_url,
      why: a.maker === 'CERATIZIT' ? ceratizitWhy(db) : (src?.why ?? a.notes),
      link_note: src?.link_note ?? null,
      is_distributor: Number(c?.is_distributor ?? 0),
      articles_on_site: Number(c?.articles_on_site ?? 0),
      holders_on_site: Number(c?.holders_on_site ?? 0),
      articles_in_catalogue: Number(c?.articles_in_catalogue ?? 0),
    }
  }
  const vendors = ADAPTERS.map(card)
  // A maker added to the database later has no adapter yet: offer the file import route for it.
  for (const c of counts)
    if (!adapterFor(c.manufacturer))
      vendors.push({
        ...card({ maker: c.manufacturer.toUpperCase(), method: 'File import (no adapter)', automated: false, notes: 'No website adapter for this maker — import its catalogue or ISO 13399 data as CSV.', robots: '—', source_url: null }),
        maker: c.manufacturer,
      })
  const sources = SOURCES.map((s) => {
    const c = byMaker.get(s.maker)
    const n = Number(c?.articles_on_site ?? 0)
    return {
      ...s,
      why: s.maker === 'CERATIZIT' ? ceratizitWhy(db) : s.why,
      vendor: `${s.maker} · ${n ? `${n} on site` : 'none on site'}`,
      articles_on_site: n,
      articles_in_catalogue: Number(c?.articles_in_catalogue ?? 0),
    }
  })
  return {
    vendors,
    sources,
    user_agent: currentUserAgent(ctx),
    vendor_contact_set: !!getSetting<string>(db, 'vendor_contact', '').trim(),
    fixtures: usingFixtures(ctx),
    images: imageStats(ctx),
  }
}

/**
 * How many holders have a maker photo URL, how many of those the photo cache may download (a maker with an
 * automated adapter, photo on that maker's own site — see photoSource), and how many are cached in images/vendor/.
 */
export function imageStats(ctx: AppContext): { with_url: number; downloadable: number; cached: number } {
  const rows = ctx.db.all<{ holder_id: string; image_url: string; maker: string }>(
    `SELECT h.holder_id, h.image_url, m.name AS maker FROM holders h JOIN manufacturers m ON m.manufacturer_id = h.manufacturer_id
     WHERE h.image_url LIKE 'http%'`,
  )
  const dir = join(ctx.paths.imagesDir, 'vendor')
  const files = existsSync(dir) ? new Set(readdirSync(dir).map((f) => f.replace(/\.[a-z0-9]+$/i, ''))) : new Set<string>()
  return {
    with_url: rows.length,
    downloadable: rows.filter((r) => photoSource(r.maker, r.image_url).ok).length,
    cached: rows.filter((r) => files.has(r.holder_id)).length,
  }
}

