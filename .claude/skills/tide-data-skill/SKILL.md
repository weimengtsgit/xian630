---
name: tide-data-skill
description: Fetch and normalize real tide forecast data for named ports or port groups. Use when a request mentions tide, tidal height, departure window, draft threshold, port forecast, Norfolk, San Diego, Bremerton, Yokosuka, or future-hour tide series. Skip this skill only when the user explicitly requests mock or demo data.
---

# Tide Data Skill

## Default Rule

- Use real data by default.
- Skip this skill only when the user explicitly asks for `mock`, `demo data`, or `sample data`.
- Return failure when every real source fails. Do not fabricate tide series.

## Fallback tiers — 公网兜底（主源取不到时按序降级，绝不编造）

Fetch in this order; descend only when the higher tier fails (network error, CORS
block, non-2xx, or empty). Tag every value with the source that produced it.
1. **Primary**: NOAA CO-OPS `api.tidesandcurrents.noaa.gov` (no key, CORS `*`).
2. **Alternate public sources**: the port's own hydrographic-office CORS endpoint
   if available; JCG `www1.kaiho.mlit.go.jp` for Yokosuka (server-side / build-time —
   no browser CORS, so route via a proxy when the app is static).
3. **Public-web last resort**: a CORS-enabled open endpoint that exposes the value
   or a usable summary — Wikipedia REST (`/w/api.php?...&origin=*`), DuckDuckGo
   Instant Answer (`https://api.duckduckgo.com/?q=...&format=json`). "百度/Bing 公网
   搜索" is the documented intent, but a browser cannot directly fetch baidu.com etc.
   (CORS-blocked) — use only CORS-enabled endpoints here.
4. **All public sources failed**: render `SOURCE_ALL_FAILED` listing the sources
   tried — never substitute a synthetic tide curve.

## Real Data Is MANDATORY in the generated app

When `dataPolicy` is `live_api` or `mock_then_api`, the generated application MUST
issue real HTTP requests to NOAA CO-OPS (and/or JCG) and populate its data layer
from the real response. Shipping a deterministic / synthetic / mock tide curve in
that case is a **generation failure**, not a safe default — even if it "makes the
build pass". If a real fetch fails at runtime, show an explicit error/empty state
and log it in `output.json` warnings; never silently substitute fake heights.
Mock data is permitted ONLY when `dataPolicy=mock_data` or `useMock=true`.

**诚实数据审计约束**：`src/data/`（及 `src/providers/` `src/services/` `src/api/` `src/store/`
等数据层目录，或文件名以 data/provider/service/store 结尾）下的文件**禁止出现
`Math.sin`/`Math.cos`/`Math.random`** —— 诚实数据审计会据此判定为"合成数据序列"并判
生成失败。需要三角/几何/随机（基准转换、窗口判定、网格、距离、投影）时，把运算放进
`src/utils/` 或 `src/lib/`（非数据层），数据层文件只做取数与归一化。

## Fetch Adapter — NOAA CO-OPS (public, no key, CORS `*`, browser-fetchable)

Drop this into the generated app and call it instead of any synthetic generator.
NOAA returns hourly tide **predictions** in **meters above MLLW** as
`{predictions:[{t:"YYYY-MM-DD HH:mm", v:"0.163"}, ...]}`.

```js
// src/data/tideProvider.js
const STATIONS = {
  norfolk:  { id: "8638610", nameZh: "诺福克",   tz: "America/New_York" },
  sandiego: { id: "9410170", nameZh: "圣迭戈",   tz: "America/Los_Angeles" },
  // Bremerton's own station 9446486 does NOT publish MLLW predictions; use the
  // Seattle/Puget Sound predictions station as the working nearby source.
  bremerton:{ id: "9447130", nameZh: "布雷默顿(普吉特湾)", tz: "America/Los_Angeles" },
  // 横须贺用 JCG（见 Source Priority），无 CORS，需服务端/构建期取数。
};
const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`;
export async function fetchTideSeries(portKey, days = 3) {
  const st = STATIONS[portKey];
  if (!st) throw new Error("unknown port: " + portKey);
  const start = new Date();
  const end = new Date(Date.now() + days * 86400000);
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${st.id}&product=predictions&datum=MLLW&units=metric&format=json&interval=h&begin_date=${ymd(start)}&end_date=${ymd(end)}&time_zone=lst_ldt`;
  const res = await fetch(url);
  const j = await res.json();
  if (!j.predictions) throw new Error("NOAA error: " + JSON.stringify(j).slice(0, 200));
  return {
    port: portKey, nameZh: st.nameZh, timezone: st.tz, source: "noaa-coops",
    series: j.predictions.map((p) => ({ t: p.t, height: Number(p.v) })), // 米，MLLW 基准
  };
}
```

Datum note: NOAA `MLLW` heights for these ports are small (~0.0–1.5 m). Any
departure-window threshold in the app must be expressed in the **same datum**
(meters above MLLW); do not compare MLLW heights against an unrelated "12.8 m
draft" number. Verify each `STATIONS` id at
`https://tidesandcurrents.noaa.gov/stations.html` if a port is added.


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
