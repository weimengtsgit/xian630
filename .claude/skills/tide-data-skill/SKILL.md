---
name: tide-data-skill
description: Fetch and normalize real tide forecast data for named ports or port groups. Use when a request mentions tide, tidal height, departure window, draft threshold, port forecast, Norfolk, San Diego, Bremerton, Yokosuka, or future-hour tide series. Skip this skill only when the user explicitly requests mock or demo data.
---

# Tide Data Skill

## Default Rule

- Use real data by default.
- Skip this skill only when the user explicitly asks for `mock`, `demo data`, or `sample data`.
- Return failure when every real source fails. Do not fabricate tide series.

## Trigger Mapping

- Trigger on intent about `tide`, `tidal height`, `departure window`, `draft threshold`, or `72-hour port forecast`.
- Prefer this skill for Norfolk, San Diego, Bremerton, and Yokosuka.
- Ask for missing port names or forecast horizon only when they cannot be inferred safely.

## Source Priority

Use sources in this order unless the caller overrides `sourcePriority`:

1. `noaa-coops` for Norfolk, San Diego, and Bremerton
2. `japan-tide-source` (JCG / 海上保安庁 潮汐推算) for Yokosuka — public, no key.
   Endpoint:
   `https://www1.kaiho.mlit.go.jp/TIDE/pred2/cgi-bin/TidePredCgi.cgi?area=<code>&year=<Y>&month=<M>&day=<D>`
   Port area codes (from the JCG region map; region 5 = Kanto): Yokosuka =
   `1407`, Kurihama(Yokosuka) = `1410`, Yokohama = `1403`. The response is an
   HTML page; the **毎時潮高** (hourly tide height) table holds 24 values in
   **cm** above mean sea level, laid out as two rows of 12 (hours 00–11 then
   12–23, each block preceded by a `(cm)` marker). Extract the 24 values,
   convert cm → m, map to `series`. A PNG graph
   (`tide_img/<area>_<YYYYMMDD>.png`) is also served but is not needed for
   numeric extraction. **Reachability:** the host is in `.jp`; confirm the
   deployment network can reach `www1.kaiho.mlit.go.jp` (verified HTTP 200 from
   the target environment — some sandboxes block `.jp`, which only affects
   local testing, not production).
3. `shipxy`
4. `page-scraper`
5. fail

Rules:

- Split by port when different ports need different primary sources.
- Record the actual winning source in `meta.source`.
- Set `meta.isFallback=true` when the winning source is not the first usable source.

## Input Contract

Expect a payload shaped like:

```json
{
  "ports": ["Norfolk", "San Diego", "Bremerton", "Yokosuka"],
  "hours": 72,
  "threshold": 12.8,
  "sourcePriority": ["noaa-coops", "japan-tide-source", "shipxy"],
  "useMock": false,
  "timeoutMs": 10000
}
```

Interpretation:

- `ports` is required.
- `hours` defaults to `72`.
- `threshold` is optional; pass it through when present.
- `useMock=true` means do not use this skill.

## Output Contract

Return:

```json
{
  "ok": true,
  "meta": {
    "source": "noaa-coops",
    "sourceLevel": "primary",
    "isFallback": false,
    "fetchedAt": "2026-06-23T15:00:00+08:00"
  },
  "data": {
    "ports": [
      {
        "port": "Norfolk",
        "timezone": "America/New_York",
        "threshold": 12.8,
        "series": [{"t": "2026-06-23T03:00:00-04:00", "height": 13.4}],
        "windows": [{"start": "2026-06-23T03:20:00-04:00", "end": "2026-06-23T06:10:00-04:00"}]
      }
    ]
  }
}
```

Requirements:

- Normalize each port to `{ port, timezone, threshold, series, windows }`.
- Keep `series[*]` as time-height points.
- Compute `windows` only when a threshold is available.
- Preserve source-specific timestamps only after normalizing them to ISO strings.

## Failure Rules

- Return `ok=false` when all real sources fail.
- Include `sourceTried`, `error.code`, and per-source failure details.
- Do not silently drop a port; either return that port with data or report it as failed.

Recommended error codes:

- `INVALID_INPUT`
- `SOURCE_TIMEOUT`
- `SOURCE_AUTH_FAILED`
- `SOURCE_RESPONSE_INVALID`
- `ALL_SOURCES_FAILED`

## Must Not Do

- Do not return mock tide data.
- Do not hard-code tide curves.
- Do not mark data as current when it is stale or partial.
- Do not merge ports into one shared source result without preserving per-port provenance.
