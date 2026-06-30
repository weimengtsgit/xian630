---
name: deck-wind-data-skill
description: Fetch and normalize real 10 m wind data for carrier operating regions or sea areas, then provide the fields needed for deck-wind assessment. Use when a request mentions deck wind, 10 m wind, wind speed, wind direction, carrier operating area, launch or recovery wind conditions, or regional wind data. Skip this skill only when the user explicitly requests mock or demo data.
---

# Deck Wind Data Skill

## Default Rule

- Use real data by default.
- Skip this skill only when the user explicitly asks for `mock`, `demo data`, or `sample data`.
- Return failure when every real source fails. Do not synthesize wind values.

## Fallback tiers — 公网兜底（主源取不到时按序降级，绝不编造）

Fetch in this order; descend only when the higher tier fails (network error, CORS
block, non-2xx, or empty). Tag every value with the source that produced it.
1. **Primary**: Open-Meteo GFS `api.open-meteo.com/v1/gfs` (no key, CORS `*`).
2. **Alternate public APIs** (no-key, CORS): Open-Meteo other models
   (`&models=best_match` or `ecmwf`); U.S. points `api.weather.gov/gridpoints/<office>/<x,y>`
   (CORS, U.S. only).
3. **Public-web last resort**: a CORS-enabled open endpoint that exposes the value
   or a usable summary — Wikipedia REST (`/w/api.php?...&origin=*`), DuckDuckGo
   Instant Answer (`https://api.duckduckgo.com/?q=...&format=json`). "百度/Bing 公网
   搜索" is the documented intent, but a browser cannot directly fetch baidu.com etc.
   (CORS-blocked) — use only CORS-enabled endpoints here.
4. **All public sources failed**: render `SOURCE_ALL_FAILED` listing the sources
   tried — never substitute synthetic wind.

## Real Data Is MANDATORY in the generated app

When `dataPolicy` is `live_api` or `mock_then_api`, the generated application MUST
issue real HTTP requests to Open-Meteo GFS and populate its data layer from the
real response. Shipping a deterministic / synthetic / mock wind series in that
case is a **generation failure**, not a safe default — even if it "makes the
build pass". If a real fetch fails at runtime, show an explicit error/empty state
and log it in `output.json` warnings; never silently substitute fake wind.
Mock data is permitted ONLY when `dataPolicy=mock_data` or `useMock=true`.

**诚实数据审计约束**：`src/data/`（及 `src/providers/` `src/services/` `src/api/` `src/store/`
等数据层目录，或文件名以 data/provider/service/store 结尾）下的文件**禁止出现
`Math.sin`/`Math.cos`/`Math.random`** —— 诚实数据审计会据此判定为"合成数据系列"并判
生成失败。需要三角/几何/随机（风向矢量分解、甲板风合成、坐标/距离）时，把运算放进
`src/utils/` 或 `src/lib/`（非数据层），数据层文件只做取数与归一化。

## Fetch Adapter — Open-Meteo GFS (public, no key, CORS `*`, browser-fetchable)

Drop this into the generated app and call it instead of any synthetic generator.
Open-Meteo serves the GFS model's 10 m wind as hourly arrays in **knots** and
**degrees** (verified: returns real values, e.g. 11.4 kt / 162°).

```js
// src/data/windProvider.js
export async function fetchDeckWind(lat, lon, { deckWindMinKt = 20, days = 3 } = {}) {
  const url = `https://api.open-meteo.com/v1/gfs?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=${days}&time_zone=auto`;
  const res = await fetch(url);
  const j = await res.json();
  const h = j.hourly;
  if (!h || !h.time) throw new Error("Open-Meteo error: " + JSON.stringify(j).slice(0, 200));
  const cardinal = (deg) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(deg/22.5)%16];
  const series = h.time.map((t, i) => ({
    t, windSpeedKt: h.wind_speed_10m[i], windFromDeg: h.wind_direction_10m[i],
    windFromCardinal: cardinal(h.wind_direction_10m[i]),
  }));
  return { lat, lon, deckWindMinKt, series, source: "gfs-open-meteo" };
}
```

Map each requested operating region to a representative `lat/lon` (e.g. Western
Pacific ≈ 22.4/138.7, Norfolk approach ≈ 36.9/-76.3). `deckWindMinKt` is the
launch/recovery wind threshold the caller supplies.


## Trigger Mapping

- Trigger on intent about `deck wind`, `10 m wind`, `wind speed and direction`, `recovery condition`, or `launch wind`.
- Use this skill when the result must drive deck-wind calculation or readiness judgement.
- Ask for missing region coordinates only during the data-integration stage, and
  only when the region cannot be mapped safely from prior dialogue,
  `confirmedRequirement`, or the selected blueprint. In solution-design or
  code-generation stages, do NOT ask the final user; use the data-integration
  result and render a degraded state when the needed coordinate/source is still
  missing.

## Source Priority

Use sources in this order unless the caller overrides `sourcePriority`:

1. `open-meteo-gfs` — `api.open-meteo.com/v1/gfs` (the Fetch Adapter above; no key, CORS `*`).
2. `gfs-nomads` — NOAA NOMADS direct (no key; CORS varies by endpoint).
3. `weather-gov` — `api.weather.gov/gridpoints/<office>/<x,y>` (U.S. only, CORS).
4. fail

Rules:

- Prefer structured gridded data over rendered pages.
- Normalize every source to region-point wind observations before downstream calculation.
- Set `meta.isFallback=true` when the winning source is not the first usable source.

## Input Contract

Expect a payload shaped like:

```json
{
  "regions": [
    {
      "id": "western-pacific",
      "name": "Western Pacific",
      "lat": 22.4,
      "lon": 138.7
    }
  ],
  "deckWindMinKt": 20,
  "carrierMaxSpeedKt": 30,
  "sourcePriority": ["gfs-nomads", "shipxy"],
  "useMock": false,
  "timeoutMs": 10000
}
```

Interpretation:

- `regions` is required.
- `deckWindMinKt` defaults to `20` when missing.
- `carrierMaxSpeedKt` defaults to `30` when missing.
- `useMock=true` means do not use this skill.

## Output Contract

Return:

```json
{
  "ok": true,
  "meta": {
    "source": "gfs-nomads",
    "sourceLevel": "primary",
    "isFallback": false,
    "fetchedAt": "2026-06-23T15:00:00+08:00"
  },
  "data": {
    "regions": [
      {
        "id": "western-pacific",
        "region": "Western Pacific",
        "lat": 22.4,
        "lon": 138.7,
        "windSpeedKt": 26,
        "windFromDeg": 200,
        "windFromCardinal": "south-southwest",
        "deckWindMinKt": 20,
        "carrierMaxSpeedKt": 30
      }
    ]
  }
}
```

Requirements:

- Normalize wind speed to knots.
- Normalize direction to degrees and, when possible, a cardinal label.
- Return only the fields needed for downstream deck-wind calculation.
- Keep downstream calculation outside this skill unless the caller explicitly asks for the assessed range and status.

## Failure Rules

- Return `ok=false` when all real sources fail.
- Include `sourceTried`, `error.code`, and per-source failure details.
- Do not return partially inferred wind direction when the source does not provide it.

Recommended error codes:

- `INVALID_INPUT`
- `SOURCE_TIMEOUT`
- `SOURCE_AUTH_FAILED`
- `SOURCE_RESPONSE_INVALID`
- `ALL_SOURCES_FAILED`

## Must Not Do

- Do not return mock wind data.
- Do not estimate wind values from screenshots or rendered maps unless page extraction is the configured fallback path.
- Do not present calculated deck-wind readiness as source truth when only raw wind data was requested.
