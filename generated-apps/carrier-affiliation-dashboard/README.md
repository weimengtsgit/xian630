# 航母归属推断仪表板 (Carrier Affiliation Dashboard)

基于本体 DaaS 数据的航母-舰载机归属推断仪表板。

## 数据源

本体 Ontology DaaS API（`ceshi.projects.bingosoft.net:8081`），经 nginx 反向代理访问。

## 技术栈

- React 18 + Vite 5
- 纯静态 SPA，无后端

## 本地开发

```bash
npm install
npm run dev      # 访问 http://localhost:5173
```

Vite dev server 已配置 `/api/ontology` 代理到 DaaS。

## 生产构建

```bash
npm run build    # → dist/
```

## Docker 部署

```bash
podman build -t carrier-affiliation-dashboard .
podman run -p 8080:80 carrier-affiliation-dashboard
```

## 字段契约

取数时必须使用 DaaS 原始字段名：

| 实体 | 请求字段 | UI 归一化后 |
|------|---------|-----------|
| AviationCarrier | `curHeading`, `curSpeed`, `homeportStation` | `heading`, `speed`, `homeport` |
| RawADSData | `lat`, `lon`, `groundspeed`, `startTime` | `lat`, `lon`, `speed_kt`, `time` |
| AircraftCarrierTrackLog | `refAviationCarrier`, `trackInitTime` | `carrierId`, `time` |

**严禁请求 `heading`/`speed`/`homeport`**（AviationCarrier）、**`longitude`/`latitude`/`speed`/`recordTime`**（RawADSData）——
这些字段在 DaaS 中不存在，会导致 HTTP 400。

## 推断模式

当前为 **编制归属模式 (B)**：每个平台已通过 `AircraftCarrier.id` 过滤绑定到打击群（CSG）。
ADS-B 事件推断（模式 A）需要 `MaritimeBaseCombatPlatform.icao` + 可用的 ADS-B 高度数据，目前不具备。
当数据满足条件时自动切换。
