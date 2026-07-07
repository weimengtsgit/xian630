# 使用方式（USAGE）

本目录是一份**脱敏后的本体实体数据**，用于在**无本体接口**的环境里做解析、渲染、关联测试。
下面给出几种典型用法（Python / JS），可直接复制。

## 1. 数据与本体接口的对应

每个 `<Entity>.json` ≈ 一次 `POST /daasDMS/entity/<Entity>/list` 的返回。注意**形状差异**：

| | 本体接口实际返回 | 本 dump 文件 |
|---|---|---|
| 结构 | `{ resultCode:200, details:{ rows, columnNames, pageParam:{recordTotal,...} } }` | `{ resultCode, columnNames, rows, recordTotal, rows_fetched, fetch_mode }`（铺平，`rows` 在顶层） |

测试时把 dump 文件当接口返回的 mock 即可。若你的 adapter 期望 `details.rows`，用第 2 节的 wrapper 包一层即可零改动复用。

## 2. 加载 helper

**Python：**

```python
import json, pathlib
DATA = pathlib.Path(__file__).parent            # 解压后的 all-endpoints-redacted/

def load_entity(name):
    """包装成与本体接口一致的 envelope，adapter 无需改动。"""
    rec = json.loads((DATA / f"{name}.json").read_text(encoding="utf-8"))
    return {
        "resultCode": rec["resultCode"],
        "details": {
            "rows": rec["rows"],
            "columnNames": rec["columnNames"],
            "pageParam": {"recordTotal": rec["recordTotal"],
                          "pageIndex": 1, "limit": len(rec["rows"])},
        },
    }

def fetch_rows(name):
    """直接拿行列表。"""
    return load_entity(name)["details"]["rows"]
```

**JS（Vite 静态托管，把本目录放到 /public/mock/ 下）：**

```js
export async function loadEntity(name) {
  const rec = await fetch(`/mock/${name}.json`).then(r => r.json());
  return {
    resultCode: rec.resultCode,
    details: {
      rows: rec.rows,
      columnNames: rec.columnNames,
      pageParam: { recordTotal: rec.recordTotal },
    },
  };
}
export const fetchRows = async (name) => (await loadEntity(name)).details.rows;
```

## 3. 替换 adapter 的真实调用

你的 adapter 里原本 `POST /daasDMS/entity/<Entity>/list` 的那一步，测试时改成 `fetch_rows("<Entity>")`，
客户端再按 `filters` 自行过滤即可。adapter 的归一化/推断逻辑**完全不用改**。

## 4. 关联 / Join 示例（真实字段名）

```python
carriers  = fetch_rows("AviationCarrier")           # 航母 master（14）
csgs      = fetch_rows("AircraftCarrier")           # 打击群（11）
platforms = fetch_rows("MaritimeBaseCombatPlatform")# 平台/舰艇（861）
ais       = fetch_rows("RawAISData")                # AIS 航迹（样本 1000）

# (a) 航母 -> 打击群：AircraftCarrier.refHMId == AviationCarrier.id  ✅ 可 join
for csg in csgs:
    carrier = next((c for c in carriers if c["id"] == csg["refHMId"]), None)

# (b) 平台 -> AIS 航迹：按 mmsi  ✅ 可 join（脱敏后两侧同一假 mmsi）
ais_by_mmsi = {}
for p in ais:
    ais_by_mmsi.setdefault(str(p["mmsi"]), []).append(p)
for p in platforms:
    track = ais_by_mmsi.get(str(p.get("mmsi")), [])
    # track 里每个点有 latitude/longitude（在测试海区 bbox 内），可画航迹

# (c) 事件/航迹日志里的 refAviationCarrier 同样指向 AviationCarrier.id ✅
```

> **注意：** `MaritimeBaseCombatPlatform` 行**没有** CSG/航母列——真实接口里"打击群→平台"是用
> `AircraftCarrier.id` 做服务端过滤的，不在行数据里。所以**打击群↔平台分组无法从 dump 还原**；
> 但**平台↔AIS（mmsi）**、**航母↔打击群（refHMId）** 都可 join。

## 5. 字段约定（与本体接口一致，原始 DaaS 字段名）

- AviationCarrier 的航向/速度/母港字段是 `curHeading` / `curSpeed` / `homeportStation`
  （**不是** `heading`/`speed`/`homeport`，那些列不存在）。
- `RawADSData` 经纬度字段是 `lat` / `lon`；`RawAISData` 是 `latitude` / `longitude`。
- 成功判定 `resultCode === 200`；行在顶层 `rows`（或 wrapper 后的 `details.rows`）。
- 坐标已整体迁到测试海区：`纬度 ∈ [-30, -25]`，`经度 ∈ [-140, -135]`（南太平洋空海域），
  相对几何保留 → 航迹仍呈线状、可渲染。
- 所有标识符都是测试代号：`CVN-Txx` / `CSG-Txx` / `999xxxxxx`(MMSI) / `AAxxxx`(ICAO) /
  `测试航母NN` 等——真实身份已脱敏。

## 6. 已知限制

- `RawAISData`（真实 5,095,550 行）/ `RawADSData`（真实 24,598,398 行）本 dump 各只含 **1000 行样本**，
  真实总量见对应文件的 `recordTotal`。
- 行内 `id` / `updateSeqnr` / `refCollectionTask` 等是数据库内部序号，在无接口环境下无含义，保留不影响测试。
- 长文本里的真实舰名/舷号/地名已替换为代号，但**句子结构、JSON 结构、篇幅保留**，适合做文本类用例。
- 人员 PII（身份证/护照/银行卡/电话/住址/简历等）已置占位 `[已脱敏-<字段>]`。
