# -*- coding: utf-8 -*-
"""Usability check: can a consumer actually load & use all-endpoints-redacted/?"""
import json, os, glob, sys
sys.stdout.reconfigure(encoding="utf-8")

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "all-endpoints-redacted")
FAIL = []
OK = []

def load(name):
    with open(os.path.join(D, name), encoding="utf-8") as fh:
        return json.load(fh)

# 1) every file is valid JSON + has required envelope keys
REQ = {"rows", "columnNames", "resultCode", "recordTotal", "rows_fetched", "fetch_mode"}
files = sorted(f for f in glob.glob(os.path.join(D, "*.json")) if not os.path.basename(f).startswith("_"))
for f in files:
    name = os.path.basename(f)
    try:
        rec = json.load(open(f, encoding="utf-8"))
    except Exception as e:
        FAIL.append(f"{name}: invalid JSON ({e})"); continue
    missing = REQ - set(rec)
    if missing:
        FAIL.append(f"{name}: missing keys {missing}"); continue
    rows = rec["rows"]; cols = rec["columnNames"]
    if not isinstance(rows, list) or not isinstance(cols, list):
        FAIL.append(f"{name}: rows/columnNames not lists"); continue
    if rec["resultCode"] != 200:
        FAIL.append(f"{name}: resultCode={rec['resultCode']} (!=200)")
    # row count integrity
    if len(rows) != rec["rows_fetched"]:
        FAIL.append(f"{name}: len(rows)={len(rows)} != rows_fetched={rec['rows_fetched']}")
    if rec["fetch_mode"] == "full" and len(rows) != rec["recordTotal"]:
        FAIL.append(f"{name}: full mode but len(rows)={len(rows)} != recordTotal={rec['recordTotal']}")
    if rec["fetch_mode"] == "sampled" and len(rows) > rec["recordTotal"]:
        FAIL.append(f"{name}: sampled but rows>recordTotal")
    # each row well-formed: keys are a subset of columnNames (or exactly)
    colset = set(cols)
    bad_rows = 0
    for r in rows:
        if not isinstance(r, dict):
            bad_rows += 1; continue
        if not set(r).issubset(colset):
            bad_rows += 1
    if bad_rows:
        FAIL.append(f"{name}: {bad_rows} rows with keys outside columnNames")
OK.append(f"{len(files)} entity files valid JSON with full envelope, rows aligned to columnNames")

# 2) type sanity: mmsi numeric-ish, lat/lon float-parseable & in bbox
mmsi_bad = coord_bad = 0; coord_seen = 0
for f in files:
    rec = json.load(open(f, encoding="utf-8"))
    for r in rec["rows"]:
        for k, v in r.items():
            kk = k.lower()
            if kk == "mmsi" and v not in (None, ""):
                try:
                    int(str(v))
                except Exception:
                    mmsi_bad += 1
            if kk in ("latitude", "longitude", "lat", "lon") and v not in (None, ""):
                coord_seen += 1
                try:
                    x = float(v)
                    if kk in ("latitude", "lat") and not (-30.0001 <= x <= -24.9999):
                        coord_bad += 1
                    if kk in ("longitude", "lon") and not (-140.0001 <= x <= -134.9999):
                        coord_bad += 1
                except Exception:
                    coord_bad += 1
if mmsi_bad: FAIL.append(f"{mmsi_bad} non-numeric mmsi values")
if coord_bad: FAIL.append(f"{coord_bad} coord values outside test bbox / non-numeric")
OK.append(f"types ok: mmsi numeric, {coord_seen} coord values all in test bbox")

# 3) end-to-end join: carrier -> CSG -> platform -> AIS track
av = load("AviationCarrier.json")["rows"]
ac = load("AircraftCarrier.json")["rows"]
mb = load("MaritimeBaseCombatPlatform.json")["rows"]
rais = load("RawAISData.json")["rows"]
av_by_id = {r["id"]: r for r in av if r.get("id")}
mb_mmsi = {str(r.get("mmsi")) for r in mb if r.get("mmsi")}
rais_mmsi = {str(r.get("mmsi")) for r in rais if r.get("mmsi")}
chain = None
for csg in ac:
    carrier = av_by_id.get(csg.get("refHMId"))
    if not carrier:
        continue
    for p in mb:
        if str(p.get("mmsi")) and str(p.get("mmsi")) in rais_mmsi:
            chain = (carrier["id"], csg["id"], p["id"], p["mmsi"])
            break
    if chain:
        break
if chain:
    OK.append(f"end-to-end join resolves: carrier {chain[0]} -> CSG {chain[1]} -> "
              f"platform {chain[2]} -> AIS mmsi {chain[3]}")
else:
    FAIL.append("end-to-end join did not resolve any carrier->CSG->platform->AIS chain")

# 4) manifest vs files consistent
man = load("_manifest.json")
man_files = {os.path.basename(v["file"]).replace("\\", "/").split("/")[-1]
             for v in man["endpoints"].values()}
disk = {os.path.basename(f) for f in files}
if man_files == disk:
    OK.append(f"manifest lists {len(man_files)} entities, matches disk")
else:
    FAIL.append(f"manifest/disk mismatch: only-man={man_files-disk} only-disk={disk-man_files}")

print("=" * 64)
print("USABILITY CHECK")
for o in OK:
    print("  ✓", o)
if FAIL:
    print("\nFAILURES:")
    for x in FAIL:
        print("  ✗", x)
    print("\nRESULT: NOT USABLE — fix above")
    sys.exit(1)
print("\nRESULT: USABLE ✓")
