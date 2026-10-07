"""Build the HSK-A63 holder catalogue: merge hyperMILL on-site holders + vendor enrichment
+ MAPAL UNIQ PDF range into holders.csv / holders.json and a seeded SQLite DB.

Usage:  python build_catalogue.py <catalogue_root>
Inputs  (<root>/data/raw):  cam_holders_hypermill.json, haimer_shrink.json,
        haimer_other_kemmler.json, ceratizit_mapal.json, mapal_uniq_2025_text.txt
Outputs: <root>/data/holders.csv, holders.json, data_flags.csv, <root>/db/holder_catalogue.sqlite
"""
import csv, json, re, sqlite3, sys, os, datetime

ROOT = sys.argv[1]
RAW = os.path.join(ROOT, "data", "raw")
TODAY = datetime.date.today().isoformat()
load = lambda f: json.load(open(os.path.join(RAW, f), encoding="utf-8"))

cam = load("cam_holders_hypermill.json")
enrich = {}
for f in ("haimer_shrink.json", "haimer_other_kemmler.json", "ceratizit_mapal.json"):
    for r in load(f):
        enrich[r["order_no"]] = r

# ---------------------------------------------------------------- MAPAL UNIQ PDF (HSK-A63 rows)
uniq = {}
fam = "UNIQ Mill Chuck, HA"
for line in open(os.path.join(RAW, "mapal_uniq_2025_text.txt"), encoding="utf-8"):
    title = line.strip()   # table titles only — the intro pages also mention both families
    if title == "UNIQ® Mill Chuck, HA":
        fam = "UNIQ Mill Chuck, HA"
    elif title == "UNIQ® DReaM Chuck, 4.5°" or title.startswith("UNIQ DReaM Chuck, 4.5° |"):
        fam = "UNIQ DReaM Chuck, 4.5°"
    m = re.match(r"\s*63\s+(.*?)\s+(MHC-HSK-A063-[\w-]+)\s+(\d{8})\s*$", line)
    if not m:
        continue
    nums = m.group(1).split()
    # columns: d1 d2 d3 l1 l2 l3 l4 G torque
    d1, d2, d3, l1, l2, l3, l4 = (float(x.replace(",", ".")) for x in nums[:7])
    g, torque = nums[7], int(nums[8])
    uniq[m.group(3)] = dict(series=fam, spec_code=m.group(2), d1=d1, d2=d2, d3=d3, l1=l1,
                            dims={"d1": d1, "d2": d2, "d3": d3, "l1": l1, "l2": l2, "l3": l3, "l4": l4,
                                  "G (length adj. thread)": g, "Torque transmittable [Nm]": torque})
assert len(uniq) == 38, len(uniq)

# ---------------------------------------------------------------- helpers
def order_from_cam(name):
    m = re.search(r"\bA63\.[0-9]+(?:\.[0-9A-Z]+)*", name)
    if m:
        return m.group(0)
    m = re.search(r"\b(\d{8})\b", name)
    return m.group(1) if m else None

def maker_from_cam(name):
    for mk in ("HAIMER", "KEMMLER", "CERATIZIT", "MAPAL"):
        if mk in name.upper():
            return mk
    raise ValueError(name)

