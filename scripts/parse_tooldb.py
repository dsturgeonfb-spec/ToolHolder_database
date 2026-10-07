"""Parse the OPEN MIND (hyperMILL) Tool Database holder report into structured rows."""
import re, json, sys, shutil, os

txt_path, img_dir, out_json, out_img_dir = sys.argv[1:5]
txt = open(txt_path, encoding="utf-8").read()

# Split into holder blocks
blocks = re.split(r"\n\s*Holder: ", "\n" + txt)[1:]
rows = []
for i, b in enumerate(blocks, start=1):
    lines = [l.strip() for l in b.splitlines()]
    # Name may wrap across two lines until 'Holder comment'
    name_parts = []
    for l in lines:
        if l.startswith("Holder comment"):
            break
        if l:
            name_parts.append(l)
    name = " ".join(name_parts).strip()
    m = re.search(r"Holder comment\s*(.*)", b)
    comment = m.group(1).strip() if m else ""
    if comment.startswith("Coupling"):
        comment = ""
    coupling = re.findall(r"^\s*(\w+)\s+(top|bottom)\s*(.*)$", b, re.M)
    rows.append({"seq": i, "cam_name": name, "cam_comment": comment,
                 "cam_coupling": [{"type": c[0], "pos": c[1], "class": c[2].strip()} for c in coupling]})

# Images: pdfimages order = per page [header, holder A, holder B]
imgs = sorted(f for f in os.listdir(img_dir) if f.endswith(".png"))
holder_imgs = [f for k, f in enumerate(imgs) if k % 3 != 0]
os.makedirs(out_img_dir, exist_ok=True)
assert len(holder_imgs) == len(rows), (len(holder_imgs), len(rows))
for r, f in zip(rows, holder_imgs):
    dst = f"cam_{r['seq']:02d}.png"
    shutil.copy(os.path.join(img_dir, f), os.path.join(out_img_dir, dst))
    r["cam_image"] = dst

json.dump(rows, open(out_json, "w"), indent=1)
for r in rows:
    print(r["seq"], "|", r["cam_name"], "|", r["cam_comment"], "|",
          [c for c in r["cam_coupling"] if c["type"] != "unknown" or c["class"]])
