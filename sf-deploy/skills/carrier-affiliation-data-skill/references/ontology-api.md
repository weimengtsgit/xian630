# Ontology / DaaS API Reference

## Runtime Configuration

Read credentials from `.claude/skills/carrier-affiliation-data-skill/config/ontology.env`, then allow equivalent deployment environment variables to override them:

```text
ONTOLOGY_API_BASE_URL=http://ceshi.projects.bingosoft.net:8081
ONTOLOGY_AUTH_TOKEN (committed in config/ontology.env)
ONTOLOGY_SPACE_ID=733b385695ae43eb9ee54ef9f4a9507a
ONTOLOGY_SCOPE_TYPE=Space
```

Do not ask the final user to provide these values.

## CORS & Browser Access — CRITICAL

**The ontology API does NOT support CORS** (OPTIONS preflight returns 500).
A browser app MUST NOT call the ontology API directly from client-side JS.
Instead, inject an nginx reverse-proxy location so the browser calls a
same-origin path and nginx forwards the request to the ontology server.

### Required nginx reverse proxy (in app's nginx.conf)

```nginx
location /ontology/ {
    proxy_pass http://ceshi.projects.bingosoft.net:8081/;
    proxy_http_version 1.1;
    proxy_set_header Host ceshi.projects.bingosoft.net;
    proxy_set_header Authorization "Bearer <ONTOLOGY_AUTH_TOKEN>";
    proxy_set_header Spaceid "<ONTOLOGY_SPACE_ID>";
    proxy_set_header scopeType "Space";
    proxy_set_header Content-Type "application/json";
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

Token NEVER reaches the browser. CORS is automatically avoided.

### Required JS adapter pattern

```js
// CORRECT: same-origin through nginx proxy
const url = `/ontology/daasDMS/entity/${entityName}/list`;

// WRONG: direct external URL — will fail with CORS in browser
const url = `http://ceshi.projects.bingosoft.net:8081/daasDMS/entity/${entityName}/list`;
```

## Headers

When using the nginx reverse proxy, nginx injects all auth headers:

```http
Authorization: Bearer ${ONTOLOGY_AUTH_TOKEN}
Spaceid: ${ONTOLOGY_SPACE_ID}
scopeType: Space
Content-Type: application/json
```

**scopeType is MANDATORY.** Without `scopeType: Space` the API defaults to
personal scope and returns `resultCode 10001` for every entity even with a
valid token. Value must be exactly `Space` (capital S, case-sensitive).

## Response Shape & resultCode

**Success resultCode is `200`, NOT `10000`.**

```json
{
  "resultCode": 200,
  "resultDesc": "OK",
  "details": {
    "pageParam": { "pageIndex": 1, "limit": 200, "pageTotal": N, "recordTotal": M },
    "columnNames": ["id", "name", ...],
    "rows": [ {...}, {...} ]
  }
}
```

The JS adapter MUST check `data.resultCode !== 200`, NOT `!== 10000`.

Always pass `"rowType": "map"` in the request body for object-format rows.

## Data Flow: Carrier → Strike Group → Platforms (MANDATORY path)

The affiliation chain is THREE entities, and **carrier→aircraft is NEVER
direct** — it must traverse the strike group:

```
Step 1: AviationCarrier       Step 2: AircraftCarrier        Step 3: MaritimeBaseCombatPlatform
 (航母 master, 11 rows)         (CSG 打击群, 11 rows)          (海基作战平台, 655 rows)
        │                              │                              │
        │  CSG.refHMId = carrier.id     │ filter: AircraftCarrier.id   │
        └──────────────────────────────┘──────────────────────────────┘
                 Carrier→CSG                   CSG→Platforms (aircraft+ships)
