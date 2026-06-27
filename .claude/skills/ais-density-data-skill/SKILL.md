---
name: ais-density-data-skill
description: Historical-only AIS MERCHANT-density skill — free real-time AIS does not exist, so obtain historical AIS data (downloadable MarineCadastre/DMA/GFW archives, or the browser-fetchable MarineCadastre ArcGIS transit-count raster for the U.S. EEZ) and aggregate it into 50-NM density grids; if every historical source is unreachable, fall back to CORS public-web endpoints — never fabricate vessel counts. Use when a request mentions AIS, merchant density, shipping density, 50-nautical-mile grid, vessel traffic analysis, or historical shipping density. MERCHANT SHIPPING ONLY — military vessels (carriers/warships/destroyers/cruisers/frigates/amphibs/any navy vessel) are NOT served here; their AIS tracks come from the ontology RawAISData entity via carrier-affiliation-data-skill. It does NOT fetch real-time data or call paid AIS APIs. Skip only when the user explicitly requests mock/demo data.
---

# AIS Density Skill

## Merchant-only — military AIS routes elsewhere

This skill is **merchant / commercial shipping density only**. AIS data in this
factory is split by TARGET FLEET:

- **Merchant density** (商船, cargo, tankers — aggregate counts per 50-NM cell,
  US EEZ, annual) → **this skill** (NOAA MarineCadastre).
- **Military vessels** — carriers, warships, destroyers, cruisers, frigates,
  amphibious ships, supply ships, ANY navy/naval vessel, per-vessel tracks by
  MMSI → **`carrier-affiliation-data-skill`** (ontology `RawAISData` entity,
  ~48 US-Navy vessels, global, ~weeks-fresh). MarineCadastre carries only
  merchant traffic and would show ~0 military vessels.

If the request targets a military vessel in any way (航母 / 舰船 / 军舰 / 舰艇 /
驱逐舰 / 巡洋舰 / 护卫舰 / 两栖舰 / 舰队 / 军队 / warship / naval / navy /
destroyer / cruiser / frigate …), STOP and defer to `carrier-affiliation-data-
skill`'s `RawAISData` adapter — do NOT build a merchant density grid for it.
Conversely, never serve a merchant-density request from `RawAISData` (it holds
only ~48 military vessels). The server-side `deriveDataSkills` router maps
military terms to the carrier skill; this skill stays merchant-only.

## Default Rule

- Use **real, free, no-key public AIS data** only — it is **historical/annual**
  (there is no free real-time AIS feed), never live site scraping, never a paid
  API. For zones overlapping the **U.S. EEZ**, prefer the browser-fetchable
  MarineCadastre ArcGIS REST path (below). For non-U.S. zones, use downloadable
  historical archives processed offline. No API key.
- Coverage is limited to the regions each free source publishes. If the
  requested sea area is outside all free sources' coverage, return `ok=false`
  with `COVERAGE_NOT_AVAILABLE` — do NOT fall back to paid sources (shipxy /
  aishub).
- Historical data is inherently stale; always report how recent it is.
- Return failure when every applicable source fails. Do not fabricate vessel counts.

## Fallback tiers — 公网兜底（主源取不到时按序降级，绝不编造）

Fetch in this order; descend only when the higher tier fails (network error, CORS
block, non-2xx, or empty). Tag every value with the source that produced it.
1. **Primary**: MarineCadastre AIS Vessel Transit Counts ArcGIS REST
   (`coast.noaa.gov/.../AISVesselTransitCounts<YEAR>/MapServer/identify`) for the
   U.S. EEZ (no key, CORS, browser-fetchable).
2. **Alternate public sources**: a different `<YEAR>` on the same service; another
   MarineCadastre / NOAA ArcGIS traffic or vessel layer.
3. **Public-web last resort**: a CORS-enabled open endpoint that exposes the value
   or a summary — Wikipedia REST (`/w/api.php?...&origin=*`), DuckDuckGo Instant
   Answer (`https://api.duckduckgo.com/?q=...&format=json`). "百度/Bing 公网搜索" is
   the documented intent, but a browser cannot directly fetch baidu.com etc.
   (CORS-blocked). For zones outside the U.S. EEZ with no CORS source, this tier
   usually cannot supply live counts — descend to tier 4 honestly.
4. **All public sources failed**: render the **Degraded State** defined in
   `software-factory-app`（顶部说明 banner + 结构预览骨架，**不含任何编造数值** + 数据源链接 + 恢复说明），并列出已尝试的源 —— never fabricate vessel counts.

