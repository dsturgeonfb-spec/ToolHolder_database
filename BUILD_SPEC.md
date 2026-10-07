# Holder Catalogue — Windows app build spec (for Claude Code)

Owner: Engineering Manager · Status: logic validated in claude.ai Project, ready to build · Taper form in scope: **HSK-A63** (schema supports any `interface_code`)

## 1. What the app must do

1. Hold a catalogue of tool holders for a commanded taper form, across the manufacturers the user selects.
2. For every holder: manufacturer, order no., holder type, clamp Ø / range, **gauge length**, nose Ø, image.
3. Track stock on site per holder and per location, and total it (the **tally**).
4. Pull catalogue data from vendor sites / catalogues on command ("scan Haimer for HSK-A63").
5. Stay aligned with the hyperMILL (OPEN MIND) tool database the CAM team uses.

## 2. What already exists in this folder

| Path | What it is |
|---|---|
| `db/schema.sql` | SQLite schema: manufacturers, interfaces, holder_types, holders, data_flags, locations, stock_transactions, holder_units, wishlist + tally views |
| `db/holder_catalogue.sqlite` | Seeded DB: 88 HSK-A63 articles (54 on site, 34 MAPAL UNIQ purchasable), 31 data flags, opening-balance stock |
| `data/holders.csv` / `holders.json` | Same catalogue as flat files (UTF-8 BOM CSV opens cleanly in Excel) |
| `data/data_flags.csv` | Issues found between hyperMILL and maker data |
| `data/raw/` | Raw inputs: parsed hyperMILL report, per-vendor enrichment JSON, vendor source register, MAPAL UNIQ text |
| `images/cam/cam_NN.png` | hyperMILL holder profile per on-site holder (300×200 PNG) |
| `scripts/parse_tooldb.py` | Parses the hyperMILL holder report (text + images) |
| `scripts/build_catalogue.py` | Merges everything → CSV/JSON/SQLite + flags. Re-runnable |
| `scripts/catalogue_template.html` + `make_page.py` | Catalogue/tally UI prototype (also published as a claude.ai artifact) |

Rebuild: `python scripts/build_catalogue.py . && python scripts/make_page.py .`

## 3. Data rules (do not change without a reason)

- **Stock is never a column on the holder.** On-site qty = `SUM(stock_transactions.qty_delta)` over locations with `counts_as_on_site = 1`. Every count, receipt, move or scrap is a transaction with date, user and reference (PO, count sheet, NCR). This gives the audit trail AS9100 auditors expect for tooling control.
- **Opening balance** = 1 per holder found in the hyperMILL DB, txn type `OPENING_BALANCE`, location "Unassigned – count required". A physical count posts `COUNT_ADJUST` deltas. The UI shows "Unverified" until a holder has a count.
- **Gauge length** `gauge_length_mm` = maker value from the HSK gauge line (flange face) to the holder nose (Haimer "A", MAPAL "l1", ISO 13399 "LPR"). `cam_gl_mm` = what hyperMILL uses. View `v_gl_check` lists differences. Known case: Haimer face mill arbors — hyperMILL GL = A + spigot length.
- **"What fits a Ø d shank"** = `clamp_min_mm <= d AND d <= clamp_max_mm`. Fixed-bore holders (shrink, hydraulic, arbor spigot) store min = max = nominal. Screw-in and tap chucks leave both null and use `clamp_spec` text.
- **Identity** = (manufacturer, order_no) unique. Distributor SKUs (Cutwel) are stored with `is_distributor = 1` and should carry the maker order no. in `spec_code` or notes when known.
- **Provenance** on every row: `data_status` (verified / partial / distributor_only / catalogue_pdf / unverified), `data_source`, `last_checked`.

## 4. Features

**MVP**
- Catalogue view grouped by holder type; filters: scope (on site / can buy / all), maker, type, fits-shank-Ø, has-issues, free-text search. Row shows profile image, maker + order no., series, clamp spec, GL with a to-scale ruler, nose Ø, qty.
- Holder detail: all maker dims (`dims_json`), coolant, balance, rpm, mass, hyperMILL name/comment, links to maker page/photo/drawing, open flags.
- **Count mode**: pick a location, step through holders, post counts (one transaction per change; debounce rapid clicks).
- **Tally**: totals by type, maker, clamp Ø, location; counted vs unverified progress. Export CSV/XLSX.
- **Issues**: list `data_flags`, close with name + date.
- **Import hyperMILL report**: parse the HTML report directly — the PDF in the project was printed from `C:\Users\Public\Documents\OPEN MIND\tooldbReport\Holder_HSK63 HOLDERS_1\Holder_HSK63 HOLDERS.html`, so the HTML and its image files are on the CAM PC. Match on order no.; new holders get an opening balance; renamed/removed ones raise a flag rather than deleting.

