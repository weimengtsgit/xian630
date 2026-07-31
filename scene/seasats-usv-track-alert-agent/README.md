# 无人艇跟监告警智能体

Preset scene app for monitoring SEASATS test-craft candidates from customer-provided Excel data, 升级为无人艇跟监告警智能体。

## 国土告警

- 以内置 `src/data/chinaCoast.json`（中国海岸简化折线）为基准，计算每个目标轨迹到国土最近距离。
- 进入 200 海里警戒区即告警，三级：高 <80 / 中 80–140 / 低 140–200 海里（阈值在 `parameters` 可调）。
- 告警点地图上有脉冲动效；点击 AIS 开闭异常告警弹出图形化卡片。
- 当前 SEASATS 样例数据位于波斯湾/北美，不触发国土告警（逻辑正确，数据可替换）。

## Data Boundary

- 运行时数据源为本体 `RawAISData`，浏览器不会再加载 `src/data/seasatsPayload.json` 或解析 CSV/Excel。
- `server/app-server.js` 在服务端注入本体鉴权信息，提供同源的摘要接口和按 MMSI 轨迹接口；令牌不会发送给浏览器。
- 页面打开时，仅对部署配置 `MONITORED_MMSI` 中的船只从本体获取完整 AIS；服务端仅保留 `2025-01-01`（含）之后的报点，按业务字段去重并排序。多个 MMSI 使用逗号分隔，例如 `MONITORED_MMSI=338555318,338414915`。
- 本体接口单次查询匹配量超过 20w 行会静默截断（其分页模式返回重复/错误页，不可用）。服务端先轻量探测窗口 `recordTotal`，≤15w 单请求拿全量，超限按 月→日→二分（下限 1 小时）递归细分，绝不使用分页。
- 去重后的轨迹按 MMSI 落盘到 `server/data/tracks/`，重启后只从水位线回退 2 小时拉增量合并；后台每 30 分钟增量刷新一次，避免每次全量重拉。
- `RawAISData` 的字段为 `mmsi`、`latitude`、`longitude`、`sog`、`courseOverGround`、`trueHeading`、`navigationalStatus`、`typeCode`、`startTime`、`dataUpdateTime`。它不提供 CSV 中的 `LENGTH/width`，界面会如实显示“接口未提供尺寸”。
- `server/seasatsScope.js` 只保存受监测 MMSI 范围，不保存位置或轨迹；新增受监测艇时更新此范围即可。

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
npm start
# 另一个终端（开发环境）
npm run dev -- --host 127.0.0.1 --port 5179
```