```

The provider has confirmed: querying aircraft carrier-direct (skipping the
CSG) returns incomplete data. Always go carrier→CSG→platform.

**Old / deprecated entity names — do NOT use (they do not exist):**
- `platform-BT`, `ads_b_track-BT`, `carrier_track_log-BT` — return `10001 entity not found`.

## Cross-Entity Filter & Column Syntax (跨实体引用)

The DaaS API supports referencing a RELATED entity's fields directly in
`columns` and `filters`, using the `EntityName.field camelAlias` form. This is
how relationships are traversed without a separate join call.

### Column form: `Entity.field alias`

```json
"columns": [
  "MaritimeBaseCombatPlatform.id id",
  "MaritimeBaseCombatPlatform.name name",
  "CarrierStrikeGroupRefFormationRelationship.name relationName",
  "MaritimeBaseCombatPlatform.typeCode typeCode"
]
```

`CarrierStrikeGroupRefFormationRelationship.name` returns the formation
relationship name (e.g. "华盛顿号与舰载机关系011") — the labeled edge between
the platform and its CSG.

### Filter form: `RelatedEntity.id`

**The ONLY correct association filter is `AircraftCarrier.id` (the strike
group).** Carrier→aircraft is NEVER direct; it must go through the CSG:

| Filter | Meaning | Used by |
|--------|---------|---------|
| `"column": "AircraftCarrier.id", "condition": "CSG-10"` | platforms/aircraft of strike group CSG-10 | `MaritimeBaseCombatPlatform` (the standard source) |

A `AviationCarrier.id` filter on `CarrierAviationPlatform` returns rows but is
**not reliable** (provider-confirmed) — do not build on it.

Always add `"useCondition": true` on filter rows per the interface spec.

## Two Detail Endpoints per Entity

Every entity exposes both:
- `POST /daasDMS/entity/<Entity>/list` — paginated list (use `filters`)
- `POST /daasDMS/entity/<Entity>/get` — single record (same `filters` shape, not a bare `id`)

---

## Entity: AviationCarrier (航母)

Master data for 11 aircraft carriers.

| Endpoint | `POST /daasDMS/entity/AviationCarrier/list` |
|---|---|

Key columns: `id`, `name`, `longitude`, `latitude`, `curStatus`, `curHeading`, `curSpeed`, `mmsi`, `homeportStation`, `airWing`, `aircraftCarried`, `dataUpdateTime`

Notes:
- `airWing` is descriptive text (e.g. "第8舰载航空联队（CVW-8）"), NOT a structured ID.
- `aircraftCarried` is descriptive text (e.g. "约80-90架各型舰载机"), NOT a structured list.
- There is NO direct AviationCarrier → aircraft relationship. Use the CSG chain.

---

## Entity: AircraftCarrier (航母打击群 / CSG)

**NEW — this is the key bridge entity.** Each of 11 CSGs links to one carrier.

| Endpoint | `POST /daasDMS/entity/AircraftCarrier/list` |
|---|---|
| Swagger | `AircraftCarrier_获取航母打击群的数据列表_swagger.json` |

Key columns: `id` (e.g. "CSG-10"), `name` (e.g. "第十航母打击群"), `refHMId` (e.g. "CVN-77"), `typeCode`, `organizationLevel`, `curStatus`, `longitude`, `latitude`, `subordinateTo`, `affiliationUnit`, `commandLevel`, `serviceBranch`

**`refHMId` is the foreign key to `AviationCarrier.id`.** Use it to link CSG back to carrier:

```json
// Get CSG for carrier CVN-77
{ "filters": [{ "column": "refHMId", "logic": "=", "condition": "CVN-77" }] }
```

Full column list from Swagger: `id`, `name`, `catCode`, `reliability`, `curAddress`, `creatorId`, `sourceOrigin`, `typeCode`, `longitude`, `refCollectionTask`, `latitude`, `curStatus`, `subordinateTo`, `introduction`, `image`, `relatedTask`, `organizationLevel`, `subordinateCount`, `affiliationUnit`, `establishmentSize`, `organizationFunction`, `stationLocation`, `establishmentTime`, `jurisdictionScope`, `belongSpaceId`, `serviceBranch`, `unitEstablishmentType`, `parentId`, `commandLevel`, `organizationType`, `campLocation`, `refFacilityId`, `combatCapabilityLevel`, `unitStrength`, `operationalTaskType`, `supportRelationship`, `mobilizationLevel`, `executionTaskType`, `unitCombatStrength`, `equipmentAllocation`, `firepowerAllocation`, `positionDeployment`, `mobilityCapability`, `sustainedCombatTime`, `combatReadinessLevel`, `adminSubordination`, `operationalSubordination`, `status`, `technicalCondition`, `nationCode`, `confidentialityLevel`, `principalOfficer`, `task_priority`, `refHMId`, `isSimulationData`, `updateSeqnr`, `dataUpdateTime`

---

## Entity: MaritimeBaseCombatPlatform (海基作战平台)

**This is the entity that holds CSG-linked aircraft, ships, and other platforms.**
Must be queried PER CSG using the `AircraftCarrier.id` filter.

| Endpoint | `POST /daasDMS/entity/MaritimeBaseCombatPlatform/list` |
|---|---|
| Reference | `接口参数说明.txt` |

Key columns: `id`, `name`, `typeCode`, `mmsi`, `longitude`, `latitude`, `curStatus`, `maxSpeed`, `cruiseRange`, `payload`, `subordinateTo`, `nationCode`, `technicalCondition`, `supplier`

**Critical filter — MUST pass `AircraftCarrier.id` to associate platforms to a CSG:**

```json
{
  "columns": ["id", "name", "typeCode", "mmsi", "longitude", "latitude", "curStatus", "maxSpeed", "cruiseRange"],
  "pageParam": { "pageIndex": 1, "limit": 500 },
  "rowType": "map",
  "filters": [
    { "column": "AircraftCarrier.id", "logic": "=", "condition": "CSG-10" }
  ]
}
```

**Data per CSG (verified 2026-06-25):**

| CSG | refHMId | Carrier | Platforms |
|-----|---------|---------|-----------|
| CSG-3 | CVN-72 | 林肯号 | 82 |
| CSG-8 | CVN-75 | 杜鲁门号 | 73 |
| CSG-7 | CVN-74 | 斯坦尼斯号 | 72 |
| CSG-10 | CVN-77 | 布什号 | 63 |
| CSG-2 | CVN-69 | 艾森豪威尔号 | 63 |
| CSG-11 | CVN-68 | 尼米兹号 | 59 |
| CSG-5 | CVN-73 | 华盛顿号 | 47 |
| CSG-12 | CVN-78 | 福特号 | 11 |
| CSG-1,4,9 | — | — | 1 each |

Total: 655 platforms across all CSGs.

Platform types include: `F/A-18E`, `F/A-18F`, `F-35C`, `E-2D`, `MH-60R`, `MH-60S`, `CMV-22B`, `MQ-25A`, `DDG-*` (destroyers), `CG-*` (cruisers), plus the carrier itself.

**Platform ID pattern**: `USA_CVN77_FA18F_003` — contains carrier code (`CVN77`) and aircraft type. Use the `AircraftCarrier.id` filter for accurate CSG association — do NOT try to parse carrier codes from platform IDs.

Additional columns from the interface spec: `catCode`, `creatorId`, `reliability`, `sourceOrigin`, `curAddress`, `refCollectionTask`, `introduction`, `image`, `webrtcUrl`, `refFacilityId`, `supplier`, `maxSpeed`, `payload`, `cruiseRange`, `enduranceRaid`, `positionOccupation`, `tagType`, `daytimePenetrationAdapt`, `ammunitionLoad`, `coordinationTimingMatch`, `isSimulationData`, `updateSeqnr`, `dataUpdateTime`.

The entity also supports `carrierStrikeGroupRefFormationRelationshipList` as a nested field showing the CSG formation relationship with `relationName`.

---

## Entity: AircraftCarrierTrackLog (航母轨迹)

48 track points for carriers.

| Endpoint | `POST /daasDMS/entity/AircraftCarrierTrackLog/list` |
|---|---|

Key columns: `refAviationCarrier` (link to AviationCarrier.id), `trackInitTime`, `longitude`, `latitude`, `trackStatusCode`, `trackUniqueId`, `trackSource`, `dataUpdateTime`

Note: `latitude` is null for many records currently.

---

## Entity: RawADSData (ADS-B raw data)

21.8M total rows, but only 191 have non-null `icao`.

| Endpoint | `POST /daasDMS/entity/RawADSData/list` |
|---|---|

Key columns: `icao`, `callsign`, `lat`, `lon`, `altitude`, `groundspeed`, `track`, `heading`, `vertRate`, `geoAlt`, `baroAlt`, `startTime`, `dataUpdateTime`

**CRITICAL**: Always filter `icao is not null` or you will get millions of unusable rows. The `altitude` (几何高度) field is frequently `0.0` or null, so takeoff/landing detection yields near-zero events.

```json
{ "filters": [{ "column": "icao", "logic": "is not null", "condition": null }] }
```

**Join limitation (blocks aircraft event inference):** `RawADSData.icao` cannot
be joined to `CarrierAviationPlatform` or `MaritimeBaseCombatPlatform`, because
neither platform entity has an `icao` field. This blocks the three-step ADS-B
aircraft event inference — see SKILL.md "Affiliation Inference Modes".

---

## Entity: RawAISData (AIS raw data — MILITARY ship tracks, joinable)

**4,834,856 rows** (verified live 2026-06-26). **Joinable to platforms via
`mmsi`** — this is the working track source for the carrier strike group's ships
(destroyers, cruisers, supply ships), unlike ADS-B for aircraft.

> **Merchant vs military AIS (hard rule):** `RawAISData` holds ONLY ~48 distinct
> MILITARY vessels (US Navy carriers DDG/CG/amphibs/USNS + one allied) — it is
> the AIS source for carriers/warships/navy and is owned by
> `carrier-affiliation-data-skill`. It is NOT merchant shipping and must NOT be
> used for merchant density (that is `ais-density-data-skill` → MarineCadastre).
> `startTime`/`dataUpdateTime` range 2014-10-20 → ~12 days ago (latest observed
> 2026-06-14); lat/lon FULLY populated; `typeCode` mostly `"1"`.

| Endpoint | `POST /daasDMS/entity/RawAISData/list` |
|---|---|

Key columns (verified fetchable — note `latitude`/`longitude`, NOT `lat`/`lon`):
`mmsi`, `latitude`, `longitude`, `sog` (speed over ground, kn),
`courseOverGround`, `trueHeading`, `shipName`, `callsign`,
`navigationalStatus`, `typeCode`, `startTime`, `dataUpdateTime`

Filter by mmsi to get one vessel's track:

```json
{ "filters": [{ "column": "mmsi", "logic": "=", "condition": "369952000" }] }
```

**Response shape note:** `resultCode`/`resultDesc` are nested INSIDE `details`
(`details.resultCode === 200`), while the top level carries `resultCode`/
`message`/`logStack`. `recordTotal`/`pageTotal` live at
`details.pageParam.recordTotal` / `.pageTotal`.

**Join path (working):** `MaritimeBaseCombatPlatform.mmsi` → `RawAISData.mmsi`
gives per-ship AIS tracks. Ship names confirmed present (e.g. "普林斯顿", "钟云号",
"丹尼尔·井上号", "黄蜂").

---

## Entity: CarrierAviationPlatform (舰载机 — NOT the standard path)

**Do NOT use this as the aircraft source.** Although a `AviationCarrier.id`
filter returns rows, the provider has confirmed the association is unreliable
when queried carrier-direct: **航母不能直接关联舰载机，必须经过打击群**.

The standard, complete aircraft/platform source is `MaritimeBaseCombatPlatform`
filtered by `AircraftCarrier.id` (the CSG), per the "Data Flow" section above.
`CarrierAviationPlatform` is kept here only for reference; treat its data as
potentially incomplete.

`icao` is empty on most rows regardless, so the ADS-B join stays broken.

---

## Other Available Entities (from catalog.md)

Catalog source: `http://<host>:8081/ontology_docs/data/catalog.md` (lists all
DaaS entity docs). Full inventory verified 2026-06-25:

