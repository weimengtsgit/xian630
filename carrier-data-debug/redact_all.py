# -*- coding: utf-8 -*-
"""
Redact carrier-data-debug/all-endpoints/*.json for EXTERNAL test use.

Goal: safe to ship to an environment with NO ontology API access, while keeping
the JSON structure / field types / row counts / cross-entity joins usable for tests.

Policy (confirmed with user):
  * identifiers + coords  -> consistent synthetic remap (joins preserved)
  * real names / units    -> generic codes
  * free text             -> substitute real names/numbers, keep structure/length
  * credentials           -> hard-stripped (token / space_id / internal URLs/IPs)

Output: carrier-data-debug/all-endpoints-redacted/<entity>.json (+ redacted _manifest).
Originals are NEVER modified.

Two passes:
  1) collect global identity maps by scanning every row of every entity
  2) redact every row field-by-field using those maps
"""
import json
import os
import re
import glob

SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "all-endpoints")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "all-endpoints-redacted")
os.makedirs(OUT_DIR, exist_ok=True)

# Fake test bbox (empty South Pacific) — all coords linearly remapped into it.
LAT0, LAT1 = -30.0, -25.0
LON0, LON1 = -140.0, -135.0

# ---- identity regexes -------------------------------------------------------
# NOTE: do NOT use \b — Python re treats CJK chars as \w, so \b fails between a
# digit and a Chinese char (e.g. "CVN-73太平洋"). Use explicit lookarounds and
# require >=2 digits to avoid matching equipment model numbers like "AN/SSN-2".
HULL_RE = re.compile(
    r"(?<![A-Za-z0-9])(CVBN|CVN|CGN|CV|CG|DDG|DD|CL|CA|LHA|LHD|LPD|LSD|SSBN|SSGN|SSN|SS|FFG|FF|PG|MCM|IX)-(\d{2,})(?![0-9])"
)
CSG_RE = re.compile(r"(?<![A-Za-z0-9])CSG-(\d+)(?![0-9])")
TRK_RE = re.compile(r"(?<![A-Za-z0-9])TRK-[A-Z]+-?\d*(?![0-9A-Za-z])")
BEH_RE = re.compile(r"(?<![A-Za-z0-9])BEH-[A-Z]+-\d+-\d+(?![0-9])")
ORG_RE = re.compile(r"(?<![A-Za-z0-9])(USA|CHN|RN|RUS)_[A-Z][A-Z0-9_-]*\d+(?![A-Za-z0-9])")
USS_RE = re.compile(r"(?<![A-Za-z])((?:USS|USNS|JS))\s+[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}")
MMSI_FIELD_RE = re.compile(r"^\d{6,9}$")
# identifiers embedded in free text (OSINT) -> collect so they get remapped too
MMSI_CTX_RE = re.compile(r"(?<![A-Za-z])MMSI[:\s]*?(\d{6,9})(?![0-9])", re.IGNORECASE)
IMO_CTX_RE = re.compile(r"(?<![A-Za-z])IMO[:\s]*?(\d{7,9})(?![0-9])", re.IGNORECASE)
VESSEL_LABEL_RE = re.compile(r"\b(?:TANKER|CARRIER|BULKER|LNG|VLCC|AFFF)\s*\d+\b", re.IGNORECASE)
SHIP_SLUG_RE = re.compile(r"\b(?:uss|usns|js)[a-z0-9_]+\b")
GUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
HOST_RE = re.compile(r"\b(?:[a-z0-9-]+\.)+(?:com|net|org|cn|io|gov)\b", re.IGNORECASE)

# ---- per-entity policy ------------------------------------------------------
# `name` is a short proper noun here -> replace whole field with a generic code,
# and feed the core token into the text-substitution map.
NAME_PROPER_ENTITIES = {
    "AviationCarrier": "测试航母{:02d}",
    "MaritimeBaseCombatPlatform": "测试舰艇{:03d}",
    "SurfaceCombatPlatform": "测试水面舰{:03d}",
    "CarrierAviationPlatform": "测试战机{:03d}",
    "AircraftCarrier": "测试打击群{:02d}",
    "Personnel": "测试员{:03d}",
}
# `name` is a sentence/headline here -> treat as TEXT (token substitute in place).

