-- =====================================================================
-- Holder Catalogue — SQLite schema (v1)
-- Interface scope: one row per physical catalogue article (manufacturer + order no.)
-- Stock is never stored on the holder row: it is the SUM of stock_transactions,
-- so every count, issue, scrap or purchase leaves an audit trail (AS9100 7.1.5 / 8.5.4 friendly).
-- =====================================================================
PRAGMA foreign_keys = ON;

-- ---------- reference tables ----------
CREATE TABLE IF NOT EXISTS manufacturers (
    manufacturer_id   INTEGER PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,          -- 'HAIMER', 'MAPAL', 'CERATIZIT', 'KEMMLER', 'SANDVIK COROMANT', 'CUTWEL'
    is_distributor    INTEGER NOT NULL DEFAULT 0,    -- 1 = reseller (Cutwel): part numbers are not maker order numbers
    website           TEXT,
    product_url_pattern TEXT,                        -- e.g. https://shop.mapal.com/en/p/0000000000{order_no}
    notes             TEXT
);

CREATE TABLE IF NOT EXISTS interfaces (            -- machine-side taper form ("the taper form I command")
    interface_code    TEXT PRIMARY KEY,              -- 'HSK-A63', later 'HSK-A100', 'BT40', 'CAT40'...
    standard          TEXT,                          -- 'DIN 69893-1 / ISO 12164-1 form A'
    flange_dia_mm     REAL
);

CREATE TABLE IF NOT EXISTS holder_types (
    type_code         TEXT PRIMARY KEY,              -- SHRINK, HYDRAULIC, ER_COLLET, PRECISION_COLLET, FACE_MILL_ARBOR, SCREW_IN, TAP_CHUCK, DRILL_CHUCK
    type_name         TEXT NOT NULL,
    clamping_principle TEXT,
    sort_order        INTEGER
);

-- ---------- catalogue ----------
CREATE TABLE IF NOT EXISTS holders (
    holder_id         TEXT PRIMARY KEY,              -- stable internal id, e.g. H0001
    manufacturer_id   INTEGER NOT NULL REFERENCES manufacturers(manufacturer_id),
    order_no          TEXT NOT NULL,                 -- maker order / article number, exactly as the maker prints it
    spec_code         TEXT,                          -- maker designation, e.g. MHC-HSK-A063-12-075-1-0-A
    product_name      TEXT,                          -- maker's product title
    series            TEXT,                          -- family, e.g. 'Power Mini Shrink Chuck', 'UNIQ DReaM Chuck 4.5°'
    type_code         TEXT NOT NULL REFERENCES holder_types(type_code),
    interface_code    TEXT NOT NULL REFERENCES interfaces(interface_code),

    -- clamping (tool side). Query "what fits a Ø d shank": clamp_min_mm <= d AND d <= clamp_max_mm
    clamp_dia_mm      REAL,                          -- nominal bore / spigot / thread size
    clamp_min_mm      REAL,
    clamp_max_mm      REAL,
    clamp_spec        TEXT,                          -- human text: 'ER16 0.5–10 mm', 'HG01 2–8 mm', 'M12 screw-in', 'M3–M12 taps'

    -- geometry
    gauge_length_mm   REAL,                          -- maker value: HSK gauge line to holder nose (A / l1 / LPR)
    gauge_length_ref  TEXT,                          -- which maker label it came from ('A', 'l1', 'LPR')
    cam_gl_mm         REAL,                          -- gauge length used in the hyperMILL holder model (may differ by convention)
    nose_dia_mm       REAL,                          -- front-most outer diameter (D2 / d2 / DLN / nut Ø) — collision relevant
    dims_json         TEXT,                          -- all other maker dimensions, label -> value (JSON)

    -- performance / options
    coolant           TEXT,
    balance           TEXT,
    max_rpm           INTEGER,
    mass_kg           REAL,

    -- media & links
    product_url       TEXT,
    image_url         TEXT,                          -- maker product photo (remote); app caches to /images/vendor/
    drawing_url       TEXT,
    cam_image         TEXT,                          -- hyperMILL holder profile PNG (local, images/cam/)

    -- CAM linkage
    cam_name          TEXT,                          -- holder name in hyperMILL tool DB
    cam_comment       TEXT,

    -- provenance
    data_status       TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (data_status IN ('verified','partial','distributor_only','catalogue_pdf','unverified')),
    data_source       TEXT,
    last_checked      TEXT,                          -- ISO date of last web/PDF check
    notes             TEXT,
    UNIQUE (manufacturer_id, order_no)
);
CREATE INDEX IF NOT EXISTS ix_holders_type  ON holders(type_code);
CREATE INDEX IF NOT EXISTS ix_holders_clamp ON holders(clamp_min_mm, clamp_max_mm);
CREATE INDEX IF NOT EXISTS ix_holders_gl    ON holders(gauge_length_mm);