| Entity | Count | Catalog section | Notes |
|--------|-------|-----------------|-------|
| `AviationCarrier` | 11 | 航母基本信息 | carrier master |
| `AircraftCarrier` | 11 | 航母打击群 | CSG, `refHMId`→carrier |
| `CarrierAviationPlatform` | 501 | 航母基本信息 | aircraft, `AviationCarrier.id` filter (~62/carrier) |
| `MaritimeBaseCombatPlatform` | 655 | 军事基地-母港 | platforms, `AircraftCarrier.id` filter |
| `SurfaceCombatPlatform` | 177 | 航母基本信息 | 水面作战平台 |
| `AircraftCarrierTrackLog` | 48 | 航母相关情报 | carrier track points |
| `CarrierRoutineDynamicEvents` | 2133 | 航母相关数据 | dynamic events, `refAviationCarrier` |
| `RawADSData` | 21.8M | 航母相关情报 | ADS-B, join broken (no platform icao) |
| `RawAISData` | 4.83M | 航母相关情报 | AIS, **joinable via `mmsi`**, MILITARY vessels only (~48 US-Navy ships) |
| `MediaReport` | 76 | 航母相关情报 | OSINT 开源情报 |
| `CarrierStrikeGroupOperationalBehaviorLaws` | — | 航母规律 | behavior laws, `refAviationCarrier`, has `/list` + `/save` |
| `Personnel` | — | 人员 | personnel master |
| `MilitaryBase` | — | 军事基地-母港 | bases (markdown doc only) |
| `meteorological_environment-BT` | — | 其他 | Weather — **currently unavailable** |

