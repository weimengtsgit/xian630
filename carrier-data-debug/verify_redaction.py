# -*- coding: utf-8 -*-
"""Verify all-endpoints-redacted/ : no leaks, counts preserved, joins intact."""
import json, os, glob, re, sys
sys.stdout.reconfigure(encoding="utf-8")

ORIG = "C:/idea/xian630/carrier-data-debug/all-endpoints"
RED  = "C:/idea/xian630/carrier-data-debug/all-endpoints-redacted"

# --- 1. load all redacted text once for leak grep ---
LEAKS = [
    # credentials / infra (real space_id / token / accessKey are intentionally
    # NOT hardcoded here — checked generically below to keep this file safe to commit)
    "yuanting", "beiyou", "codex", "hangkongmujian", "ADMIN-USA",
    "203.83.238.87", "junshibentitong", "ceshi.projects.bingosoft",
    # real ship names
    "尼米兹", "卡尔·文森", "杜鲁门", "里根号", "华盛顿号", "林肯号",
    "艾森豪威尔", "福特号", "乔治·H·W·布什", "约翰·肯尼迪",
    "Gettysburg", "Stout", "Nimitz", "Vinson", "Truman", "Reagan",
    "普林斯顿", "钟云号", "丹尼尔·井上",
    # real mmsi / icao
    "303981000", "368800000", "368962000", "638824000", "369970409",
    "369952000", "303981000",
    # real places
    "横须贺", "圣迭戈", "诺福克", "珍珠港", "布雷默顿", "Souda Bay",
]
# case-insensitive scan over every redacted file's raw bytes
raw_all = ""
for f in sorted(glob.glob(os.path.join(RED, "*.json"))):
    raw_all += open(f, encoding="utf-8").read()
raw_low = raw_all.lower()

print("=" * 70)
print("1) LEAK SCAN (these MUST be absent)")
bad = []
for tok in LEAKS:
    if tok.lower() in raw_low:
        bad.append(tok)
print("   hits:", bad if bad else "NONE  ✓")
# any residual 9-digit real-looking mmsi NOT starting with 999?
stray_mmsi = re.findall(r"\b\d{9}\b", raw_all)
stray_not999 = [m for m in set(stray_mmsi) if not m.startswith("999")]
print("   9-digit numbers not in 999xxx test range:", sorted(stray_not999)[:20], "..." if len(stray_not999) > 20 else "")
# residual internal IPs (not 10.0.0.1 placeholder)
ips = set(re.findall(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", raw_all))
ips.discard("10.0.0.1")
print("   residual IPs (excl 10.0.0.1):", sorted(ips))
# generic secret checks (no hardcoded real values)
jwt = re.findall(r"eyJ[A-Za-z0-9_-]{8,}", raw_all)
print("   JWT-like tokens:", len(jwt))
_man = json.load(open(os.path.join(RED, "_manifest.json"), encoding="utf-8"))
print("   manifest space_id scrubbed:", _man["_meta"].get("space_id") == "REDACTED_SPACE")

# --- 2. row counts match ---
print("\n2) ROW COUNTS (redacted vs original)")
def nrows(p):
    rec = json.load(open(p, encoding="utf-8"))
    return rec.get("rows_fetched"), rec.get("recordTotal"), len(rec.get("rows") or [])
mismatch = []
for f in sorted(glob.glob(os.path.join(RED, "*.json"))):
    name = os.path.basename(f)
    if name.startswith("_"):
        continue
    r = nrows(f)
    o = nrows(os.path.join(ORIG, name))
    flag = "" if r == o else "  <-- MISMATCH"
    if r != o:
        mismatch.append(name)
    print("   {:<46} redacted{} original{}".format(name, r, o) + flag)
print("   ", "ALL MATCH ✓" if not mismatch else ("MISMATCH: " + str(mismatch)))

# --- 3. join integrity ---
print("\n3) JOIN INTEGRITY")
def col(rec, entity_field):
    pass
# 3a carrier hull join: redacted AircraftCarrier.refHMId should be subset of
#    redacted (AviationCarrier.id ∪ MaritimeBaseCombatPlatform.id where carrier)
av = json.load(open(os.path.join(RED, "AviationCarrier.json"), encoding="utf-8"))["rows"]
ac = json.load(open(os.path.join(RED, "AircraftCarrier.json"), encoding="utf-8"))["rows"]
av_ids = {r.get("id") for r in av if r.get("id")}
refhmid = {r.get("refHMId") for r in ac if r.get("refHMId")}
print("   AviationCarrier ids (carrier hulls):", sorted(x for x in av_ids if x))
print("   AircraftCarrier.refHMId refs     :", sorted(x for x in refhmid if x))
missing = refhmid - av_ids - {None, ""}
print("   refs not found among carrier ids:", missing if missing else "NONE ✓ (join intact)")

# 3b mmsi join: fake mmsi in MaritimeBaseCombatPlatform should overlap RawAISData
mb = json.load(open(os.path.join(RED, "MaritimeBaseCombatPlatform.json"), encoding="utf-8"))["rows"]
ra = json.load(open(os.path.join(RED, "RawAISData.json"), encoding="utf-8"))["rows"]
mb_mmsi = {str(r.get("mmsi")) for r in mb if r.get("mmsi")}
ra_mmsi = {str(r.get("mmsi")) for r in ra if r.get("mmsi")}
inter = mb_mmsi & ra_mmsi
print("   platform mmsi={}  rais mmsi={}  intersection={}".format(len(mb_mmsi), len(ra_mmsi), len(inter)))
print("   platforms joinable to AIS tracks:", len(inter), "✓" if inter else "(no overlap)")

# --- 4. coord bounds within fake bbox ---
print("\n4) COORD BOUNDS (must be inside test bbox lat[-30,-25] lon[-140,-135])")
lats, lons = [], []
for f in sorted(glob.glob(os.path.join(RED, "*.json"))):
    if os.path.basename(f).startswith("_"):
        continue
    for row in json.load(open(f, encoding="utf-8")).get("rows") or []:
        for k, v in row.items():
            if k in ("latitude", "lat") and v not in (None, ""):
                try: lats.append(float(v))
                except: pass
            if k in ("longitude", "lon") and v not in (None, ""):
                try: lons.append(float(v))
                except: pass
def inrange(xs, lo, hi):
    return all(lo - 1e-6 <= x <= hi + 1e-6 for x in xs) if xs else True
if lats:
    print("   lat [{:.4f}, {:.4f}] inside bbox: {}".format(min(lats), max(lats), inrange(lats, -30, -25)))
if lons:
    print("   lon [{:.4f}, {:.4f}] inside bbox: {}".format(min(lons), max(lons), inrange(lons, -140, -135)))

print("\n" + "=" * 70)
print("DONE")
