# 无人艇跟监告警智能体

Preset scene app for monitoring SEASATS test-craft candidates from customer-provided Excel data, 升级为无人艇跟监告警智能体。

## 国土告警

- 以内置 `src/data/chinaCoast.json`（中国海岸简化折线）为基准，计算每个目标轨迹到国土最近距离。
- 进入 200 海里警戒区即告警，三级：高 <80 / 中 80–140 / 低 140–200 海里（阈值在 `parameters` 可调）。
- 告警点地图上有脉冲动效；点击 AIS 开闭异常告警弹出图形化卡片。
- 当前 SEASATS 样例数据位于波斯湾/北美，不触发国土告警（逻辑正确，数据可替换）。

## Data Boundary

- `scripts/build-data.py` reads the two customer Excel files and writes `src/data/seasatsPayload.json`.
- Default source files live under `data/raw/` so the app can be regenerated without machine-local absolute paths.
- The target workbook contributes 79 latest-position targets.
- The track workbook contributes 19091 AIS points for `mmsi=338414915` (`SEASATS 55`).
- The browser loads the generated JSON as a static asset; it does not parse Excel.
- Future extension tracks can reuse the same JSON shape, but internal provenance must distinguish observed AIS, latest-position-only, and generated extension tracks.

## Judgement Rules

- Name hit: `SEASAT` or `SEASATS`, followed by `TEST` or a numeric suffix.
- Dimension hit: `4*2` is strong; `3*2` remains a review candidate.
- Low speed: inclusive `0-3 kt`.
- Sustained low-speed alert: at least 10 minutes inside one monitored area.
- Repeated activity alert: path distance divided by start-to-end displacement is at least 3 for at least 10 minutes.
- Suspected AIS interruption: same-MMSI time gap over 30 minutes; gaps over 6 hours are critical.

## Map

The map uses MapLibre GL JS with public Esri World Imagery raster tiles:

`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`

The satellite base map requires network access. If tiles are unavailable, the app shows `底图加载受限` while keeping GeoJSON business overlays visible.

## Commands

```bash
npm install
npm test
npm run build
npm run dev -- --host 127.0.0.1 --port 5179
```

To regenerate the JSON payload:

```bash
/Users/mengwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/build-data.py
```

The script defaults to:

- `data/raw/副本1a8083ce4a7ced5847024a560e3ed22b.xlsx`
- `data/raw/副本0cb4b68fa1a67179a0368da8eb82dff6.xlsx`

For a one-off rebuild with different files, pass relative or absolute paths:

```bash
SEASATS_TARGETS_XLSX=data/raw/targets.xlsx \
SEASATS_TRACKS_XLSX=data/raw/tracks.xlsx \
/Users/mengwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/build-data.py
```