The MCP transport (`data/markdown/ontology-mcp.md`) connects but token auth
fails as of 2026-06-24 — use REST.

---

## Known Data Gaps (verified 2026-06-25) — design UI for graceful degradation

The ontology is sparsely populated. Generated apps MUST tolerate empty fields
and must NOT assume a field is always present:

| Entity | Field | Fill rate | Impact |
|--------|-------|-----------|--------|
| `AviationCarrier` | longitude/latitude/curStatus | ✅ full | carrier positions render |
| `AviationCarrier` | airWing/aircraftCarried | ⚠️ partial, text-only | descriptive only |
| `AircraftCarrierTrackLog` | longitude/latitude | ❌ mostly null | carrier track lines CANNOT render |
| `AircraftCarrierTrackLog` | trackInitTime/refAviationCarrier | ✅ present | time + carrier link ok |
| `MaritimeBaseCombatPlatform` | longitude/latitude/mmsi | ❌ mostly null | platform positions & AIS join broken |
| `MaritimeBaseCombatPlatform` | name/typeCode | ✅ full | list/cards work |
| `RawADSData` | altitude | ❌ ~all 0.0 or negative | takeoff/landing detection impossible |
| `RawADSData` | icao | ❌ 191 of 21.8M | almost no joinable aircraft tracks |

