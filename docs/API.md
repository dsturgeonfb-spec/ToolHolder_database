# Holder Catalogue — architecture and API contract

Read `BUILD_SPEC.md` (requirements, data rules, acceptance checks) and `CLAUDE.md` first.

## Shape of the app

```
Electron window (host PC) ──► http://127.0.0.1:<random port>  ─┐
Tablets / other PCs (optional) ► http://<host-ip>:8763 + PIN  ─┤──► AppServer (src/server/app.ts)
node dist/src/server/standalone.js (dev / LAN server) ────────┘      │ one process owns the SQLite file
                                                                     ▼
                                     <data folder>/holder_catalogue.sqlite, images/, backups/, logs/, imports/
```

- **Database**: `node:sqlite` (built into Node/Electron — no native module). `src/server/db.ts` wraps it:
  `db.all(sql, params)`, `db.get`, `db.value` (first column), `db.run` → `{changes, lastInsertRowid}`,
  `db.tx(() => …)` (synchronous; nests via savepoints). Params are positional arrays or named objects;
  booleans/undefined are converted for you. `migrate()` applies `db/schema.sql` on every start.
- **Schema**: `db/schema.sql` is the source of truth. New tables go there with `IF NOT EXISTS`; new columns on
  existing tables also go in `ADDED_COLUMNS` in `db.ts`. Views are dropped and recreated on every start.
- **Shared data rules**: `src/server/domain.ts` — `postTransaction`, `qtyOnSite`, `qtyAt`, `countStatus`,
  `raiseFlag` (dedupes open flags), `logChange`, `nextHolderId`, `today()`/`nowStamp()` (local time),
  `getSetting`/`setSetting`, `requireUser`. **Use these; do not re-implement the rules.**
- **HTTP**: `src/server/http.ts` — `Router` (`r.get/post/put/patch/delete(path, handler, {hostOnly})`),
  `HttpError(status, message)`, `Download(filename, contentType, body, 'attachment'|'inline')`,
  `Reply(status, body, headers)`, validators `int`, `optNum`, `str`, `optStr`. A handler returns a plain
  object/array (→ 200 JSON), `undefined` (→ 204), a `Download` or a `Reply`; throw `HttpError` for 4xx.
  SQLite constraint errors become 409 with a readable message automatically.
- **Request** (`Req`): `params`, `query` (URLSearchParams), `body` (parsed JSON or raw text), `user`
  (person booking, from `X-User`; network clients always get their signed-in name), `isHost`.
- **Every write** calls `requireUser(req.user)` and records that name (`by_user`, `closed_by`, `added_by`…).
- **Exports**: `src/server/lib/csv.ts` (`toCsv` — UTF-8 BOM + CRLF, formula-injection safe; `parseCsv`,
  `parseCsvObjects`), `src/server/lib/xlsx.ts` (`buildXlsx(sheets)`, `XLSX_TYPE`), `src/server/lib/html.ts`
  (`printPage(title, bodyHtml)`, `esc`) for printable sheets.
- **Jobs** (`ctx.jobs.start(kind, title, async (job) => result)`): for slow work (vendor scans, image
  downloads). `job.progress(done,total,msg)`, `job.log(msg)`, `job.sleep(ms)` (cancellable),
  `job.signal`. Core routes: `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`.
- **Security**: non-GET `/api/*` requests need header `X-Requested-With: HolderCatalogue` (the UI's `api.js`
  sends it). Network clients need a PIN session. `hostOnly` routes (anything that touches a path on disk,
  backups, sharing) refuse network clients.

## Module ownership

| Module (server) | UI | Owns |
|---|---|---|
| `modules/catalogue.ts` | `views/catalogue.js`, `views/holder.js`, `views/tally.js` | holders list/detail/create/edit, tally, catalogue + tally exports |
| `modules/stock.ts` | `views/count.js`, `views/log.js`, `views/locations.js`, `components/stock-actions.js` | locations, transactions, counts, moves, count sheets, transaction log |
| `modules/flags.ts` | `views/issues.js`, `components/flag-actions.js` | data flags, CAM write-back report |
| `modules/hypermill.ts` (+ `src/server/hypermill/*`) | `views/import.js` | hyperMILL report import (parse → preview → apply) |
| `modules/vendors.ts` (+ `src/server/vendors/*`) | `views/vendors.js` | vendor adapters, scans, diff/approve, file import, image cache, sources |
| `modules/purchasing.ts` | `views/want.js`, `components/want-actions.js` | want list, RFQ export |
| `modules/units.ts` | `views/units.js`, `components/unit-actions.js` | serialised units (runout, inspection, quarantine) |
| `modules/system.ts` + `src/main/*` | `views/settings.js` | backups, system info, Electron shell, packaging, CI |