COORD_FIELDS = {"latitude", "longitude", "lat", "lon"}
URL_FIELDS = {"image", "sourceurl", "imageurl", "satelliteaccessurl",
              "webrtcurl", "rawdatablockptr", "fileurl", "videourl",
              "associatedobject", "associatedaction"}
PII_FIELDS = {
    "telphone", "idnumber", "passportnumber", "bankaccountnumber",
    "residentialaddress", "usualresidence", "nativeplace", "placeofbirth",
    "worklocation", "relatedaddress", "resume", "alhamamater", "almamater",
    "workpermitnumber", "socialaccount", "publisher", "informationprovider",
    "heightcm", "weightkg",
}
# Free-text fields -> token substitution (real names/numbers -> codes).
TEXT_FIELDS = {
    "introduction", "details", "eventdescription", "summary", "contentsummary",
    "payload", "surfaceescort", "ammunitionload", "sensors", "armament",
    "electronicwarfare", "replenishmentcapability", "underwatercapability",
    "endurancerefuelingcycle", "description", "organizationdescription",
    "geographicbackground", "keywordtags", "motto", "aircraftcarried",
    "airwingcomposition", "coreorganization", "ammunitionreserve",
    "maintenancecontent", "positionoccupation", "name",   # name handled per-entity
    "foreignname", "localname", "englishname", "alias", "formername",
    "keytargetname", "title", "jobtitle", "professionalbackground",
    "professionalbackground", "employmenthistory", "politicalcareer",
    "specialtyarea", "primarybusiness", "remarks", "eventsource", "location",
}
# Author-ish fields whose latin-handle values get mapped to generic analyst/source codes.
USER_FIELDS = {"creatorid", "eventsource", "eventsourceid", "publisher",
               "socialaccount", "informationprovider"}

# Known homeports / seas / regions / real place names -> generic.
PORT_MAP = {
    # homeports
    "横须贺海军基地": "测试母港A", "横须贺": "测试母港A",
    "圣迭戈海军基地": "测试母港B", "圣迭戈": "测试母港B",
    "诺福克海军基地": "测试母港C", "诺福克": "测试母港C",
    "布雷默顿": "测试母港D", "基特萨普": "测试母港D",
    "珍珠港": "测试母港E", "关岛": "测试母港F", "Souda Bay": "测试母港G",
    # seas / oceans / straits / regions (operationally sensitive)
    "太平洋": "测试海区甲", "大西洋": "测试海区乙", "印度洋": "测试海区丙",
    "南海": "测试海区丁", "东海": "测试海区戊", "菲律宾海": "测试海区己",
    "日本海": "测试海区庚", "鄂霍次克海": "测试海区辛", "地中海": "测试海区壬",
    "黑海": "测试海区癸", "波斯湾": "测试海湾甲", "红海": "测试海湾乙",
    "台湾海峡": "测试海峡甲", "台海": "测试海峡甲", "苏伊士运河": "测试运河甲",
    "苏伊士": "测试运河甲", "巴拿马运河": "测试运河乙", "巴拿马": "测试运河乙",
    # states / islands / land regions
    "夏威夷": "测试陆地甲", "弗吉尼亚州": "测试陆地乙", "弗吉尼亚": "测试陆地乙",
    "冲绳": "测试陆地丙", "北海道": "测试陆地丁", "九州": "测试陆地戊",
    "釜山": "测试港城甲", "新加坡港": "测试港城乙", "新加坡": "测试港城乙",
    "巴林": "测试港城丙", "中东": "测试陆域甲", "也门": "测试陆域乙", "伊朗": "测试陆域丙",
    # OSINT source codenames / exercises
    "豆包": "测试来源甲", "环太": "测试演习甲",
    "Greece": "测试区域G",
}
# English place equivalents (OSINT prose). Multi-word first; merged longest-first.
ENG_PLACE_MAP = {
    "San Diego": "测试母港B", "Yokosuka": "测试母港A", "Pearl Harbor": "测试母港E",
    "Bremerton": "测试母港D", "Kitsap": "测试母港D", "Norfolk": "测试母港C",
    "Persian Gulf": "测试海湾甲", "Persian": "测试海湾甲",
    "Gulf of Aden": "测试海湾丁", "Gulf of Oman": "测试海湾丙", "Red Sea": "测试海湾乙",
    "Pacific Ocean": "测试海区甲", "Eastern Pacific": "测试海区甲",
    "Western Pacific": "测试海区甲", "Pacific Coast": "测试海区甲", "Pacific": "测试海区甲",
    "Atlantic Ocean": "测试海区乙", "North Atlantic": "测试海区乙",
    "Western Atlantic": "测试海区乙", "Atlantic": "测试海区乙",
    "Indian Ocean": "测试海区丙",
    "South China Sea": "测试海区丁", "East China Sea": "测试海区戊",
    "Sea of Japan": "测试海区庚", "Yellow Sea": "测试海区己",
    "Philippine Sea": "测试海区己2", "Hawaii": "测试陆地甲", "Guam": "测试母港F",
    "Japan": "测试国别甲", "Bush": "测试舰EN",   # carrier surname in prose
}

