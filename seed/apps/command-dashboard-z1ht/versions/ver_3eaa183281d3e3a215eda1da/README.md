# 美海军航母甲板风起降条件评估（command-dashboard-z1ht）

面向作战值班与参谋人员的指挥仪表盘（软件工厂生成应用，React + Vite 静态 SPA + nginx 同源反向代理）。

## 功能

- 接入 **Open-Meteo GFS 公开朗格 10 米风场**（免鉴权公开 API，单位原生节/度，当前 UTC 小时槽）。
- 接入 **本体 DaaS AviationCarrier 公开情报航母位置库**（经 nginx 服务端反代注入鉴权），过滤仅保留美海军现役航母（CVN），并标注位置时效。
- 固定判定模型（常量不可被数据覆盖）：
  - 甲板风阈值 **20 节**；航母最大航速 **30 节**；
  - 可实现甲板风范围 **[|W−30|, W+30]**（W 为该舰活动区域 10 米自然风速）；
  - 四级分级：`|W−30| ≥ 20` 满足（全向）；`|W−30| < 20 ≤ W+30` 条件满足（需顶风最大航速）；`W+30 < 20` 不满足；数据失败/不可信 **无法判定**；
  - 「无弹射器辅助起飞」与「安全着舰」两项判定共用 20 节阈值（`W+30 ≥ 20` 即可行）。
- **每 5 分钟自动刷新**（常显倒计时）+ 立即刷新；界面同时展示风场数据时间（validTime，UTC）与航母位置时效。
- 主从双栏指挥台布局：顶部状态栏（双源状态灯/数据时间/倒计时）→ 全局告警条 → 关键指标 → 航母态势矩阵（筛选/搜索/行选中）→ 单舰下钻详情（矢量合成计算明细、甲板风范围条与 20 节阈值线、判定依据、数据健康度、AIS 佐证）。
- 响应式：≥960px 双栏；<960px 单列堆叠并隐藏矩阵次要列；<640px 仅保留舰名/风速/判定等核心列，指标卡两列换行。

## 诚实数据策略（dataPolicy = live_api）

全部数据在运行时经真实公开请求获取，**绝不使用合成/伪造数值**：

| 数据域 | 主源 | 降级序 | 全部失败时 |
|---|---|---|---|
| 风场 | Open-Meteo GFS `/v1/gfs` | Open-Meteo best_match `/v1/forecast?models=best_match` | 显式降级态：失败原因 + 已尝试来源 + 手动重试 + 结构预览 + 官方源链接；相关舰判定「无法判定」 |
| 航母位置 | 本体 DaaS `AviationCarrier` | 内置静态默认活动区域代表点（公开常识，界面显著标注「非当前位置」） | 见左：静态降级仍可按默认区域评估，位置时效列显示不可用 |
| AIS 佐证（可选） | 本体 DaaS `RawAISData`（按 mmsi 小样本） | 无（仅佐证，不作位置真值） | 静默跳过并标注未启用 |

时效口径：位置 `dataUpdateTime` ≤72h 正常、72h–7d 陈旧（结论仅供参考）、>7d 深度陈旧（醒目警示）；风场槽龄 >2h 标注陈旧。

## 运行

```bash
npm install
npm run dev      # 开发（5173，经 vite proxy 走同源 /api/ 路径）
npm run build    # 产出 dist/index.html（完全离线，无构建期取数）
```

容器（Podman/Docker）：

```bash
podman build -t command-dashboard-z1ht .
podman run -p 8080:80 command-dashboard-z1ht
```

**环境要求**：容器需可访问公网 DNS 与 `api.open-meteo.com`（风场）；本体 DaaS（`ceshi.projects.bingosoft.net:8081`）可达时位置库生效，否则应用按上表降级并显著标注。无外网环境将呈现诚实降级态，不展示任何伪造数值。

## 网络路径与凭证

- 浏览器 JS 一律请求**同源** `/api/wind/*`、`/api/ontology/*`，由 nginx 反向代理转发到外部源（规避 CORS）。
- 本体 DaaS 的鉴权头（Authorization / Spaceid / scopeType）**仅在部署侧 nginx 配置（`nginx.conf`）注入**，不进入前端源码、静态构建产物、README 用户文档或浏览器。
- 所有 `proxy_pass` 使用 nginx 变量 + resolver，DNS 在请求期解析，容器 DNS 暂时不可达不会导致 nginx 启动失败。

## 目录结构

```
.factory/app.json          # 工厂 manifest
nginx.conf                 # 静态托管 + /api/wind、/api/ontology 反向代理
Dockerfile                 # node:20 构建 → nginx:1.27 运行
src/
  constants.js             # 判定常量（20/30 节）、时效阈值、公开常识在册清单与默认活动区域
  utils/deckWind.js        # 甲板风矢量合成与四级分级（判定核心，可复核）
  utils/timeFormat.js      # 时效分级与时间格式化（当前 UTC 小时槽定位）
  utils/seaArea.js         # 海域框推定
  data/ontologyClient.js   # 本体 DaaS 请求客户端（pageParam/rowType=map、resultCode===200）
  data/windProvider.js     # Open-Meteo GFS → best_match 降级序（批量优先，逐点回退）
  data/carrierPositionProvider.js  # AviationCarrier 取数、CVN 过滤、静态降级
  data/aisProvider.js      # RawAISData AIS 佐证（可选，失败静默）
  data/assessmentProvider.js       # 编排：位置+风场 → 逐舰判定/指标/告警/双源健康度
  components/              # 顶部状态栏 / 告警条 / 指标 / 态势矩阵 / 单舰详情 / 范围条 / 降级态
  App.jsx                  # 五态状态机（default/loading/empty/error/stale）+ 5 分钟轮询
```

## 已知局限（如实告知）

- GFS 网格约 0.11°（约 11 km），对航母尺度为**区域近似评估**，界面标注格点坐标。
- 公开情报位置存在时效滞后，位置时间与风场时间可能不匹配，判定为当前位置时刻的近似评估。
- 矢量合成为简化模型（自然风叠加航速近似），未计入弹射器状态、机型、海况等因素，结论仅供值班参考。
- AIS 佐证来自本体历史存档，滞后明显，仅作时效佐证、不作位置真值。
