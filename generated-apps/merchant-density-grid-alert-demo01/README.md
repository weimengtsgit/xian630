# 海域网格商船密度异常告警器

A maritime command dashboard that monitors merchant-ship density across US
carrier operating areas abroad using a **50-nautical-mile grid**, compares each
cell against its **30-day sliding-average baseline**, and raises green / yellow /
red alerts on sharp drops.

> This preset uses **MOCK / DEMO data** shaped for the future real AIS
> aggregation adapter. There is no backend, no live AIS feed, no API keys, and no
> login. The mock provider lives in `src/data/mock.js` and is the single place a
> real adapter will replace.

## Customer口径 (preserved verbatim)

- 接入 AIS 船舶位置数据流（mock provider named `AIS 船舶位置（mock）`）。
- 将美在外活动航母区域按边长 **50 海里** 划分网格监控。
- 统计各网格内正在活动的**商船数量**。
- 基准线取 **30 天滑动平均**。
- 商船数量突然锐减触发告警；数量正常或略高保持绿色。
- 当前数量低于基准线 **70%** 时黄灯，低于 **50%** 时红灯。
- 前端显示多个方格，每个方格内显示数量曲线。
- **每 3 分钟刷新一次**（顶部固定显示）。

## Status rule

```
ratio = currentCount / baseline30d   (baseline = 30-day sliding average)
ratio >= 0.70 → 绿灯 (green)
0.50 <= ratio < 0.70 → 黄灯 (yellow)
ratio < 0.50 → 红灯 (red)
```

The 70% / 50% thresholds are shown beside every computed status (KPI strip,
each cell, the legend, and the detail panel). Color is never the only signal —
every state also carries a 绿/黄/红 text label.

## Dashboard layout (first viewport IS the board)

- **Top bar**: title, mock badge, source name `AIS 船舶位置（mock）`, last-refresh
  time, and the literal string **每 3 分钟刷新一次**.
- **KPI strip**: total monitored grids + red/yellow/green counts + the 70%/50%
  rule stated in plain text.
- **Grid matrix**: grouped by operating zone. Each cell is a 50 海里 monitoring
  unit showing cell id + coords, current merchant count, 30-day average, ratio
  %, 绿/黄/红 status, and an inline-SVG **count sparkline** with the baseline
  drawn as a dashed reference line. Green, yellow, and red cells are all seeded
  on first load.
- **Alert list**: sorted 红 → 黄 → 绿, each row shows cell id, zone, current count,
  baseline, ratio, and the triggered threshold.
- **Detail panel**: explains the status calculation with the actual source
  values (count, 30-day baseline, ratio) and the 70%/50% rule substituted in.

## Demo tick

A local demo tick (6 s) nudges counts so the last-refresh time, sparkline
curves, ratios, and statuses visibly move. The UI still shows the customer's
real cadence **每 3 分钟刷新一次**.

## Develop / build / run

```bash
npm install
npm run dev       # http://127.0.0.1:5173
npm run build     # outputs dist/
npm run preview
```

Build command is `vite build` (no TypeScript step). Stack: React 18 +
lucide-react + Vite 6, plain JavaScript (.jsx).

### Docker

```bash
docker build -t merchant-density-grid-alert .
docker run -p 8080:80 merchant-density-grid-alert
# open http://localhost:8080
```

## Files

```
src/
  main.jsx              # React root
  app/App.jsx           # the dashboard
  data/mock.js          # MOCK AIS provider — replace with real adapter later
  styles/global.css     # dark tactical theme
.factory/app.json       # manifest (schemaVersion 1, preset, command-dashboard)
Dockerfile              # node:22-alpine build → nginx:1.27-alpine
nginx.conf              # SPA fallback + static caching
```