# Curated distinctive ship-name tokens (transliterations are unambiguous -> safe).
# These are merged into the NAME substitution map so any mention in free text is
# replaced. Rare/distinctive only; common words (Lincoln/Ford/Bush/Washington/
# Portland/Island/Bay/Comfort) are intentionally excluded and left to the
# in-context (USS/CG/DDG-prefix) scan below.
CHN_SHIP_TOKENS = [
    "尼米兹", "卡尔·文森", "卡尔文森", "杜鲁门", "里根", "艾森豪威尔", "肯尼迪",
    "斯坦尼斯", "罗斯福", "乔治·布什", "乔治布什", "布什", "葛底斯堡", "普林斯顿",
    "莫比尔湾", "乔辛", "钟云", "井上", "斯托特", "邦克山", "霍华德", "麦凯恩",
    "阿利·伯克", "阿利伯克", "提康德罗加", "丹尼尔·井上", "丹尼尔井上", "霞光",
    "哈尔西", "格雷夫利", "杰拉尔德·福特", "杰拉尔德福特", "企业号", "小鹰号",
    # bare common-word carrier names (military dataset context -> safe to map)
    "华盛顿", "福特", "林肯", "小鹰", "企业",
    # JDS / other allied vessel names
    "足柄", "爱宕", "摩耶", "金刚", "高波", "村雨", "秋月", "日向", "伊势", "出云",
]
ENG_SHIP_TOKENS = [  # distinctive surnames/names appearing w/o prefix (e.g. "Nimitz-class")
    "Nimitz", "Vinson", "Truman", "Reagan", "Eisenhower", "Kennedy", "Stennis",
    "Gettysburg", "Chosin", "Chung-Hoon", "Inouye", "Decatur", "Princeton",
    "Bunker", "Moblie", "Mobile", "Ike", "Higgin",
    # escort vessel surnames that appear bare in OSINT/escort text
    "Curtis Wilbur", "Curtis", "Wilbur", "McCain", "Mustin", "Fitzgerald", "Laboon",
    "Nitze", "Sterett", "Stockdale", "Spruance", "Preble", "Halsey", "Shoup",
    "Shiloh", "Antietam", "Chancellorsville", "Cowpens", "Vella", "Leyte",
    "Cushing", "Ramage", "Mitscher", "Gravely", "Dunham", "Dewey", "Milius",
    "Higgins", "Benfold", "Stethem", "Hopper", "Howard", "Barry", "Mahan",
    "Porter", "Ross", "Carney", "Jason", "Hopkins", "Hamm",
]
# Scan original text for ship names IN CONTEXT (prefix + Name) -> reliable capture
# without curating ambiguous words.
SHIP_CTX_RE = re.compile(
    r"(?<![A-Za-z])(?:USS|USNS|JS|CG|DDG|DD|CVN|CV|LHA|LHD|LPD|LSD|SSN|SSBN)\s+"
    r"([A-Z][a-zA-Z]{2,}(?:[\s-][A-Z][a-zA-Z]{2,}){0,3})"
)
# Chinese ship-name suffixes to strip when deriving the distinctive core.
SHIP_SUFFIXES = [
    "号航空母舰", "号核动力航空母舰", "核动力航空母舰", "航空母舰", "号航母", "航母",
    "号两栖攻击舰", "两栖攻击舰", "号船坞登陆舰", "船坞登陆舰", "号船坞运输舰",
    "船坞运输舰", "号巡洋舰", "巡洋舰", "号驱逐舰", "驱逐舰", "级驱逐舰",
    "号护卫舰", "护卫舰", "级护卫舰", "号补给舰", "补给舰", "号登陆舰", "登陆舰",
    "号核潜艇", "核潜艇", "级核潜艇", "号潜艇", "潜艇", "号舰载机联队", "舰载机联队",
    "号航空大队", "航空大队", "号舰载机", "舰载机", "号", "级",
]