def classify(maker, order, rec):
    """-> (type_code, series)"""
    o = order
    if maker == "HAIMER":
        if o.startswith(("A63.050.", "A63.051.")): return "FACE_MILL_ARBOR", "Face Mill Arbor (KKB = coolant bores)"
        if o.startswith("A63.020."):  return "ER_COLLET", "Collet Chuck Type ER"
        if o.startswith("A63.022."):  return "ER_COLLET", "Power Collet Chuck"
        if o.startswith("A63.120."):  return "PRECISION_COLLET", "High-Precision Chuck (HG collets)"
        if o.startswith(("A63.182.", "A63.184.")): return "SHRINK", "Power Mini Shrink Chuck"
        if o.startswith("A63.145."):  return "SHRINK", "Power Shrink Chuck – ultra short (Cool Jet)"
        if o.startswith("A63.144.") and o.endswith(".3"): return "SHRINK", "Power Shrink Chuck – long ZG130 (Cool Jet)"
        if o.startswith("A63.144."):  return "SHRINK", "Shrink Fit Chuck Standard – long ZG130"
        if o == "A63.140.20.6":       return "SHRINK", "Heavy Duty Shrink Chuck"
        if o in ("A63.140.03", "A63.140.04"): return "SHRINK", "Shrink Fit Chuck Standard – short, with slits"
        if o.startswith("A63.140."):  return "SHRINK", "Shrink Fit Chuck Standard – short"
    if maker == "KEMMLER":   return "SCREW_IN", "Milling arbor for screw-in cutters"
    if maker == "CERATIZIT":
        if o == "83724612":  return "TAP_CHUCK", "Synchro Quick-Change Tapping Chuck (min. length comp.)"
        return "ER_COLLET", "Centro-P precision collet chuck" + (" – slim" if ".SF.ER11" in (rec.get("spec_code") or "") or ".SF.ER16" in (rec.get("spec_code") or "") else "")
    if maker == "MAPAL":
        if o in uniq:        return "HYDRAULIC", uniq[o]["series"]
        if o in ("30259875", "30259879"): return "DRILL_CHUCK", "Precision-DrillChuck"
        return "HYDRAULIC", "HighTorque Chuck HTC – short heavy design"
    raise ValueError((maker, o))

def num(x):
    if x is None: return None
    if isinstance(x, (int, float)): return float(x)
    m = re.search(r"\d+(?:[.,]\d+)?", str(x))
    return float(m.group(0).replace(",", ".")) if m else None

NOSE_KEYS = ("D2 Diameter 2", "D2 diameter (collar)", "D clamping nut diameter", "D diameter",
             "BD1 body diameter 1", "DLN (diameter lock nut)", "BD_1 (body diameter, 1st cutting step)", "d2")
def nose_dia(diams):
    for k in NOSE_KEYS:
        if diams and k in diams and num(diams[k]) is not None:
            return num(diams[k])
    return None

def clamp_range(rec, type_code, clamp_dia):
    if type_code in ("SHRINK", "HYDRAULIC", "FACE_MILL_ARBOR"):
        return clamp_dia, clamp_dia
    if type_code in ("SCREW_IN", "TAP_CHUCK"):
        return None, None
    cr = rec.get("clamp_range_mm")
    if isinstance(cr, dict):
        return cr.get("min"), cr.get("max")
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*mm", rec.get("clamp_spec") or "")
    if m:
        return float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", "."))
    return None, None

SHORT_SPEC = {  # concise operator-facing clamp text
    "A63.020.16": "ER16 · 0.5–10 mm", "A63.020.32": "ER32 · 1.5–20 mm",
    "A63.022.16.3": "ER16 · 2–10 mm", "A63.022.32.3": "ER32 · 2–20 mm",
    "A63.120.01": "HG01 collet · 2–8 mm (h6)", "A63.120.02": "HG02 collet · 10–14 mm (h6)",
    "A63.06.12.3": "M12 screw-in thread", "83724612": "Taps M3–M12 · QC size 1",
    "84719607": "ER11 · 1–7 mm", "84719707": "ER11 · 1–7 mm", "84719608": "ER11 · 1–7 mm",
    "84719810": "ER16 · 1–10 mm", "84719910": "ER16 · 1–10 mm", "84722621": "ER32 · 2–20 mm",
    "30259875": "Drill chuck · 0.5–13 mm", "30259879": "Drill chuck · 2.5–16 mm",
}