-- data-quality / engineering flags raised against a holder (shown as warnings in the app)
CREATE TABLE IF NOT EXISTS data_flags (
    flag_id           INTEGER PRIMARY KEY,
    holder_id         TEXT REFERENCES holders(holder_id),
    severity          TEXT NOT NULL CHECK (severity IN ('HIGH','MEDIUM','LOW','INFO')),
    category          TEXT,                          -- 'CAM model', 'Naming', 'Data source', 'Gauge length'
    message           TEXT NOT NULL,
    action            TEXT,
    status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
    raised_on         TEXT,
    closed_on         TEXT,
    closed_by         TEXT,
    raised_by         TEXT,                          -- person or process that raised it ('hyperMILL import', 'vendor sync', a name)
    source            TEXT,                          -- 'build_catalogue', 'hyperMILL import', 'vendor sync', 'manual'
    close_note        TEXT                           -- what was done to close it (the auditor's question)
);

-- ---------- stock ----------
CREATE TABLE IF NOT EXISTS locations (
    location_id       INTEGER PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,          -- 'Tool crib', 'DMG cell 1 magazine', 'Out for regrind/repair'
    kind              TEXT CHECK (kind IN ('crib','machine','external','holding')),
    counts_as_on_site INTEGER NOT NULL DEFAULT 1     -- 0 for e.g. 'At vendor for repair' if you don't want it in the site tally
);

CREATE TABLE IF NOT EXISTS stock_transactions (
    txn_id            INTEGER PRIMARY KEY,
    holder_id         TEXT NOT NULL REFERENCES holders(holder_id),
    location_id       INTEGER NOT NULL REFERENCES locations(location_id),
    qty_delta         INTEGER NOT NULL,              -- +n received/found, -n scrapped/moved out
    txn_type          TEXT NOT NULL CHECK (txn_type IN
                      ('OPENING_BALANCE','COUNT_ADJUST','RECEIPT','MOVE_OUT','MOVE_IN','SCRAP','RETURN')),
    reference         TEXT,                          -- PO no., count sheet no., NCR no.
    txn_date          TEXT NOT NULL DEFAULT (date('now')),
    by_user           TEXT,
    note              TEXT,
    created_at        TEXT                           -- local timestamp the row was written (txn_date is the business date)
);
CREATE INDEX IF NOT EXISTS ix_txn_holder ON stock_transactions(holder_id);
CREATE INDEX IF NOT EXISTS ix_txn_location ON stock_transactions(location_id);

-- optional: individually serialised holders (balance/runout cert, presetter ID, chip)
CREATE TABLE IF NOT EXISTS holder_units (
    unit_id           TEXT PRIMARY KEY,              -- your etched/RFID number
    holder_id         TEXT NOT NULL REFERENCES holders(holder_id),
    location_id       INTEGER REFERENCES locations(location_id),
    serial_no         TEXT,
    runout_check_um   REAL,
    last_inspected    TEXT,
    status            TEXT DEFAULT 'IN_SERVICE' CHECK (status IN ('IN_SERVICE','QUARANTINE','SCRAPPED')),
    note              TEXT,
    inspected_by      TEXT
);

-- wish list / purchasing
CREATE TABLE IF NOT EXISTS wishlist (
    wish_id           INTEGER PRIMARY KEY,
    holder_id         TEXT NOT NULL REFERENCES holders(holder_id),
    qty_wanted        INTEGER NOT NULL DEFAULT 1,
    reason            TEXT,
    added_on          TEXT DEFAULT (date('now')),
    status            TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN','QUOTED','ORDERED','RECEIVED','CANCELLED')),
    added_by          TEXT,
    updated_on        TEXT
);

-- ---------- audit & app state (added by the desktop app, v2) ----------
-- Every change the app makes to a catalogue row (vendor sync, hyperMILL import, manual entry from a maker
-- catalogue) is logged field by field, so "who changed this gauge length, from what, on whose data" has an answer.
CREATE TABLE IF NOT EXISTS holder_changes (
    change_id         INTEGER PRIMARY KEY,
    holder_id         TEXT NOT NULL REFERENCES holders(holder_id),
    field             TEXT NOT NULL,                 -- column name, or '*' for an inserted row
    old_value         TEXT,
    new_value         TEXT,
    source            TEXT NOT NULL,                 -- 'vendor sync HAIMER', 'hyperMILL import', 'manual'
    reference         TEXT,                          -- URL, report path, catalogue page
    by_user           TEXT,
    changed_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_changes_holder ON holder_changes(holder_id);

-- One row per hyperMILL import / vendor sync / file import that was applied
CREATE TABLE IF NOT EXISTS import_runs (
    run_id            INTEGER PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('HYPERMILL','VENDOR','FILE')),
    source            TEXT,                          -- report path, maker name, file name
    interface_code    TEXT,
    run_at            TEXT NOT NULL,
    by_user           TEXT,
    summary_json      TEXT
);

-- Who changed what outside the stock ledger and the catalogue: locations, want-list lines, serialised units
-- (each runout inspection is an INSPECT event with the measured value and the result).
CREATE TABLE IF NOT EXISTS audit_events (
    event_id          INTEGER PRIMARY KEY,
    entity            TEXT NOT NULL,                 -- 'location', 'wishlist', 'unit'
    entity_id         TEXT NOT NULL,
    action            TEXT NOT NULL,                 -- 'ADD', 'EDIT', 'DELETE', 'STATUS', 'INSPECT', 'NOTE'
    detail_json       TEXT,
    by_user           TEXT,
    at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_events(entity, entity_id);

-- Retry-safe bookings: a dialog sends the same Idempotency-Key on every attempt, so a resend after a network
-- error returns the first result instead of booking twice. Kept for a week.
CREATE TABLE IF NOT EXISTS request_keys (
    key               TEXT PRIMARY KEY,
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    status            INTEGER NOT NULL,
    body_json         TEXT,
    at                TEXT NOT NULL
);

-- Small key/value store for settings that belong with the data (people who book counts, inspection interval)
CREATE TABLE IF NOT EXISTS app_settings (
    key               TEXT PRIMARY KEY,
    value             TEXT
);

-- ---------- views (the tally) ----------
CREATE VIEW IF NOT EXISTS v_stock_by_location AS
SELECT t.holder_id, l.name AS location, l.counts_as_on_site,
       SUM(t.qty_delta) AS qty
FROM stock_transactions t JOIN locations l USING (location_id)
GROUP BY t.holder_id, l.location_id
HAVING SUM(t.qty_delta) <> 0;

CREATE VIEW IF NOT EXISTS v_stock_on_hand AS
SELECT h.holder_id,
       COALESCE((SELECT SUM(t.qty_delta) FROM stock_transactions t
                 JOIN locations l USING (location_id)
                 WHERE t.holder_id = h.holder_id AND l.counts_as_on_site = 1), 0) AS qty_on_site
FROM holders h;

CREATE VIEW IF NOT EXISTS v_catalogue AS
SELECT h.holder_id, m.name AS manufacturer, h.order_no, h.spec_code, h.series,
       ht.type_name AS holder_type, h.interface_code,
       h.clamp_dia_mm, h.clamp_min_mm, h.clamp_max_mm, h.clamp_spec,
       h.gauge_length_mm, h.cam_gl_mm, h.nose_dia_mm,
       h.coolant, h.balance, h.max_rpm, h.mass_kg,
       h.product_url, h.image_url, h.cam_image, h.cam_name, h.data_status,
       s.qty_on_site,
       (SELECT COUNT(*) FROM data_flags f WHERE f.holder_id = h.holder_id AND f.status='OPEN') AS open_flags
FROM holders h
JOIN manufacturers m USING (manufacturer_id)
JOIN holder_types ht USING (type_code)
JOIN v_stock_on_hand s USING (holder_id);

CREATE VIEW IF NOT EXISTS v_tally_by_type AS
SELECT ht.sort_order, ht.type_name AS holder_type,
       COUNT(CASE WHEN s.qty_on_site > 0 THEN 1 END) AS articles_on_site,
       COALESCE(SUM(s.qty_on_site),0)                 AS holders_on_site
FROM holder_types ht
LEFT JOIN holders h USING (type_code)
LEFT JOIN v_stock_on_hand s USING (holder_id)
GROUP BY ht.type_code ORDER BY ht.sort_order;

CREATE VIEW IF NOT EXISTS v_tally_by_manufacturer AS
SELECT m.name AS manufacturer,
       COUNT(CASE WHEN s.qty_on_site > 0 THEN 1 END) AS articles_on_site,
       COALESCE(SUM(s.qty_on_site),0)                 AS holders_on_site,
       COUNT(h.holder_id)                             AS articles_in_catalogue
FROM manufacturers m
LEFT JOIN holders h USING (manufacturer_id)
LEFT JOIN v_stock_on_hand s USING (holder_id)
GROUP BY m.manufacturer_id ORDER BY holders_on_site DESC;

CREATE VIEW IF NOT EXISTS v_tally_by_clamp AS          -- fixed-bore holders by clamp Ø
SELECT h.clamp_dia_mm, ht.type_name AS holder_type, SUM(s.qty_on_site) AS holders_on_site
FROM holders h JOIN holder_types ht USING (type_code) JOIN v_stock_on_hand s USING (holder_id)
WHERE s.qty_on_site > 0 AND h.clamp_min_mm = h.clamp_max_mm
GROUP BY h.clamp_dia_mm, ht.type_code ORDER BY h.clamp_dia_mm;

-- Count status per holder:
--  'unverified' while any of its hyperMILL opening balance is still waiting at "Unassigned – count required"
--               (the holder has not been located yet — a count of 0 at ONE location doesn't settle that: it may be
--               in another magazine);
--  'counted'    once it has a physical count and nothing is left waiting at Unassigned (found, or written off by
--               counting 0 at Unassigned itself);
--  'booked'     on site through receipts etc., not counted yet;
--  'none'       not on site (never booked, or everything booked has gone out again).
CREATE VIEW IF NOT EXISTS v_count_status AS
SELECT x.holder_id, x.has_opening, x.has_count, x.last_count_date, x.qty_unassigned,
       CASE WHEN x.has_opening = 1 AND x.qty_unassigned > 0 THEN 'unverified'
            WHEN x.has_count = 1 THEN 'counted'
            WHEN x.has_any = 1 AND x.qty_on_site > 0 THEN 'booked'
            ELSE 'none' END AS count_status
FROM (SELECT h.holder_id,
             EXISTS (SELECT 1 FROM stock_transactions t WHERE t.holder_id = h.holder_id AND t.txn_type = 'OPENING_BALANCE') AS has_opening,
             EXISTS (SELECT 1 FROM stock_transactions t WHERE t.holder_id = h.holder_id AND t.txn_type = 'COUNT_ADJUST')    AS has_count,
             EXISTS (SELECT 1 FROM stock_transactions t WHERE t.holder_id = h.holder_id)                                    AS has_any,
             (SELECT MAX(t.txn_date) FROM stock_transactions t WHERE t.holder_id = h.holder_id AND t.txn_type = 'COUNT_ADJUST') AS last_count_date,
             COALESCE((SELECT SUM(t.qty_delta) FROM stock_transactions t JOIN locations l USING (location_id)
                       WHERE t.holder_id = h.holder_id AND l.name = 'Unassigned – count required'), 0) AS qty_unassigned,
             COALESCE((SELECT SUM(t.qty_delta) FROM stock_transactions t JOIN locations l USING (location_id)
                       WHERE t.holder_id = h.holder_id AND l.counts_as_on_site = 1), 0) AS qty_on_site
      FROM holders h) x;

CREATE VIEW IF NOT EXISTS v_tally_by_location AS
SELECT l.location_id, l.name AS location, l.kind, l.counts_as_on_site,
       COUNT(CASE WHEN q.qty > 0 THEN 1 END) AS articles,
       COALESCE(SUM(CASE WHEN q.qty > 0 THEN q.qty END), 0) AS holders
FROM locations l
LEFT JOIN (SELECT holder_id, location_id, SUM(qty_delta) AS qty FROM stock_transactions GROUP BY holder_id, location_id) q
       ON q.location_id = l.location_id
GROUP BY l.location_id ORDER BY l.location_id;

CREATE VIEW IF NOT EXISTS v_gl_check AS                -- maker GL vs hyperMILL GL
SELECT holder_id, order_no, gauge_length_mm, cam_gl_mm, cam_gl_mm - gauge_length_mm AS delta_mm
FROM holders WHERE cam_gl_mm IS NOT NULL AND gauge_length_mm IS NOT NULL AND cam_gl_mm <> gauge_length_mm;