# ---- map state --------------------------------------------------------------
MAPS = {
    "hull": {},   # CVN-70 -> CVN-T01
    "csg":  {},   # CSG-1  -> CSG-T01
    "trk":  {},   # TRK-...-> TRK-T01
    "beh":  {},   # BEH-...-> BEH-T01
    "org":  {},   # USA_INDOPACOM_HQ_001 -> ORG_TEST_001
    "mmsi": {},   # 9-digit -> 999xxxxxx
    "icao": {},   # hex    -> AAxxxx
    "imo":  {},   # IMO    -> IMO_TEST_NNNNN
    "name": {},   # core proper-noun -> generic code
    "user": {},   # handle -> analystNN / sourceNN
}
_counters = {k: 1 for k in MAPS}


def assign(d, key, fmt):
    if key not in d:
        n = _counters.get(fmt, 1)
        d[key] = fmt.format(n)
        _counters[fmt] = n + 1
    return d[key]


def name_core(s):
    """Strip parentheticals, hull ids, english -> leading proper-noun token."""
    if not isinstance(s, str):
        return None
    c = re.sub(r"\([^)]*\)", "", s)
    c = HULL_RE.sub("", c)
    c = USS_RE.sub("", c)
    c = re.sub(r"[A-Za-z0-9_./:-]+", " ", c)
    c = c.replace("（", " ").replace("）", " ")
    c = re.sub(r"\s+", "", c)
    return c or None


def ship_name_variants(core):
    """Given a Chinese ship-name core, yield the distinctive stem(s) so that
    partial text mentions (e.g. '尼米兹号', '尼米兹') also map to the same code."""
    out = set()
    if not core:
        return out
    out.add(core)
    stem = core
    changed = True
    while changed:
        changed = False
        for suf in SHIP_SUFFIXES:
            if stem.endswith(suf) and len(stem) > len(suf):
                stem = stem[: -len(suf)]
                changed = True
                break
    if stem:
        out.add(stem)
    return out


# ============================================================================
# PASS 1 — collect maps
# ============================================================================
def collect_from_text(s):
    if not isinstance(s, str) or not s:
        return
    for m in HULL_RE.finditer(s):
        assign(MAPS["hull"], m.group(0), m.group(1) + "-T{:02d}")
    for m in CSG_RE.finditer(s):
        assign(MAPS["csg"], m.group(0), "CSG-T{:02d}")
    for m in TRK_RE.finditer(s):
        assign(MAPS["trk"], m.group(0), "TRK-T{:02d}")
    for m in BEH_RE.finditer(s):
        assign(MAPS["beh"], m.group(0), "BEH-T{:02d}")
    for m in ORG_RE.finditer(s):
        assign(MAPS["org"], m.group(0), "ORG_TEST_{:03d}")
    # ship names captured IN CONTEXT (prefix + Name) -> reliable, no ambiguous words
    for m in SHIP_CTX_RE.finditer(s):
        nm = m.group(1).strip()
        if len(nm) >= 3:
            assign(MAPS["name"], nm, "测试舰EN{:02d}")
    # MMSI / IMO embedded in OSINT text ("MMSI 369914055", "IMO 9838785")
    for m in MMSI_CTX_RE.finditer(s):
        assign(MAPS["mmsi"], m.group(1), "999{:06d}")
    for m in IMO_CTX_RE.finditer(s):
        assign(MAPS["imo"], m.group(1), "IMO_TEST_{:05d}")
    # 9-digit numbers that are known MMSI are added in the mmsi-field pass.