# ---------------------------------------------------------------- build on-site records
holders = []
for i, c in enumerate(cam, start=1):
    maker = maker_from_cam(c["cam_name"])
    order = order_from_cam(c["cam_name"])
    rec = enrich.get(order, {})
    tcode, series = classify(maker, order, rec)
    gl_cam = num(re.search(r"(\d+)GL", c["cam_name"]).group(1))
    h = dict(holder_id=f"H{i:04d}", manufacturer=maker, order_no=order, interface_code="HSK-A63",
             type_code=tcode, series=series, cam_name=c["cam_name"].replace("(HSK63) ", ""),
             cam_comment=c["cam_comment"] or None, cam_gl_mm=gl_cam, cam_image=f"images/cam/{c['cam_image']}",
             on_site=True)
    if order in uniq:  # MAPAL UNIQ — use the catalogue PDF (authoritative, full dims)
        u = uniq[order]
        h.update(spec_code=u["spec_code"], product_name=u["series"], clamp_dia_mm=u["d1"],
                 gauge_length_mm=u["l1"], gauge_length_ref="l1", nose_dia_mm=u["d2"], dims_json=u["dims"],
                 coolant="Central through-coolant", balance="G2.5 at 25,000 rpm (as delivered)",
                 product_url=f"https://shop.mapal.com/en/p/0000000000{order}",
                 data_status="catalogue_pdf", data_source="MAPAL UNIQ 2025 catalogue (project PDF) + shop.mapal.com")
    else:
        dims = dict(rec.get("diameters") or {}); dims.update(rec.get("other_dims") or {})
        h.update(spec_code=rec.get("spec_code"),
                 product_name=rec.get("haimer_product_name") or rec.get("product_name"),
                 clamp_dia_mm=num(rec.get("clamp_dia_mm")) if tcode not in ("ER_COLLET", "PRECISION_COLLET", "DRILL_CHUCK", "TAP_CHUCK") else None,
                 gauge_length_mm=num(rec.get("gauge_length_mm")),
                 gauge_length_ref=rec.get("gauge_length_label") or "A",
                 nose_dia_mm=nose_dia(rec.get("diameters")), dims_json=dims,
                 coolant=rec.get("coolant"), balance=rec.get("balancing"),
                 max_rpm=int(rec["max_rpm"]) if rec.get("max_rpm") else None,
                 mass_kg=num(rec.get("mass_kg")),
                 product_url=rec.get("product_url"), image_url=rec.get("image_url"),
                 drawing_url=rec.get("drawing_url"),
                 data_status=rec.get("status", "unverified"),
                 data_source=rec.get("source") or ("shop.haimer.com" if maker == "HAIMER" else "kemmler-shop.de / camcut-group.com" if maker == "KEMMLER" else None))
        if maker == "MAPAL":
            h["product_url"] = f"https://shop.mapal.com/en/p/0000000000{order}"
        if maker == "HAIMER" and tcode == "FACE_MILL_ARBOR":
            h["clamp_dia_mm"] = num(rec.get("clamp_dia_mm"))
    if tcode == "SCREW_IN":
        h["clamp_dia_mm"] = 12.0
    h["clamp_min_mm"], h["clamp_max_mm"] = clamp_range(rec, tcode, h.get("clamp_dia_mm"))
    if tcode == "SHRINK" or tcode == "HYDRAULIC" or tcode == "FACE_MILL_ARBOR":
        h["clamp_spec"] = (f"Spigot Ø{h['clamp_dia_mm']:g} mm" if tcode == "FACE_MILL_ARBOR"
                           else f"Ø{h['clamp_dia_mm']:g} mm shank (h6)")
    else:
        h["clamp_spec"] = SHORT_SPEC.get(order, rec.get("clamp_spec"))
    h["last_checked"] = TODAY
    h["notes"] = rec.get("notes")
    holders.append(h)

on_site_orders = {h["order_no"] for h in holders}

# ---------------------------------------------------------------- MAPAL UNIQ range not on site (purchase catalogue)
n = len(holders)
for order, u in uniq.items():
    if order in on_site_orders:
        continue
    n += 1
    holders.append(dict(holder_id=f"H{n:04d}", manufacturer="MAPAL", order_no=order, interface_code="HSK-A63",
        type_code="HYDRAULIC", series=u["series"], spec_code=u["spec_code"], product_name=u["series"],
        clamp_dia_mm=u["d1"], clamp_min_mm=u["d1"], clamp_max_mm=u["d1"], clamp_spec=f"Ø{u['d1']:g} mm shank (h6)",
        gauge_length_mm=u["l1"], gauge_length_ref="l1", cam_gl_mm=None, nose_dia_mm=u["d2"], dims_json=u["dims"],
        coolant="Central through-coolant", balance="G2.5 at 25,000 rpm (as delivered)",
        product_url=f"https://shop.mapal.com/en/p/0000000000{order}", data_status="catalogue_pdf",
        data_source="MAPAL UNIQ 2025 catalogue (project PDF)", last_checked=TODAY, on_site=False,
        cam_name=None, cam_comment=None, cam_image=None))

