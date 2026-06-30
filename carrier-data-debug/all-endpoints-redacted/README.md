# 本体实体数据（脱敏版 / Redacted）

供**无法访问本体接口**的环境做解析、渲染、关联测试用。原始数据来自本体 DaaS
`POST /daasDMS/entity/<Entity>/list` 接口的返回，已整体脱敏；**列结构、字段类型、行数、
跨实体关联全部保留**，凭证与真实标识已删除。

> **怎么用**（加载 helper、mock 接线、join 示例、字段约定）见同目录 [`USAGE.md`](USAGE.md)。

## 文件结构

每个 `<Entity>.json` 是一个实体的转储，结构对应接口返回的 `details`：

```jsonc
{
  "entity": "...", "title": "...",
  "http_status": 200, "resultCode": 200,
  "recordTotal": <真实总行数>,
  "rows_fetched": <本文件实际行数>,
  "fetch_mode": "full" | "sampled",
  "columnNames": [...],
  "rows": [ { <col>: <value>, ... }, ... ]
}
```

`_manifest.json` 是汇总清单（`space_id`/`source` 已置为占位符）。

## 行数与采样

| 实体 | recordTotal | 本文件行数 | 模式 |
|---|---:|---:|---|
| AircraftCarrier（航母打击群） | 11 | 11 | full |
| AircraftCarrierTrackLog（航母航迹） | 48 | 48 | full |
| AviationCarrier（航空母舰） | 14 | 14 | full |
| CarrierAviationPlatform（舰载机） | 962 | 962 | full |
| CarrierRoutineDynamicEvents（常规动态事件） | 2133 | 2133 | full |
| CarrierStrikeGroupOperationalBehaviorLaws（行为规律） | 43 | 43 | full |
| MaritimeBaseCombatPlatform（海基作战平台） | 861 | 861 | full |
| SurfaceCombatPlatform（水面作战平台） | 177 | 177 | full |
| MediaReport（开源情报） | 76 | 76 | full |
| Personnel（人员） | 406 | 406 | full |
| DeviceType / FireControlSystem / SensorType / WeaponSystemType / NavigationEquipmentType / communicationEquipmentType | — | 全量 | full |
| hydrologicalEnvironment-BT / meteorological_environment-BT | 10 / 1936 | 全量 | full |
| **RawAISData（AIS 原始）** | **5,095,550** | **1000** | **sampled** |
| **RawADSData（ADS-B 原始）** | **24,598,398** | **1000** | **sampled** |

> `RawAISData` / `RawADSData` 体量过大，仅取前 1000 行作样本；`recordTotal` 仍为真实总数，
> 需要全量请单独向有接口权限的环境申请。

## 脱敏规则（真实值 → 测试值）

| 类别 | 处理 | 测试值形态 |
|---|---|---|
| 航母/舰艇舷号 | 一致映射 | `CVN-70 → CVN-T01`、`DDG-89 → DDG-T45`（保留前缀，关联不变） |
| 打击群 / 航迹 / 行为 id | 一致映射 | `CSG-T01`、`TRK-T01`、`BEH-T01` |
| MMSI | 一致映射 | `999xxxxxx`（统一 999 前缀） |
| ICAO / IMO | 一致映射 | `AAxxxx` / `IMO_TEST_NNNNN` |
| 舰名 / 人名 / 部队番号 / 单位 / 用户名 | 通用代号 | `测试航母NN`、`测试舰艇NNN`、`测试员NNN`、`ORG_TEST_NNN`、`analystNN` |
| 经纬度（lat/lon 及文本内坐标） | 线性整体搬迁到测试海区 | 纬度 ∈ [-30, -25]，经度 ∈ [-140, -135]（南太平洋空海域） |
| 港口 / 海域 / 海峡 / 地区 | 通用代号 | `测试母港A…`、`测试海区甲…`、`测试海湾甲…` |
| 长文本（简介/详情/事件/开源情报） | 用上述代号替换真实名、舷号、地名，保留篇幅与结构 | — |
| 人员 PII（身份证/护照/银行卡/电话/住址/简历等） | 置占位 | `[已脱敏-<字段>]` |
| 内部 URL / 图片指针 / 内网 IP / GUID | 清空或占位 | 空 / `10.0.0.1` / `00000000-0000-4000-8000-000000000000` |
| 凭证（token / space_id / source） | 删除/占位 | `REDACTED_SPACE` / `https://ontology.example.test` |

装备型号（AN/TPY-2、F/A-18、SLQ-32 等）、厂商（波音/雷神等）、日期、规格数值、
`recordTotal` 等公开/非标识性内容**保持原样**，便于做真实感测试。

## 关联（join）仍可用

- `AircraftCarrier.refHMId` → `AviationCarrier.id`（打击群 → 航母）
- `AircraftCarrierTrackLog / CarrierStrikeGroupOperationalBehaviorLaws / CarrierRoutineDynamicEvents` 的 `refAviationCarrier` → `AviationCarrier.id`
- `MaritimeBaseCombatPlatform.mmsi` ↔ `RawAISData.mmsi`（平台 ↔ AIS 航迹，脱敏后两侧用同一假 MMSI，仍可 join）
- `RawADSData.icao` 同理

坐标整体迁到同一测试海区，**相对几何关系保留**（航迹仍呈线状、编队仍成群）。

## 注意

- 文件内的内部行 ID（`id`、`updateSeqnr`、`refCollectionTask` 等）是数据库内部序号，
  在无接口环境下无含义，保留不影响脱敏与测试。
- 本目录已脱敏；**不要**混入上一级目录里的 `dump_all_endpoints.py` / `download_carrier_data.py`
  等脚本或 `all-endpoints/`（原始）数据——那些含可用凭证与真实数据。
