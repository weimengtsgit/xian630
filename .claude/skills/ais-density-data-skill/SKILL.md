---
name: ais-density-data-skill
description: Fetch real AIS data for sea areas, normalize vessel points, and aggregate them into merchant-density grid results with baseline comparison. Use when a request mentions AIS, merchant density, shipping density, 50-nautical-mile grid, baseline comparison, merchant count, or grid-based maritime anomaly detection. Skip this skill only when the user explicitly requests mock or demo data.
---

# AIS Density Data Skill

## Default Rule

- Use real data by default.
- Skip this skill only when the user explicitly asks for `mock`, `demo data`, or `sample data`.
- Return failure when every real source fails. Do not generate fake vessel density.

## Trigger Mapping

- Trigger on intent about `AIS`, `merchant density`, `grid alert`, `50-nautical-mile`, or `30-day sliding average`.
- Use this skill when the output must contain current merchant count, baseline, ratio, or red-yellow-green density status.
- Ask for missing sea-area bounds only when the monitored zone cannot be inferred safely.

## Source Priority

Use sources in this order unless the caller overrides `sourcePriority`:

1. `shipxy`
2. `aishub`
3. fail

Rules:

- Prefer structured AIS APIs over page scraping.
- Filter to merchant-like vessel types before counting.
- Set `meta.isFallback=true` when the winning source is not the first usable source.

## Input Contract

Expect a payload shaped like:

```json
{
  "zones": [
    {
      "id": "philippine-sea",
      "name": "Philippine Sea",
      "bbox": {
        "minLat": 14.0,
        "maxLat": 18.0,
        "minLon": 130.0,
        "maxLon": 135.0
      }
    }
  ],
  "gridSizeNm": 50,
  "baselineWindowDays": 30,
  "shipFilter": {
    "includeTypes": ["merchant"],
    "excludeTypes": ["navy", "fishing", "unknown"]
  },
  "sourcePriority": ["shipxy", "aishub"],
  "useMock": false,
  "timeoutMs": 10000
}
```

Interpretation:

- `zones` is required.
- `gridSizeNm` defaults to `50`.
- `baselineWindowDays` defaults to `30`.
- `useMock=true` means do not use this skill.

## Output Contract

Return:

```json
{
  "ok": true,
  "meta": {
    "source": "shipxy",
    "sourceLevel": "primary",
    "isFallback": false,
    "fetchedAt": "2026-06-23T15:00:00+08:00"
  },
  "data": {
    "thresholds": {
      "yellow": 0.7,
      "red": 0.5
    },
    "cells": [
      {
        "id": "philippine-sea-r00-c00",
        "zoneId": "philippine-sea",
        "zoneName": "Philippine Sea",
        "row": 0,
        "col": 0,
        "lat": 16.0,
        "lon": 132.0,
        "sizeNm": 50,
        "currentCount": 31,
        "baseline30d": 64,
        "ratio": 0.4844,
        "status": {
          "level": "red",
          "label": "red"
        },
        "history": [62, 61, 63, 60, 59, 31],
        "lastUpdated": "2026-06-23T15:00:00+08:00"
      }
    ]
  }
}
```

Requirements:

- Normalize source vessel points before grid aggregation.
- Count only merchant vessels after filtering.
- Compute `ratio = currentCount / baseline30d` when baseline exists.
- Use `green/yellow/red` with thresholds `0.7` and `0.5`.
- Return `unknown` status when baseline is missing instead of inventing one.

## Failure Rules

- Return `ok=false` when all real sources fail.
- Include `sourceTried`, `error.code`, and per-source failure details.
- Do not fall back to social data or text mentions for vessel density.

Recommended error codes:

- `INVALID_INPUT`
- `SOURCE_TIMEOUT`
- `SOURCE_AUTH_FAILED`
- `SOURCE_RESPONSE_INVALID`
- `BASELINE_MISSING`
- `ALL_SOURCES_FAILED`

## Must Not Do

- Do not return mock AIS density.
- Do not mix social posts or text mentions into `currentCount`.
- Do not hide baseline absence; mark the affected cell as `unknown`.