**v2**
- Vendor sync on command: choose maker(s) + interface → adapter fetches, diffs against DB, user approves inserts/updates.
- Image cache: download maker photos to `images/vendor/` (only from adapters that expose image URLs in HTML).
- Want list → simple RFQ export grouped by maker.
- Serialised units (`holder_units`): runout check, last inspection, quarantine.
- Write-back report: list of hyperMILL holder renames/fixes from open CAM flags.

## 5. Vendor adapters

One adapter per maker implementing `discover(interface_code) -> [product_ref]` and `fetch(product_ref) -> HolderRecord`. Throttle and identify politely; respect robots.txt; never bypass a block.

| Maker | Method | Notes |
|---|---|---|
| HAIMER | Static HTML (requests + BeautifulSoup) | Product URL `shop.haimer.com/en/<slug>/<order_no>`; discover via `sitemap.xml` (gzipped children) filtered on `HSK-A63` / `/A63.`; spec table uses DIN 4000/ISO 13399 labels (D1, A, D2, L, mass); robots.txt Crawl-delay 10 s; `/search`, `/printpage/`, `/downloadfile/` disallowed; category pages 404 to non-browsers |
| MAPAL | PDF parse + static HTML | `shop.mapal.com/en/p/0000000000<order_no>` resolves any product; designation `MHC-HSK-A063-<d1>-<l1>-…` encodes Ø and GL; UNIQ PDF parser already in `build_catalogue.py`; MQL (MMS) PDF has 388 HSK-A63 MQL rows — optional; HSK-C/E PDF is out of scope for form A |
| KEMMLER | Static HTML | Search `kemmler-shop.de/search?search=<order_no>`; ISO 13399 codes (ADINTMS, DCONWS, DLN, LPR); free DXF/STEP; check which field is GL against the drawing |
| CERATIZIT | PDF catalogue / ISO 13399 package from rep | Site returns 403 to automated access — **do not scrape**. Current data is from distributor Zedaro |
| SANDVIK COROMANT | ISO 13399 / GTC via CoroPlus Tool Library; Playwright fallback | Site is a JS single-page app |
| CUTWEL | Playwright | Distributor; own SKUs; HSK63 landing page renders products via JS |

Better long-term route for all makers: ISO 13399 / GTC packages (and the same data hyperMILL can import), so the app and CAM read one source.

## 6. Tech stack — options

| Option | For | Against |
|---|---|---|
| **A. Python + SQLite + pywebview** (reuse `catalogue_template.html` as the UI, FastAPI or direct bridge), Playwright for JS sites, PyInstaller exe | Reuses all existing parsing and the UI; fastest to a working tool | ~150 MB exe; Python packaging quirks |
| B. .NET 8 (WPF/WinUI) + EF Core SQLite + Microsoft.Playwright | Native Windows, easy for IT to support | Rewrite parsers in C# |
| C. Tauri + React/TS + SQLite, Node Playwright sidecar | Small, modern | Two languages, most build complexity |

Recommendation: **A** for v1. Decide early on multi-user: SQLite on a network share corrupts under concurrent writes — if more than one PC writes counts, run the app as a small LAN server on one PC (FastAPI + SQLite) or move to PostgreSQL.

## 7. Acceptance checks against the seeded DB

- `SELECT SUM(qty_on_site) FROM v_stock_on_hand` → 54 before any count.
- `v_tally_by_manufacturer` → HAIMER 37, MAPAL 9, CERATIZIT 7, KEMMLER 1.
- `v_gl_check` → exactly the 4 Haimer face mill arbors (deltas 17, 19, 19, 21 mm).
- On-site holders that fit a Ø12 shank → 13.
- `data_flags` → 31 (1 HIGH, 9 MEDIUM, 9 LOW, 12 INFO).
- Re-running the hyperMILL import on the same report creates no duplicates and no new opening balances.

## 8. Open decisions for the owner

1. GL convention for shell/face mill arbors in the catalogue (maker A vs hyperMILL A + spigot).
2. Locations to set up (crib, per-machine magazines, presetter, out for repair) and whether "at vendor" counts as on site.
3. Single PC or multi-user (drives the stack decision above).
4. Whether to load MAPAL MQL holders.
5. Ask Ceratizit and Sandvik reps for ISO 13399 / GTC data for HSK-A63 holders.
