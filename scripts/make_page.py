"""Inject catalogue data + hyperMILL profile images into the HTML template -> catalogue.html"""
import base64, csv, json, os, sys, datetime

ROOT = sys.argv[1]
holders = json.load(open(os.path.join(ROOT, "data", "holders.json"), encoding="utf-8"))
flags = list(csv.DictReader(open(os.path.join(ROOT, "data", "data_flags.csv"), encoding="utf-8-sig")))

TYPES = {"SHRINK": "Shrink fit chuck", "HYDRAULIC": "Hydraulic expansion chuck", "ER_COLLET": "ER collet chuck",
         "PRECISION_COLLET": "High-precision collet chuck", "FACE_MILL_ARBOR": "Face / shell mill arbor",
         "SCREW_IN": "Screw-in cutter holder", "TAP_CHUCK": "Tapping chuck", "DRILL_CHUCK": "Drill chuck"}

SOURCES = [
    dict(vendor="HAIMER · 37 on site", method="Static HTML scrape (product pages)",
         why="Product pages are plain HTML with a DIN 4000 / ISO 13399 spec table and photo URLs. Category pages refuse non-browser requests, so find products through shop.haimer.com/sitemap.xml and keep to the 10-second crawl delay in robots.txt.",
         issue="Points at HSK-A50, not HSK-A63.",
         url="https://shop.haimer.com/en/Tool-Holders/HSK-Hollow-shank-DIN-69893/HSK-A63/"),
    dict(vendor="MAPAL · 9 on site", method="PDF catalogue parse + shop listings",
         why="The UNIQ catalogue in this project was parsed directly (38 HSK-A63 chucks). Every MAPAL product opens at shop.mapal.com/en/p/0000000000<order no.>, and the designation encodes the geometry: MHC-HSK-A063-12-075 is Ø12, GL 75.",
         issue="Spannfutter-HSK-C-HSK-E-EN.pdf covers HSK-C and HSK-E, not form A, so it is left out. The MQL catalogue lists 388 HSK-A63 MQL holders; not loaded unless you run MQL.",
         url="https://shop.mapal.com/Spannen/Spannfutter/c/chucks?q=%3Adiameter-asc%3AClampingConnectionCodeMachineSide%3AHSK0506"),
    dict(vendor="CERATIZIT · 7 on site", method="PDF catalogue or ISO 13399 data from your rep",
         why="cuttingtools.ceratizit.com answers 403 to any automated request, so the app should not scrape it. Data for your 7 holders came from the distributor Zedaro, which quotes the Ceratizit article numbers.",
         issue="Hash-routed search page; it can only be read inside a browser.", url=None),
    dict(vendor="KEMMLER · 1 on site", method="Static HTML scrape (product pages)",
         why="Product pages carry ISO 13399 properties, photos and free DXF/STEP downloads. Shop search works: kemmler-shop.de/search?search=<order no.>.",
         issue="Path should be /ISO-12164-HSK-A/ (no '-1'), and it only covered ER collet chucks.",
         url="https://www.kemmler-shop.de/en/Products-Shop/ISO-12164-HSK-A/"),
    dict(vendor="SANDVIK COROMANT · none on site", method="ISO 13399 / GTC via CoroPlus (fallback: Playwright)",
         why="The site renders entirely in JavaScript. Sandvik's tool-data channel is the dependable route for holder geometry.",
         issue="Filter value could not be confirmed without a browser.", url="https://www.sandvik.coromant.com/en-gb/tools/tool-data"),
    dict(vendor="CUTWEL · none on site", method="Playwright scrape",
         why="UK distributor (Dine, EZChange): its part numbers are its own, not maker order numbers. The product grid only appears once JavaScript runs.",
         issue="Covers every HSK size; the HSK63 page is linked below.",
         url="https://www.cutwel.co.uk/landing-pages/shop-by/shop-by-taper/hsk-din69893-spindle-tooling/hsk63-spindle-tooling"),
]

def compact(h):
    return dict(id=h["holder_id"], mk=h["manufacturer"], ord=h["order_no"], spec=h.get("spec_code"),
                name=h.get("product_name"), series=h.get("series"), type=h["type_code"],
                cd=h.get("clamp_dia_mm"), cmin=h.get("clamp_min_mm"), cmax=h.get("clamp_max_mm"),
                cspec=h.get("clamp_spec"), gl=h.get("gauge_length_mm"), glref=h.get("gauge_length_ref"),
                cgl=h.get("cam_gl_mm"), nose=h.get("nose_dia_mm"), cool=h.get("coolant"), bal=h.get("balance"),
                rpm=h.get("max_rpm"), kg=h.get("mass_kg"), url=h.get("product_url"), img=h.get("image_url"),
                drw=h.get("drawing_url"), camName=h.get("cam_name"), camCmt=h.get("cam_comment"),
                st=h.get("data_status"), src=h.get("data_source"), on=h["on_site"], dims=h.get("dims_json") or {})

data = dict(holders=[compact(h) for h in holders], types=TYPES, sources=SOURCES,
            generated=datetime.date.today().strftime("%d %b %Y"),
            flags=[dict(id=int(f["flag_id"]), hid=f["holder_id"] or None, sev=f["severity"], cat=f["category"],
                        msg=f["message"], act=f["action"]) for f in flags])
img = {}
for h in holders:
    if h.get("cam_image"):
        b = open(os.path.join(ROOT, h["cam_image"]), "rb").read()
        img[h["holder_id"]] = "data:image/png;base64," + base64.b64encode(b).decode()

tpl = open(os.path.join(ROOT, "scripts", "catalogue_template.html"), encoding="utf-8").read()
js = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
out = tpl.replace("/*__DATA__*/null", js(data)).replace("/*__IMG__*/null", js(img))
open(os.path.join(ROOT, "catalogue.html"), "w", encoding="utf-8").write(out)
print("catalogue.html", round(len(out.encode()) / 1024), "KB;", len(img), "profiles;", len(data["holders"]), "holders")
