# 开源社区异常监测 · 社媒海上目击聚合告警地图

Social-sighting cluster alert dashboard — a maritime command board that ingests
(mocks of) public Twitter + Instagram posts matching carrier/warship/large-ship/
at-sea keywords in multiple languages, extracts GPS geotag or image-EXIF
coordinates, scatters them on a global sea-area map, and highlights clusters
where multiple distinct accounts post similar content in the same sea area
during a short window (a suspected **目击潮** / sighting tide).

## 数据边界 / Data is mock

All data is **mock / demo** produced by `src/data/mock.js`, shaped like the
future social-search / ingest adapter (Twitter & Instagram public search, GPS
geotag + image EXIF coordinate extraction, cluster aggregation). There is:

- **No real Twitter/Instagram API.**
- **No scraping, no fetch, no keys, no login, no backend, no cloud.**

A local demo tick (≈7 s) prepends a synthetic "new post" to the stream and
advances the last-fetch clock, while the top bar keeps showing the customer's
verbatim cadence **「每 15 分钟抓取一次新帖」**.

## What the board shows (first viewport = the operational board)

- **Top bar** — title, source state (`源：社媒公开搜索（mock）· Twitter + Instagram`,
  mock badge), last-fetch time, and the literal `每 15 分钟抓取一次新帖` cadence
  plus a display-only countdown.
- **Global sea-area scatter map** (inline SVG, no maplibre) with two layers:
  1. **Scatter layer** — one glyph per geotagged post. Encoding:
     - **Platform** = hue + shape (Twitter = cyan circle, Instagram = amber square).
     - **Coord source** = fill style (GPS 标签 = solid filled, 图片 EXIF = ringed/hollow).
     - The legend explains both encodings so color is never the only signal.
  2. **Cluster-highlight layer** — pulsing rings over regions where multiple
     distinct accounts posted similar content in a short window. Suspected 目击潮
     clusters render red, non-tide clusters amber.
  - A layer toggle turns each layer on/off; both are on by default.
- **Cluster detail panel** (right rail) — per-cluster: region name, distinct
  account count, post count, time window (start → end + minutes), keywords,
  languages, platforms, and the suspected 目击潮 hint with the judgement basis.
  At least one cluster (C1, Philippine Sea) is flagged as a likely 目击潮.
- **New-post stream** (bottom rail) — newest first; each row shows platform,
  account, language, matched keyword (命中关键词), coordinate source (GPS 标签 /
  图片 EXIF), time, text, and a similar-content summary.

## Customer口径 preserved verbatim

- 接入推特 (Twitter) 和 Instagram 的公开搜索接口 (mocked).
- 关键词：航母 / 军舰 / 大船 / 海上 + EN (carrier / warship / large ship / at sea),
  JA (空母 / 軍艦 / 海上), RU (авианосец). Multiple languages are surfaced.
- 限定地理范围：全球海域.
- GPS 标签 or 图片 EXIF 经纬度 (visually distinguished).
- 散点图 + 同海域短时间多账号聚合高亮.
- **目击潮** hint (exact term used).
- **每 15 分钟抓取一次新帖** (exact cadence string in the top bar).

## Stack

- Plain JavaScript (`.jsx`) — React 18 + lucide-react + Vite 6.
- Build = `vite build` only (no `tsc`). Map = inline SVG (no maplibre / tiles).

## Develop / build / run

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # -> dist/
npm run preview
```

Docker:

```bash
docker build -t social-sighting-cluster-alert .
docker run -p 8080:80 social-sighting-cluster-alert
```

## Mock payload shape (`src/data/mock.js`)

```js
{
  source: "社媒公开搜索（mock）",
  platforms: ["twitter", "instagram"],
  cadenceText: "每 15 分钟抓取一次新帖",
  cadenceMinutes: 15,
  keywordGroups: [{ lang, label, terms[] }, ...],  // multilingual keywords
  coordSources: [{ code: "gps", label: "GPS 标签" }, { code: "exif", label: "图片 EXIF" }],
  lastFetchAt: ISO,
  posts: [{ id, platform, account, language, keyword, coordSource, lat, lon, text, time, similarSummary }],
  clusters: [{ id, regionName, lat, lon, accountCount, postCount, timeWindowStart, timeWindowEnd, windowMinutes, keywords[], languages[], platforms[], radiusDeg, suspectedSightingTide, hint }]
}
```

This shape is designed for direct replacement by a future social-search /
ingest adapter that calls the real (rate-limited, authenticated) Twitter &
Instagram public search endpoints.