**Implication for affiliation inference:**
- ADS-B event-based inference (the ideal three-step flow) CANNOT run: no
  altitude transitions + no platform `icao` to join. Show `mode: establishment_based`
  and `takeoffLandingCount: 0` honestly — do not fabricate events.
- Carrier track lines and platform positions will be largely empty on the map.
  Render carrier current-position markers (from AviationCarrier) instead of
  track polylines when track coordinates are null.
- Report these gaps to the provider; when backfilled, Mode A activates.

## Request Shape

```json
{
  "columns": ["id", "name", ...],
  "pageParam": { "pageIndex": 1, "limit": 500 },
  "rowType": "map",
  "filters": [
    { "column": "field", "logic": "=", "condition": "value" }
  ]
}
```

Supported logics: `=`, `is not null`, `like`. NOTE: the value is `is not null`
as a SINGLE string logic with `condition: null` — NOT `is not` + `'null'`.

## Raw Field Names vs UI Field Names

The Swagger/Markdown docs under
`http://ceshi.projects.bingosoft.net:8081/ontology_docs/?doc=catalog` are the
source of truth for request columns. The adapter may expose normalized UI names
after fetch, but those normalized names MUST NOT be sent in `columns`.

| Entity | Request these raw columns | Do NOT request these normalized/nonexistent columns |
|---|---|---|
| `AviationCarrier` | `curHeading`, `curSpeed`, `homeportStation` | `heading`, `speed`, `homeport` |
| `RawADSData` | `lat`, `lon`, `groundspeed`, `startTime` | `latitude`, `longitude`, `speed`, `recordTime` |
| `AircraftCarrierTrackLog` | `refAviationCarrier`, `trackInitTime` | `carrierId`, `recordTime` |