# ---------------------------------------------------------------- data flags
by_order = {h["order_no"]: h["holder_id"] for h in holders}
F = []
def flag(order, sev, cat, msg, action):
    F.append(dict(holder_id=by_order.get(order) if order else None, severity=sev, category=cat,
                  message=msg, action=action))

flag("84719607", "HIGH", "CAM model",
     "hyperMILL coupling on this HSK-A63 holder is 'adaptor / top / SPINDLE 40TAPER' — wrong interface class (all other holders are 'unknown').",
     "Correct the top coupling in the hyperMILL holder so it can't be assembled to a 40-taper spindle definition.")
for o, wrong in (("A63.140.08", 90), ("A63.140.10", 90)):
    gl = next(h["gauge_length_mm"] for h in holders if h["order_no"] == o)
    flag(o, "MEDIUM", "Gauge length",
         f"hyperMILL comment says {wrong}GL; Haimer and the hyperMILL holder name both say {gl:g} mm.",
         f"Fix the comment, and confirm the holder geometry in hyperMILL is the {gl:g} mm one.")
for o in ("A63.050.16.KKB", "A63.050.22.KKB", "A63.051.22.KKB", "A63.051.27.KKB"):
    hh = next(h for h in holders if h["order_no"] == o)
    flag(o, "MEDIUM", "Gauge length",
         f"Convention difference: Haimer A = {hh['gauge_length_mm']:g} mm to the cutter seating face; hyperMILL GL = {hh['cam_gl_mm']:g} mm = A + spigot length.",
         "Confirm which face hyperMILL references the shell mill from; a mismatch puts holder clearance checks out by the spigot length (17–21 mm).")
for o in ("A63.120.01", "A63.120.02"):
    flag(o, "MEDIUM", "Naming",
         "Both HG chucks share the description 'HIGH-PRECISION COLLET CHUCK 120GL'. They take HAIMER HG collets (not ER): A63.120.01 = HG01 2–8 mm, A63.120.02 = HG02 10–14 mm.",
         "Rename in hyperMILL to include HG01 / HG02 and the clamping range.")
flag("83724612", "MEDIUM", "Naming",
     "hyperMILL calls this 'QC TAP CHUCK CLUTCHED'; Ceratizit lists it as a Synchro quick-change tapping chuck with minimum length compensation — no torque clutch listed.",
     "Rename; don't rely on it for tap overload protection. Rigid/synchronised tap cycle required.")
for o in ("A63.145.06.3", "A63.145.08.3", "A63.145.12.3", "A63.145.20.3"):
    flag(o, "LOW", "Naming", "hyperMILL 'SHORT SHRINK' is HAIMER's Power Shrink Chuck, ultra-short, with Cool Jet.",
         "Rename to POWER SHRINK ULTRA SHORT.")
flag("30259875", "LOW", "Naming", "hyperMILL comment says 0.5–12 mm; MAPAL lists 0.5–13 mm (MPC-HSK-A063-13-110).", "Update comment.")
flag("84719608", "LOW", "Data source", "Distributor lists LSCX 68 mm — identical to the 100 mm version 84719607; looks copied.", "Check against Ceratizit catalogue / drawing.")
flag("84719707", "LOW", "Data source", "Spec code contains '.22.' but listed nose Ø is 16 mm.", "Measure nose Ø; it matters for collision checking.")
flag("A63.140.03", "LOW", "Naming", "hyperMILL comment omits 'SLIT' (Haimer: with slits).", "Update comment.")
flag("A63.050.22.KKB", "LOW", "Naming", "hyperMILL comment has a typo: 'A63-050-22-KKB.KKB'.", "Update comment.")
flag("A63.140.04", "INFO", "Data source", "Haimer variant page 404 — D2, L, mass not captured (A 80 mm confirmed from variant table).", "App scraper / manual check.")
for o in ("84719607", "84719707", "84719810", "84719608", "84719910", "84722621", "83724612"):
    flag(o, "INFO", "Data source", "Ceratizit site blocks automated access (403); data taken from distributor Zedaro, which quotes the Ceratizit article no.", "Confirm against Ceratizit catalogue or ISO 13399 data from rep.")
