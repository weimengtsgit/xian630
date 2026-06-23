---
name: ais-density-data-skill
description: Download and process HISTORICAL AIS archives (MarineCadastre / DMA / GFW public data, all free and no-API-key) into merchant-density grids over a date range. Use when a request mentions AIS, merchant density, shipping density, 50-nautical-mile grid, vessel traffic analysis, or historical shipping density. This skill is historical-only — it does NOT fetch real-time data or call paid AIS APIs. Skip only when the user explicitly requests mock/demo data.
---

# AIS Density Skill

## Default Rule

- Use **historical downloadable AIS archives** only. No real-time API, no live
  site scraping, no API key.
- Coverage is limited to the regions each free source publishes. If the
  requested sea area is outside all free sources' coverage, return `ok=false`
  with `COVERAGE_NOT_AVAILABLE` — do NOT fall back to paid sources (shipxy /
  aishub).
- Historical data is inherently stale; always report how recent it is.
- Return failure when every applicable source fails. Do not fabricate vessel counts.

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
  source fails.
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