## Real Data Is MANDATORY — preferred browser-fetchable source for U.S. waters

MarineCadastre (NOAA/BOEM) publishes **AIS Vessel Transit Counts per year
(2019-2025)** as a CORS-enabled ArcGIS REST raster MapServer that a static
browser app CAN fetch directly — no key, no backend, no GB download. This is the
preferred real source whenever the requested zone overlaps the U.S. EEZ (e.g.
Norfolk, San Diego, Bremerton, Pearl Harbor, Mayport carrier homeports).

**Endpoint — verified reachable from CN without proxy, CORS open, returns JSON:**
`https://coast.noaa.gov/arcgis/rest/services/MarineCadastre/AISVesselTransitCounts<YEAR>/MapServer`
Use `?f=json` for layer metadata, and `/identify` for a real transit count at a
point:
`/identify?geometry={"x":<lon>,"y":<lat>}&geometryType=esriGeometryPoint&sr=4326&layers=all:0&tolerance=3&mapExtent=<bbox>&imageDisplay=400:400:96&f=json`
→ `results[].attributes["UniqueValue.Pixel Value"]` is the integer AIS transit
count for that cell in `<YEAR>` (layer 0 is a raster; extent covers the U.S.
EEZ in Web Mercator). Verified real values: San Diego approach 2024 = 3,
Norfolk approach 2024 = 1.

To build a density grid: place grid-cell centroids inside U.S. waters, call
`identify` on each for the latest year and for the historical years, tag every
value `source = "NOAA MarineCadastre AIS Vessel Transit Counts <YEAR>"`, and
treat the data as **historical/annual** (NOT real-time). Compute anomaly as
current-year count vs the historical multi-year mean per cell — the skill is
historical-only, so do NOT claim a 3-minute real-time feed; refresh re-fetches
the same annual raster. Yokosuka (Japan) and other non-U.S. zones are outside
this service's coverage — handle them as `COVERAGE_NOT_AVAILABLE`.

## Outside U.S. EEZ — AIS is NOT browser-fetchable

For zones outside the U.S. EEZ (e.g. Philippine Sea, Western Pacific, South China
Sea), historical AIS is **gigabyte-scale archive download** with no CORS browser
API, so the generated app CANNOT `fetch()` it live. When `dataPolicy` is
`live_api`/`mock_then_api` and the zone is outside U.S. EEZ, the app MUST do one
of these — and **never** invent `MOCK_CELLS` / synthetic density numbers:

1. **Load a real historical density sample** that ships with the repo (a JSON
   whose every field carries provenance: `source`, `dateRange`, `coverageNote`,
   `dataAsOf`). Display it labeled "历史样本 / historical sample", not "live".
2. **If no real sample exists for the requested zone**, render an explicit
   `COVERAGE_NOT_AVAILABLE` / "需下载历史归档" state — empty grid + the real
   source link — NOT a green heat-map of fake counts.

Fabricating vessel counts to "make the demo look full" is a **generation
failure**. Mock data is permitted ONLY when `dataPolicy=mock_data` or
`useMock=true`, and even then must be labeled as mock.

## Real download sources (one-time, offline processing — for non-U.S. zones)

- `marinecadastre` — NOAA/BOEM U.S. AIS Vessel Traffic Data. **U.S. EEZ only.**
  For browser apps, prefer the ArcGIS REST `identify` raster path above. For
  bulk processing use the ArcGIS hub / AWS Open Data per-month files, aggregate
  to a 50-NM grid offline, then ship the resulting small JSON as the real sample.
- `dma` — Danish Maritime Authority bulk AIS CSV (`aisdata.ais.dk`). Danish
  waters only.
- `gfw` — Global Fishing Watch (global, fishing-oriented; free account/token).

If the brief targets a sea outside all free sources (e.g. Philippine Sea, deep
Western Pacific), the correct app behavior is option 2 (coverage-not-available),
not invented data.


## Trigger Mapping

- Trigger on intent about `AIS`, `merchant density`, `shipping density`,
  `50-nautical-mile grid`, `historical vessel traffic`, or `shipping traffic
  analysis`.
- Use this skill when the output is a density grid over a historical period
  (counts/means per cell), NOT a real-time alert.

## Source Priority

Use sources in this order, picking the one whose coverage includes the requested zone:

1. `marinecadastre` — NOAA/BOEM U.S. AIS Vessel Traffic Data. Free, no key,
   downloadable (ArcGIS hub / AWS Open Data). **Covers U.S. waters and EEZ
   only.** Historical archives, typically weeks-to-months behind real time.
