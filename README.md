# Holder Catalogue

Windows desktop app for the shop's tool-holder catalogue and stock tally — HSK-A63 first, any
taper form later. It keeps the catalogue of holders on site and available to buy, books physical
counts and movements as an audit trail, totals the tally, tracks data issues between hyperMILL and
the makers' data, imports the hyperMILL holder report, and pulls maker data on command.

Requirements, data rules and acceptance checks: [`BUILD_SPEC.md`](BUILD_SPEC.md). Architecture and
API contract: [`docs/API.md`](docs/API.md).

## Install (shop PC)

1. Get `Holder-Catalogue-Setup-<version>.exe`:
   - from the repository's **Releases** page, or
   - from the latest **Desktop release** run under **Actions** (artifact `holder-catalogue-installer`).
2. Run it. It installs for the current user — no admin rights, no UAC prompt — and adds a desktop
   and Start-menu shortcut.
3. First start creates the data folder **`C:\Holder Catalogue`** (fallback
   `%LOCALAPPDATA%\Holder Catalogue` if C:\ is locked down) and copies in the seeded catalogue:
   88 HSK-A63 articles, 54 on site at an *unverified* opening balance of 1, 31 data issues.

Uninstalling removes the program only; the data folder is the shop's record and is left alone.

## Using it

| Screen | What for |
|---|---|
| **Catalogue** | Find a holder: on site / can buy / all, maker, type, *fits shank Ø*, issues, search. Profile, clamp, gauge length (to scale), nose Ø, qty. |
| **Holder** | Everything about one article: maker dimensions, links, stock by location with receipt / move / scrap / return, history, issues, serialised units, change log. |
| **Count** | Tool-crib counting: pick a location, step through holders, confirm each count. Every count is a dated transaction with your name; the first count replaces the hyperMILL opening balance. |
| **Tally** | Totals by type, maker, clamp Ø, location; counted vs. unverified; GL check (maker vs hyperMILL); CSV / Excel export. |
| **Issues** | Data flags (HIGH → INFO), close with what was done; hyperMILL write-back list for the CAM engineer. |
| **Want list** | Holders to buy → RFQ per maker (CSV, Excel, printable). |
| **Serialised** | Individually numbered holders: runout checks, inspection due dates, quarantine. |
| **hyperMILL** | Import the tool-database HTML report (`C:\Users\Public\Documents\OPEN MIND\tooldbReport\…`): preview, then apply. Never deletes. |
| **Vendors** | Scan a maker for your taper form, review the differences, approve what goes in. Manual (file) route for makers that block automated access. |
| **Log** | The stock ledger — every transaction, who, when, reference. |
| **Settings** | Names, locations, network sharing, backups, vendor contact. |

**Who's booking** (top right): every change is recorded against a name.

### Several PCs or a tablet in the crib

Turn on **Settings → Share on network** on the PC that has the data. Other devices open the address
shown (e.g. `http://192.168.1.20:8763`) in a browser and sign in with the PIN and their name. Only the
host PC writes the database, so it can't be corrupted by two writers — never put the data folder on a
network share and open it from two PCs.

### Backups

A backup is written to `<data folder>\backups` the first time the app runs each day (newest 30 kept), and
on demand from **File → Back up now** or Settings. Make sure that folder is included in the shop's server
backup. Restore steps are in Settings → Data & backups.

## Development

Requires Node 22.13+ (for `node:sqlite`).

```bash
npm ci
npm run serve          # http://127.0.0.1:8763 in a browser, data in ./.devdata
npm start              # the Electron app (data in C:\Holder Catalogue or ~/Holder Catalogue)
npm test               # typecheck+build, unit/API tests (incl. BUILD_SPEC §7 acceptance), browser tests
npm run test:electron  # launches the desktop app (Linux: xvfb-run -a npm run test:electron)
npm run package:win    # Windows installer into release/ (CI does this on windows-latest)
```

`HOLDER_CATALOGUE_DATA=<folder>` points the app at another data folder (tests, training copy).

Rebuild the seed data from the raw inputs: `python scripts/build_catalogue.py . && python scripts/make_page.py .`

### Releasing

1. Bump `version` in `package.json` and head `release-notes.md` with `# Holder Catalogue <version>`.
2. Push a tag `desktop-v<version>` — or run the **Desktop release** workflow on the default branch with
   *release* ticked. The workflow builds the installer on Windows, smoke-tests the packaged app, and
   publishes it as a GitHub Release.

### Layout

```
src/server/        app server: db (node:sqlite), http router, domain rules, modules/*, hypermill/, vendors/
src/main/          Electron main process + preload
ui/                the UI (vanilla JS modules, no build step)
db/                schema.sql (source of truth) + the seeded holder_catalogue.sqlite
images/cam/        hyperMILL holder profiles for the seeded holders
data/, scripts/    the catalogue's raw inputs and the Python build scripts
test/              unit, api, e2e (Chromium), electron smoke tests
```