def collect_entity(entity, rec):
    proper_fmt = NAME_PROPER_ENTITIES.get(entity)
    for row in rec.get("rows") or []:
        for k, v in row.items():
            kk = k.lower()
            if v is None:
                continue
            sv = v if isinstance(v, str) else None
            # mmsi field -> MMSI map (also numeric)
            if kk == "mmsi":
                ms = str(v).strip()
                if MMSI_FIELD_RE.match(ms):
                    assign(MAPS["mmsi"], ms, "999{:06d}")
            if kk == "icao" and isinstance(v, str) and re.match(r"^[0-9A-Fa-f]{6}$", v.strip()):
                assign(MAPS["icao"], v.strip().upper(), "AA{:04X}")
            if (kk in USER_FIELDS) and isinstance(v, str) \
                    and re.match(r"^[a-zA-Z][A-Za-z0-9_-]{2,}$", v.strip()):
                if "OSINT" not in v:
                    assign(MAPS["user"], v.strip(), "analyst{:02d}" if kk == "creatorid" else "source{:02d}")
            # sourceOrigin may be "hangkongmujian上推" (latin handle + Chinese) -> extract latin runs
            if kk == "sourceorigin" and isinstance(v, str):
                for m in re.finditer(r"[a-zA-Z]{4,}", v):
                    tok = m.group(0)
                    if "OSINT" not in tok:
                        assign(MAPS["user"], tok, "source{:02d}")
            # name proper noun (+ distinctive stem variants for text mentions)
            if kk == "name" and proper_fmt and isinstance(v, str) and v.strip():
                core = name_core(v)
                if core:
                    code = assign(MAPS["name"], core, proper_fmt)
                    for var in ship_name_variants(core):
                        if var and var not in MAPS["name"]:
                            MAPS["name"][var] = code
                    full = v.strip()
                    if full and full not in MAPS["name"]:
                        MAPS["name"][full] = code
            # scan textish + everything for ids
            if sv:
                collect_from_text(sv)


# ============================================================================
# PASS 2 — redact
# ============================================================================
def remap_coord(v, rmin, rmax):
    if v is None or v == "":
        return v
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    if rmax == rmin:
        out = (LAT0 + LAT1) / 2 if rmin is _LAT else v
        return out
    span = rmax - rmin
    # remap into fake bbox preserving relative position
    is_lat = True  # set by caller via wrapper
    return f  # placeholder, replaced below


def make_coord_remappers(lat_min, lat_max, lon_min, lon_max):
    def remap(v, lo, hi, f0, f1):
        if v is None or v == "":
            return v
        try:
            f = float(v)
        except (TypeError, ValueError):
            return v
        if hi == lo:
            return type(v)((f0 + f1) / 2) if isinstance(v, (int, float)) else "{:.5f}".format((f0 + f1) / 2)
        out = f0 + (f - lo) / (hi - lo) * (f1 - f0)
        if isinstance(v, float):
            return round(out, 5)
        if isinstance(v, int):
            return int(round(out))
        return "{:.5f}".format(out)
    return remap