Core (already built, `src/server/app.ts`): `/api/health`, `/api/session`, `/api/login`, `/api/logout`,
`/api/meta`, `/api/summary`, `/api/settings` (GET/PUT), `/api/system/share` (GET/PUT, host only), `/api/jobs*`.

## Holder object (as returned by list/detail endpoints)

All `holders` columns, plus:

| field | meaning |
|---|---|
| `manufacturer` | maker name (from `manufacturers.name`) |
| `is_distributor` | 1 for Cutwel-style distributor SKUs |
| `type_name` | from `holder_types` |
| `qty_on_site` | SUM of transactions at on-site locations |
| `count_status` | `counted` \| `unverified` \| `booked` \| `none` (view `v_count_status`) |
| `last_count_date` | date of last COUNT_ADJUST or null |
| `open_flags` | number of OPEN flags (all severities) |
| `open_issues` | number of OPEN flags excluding INFO |
| `worst_severity` | highest open non-INFO severity or null |
| `on_want_list` | qty wanted on OPEN/QUOTED/ORDERED wishlist rows (0 if none) |
| `dims` | `dims_json` parsed to an object (`{}` when empty) |
| `vendor_image` | `/images/vendor/<holder_id>.<ext>` when a cached maker photo exists, else null |

`cam_image` stays the DB value (`images/cam/cam_01.png`); the UI serves it as `/images/cam/cam_01.png`.

## Routes

### Catalogue (`modules/catalogue.ts`)
- `GET /api/holders` — query: `scope=site|cat|all` (site = qty_on_site > 0; cat = qty_on_site = 0, i.e. can buy;
  default `all`), `q` (all whitespace-separated terms must match manufacturer, order_no, spec_code, product_name,
  series, clamp_spec, cam_name, cam_comment, `gl<value>`, `d<value>`), `type`, `mk` (manufacturer name),
  `fit` (shank Ø: `clamp_min_mm <= fit <= clamp_max_mm`), `flag=1` (open non-INFO flags), `iface`
  (interface_code), `status` (count_status). Sorted by type sort_order, clamp_min, gauge length, order_no.
  Returns `{ holders: Holder[], total: <count before filters> }`.
- `GET /api/holders/:id` — Holder plus `stock` (per location: `location_id, location, kind, counts_as_on_site, qty`,
  non-zero only), `transactions` (latest 200, newest first, with location name), `flags` (all, OPEN first),
  `units`, `wishlist` (rows), `changes` (holder_changes, newest first), `manufacturer_row`.
- `POST /api/holders` — manual entry from a maker catalogue. Body: `manufacturer` (name; must exist),
  `order_no`, `type_code`, `interface_code`, `data_source` (required — where the values came from), optional
  every other holder column (`dims` object allowed). Sets `data_status` default `'unverified'`,
  `last_checked = today`. Fixed-bore types (SHRINK, HYDRAULIC, FACE_MILL_ARBOR) with `clamp_dia_mm` and no
  min/max get min = max = clamp_dia. Logs `holder_changes` (field `'*'`). Returns the Holder.
- `PATCH /api/holders/:id` — edit catalogue fields; body must include `data_source` (provenance) unless only
  `notes` changes. Logs one `holder_changes` row per changed field; sets `last_checked = today`. Never touches
  stock. Returns the Holder.
- `GET /api/tally` — `{ summary, byType[], byMaker[], byClamp[], byLocation[], glCheck[] }` where byType rows
  `{type_code, type_name, articles_on_site, holders_on_site}` (all types, sort_order), byMaker rows
  `{manufacturer, articles_on_site, holders_on_site, articles_in_catalogue}`, byClamp rows `{clamp_dia_mm,
  type_code, type_name, holders_on_site, gauge_lengths:[…]}` (fixed-bore only), byLocation rows from
  `v_tally_by_location`, glCheck from `v_gl_check`, summary as `/api/summary`.
- `GET /api/export/catalogue.csv`, `GET /api/export/catalogue.xlsx` — one row per article (same filters as
  `/api/holders`), with qty_on_site and count_status.