Mapping is done after fetch, for example:

```js
const carrier = {
  heading: Number(row.curHeading) || 0,
  speed: Number(row.curSpeed) || 0,
  homeport: row.homeportStation || '',
};
```

## Row Normalization

When `rowType: "map"`, rows are objects keyed by `columnNames`. Still handle
the case where rows come back as positional arrays:

```js
export function normalizeRows(details) {
  const names = details?.columnNames || [];
  return (details?.rows || []).map((row) => {
    if (!Array.isArray(row)) return row || {};
    return Object.fromEntries(names.map((name, i) => [name, row[i]]));
  });
}
```

## Reference Adapter (copy this — do NOT guess field names or response shape)

Generated adapters MUST follow this exact shape. The API response is
`{ resultCode, details: { columnNames, rows } }` (NOT `data.resultCode` /
`data.data`), and the request body MUST use `pageParam` + `rowType: "map"`
(NOT `pageNo`/`pageSize`). Field names below are VERIFIED — guessing causes
HTTP 400 "Unknown column".

```ts
const API_BASE = '/api/ontology'; // same-origin via nginx proxy

async function fetchEntity(entity: string, columns: string[], filters: any[] = []) {
  const res = await fetch(`${API_BASE}/daasDMS/entity/${entity}/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columns, pageParam: { pageIndex: 1, limit: 500 }, rowType: 'map', filters }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.resultCode !== 200) throw new Error(`API ${json.resultCode}: ${json.message}`);
  const names: string[] = json.details?.columnNames || [];
  const rows: any[] = json.details?.rows || [];
  return rows.map((r) => Array.isArray(r)
    ? Object.fromEntries(names.map((n, i) => [n, r[i]]))
    : r || {});
}

// VERIFIED column names per entity — use EXACTLY these:
// AviationCarrier:      id, name, longitude, latitude, curStatus, curHeading, curSpeed, mmsi, airWing, aircraftCarried, homeportStation
// AircraftCarrier:      id, name, refHMId, typeCode, curStatus, longitude, latitude
// MaritimeBaseCombatPlatform: id, name, typeCode, mmsi, longitude, latitude, curStatus, maxSpeed, cruiseRange
//   (filter by { column: 'AircraftCarrier.id', logic: '=', condition: '<CSG-XX>' })
// AircraftCarrierTrackLog: refAviationCarrier, trackInitTime, longitude, latitude, trackStatusCode
// RawADSData:           icao, callsign, lat, lon, altitude, groundspeed, track, heading, startTime
//   (filter by { column: 'icao', logic: 'is not null', condition: null })
// RawAISData:           mmsi, latitude, longitude, sog, shipName, startTime
//   (filter by { column: 'mmsi', logic: '=', condition: '<mmsi>' })
```

**Common mistakes to avoid** (all observed in generated code):
- `heading`/`speed`/`homeport` on AviationCarrier → use `curHeading`/`curSpeed`/`homeportStation`.
- `longitude`/`latitude` on RawADSData → use `lon`/`lat`.
- `speed` on RawADSData → use `groundspeed`.
- `createTime` → use `trackInitTime` (track log) or `startTime` (ADS-B/AIS).
- `carrierId` on AircraftCarrierTrackLog → use `refAviationCarrier`.
- Response `data.resultCode` / `data.data` → use `resultCode` / `details.rows`.
- Request `pageNo`/`pageSize` → use `pageParam: { pageIndex, limit }`.

## Token Handling

The provided token may expire. If a request returns `401`, report
`SOURCE_AUTH_FAILED`; do not ask the UI user for a token.
