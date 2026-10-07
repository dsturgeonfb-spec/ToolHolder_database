# Holder Catalogue

Windows app for a CNC shop's tool-holder catalogue and stock tally (HSK-A63 first; any taper form later).

- Read `BUILD_SPEC.md` before changing anything — it holds the requirements, data rules, vendor adapter notes and acceptance checks.
- `db/schema.sql` is the source of truth for the data model. Stock is always the sum of `stock_transactions`; never add a quantity column to `holders`.
- Rebuild seed data: `python scripts/build_catalogue.py . && python scripts/make_page.py .`
- Vendor data: only values read from the maker's page or catalogue go into `holders`; record `data_status`, `data_source`, `last_checked`. Don't scrape sites that block automated access (Ceratizit returns 403).
- Gauge length = maker value from the HSK gauge line (flange face) to the holder nose; hyperMILL's value goes in `cam_gl_mm`.