2. `dma` — Danish Maritime Authority historical AIS. Free, no key, bulk CSV at
   `aisdata.ais.dk`. **Covers Danish waters only.**
3. `gfw` — Global Fishing Watch public data. Global coverage (includes merchant
   tracks), but **fishing-analysis oriented and requires a free account/token**.
   Use only when the caller accepts a free token.
4. fail

Rules:

- Prefer structured archives over rendered pages.
- Filter to merchant-like vessel types before counting.
- Record the winning source in `meta.source` and its coverage limit in
  `meta.coverageNote`.
- If no source covers the requested zone, fail with `COVERAGE_NOT_AVAILABLE`.

## Input Contract

Expect a payload shaped like:

```json
{
  "zones": [
    {
      "id": "us-west-coast",
      "name": "U.S. West Coast Approaches",
      "bbox": {"minLat": 30.0, "maxLat": 48.0, "minLon": -128.0, "maxLon": -117.0}
    }
  ],
  "gridSizeNm": 50,
  "dateRange": {"from": "2024-01-01", "to": "2024-12-31"},
  "shipFilter": {
    "includeTypes": ["merchant"],
    "excludeTypes": ["navy", "fishing", "unknown"]
  },
  "source": "marinecadastre"
}
```

Interpretation:

- `zones` is required (bbox per zone).
- `gridSizeNm` defaults to `50`.
- `dateRange` is required — this is a historical skill; specify a period. If the
  user says "recent", use the most recent full period the chosen source publishes.
- `source` is optional; auto-select by zone coverage when omitted.

## Output Contract

Return:

```json
{
  "ok": true,
  "meta": {
    "source": "marinecadastre",
    "dateRange": {"from": "2024-01-01", "to": "2024-12-31"},
    "dataAsOf": "2024-12-31",
    "freshnessNote": "Historical archive; not real-time. Source lags weeks-to-months.",
    "coverageNote": "U.S. waters/EEZ only."
  },
  "data": {
    "cells": [
      {
        "id": "us-west-coast-r03-c11",
        "zoneId": "us-west-coast",
        "zoneName": "U.S. West Coast Approaches",
        "row": 3,
        "col": 11,
        "lat": 36.0,
        "lon": -123.0,
        "sizeNm": 50,
        "periodCount": 18420,
        "dailyMean": 50.4,
        "daysWithCoverage": 365,
        "status": {"level": "info", "label": "historical density"},
        "lastUpdated": "2024-12-31"
      }
    ]
  }
}
```

Requirements:

- Normalize source vessel messages before grid aggregation; count only merchant
  vessels after type filtering.
- `periodCount` = total merchant vessel-presence observations over the range;
  `dailyMean` = periodCount / daysWithCoverage.
- Use status `info` (historical density). Do NOT emit real-time red/yellow/green
  alerts — there is no live baseline.
- Mark cells with partial coverage (missing days) explicitly in
  `daysWithCoverage`.

## Failure Rules

- Return `ok=false` when no free source covers the requested zone or every
  source fails. In the generated app this terminal MUST render the **Degraded
  State** from `software-factory-app`（banner + 结构预览，**无数造数值** + 已尝试源 + 重试），而不是一行裸错误串。
- Include `sourceTried`, `error.code`, and per-source failure details.

Recommended error codes:

- `INVALID_INPUT`
- `COVERAGE_NOT_AVAILABLE` (requested zone outside all free sources, e.g.
  Philippine Sea / deep Western Pacific)
- `SOURCE_UNREACHABLE`
- `FORMAT_CHANGED` (archive layout changed; scraper needs updating)
- `NO_DATA_FOR_RANGE`
- `ALL_SOURCES_FAILED`

## Must Not Do

- Do not call real-time AIS APIs (shipxy, aishub, etc.) — this is historical-only.
- Do not scrape live tracking sites.
- Do not fabricate or estimate vessel counts.
- Do not present historical density as live or real-time.
- Do not silently use a free-token source (GFW) without surfacing that it needs registration.

**诚实数据审计约束**：`src/data/`（及 `src/providers/` `src/services/` `src/api/` `src/store/`
等数据层目录，或文件名以 data/provider/service/store 结尾）下的文件**禁止出现
`Math.sin`/`Math.cos`/`Math.random`** —— 诚实数据审计会据此判定为"合成数据序列"并判
生成失败。网格中心点、大圆距离、经纬度投影等三角/几何运算请放进 `src/utils/` 或
`src/lib/`（非数据层），数据层文件只做 identify 取数与归一化。