- `GET /api/export/tally.csv` — one row per article on site or counted: holder_id, manufacturer, order_no,
  series, clamp, gauge_length_mm, qty_on_site, count_status, last_count_date (the prototype's "count CSV").
- `GET /api/export/tally.xlsx` — sheets: Articles, By type, By maker, By clamp Ø, By location, GL check.

### Stock (`modules/stock.ts`)
- `GET /api/locations` — locations + `holders` and `articles` currently there.
- `POST /api/locations` — `{name, kind: crib|machine|external|holding, counts_as_on_site: bool}`.
- `PATCH /api/locations/:id` — rename / change kind / counts_as_on_site. The Unassigned location keeps its name.
- `DELETE /api/locations/:id` — only when it has no transactions.
- `GET /api/stock?location_id=` — holders with non-zero qty at that location.
- `GET /api/transactions` — query: `holder_id`, `location_id`, `type`, `since`, `until`, `user`, `limit`
  (default 500). Newest first, with manufacturer/order_no/location names. `GET /api/export/transactions.csv` same filters.
- `POST /api/transactions` — single booking `{holder_id, location_id, txn_type: RECEIPT|SCRAP|RETURN, qty
  (positive), reference, note, txn_date?}`. Sign comes from the type: RECEIPT/RETURN +qty, SCRAP −qty.
  SCRAP more than is at the location → 409. RECEIPT should carry a PO no. in `reference` (warn, don't block).
  OPENING_BALANCE / COUNT_ADJUST / MOVE_* are not accepted here (use counts/moves).
- `POST /api/moves` — `{holder_id, from_location_id, to_location_id, qty, reference, note}` → MOVE_OUT −qty at
  from + MOVE_IN +qty at to, one transaction, same reference. Can't move more than is there → 409.
- `POST /api/counts` — `{holder_id, location_id, counted_qty (≥0, absolute), reference?, note?}`.
  Posts ONE `COUNT_ADJUST` with delta = counted − current qty at that location (a zero delta is still recorded
  as a count confirmation, note "count confirmed, no change"). **First count of a holder** (no COUNT_ADJUST
  before) also posts a `COUNT_ADJUST` that zeroes its balance at the Unassigned location (note "opening balance
  superseded by physical count") — unless the count itself is AT the Unassigned location. If the same holder +
  location + reference already has a count today and the new delta is 0, nothing is posted (retry-safe).
  Default reference: `COUNT <YYYY-MM-DD> <location name>`. Returns `{ holder: Holder, posted: txn[] }`.
- `GET /api/count/list?location_id=&scope=site|all|location&type=&mk=` — the step-through list for count mode:
  holders (Holder fields) + `qty_at_location`, `counted_here_today` (bool).
- `GET /api/export/count-sheet?location_id=` — printable HTML count sheet (inline): holders expected at the
  location (or all on-site for Unassigned), boxes to write counts, sign-off line.

### Issues (`modules/flags.ts`)
- `GET /api/flags?status=OPEN|CLOSED|all&severity=&category=&holder_id=&q=` — with holder manufacturer/order_no.
  Sorted OPEN first, then severity HIGH→INFO, then flag_id.
- `POST /api/flags` — raise `{holder_id?, severity, category, message, action}` (raised_by = user, source 'manual').
- `POST /api/flags/:id/close` — `{note}` (required: what was done) → status CLOSED, closed_on today, closed_by user.
- `POST /api/flags/:id/reopen` — `{note}` → back to OPEN; clears closed_on/closed_by/close_note and appends
  "Reopened <date> by <user>: <note>" to `action` so the history stays visible.
- `GET /api/flags/categories` — distinct categories.
- `GET /api/writeback` — open flags in CAM-facing categories (`CAM model`, `Naming`, `Gauge length`, `hyperMILL`)
  joined to holders (cam_name, cam_comment, order_no, cam_gl_mm, gauge_length_mm) — the list of fixes to make in
  hyperMILL. `GET /api/export/writeback.csv` and `GET /api/export/writeback.html` (printable).
- `GET /api/export/flags.csv`.

### hyperMILL import (`modules/hypermill.ts`, parser in `src/server/hypermill/`)
- `POST /api/import/hypermill/preview` (host only) — `{path, interface_code}` path to the report `.html`
  (or a `.txt` text export). Parses holders + images, matches on (maker, order no.), returns
  `{token, report:{path, holders: n}, plan:{new[], renamed[], changed[], removed[], unchanged: n, unmatched[]}, warnings[]}`.
- `POST /api/import/hypermill/apply` (host only) — `{token}` → one DB transaction: new holders inserted
  (classified type, CAM GL, opening balance 1 at Unassigned), renames/changes update cam_name/cam_comment/cam_gl_mm/
  cam_image with `holder_changes` + a flag, removed raise a flag (never delete). Copies the report + images into
  `<data>/imports/<timestamp>/` and new profile images into `<data>/images/cam/`. Records `import_runs`.
  Re-running the same report → no new holders, no new opening balances, no duplicate flags.
- `GET /api/import/runs` — import history.

### Vendors (`modules/vendors.ts`, adapters in `src/server/vendors/`)
- `GET /api/vendors` — adapters: `{maker, method, automated: bool, notes, robots, source_url}` + sources text.
- `POST /api/vendors/:maker/scan` — `{interface_code, order_nos?: string[], discover?: bool}` → `{job_id}`.
  Job result: `{maker, proposals: [{order_no, action: 'insert'|'update'|'same'|'error', holder_id?, fields:
  {col: {old, new}}, record, source_url, error?}]}`.
- `POST /api/vendors/apply` — `{job_id, approve: [{order_no, fields?: string[]}]}` → writes approved
  inserts/updates with `data_status`, `data_source`, `last_checked`, `holder_changes`; records `import_runs`.
- `POST /api/vendors/import-file` — raw CSV body (text/csv) with our column names or ISO 13399 codes
  (DCONWS, LPR, BD/DLN, WT, RPMX, ADINTMS…) + query `maker`, `interface_code`, `source` → same proposal shape
  (synchronous, returns `{token, proposals}`); `POST /api/vendors/apply` also accepts `{token, approve}`.
- `POST /api/vendors/images` — `{holder_ids?: string[]}` → job downloading `image_url` into
  `images/vendor/<holder_id>.<ext>`.

### Want list / RFQ (`modules/purchasing.ts`)
- `GET /api/wishlist?status=` — rows with holder fields (manufacturer, order_no, spec_code, series, clamp_spec,
  gauge_length_mm, product_url, qty_on_site).
- `POST /api/wishlist` — `{holder_id, qty_wanted, reason}`; if an OPEN row exists for the holder, add to it.
- `PATCH /api/wishlist/:id` — `{qty_wanted?, reason?, status?}` (sets updated_on). `DELETE /api/wishlist/:id`
  sets status CANCELLED (rows are kept for the purchasing record).
- `GET /api/export/rfq.csv`, `/api/export/rfq.xlsx` (one sheet per maker), `/api/export/rfq.html?maker=`
  (printable RFQ per maker: order no., designation, qty, reason, maker URL). Only OPEN rows unless `status=`.
- Marking ORDERED/RECEIVED does not book stock — receipts go through `POST /api/transactions` (RECEIPT) so stock
  stays one ledger; the UI offers "book receipt" when marking RECEIVED.

### Serialised units (`modules/units.ts`)
- `GET /api/units?holder_id=&status=&due=1` — with holder maker/order_no, location name, `next_due` (last_inspected +
  `unit_inspection_days` setting), `overdue` bool.
- `POST /api/units` — `{unit_id, holder_id, serial_no?, location_id?, runout_check_um?, last_inspected?, note?}`.
- `PATCH /api/units/:id` — edit; `POST /api/units/:id/inspect` — `{runout_check_um, passed: bool, note}` →
  last_inspected today, inspected_by user, status QUARANTINE if not passed; `POST /api/units/:id/status` —
  `{status: IN_SERVICE|QUARANTINE|SCRAPPED, note}`.
- `GET /api/export/units.csv`.

### System (`modules/system.ts`)
- `GET /api/system` (host only) — `{version, dataDir, dbPath, dbSizeBytes, backups:[{file, size, created}], lastBackup,
  logsDir, share: ShareState, platform}`.
- `POST /api/system/backup` (host only) — `VACUUM INTO` `<data>/backups/holder_catalogue-YYYYMMDD-HHMMSS.sqlite`;
  keeps the newest 30. Returns the backup entry.
- `POST /api/system/open` (host only) — `{what: 'data'|'backups'|'logs'}` → opens the folder via the desktop hook.

## UI conventions

- Views are ES modules in `ui/js/views/` exporting `render(root, ctx)` (and optional `teardown()`).
  `ctx = { params, query, api, state, navigate, refreshSummary, ensureUser }`. Routes are `#/<view>/<params…>?query`.
- Import helpers from `../ui.js` (`esc`, `fmt`, `fmtDate`, `sevChip`, `statusChip`, `rulerHTML`, `profileHTML`,
  `toast`, `toastError`, `confirmDialog`, `formDialog`, `infoDialog`, `kvHTML`, `debounce`, `setSaveStatus`,
  `emptyHTML`, `DATA_STATUS_LABEL`), `../state.js` (`state`, `typeName`, `ensureUser`, `refreshSummary`),
  `../api.js` (`api`).
- **Escape every data value with `esc()`** when building HTML. No inline `onclick` — use event delegation.
- Before any write: `const who = await ctx.ensureUser(); if (!who) return`. After writes that change stock or
  flags: `ctx.refreshSummary()`.
- Downloads: `api.download('/api/export/…')`. Printable pages: `api.openPrintable('/api/export/….html')`.
- Holder link: `#/holder/<holder_id>`. Count a holder: `#/count?holder=<id>`.
- Shop-floor first: big touch targets in count mode, works at tablet width (≥ 768 px) and phone width.
- Dates shown DD/MM/YYYY (`fmtDate`); stored ISO.