flag("30524702", "INFO", "Purchasing", "MAPAL shop also lists 30655666 with the same spec code HTC-HSK-A063-12-080 (different drawing no.).", "Confirm current order no. with MAPAL before reordering.")
flag("30490553", "INFO", "Purchasing", "MAPAL shop also lists 30655668 with the same spec code HTC-HSK-A063-20-080 (different drawing no.).", "Confirm current order no. with MAPAL before reordering.")
flag("30588142", "INFO", "CAM model", "No comment in hyperMILL holder.", "Add spec code HTC-HSK-A063-32-105-1-0-A.")
flag("A63.06.12.3", "INFO", "Data source", "Kemmler table doesn't print LPR 126 / M12; taken from distributor Camcut, consistent with Kemmler's product title.", "None — consistent.")

for i, f in enumerate(F, 1):
    f.update(flag_id=i, status="OPEN", raised_on=TODAY)

# ---------------------------------------------------------------- write CSV / JSON
COLS = ["holder_id", "on_site", "manufacturer", "order_no", "spec_code", "product_name", "series", "type_code",
        "interface_code", "clamp_dia_mm", "clamp_min_mm", "clamp_max_mm", "clamp_spec", "gauge_length_mm",
        "gauge_length_ref", "cam_gl_mm", "nose_dia_mm", "coolant", "balance", "max_rpm", "mass_kg",
        "product_url", "image_url", "drawing_url", "cam_image", "cam_name", "cam_comment", "data_status",
        "data_source", "last_checked", "dims_json", "notes"]
os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
with open(os.path.join(ROOT, "data", "holders.csv"), "w", newline="", encoding="utf-8-sig") as fh:
    w = csv.DictWriter(fh, COLS); w.writeheader()
    for h in holders:
        row = {k: h.get(k) for k in COLS}
        row["dims_json"] = json.dumps(h.get("dims_json") or {}, ensure_ascii=False)
        w.writerow(row)