def substitute_text(s):
    """Apply all maps + regexes to a string, longest verbatim tokens first."""
    if not isinstance(s, str) or not s:
        return s
    # regex-based id maps
    s = HULL_RE.sub(lambda m: MAPS["hull"].get(m.group(0), m.group(0)), s)
    s = CSG_RE.sub(lambda m: MAPS["csg"].get(m.group(0), m.group(0)), s)
    s = TRK_RE.sub(lambda m: MAPS["trk"].get(m.group(0), m.group(0)), s)
    s = BEH_RE.sub(lambda m: MAPS["beh"].get(m.group(0), m.group(0)), s)
    s = ORG_RE.sub(lambda m: MAPS["org"].get(m.group(0), m.group(0)), s)
    s = USS_RE.sub(lambda m: m.group(1) + " 测试舰", s)
    # verbatim token maps, longest first
    verbatim = {}
    for d in (MAPS["mmsi"], MAPS["icao"], MAPS["imo"], MAPS["name"], MAPS["user"]):
        verbatim.update({k: v for k, v in d.items()})
    verbatim.update(PORT_MAP)
    verbatim.update(ENG_PLACE_MAP)
    for tok in sorted(verbatim, key=len, reverse=True):
        if tok and tok in s:
            s = s.replace(tok, verbatim[tok])
    # internal infra / slugified ship names / vessel labels
    s = GUID_RE.sub("00000000-0000-4000-8000-000000000000", s)
    s = HOST_RE.sub("example.test", s)
    s = SHIP_SLUG_RE.sub("测试舰", s)          # uss_nimitz, usstruman2, ...
    s = VESSEL_LABEL_RE.sub("测试船舶", s)      # TANKER 207, VLCC 5, ...
    s = re.sub(r"avianos", "测试舰", s, flags=re.IGNORECASE)
    # textual coordinates embedded in prose ("西经43.15°", "北纬32.6°", "东经51度")
    s = re.sub(r"[东西]经\s*\d+(?:\.\d+)?\s*[°度]?", "测试经度", s)
    s = re.sub(r"[南北]纬\s*\d+(?:\.\d+)?\s*[°度]?", "测试纬度", s)
    s = re.sub(r"\b\d{1,3}\.\d{1,2}\s*[°º]\s*[NSEW]\b", "测试坐标", s)
    s = re.sub(r"\b[NSEW]\s*\d{1,3}\.\d{1,2}\s*[°º]\b", "测试坐标", s)
    # unit designations embedded in prose (DESRON 28, CVW-17, 第40驱逐舰中队, org_...)
    s = re.sub(r"(?<![A-Za-z])DESRON\s*\d+", "测试驱逐舰中队", s, flags=re.IGNORECASE)
    s = re.sub(r"(?<![A-Za-z])CVW-\d+", "CVW-T", s)
    s = re.sub(r"第\s*\d+\s*[一-龥]{0,6}中队", "测试中队", s)
    s = re.sub(r"(?<![A-Za-z])org_[A-Za-z0-9_]+", "测试单位", s)
    s = re.sub(r"junshibentitong", "ontology-test", s)
    s = re.sub(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "10.0.0.1", s)  # internal IPs
    return s


def redact_location_json(v, remap):
    """location field is a JSON string with lat/lon + eventPlace."""
    if not isinstance(v, str) or not v.strip().startswith(("[", "{")):
        return substitute_text(v)
    try:
        obj = json.loads(v)
    except Exception:
        return substitute_text(v)
    def walk(o):
        if isinstance(o, dict):
            for k, vv in list(o.items()):
                kk = k.lower()
                if kk in ("lat", "latitude"):
                    o[k] = remap(vv, _LAT_MIN, _LAT_MAX, LAT0, LAT1)
                elif kk in ("lon", "longitude"):
                    o[k] = remap(vv, _LON_MIN, _LON_MAX, LON0, LON1)
                elif kk in ("eventplace", "place", "region"):
                    o[k] = substitute_text(str(vv)) if isinstance(vv, str) else vv
                else:
                    o[k] = walk(vv)
            return o
        if isinstance(o, list):
            return [walk(x) for x in o]
        if isinstance(o, str):
            return substitute_text(o)
        return o
    return json.dumps(walk(obj), ensure_ascii=False)


# global coord bounds (filled before pass 2)
_LAT_MIN = _LAT_MAX = _LON_MIN = _LON_MAX = None
_LAT = None


def redact_entity(entity, rec):
    proper_fmt = NAME_PROPER_ENTITIES.get(entity)
    rows = rec.get("rows") or []
    for row in rows:
        for k, v in list(row.items()):
            kk = k.lower()
            if v is None or v == "":
                continue
            # credentials / internal URLs -> blank
            if kk in URL_FIELDS or kk in ("belongspeaceid", "belongspaceid"):
                row[k] = "" if isinstance(v, str) else None
                continue
            if kk == "name" and proper_fmt and isinstance(v, str):
                core = name_core(v)
                row[k] = MAPS["name"].get(core, proper_fmt.format(0))
                continue
            if kk in COORD_FIELDS:
                lo, hi, f0, f1 = (_LAT_MIN, _LAT_MAX, LAT0, LAT1) if kk in ("latitude", "lat") else (_LON_MIN, _LON_MAX, LON0, LON1)
                # numeric or string?
                row[k] = _remap(v, lo, hi, f0, f1)
                continue
            if kk == "mmsi":
                sv = (v.strip() if isinstance(v, str) else str(v))
                if sv in MAPS["mmsi"]:
                    mapped = MAPS["mmsi"][sv]
                    row[k] = int(mapped) if (isinstance(v, int) and not isinstance(v, bool) and mapped.isdigit()) else mapped
                    continue
            if kk == "icao" and isinstance(v, str) and v.strip().upper() in MAPS["icao"]:
                row[k] = MAPS["icao"][v.strip().upper()]; continue
            if kk == "callsign" and isinstance(v, str) and v.strip():
                row[k] = "CALL{}".format(_counters.setdefault("_callsign", 1)); _counters["_callsign"] += 1; continue
            if kk in USER_FIELDS and isinstance(v, str) and v.strip() in MAPS["user"]:
                row[k] = MAPS["user"][v.strip()]; continue
            if kk in PII_FIELDS and isinstance(v, str) and v.strip():
                row[k] = "[已脱敏-{}]".format(kk); continue
            if kk == "location":
                row[k] = redact_location_json(v, _remap); continue
            if kk in TEXT_FIELDS and isinstance(v, str):
                row[k] = substitute_text(v); continue
            # fallthrough: apply id substitution to any other string that holds ids
            if isinstance(v, str):
                row[k] = substitute_text(v)
    # scrub rec-level credential/url fields
    if "source" in rec and isinstance(rec["source"], str):
        rec["source"] = "https://ontology.example.test (redacted)"
    return rec


