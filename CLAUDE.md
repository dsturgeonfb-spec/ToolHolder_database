# Holder Catalogue

Windows app for a CNC shop's tool-holder catalogue and stock tally (HSK-A63 first; any taper form later).

- Read `BUILD_SPEC.md` before changing anything — it holds the requirements, data rules, vendor adapter notes and acceptance checks.
- `db/schema.sql` is the source of truth for the data model. Stock is always the sum of `stock_transactions`; never add a quantity column to `holders`.
- Rebuild seed data: `python scripts/build_catalogue.py . && python scripts/make_page.py .`
- Vendor data: only values read from the maker's page or catalogue go into `holders`; record `data_status`, `data_source`, `last_checked`. Don't scrape sites that block automated access (Ceratizit returns 403).
- Gauge length = maker value from the HSK gauge line (flange face) to the holder nose; hyperMILL's value goes in `cam_gl_mm`.

## The app

- Electron desktop app; the server (`src/server/`) runs in-process and also standalone (`node dist/src/server/standalone.js`). Architecture, routes and module ownership: `docs/API.md`.
- Database access through `src/server/db.ts` (`node:sqlite`, no native modules). Schema changes: edit `db/schema.sql`; a new column on an existing table also goes in `ADDED_COLUMNS` in `db.ts`. Views are recreated on every start.
- Shared rules live in `src/server/domain.ts` (`postTransaction`, `raiseFlag`, `logChange`, `requireUser`…) — use them, don't re-implement stock or flag logic in a module.
- Every write needs a person (`requireUser(req.user)`); every catalogue field change is logged in `holder_changes` with its source.
- Build/test: `npm run build`, `npm test` (unit/API incl. the §7 acceptance checks, then Chromium e2e), `xvfb-run -a npm run test:electron`. The Windows installer is built by `.github/workflows/desktop-release.yml`.