json.dump(holders, open(os.path.join(ROOT, "data", "holders.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
with open(os.path.join(ROOT, "data", "data_flags.csv"), "w", newline="", encoding="utf-8-sig") as fh:
    w = csv.DictWriter(fh, ["flag_id", "holder_id", "severity", "category", "message", "action", "status", "raised_on"])
    w.writeheader(); [w.writerow({k: f.get(k) for k in w.fieldnames}) for f in F]

# ---------------------------------------------------------------- SQLite
dbp = os.path.join(ROOT, "db", "holder_catalogue.sqlite")
if os.path.exists(dbp): os.remove(dbp)
db = sqlite3.connect(dbp)
db.executescript(open(os.path.join(ROOT, "db", "schema.sql"), encoding="utf-8").read())
MK = [("HAIMER", 0, "https://shop.haimer.com", "https://shop.haimer.com/en/<slug>/{order_no}", "Static product pages; robots crawl-delay 10 s"),
      ("MAPAL", 0, "https://shop.mapal.com", "https://shop.mapal.com/en/p/0000000000{order_no}", "UNIQ PDF in project; shop listings server-rendered"),
      ("CERATIZIT", 0, "https://cuttingtools.ceratizit.com", None, "Site returns 403 to automated access — use PDF / ISO 13399 from rep"),
      ("KEMMLER", 0, "https://www.kemmler-shop.de", "https://www.kemmler-shop.de/search?search={order_no}", "Static product pages; free DXF/STP"),
      ("SANDVIK COROMANT", 0, "https://www.sandvik.coromant.com", None, "JS site — ISO 13399/GTC via CoroPlus, or Playwright"),
      ("CUTWEL", 1, "https://www.cutwel.co.uk", None, "UK distributor — own SKUs; JS product grid")]
db.executemany("INSERT INTO manufacturers(name,is_distributor,website,product_url_pattern,notes) VALUES (?,?,?,?,?)", MK)
db.execute("INSERT INTO interfaces VALUES ('HSK-A63','DIN 69893-1 / ISO 12164-1 form A, size 63',63)")
TYPES = [("SHRINK", "Shrink fit chuck", "Thermal interference fit", 1), ("HYDRAULIC", "Hydraulic expansion chuck", "Hydraulic expansion sleeve", 2),
         ("ER_COLLET", "ER collet chuck", "ER collet (ISO 15488)", 3), ("PRECISION_COLLET", "High-precision collet chuck", "Proprietary collet (HAIMER HG)", 4),
         ("FACE_MILL_ARBOR", "Face / shell mill arbor", "Spigot + drive keys + bolt", 5), ("SCREW_IN", "Screw-in cutter holder", "Threaded (modular heads)", 6),
         ("TAP_CHUCK", "Tapping chuck", "Quick-change tap adaptor", 7), ("DRILL_CHUCK", "Drill chuck", "Keyless jaw chuck", 8)]
db.executemany("INSERT INTO holder_types VALUES (?,?,?,?)", TYPES)
mid = dict(db.execute("SELECT name, manufacturer_id FROM manufacturers"))
HCOLS = [c for c in COLS if c not in ("on_site", "manufacturer")]
for h in holders:
    vals = [mid[h["manufacturer"]]] + [json.dumps(h.get("dims_json") or {}, ensure_ascii=False) if c == "dims_json" else h.get(c) for c in HCOLS]
    db.execute(f"INSERT INTO holders(manufacturer_id,{','.join(HCOLS)}) VALUES ({','.join('?'*(len(HCOLS)+1))})", vals)
db.executemany("INSERT INTO data_flags(flag_id,holder_id,severity,category,message,action,status,raised_on) VALUES (?,?,?,?,?,?,?,?)",
               [(f["flag_id"], f["holder_id"], f["severity"], f["category"], f["message"], f["action"], f["status"], f["raised_on"]) for f in F])
db.executemany("INSERT INTO locations(name,kind,counts_as_on_site) VALUES (?,?,?)",
               [("Unassigned – count required", "holding", 1), ("Tool crib", "crib", 1), ("At vendor / repair", "external", 0)])
# Opening balance: 1 per holder listed in hyperMILL, flagged unverified until a physical count is booked
db.executemany("INSERT INTO stock_transactions(holder_id,location_id,qty_delta,txn_type,reference,txn_date,by_user,note) VALUES (?,1,1,'OPENING_BALANCE','hyperMILL tool DB report 07/10/2026',?,'system','Unverified: holder exists in CAM DB; replace with physical count')",
               [(h["holder_id"], TODAY) for h in holders if h["on_site"]])
db.commit()

# ---------------------------------------------------------------- report
print("holders:", len(holders), "| on site:", sum(h["on_site"] for h in holders), "| catalogue only:", sum(not h["on_site"] for h in holders))
print("flags:", len(F))
for q in ("SELECT * FROM v_tally_by_type", "SELECT * FROM v_tally_by_manufacturer", "SELECT * FROM v_gl_check",
          "SELECT SUM(qty_on_site) FROM v_stock_on_hand"):
    print("--", q); [print("  ", r) for r in db.execute(q)]
missing = [(h["order_no"], k) for h in holders for k in ("gauge_length_mm", "product_url") if h.get(k) is None]
print("missing core fields:", missing)
print("nose dia missing:", [h["order_no"] for h in holders if h.get("nose_dia_mm") is None])
print("vendor image:", sum(bool(h.get("image_url")) for h in holders if h["on_site"]), "/", sum(h["on_site"] for h in holders))