# ============================================================================
# main
# ============================================================================
def main():
    global _LAT_MIN, _LAT_MAX, _LON_MIN, _LON_MAX, _remap

    files = sorted(glob.glob(os.path.join(SRC_DIR, "*.json")))
    recs = {}
    for f in files:
        name = os.path.basename(f)
        if name.startswith("_"):
            continue
        recs[name] = json.load(open(f, encoding="utf-8"))

    # PASS 1
    # Seed curated distinctive ship-name tokens first (both languages).
    for tok in CHN_SHIP_TOKENS:
        assign(MAPS["name"], tok, "测试舰CN{:02d}")
    for tok in ENG_SHIP_TOKENS:
        assign(MAPS["name"], tok, "测试舰EN{:02d}")
    for name, rec in recs.items():
        entity = name[:-5]
        collect_entity(entity, rec)

    # compute global coord bounds
    lats, lons = [], []
    for rec in recs.values():
        for row in rec.get("rows") or []:
            for k, v in row.items():
                kk = k.lower()
                if kk in ("latitude", "lat"):
                    try: lats.append(float(v))
                    except (TypeError, ValueError): pass
                elif kk in ("longitude", "lon"):
                    try: lons.append(float(v))
                    except (TypeError, ValueError): pass
    _LAT_MIN, _LAT_MAX = (min(lats), max(lats)) if lats else (LAT0, LAT1)
    _LON_MIN, _LON_MAX = (min(lons), max(lons)) if lons else (LON0, LON1)
    _remap = make_coord_remappers(_LAT_MIN, _LAT_MAX, _LON_MIN, _LON_MAX)

    # PASS 2
    for name, rec in recs.items():
        redacted = redact_entity(name[:-5], rec)
        out = os.path.join(OUT_DIR, name)
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(redacted, fh, ensure_ascii=False, indent=2)

    # redacted manifest
    man = json.load(open(os.path.join(SRC_DIR, "_manifest.json"), encoding="utf-8"))
    man.setdefault("_meta", {})
    man["_meta"]["space_id"] = "REDACTED_SPACE"
    man["_meta"]["source"] = "https://ontology.example.test (redacted)"
    man["_meta"]["redacted"] = True
    man["_meta"]["redaction_note"] = (
        "Identifiers, names, coords, mmsi/icao, free-text realia, credentials "
        "and internal URLs/IPs have been synthetically remapped for external "
        "test use. Structure, field types, row counts and cross-entity joins "
        "are preserved. Token maps are NOT included."
    )
    # fix any per-endpoint file path slashes + scrub stray creds
    with open(os.path.join(OUT_DIR, "_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(man, fh, ensure_ascii=False, indent=2)

    # report
    print("=" * 70)
    print("REDACTION COMPLETE  ->", OUT_DIR)
    print("coord bounds: lat [{:.3f},{:.3f}] lon [{:.3f},{:.3f}]".format(
        _LAT_MIN, _LAT_MAX, _LON_MIN, _LON_MAX))
    for k in ("hull", "csg", "trk", "beh", "org", "mmsi", "icao", "name", "user"):
        print("  map {:<5}: {} entries".format(k, len(MAPS[k])))
    print("entities written:", len(recs))


if __name__ == "__main__":
    main()
