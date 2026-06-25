# Ontology / DaaS API Reference

## Runtime Configuration

Read credentials from `.claude/skills/carrier-affiliation-data-skill/config/ontology.env`, then allow equivalent deployment environment variables to override them:

```text
ONTOLOGY_API_BASE_URL=http://ceshi.projects.bingosoft.net:8081
ONTOLOGY_AUTH_TOKEN (committed in config/ontology.env)
ONTOLOGY_SPACE_ID=733b385695ae43eb9ee54ef9f4a9507a
ONTOLOGY_SCOPE_TYPE=
```

Do not ask the final user to provide these values.

## CORS & Browser Access — CRITICAL

**The ontology API does NOT support CORS** (OPTIONS preflight returns 500).
A browser app MUST NOT call the ontology API directly from client-side JS.
Instead, inject an nginx reverse-proxy location so the browser calls a
same-origin path and nginx forwards the request to the ontology server.

### Required nginx reverse proxy (in app's nginx.conf)

```nginx
location /api/ontology/ {
    proxy_pass http://<ONTOLOGY_API_BASE_URL_WITHOUT_HTTP_PREFIX>/;
    proxy_http_version 1.1;
    proxy_set_header Host <ontology-host>;
    proxy_set_header Authorization "Bearer <ONTOLOGY_AUTH_TOKEN>";
    proxy_set_header Spaceid "<ONTOLOGY_SPACE_ID>";
    proxy_set_header scopeType "Space";
    proxy_set_header Content-Type "application/json";
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

The three ontology auth headers (Authorization, Spaceid, scopeType) are
injected by nginx, so the token NEVER reaches the browser and CORS is
automatically avoided.

### Required JS adapter pattern

```js
// CORRECT: same-origin through nginx proxy
const url = `/api/ontology/daasDMS/entity/${entityName}/list`;
fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ... })

// WRONG: direct external URL — will fail with CORS
const url = `http://ceshi.projects.bingosoft.net:8081/daasDMS/entity/${entityName}/list`;
```

**MUST NOT** put `ONTOLOGY_API_BASE_URL` as an external URL in JS that runs
in a browser. Always route through the app's nginx reverse proxy.

## Headers

The ontology API requires these headers. When using the nginx reverse proxy,
nginx injects Authorization, Spaceid, and scopeType — the browser JS only
sends Content-Type:

```http
Authorization: Bearer ${ONTOLOGY_AUTH_TOKEN}
Spaceid: ${ONTOLOGY_SPACE_ID}
scopeType: Space
Content-Type: application/json
```

If the backend expects the raw JWT without `Bearer`, retry once with
`Authorization: ${ONTOLOGY_AUTH_TOKEN}` and record the fallback in provenance.

**scopeType is MANDATORY.** Without `scopeType: Space` the API defaults to
personal scope and returns `resultCode 10001` for every entity even with a
valid token. Value must be exactly `Space` (capital S, case-sensitive).

## Endpoint Base

The documentation page is:

```text
http://ceshi.projects.bingosoft.net:8081/ontology_docs/?doc=catalog
```

> The same catalog documents an **ontology MCP** connection guide (`本体 MCP 接口与连接指南`)
> as an alternative access path to the ontology. **As of 2026-06-24 the MCP transport
> connects but token auth fails (协议通 / token不通), so it is unusable.** Use the REST
> entity endpoints below instead. When the MCP token is fixed it may serve as an
> alternative to REST.

The entity endpoints are relative to the ontology service base URL.

## Entity Endpoints

| Boundary | Entity | Endpoint | Key fields |
|---|---|---|---|
| Carrier master | `AviationCarrier` | `POST /daasDMS/entity/AviationCarrier/list` | `id`, `name`, `longitude`, `latitude`, `curStatus`, `curHeading`, `curSpeed`, `mmsi`, `homeportStation`, `aircraftCarried`, `airWing`, `dataUpdateTime` |
| Aircraft master | `CarrierAviationPlatform` | `POST /daasDMS/entity/CarrierAviationPlatform/list` | `id`, `name`, `longitude`, `latitude`, `curStatus`, `icao`, `mmsi`, `callsign`, `typeCode`, `dataUpdateTime` |
| Surface vessels | `SurfaceCombatPlatform` | `POST /daasDMS/entity/SurfaceCombatPlatform/list` | `id`, `name`, `longitude`, `latitude`, `mmsi`, `curStatus`, `typeCode`, `dataUpdateTime` |
| OSINT | `MediaReport` | `POST /daasDMS/entity/MediaReport/list` | `id`, `sourceUrl`, `contentSummary`, `publishTime`, `sourcePlatform`, `credibilityScore`, `keywordTags`, `relatedPlatform`, `reliability` |
| ADS-B raw | `RawADSData` | `POST /daasDMS/entity/RawADSData/list` | `icao`, `callsign`, `lat`, `lon`, `altitude`, `groundspeed`, `track`, `vertRate`, `heading`, `geoAlt`, `baroAlt`, `startTime`, `dataUpdateTime` |
| AIS raw | `RawAISData` | `POST /daasDMS/entity/RawAISData/list` | `mmsi`, `latitude`, `longitude`, `sog`, `courseOverGround`, `trueHeading`, `shipName`, `callsign`, `startTime`, `dataUpdateTime` |
| Carrier track | `AircraftCarrierTrackLog` | `POST /daasDMS/entity/AircraftCarrierTrackLog/list` | `longitude`, `latitude`, `trackInitTime`, `trackStatusCode`, `trackUniqueId`, `refAviationCarrier`, `trackSource`, `dataUpdateTime` |
| Behavior law list | `CarrierStrikeGroupOperationalBehaviorLaws` | `POST /daasDMS/entity/CarrierStrikeGroupOperationalBehaviorLaws/list` | `cycleRule`, `reappearProb`, `standardDuration`, `minDuration`, `maxDuration`, `startTime`, `endTime`, `summary`, `refAviationCarrier` |
| Behavior law save | `CarrierStrikeGroupOperationalBehaviorLaws` | `POST /daasDMS/entity/CarrierStrikeGroupOperationalBehaviorLaws/save` | `values[]` with entity camel-case keys |
| Weather | `meteorological_environment-BT` | `POST /daasDMS/entity/meteorological_environment-BT/list` | `geoData`, `date`, `timeStart`, `timeEnd`, `windSpeed`, `windDirection`, `heightRange`, `humidity`, `visibilityCode` |

> **Availability (2026-06-24):** the Weather endpoint (`meteorological_environment-BT`)
> is **currently unavailable**. Do not call it. If a job needs wind/weather, route to
> `deck-wind-data-skill` (Open-Meteo GFS) instead and record that in provenance.

## Response Shape & resultCode

**Success resultCode is `200`, NOT `10000`.** Every list response wraps its
payload in `details` and signals success with `resultCode: 200`:

```json
{
  "resultCode": 200,
  "resultDesc": "OK",
  "details": {
    "pageParam": { "pageIndex": 1, "limit": 200, "pageTotal": N, "recordTotal": M },
    "columnNames": ["id", "name", ...],
    "rows": [ [...], [...] ]
  }
}
```

Error responses carry `resultCode` values like `10001` ("entity not found in
scope"), not HTTP status codes. The JS adapter MUST check `data.resultCode !== 200`,
NOT `!== 10000`.

### rowType must be "map"

Always pass `"rowType": "map"` in the request body. Responses with `rowType: "map"`
return `details.rows` as an array of objects (keyed by columnNames). If you omit
`rowType` or use another value, rows may come back as positional arrays and the
consumer must normalize them with `details.columnNames`.

### Do not check HTTP status alone

A "200 OK" HTTP response can carry `resultCode: 10001` (entity not found).
Always check `resultCode` inside the JSON body — do not rely on HTTP status
alone to decide success vs. failure.

Use `rowType: "map"` unless the caller explicitly needs another shape.

```json
{
  "columns": ["id", "name", "longitude", "latitude"],
  "pageParam": {"pageIndex": 1, "limit": 200},
  "rowType": "map",
  "filters": [{"column": "id", "logic": "=", "condition": "CVN-78"}]
}
```

## Common Filters

| Use case | Filter |
|---|---|
| ADS-B by aircraft | `{"column":"icao","logic":"=","condition":"<icao>"}` |
| Aircraft carried by carrier | `{"column":"AviationCarrier.id","logic":"=","condition":"<carrierId>"}` plus `{"column":"CarrierAviationPlatform.id","logic":"is not null","condition":null}` |
| AIS by vessel | `{"column":"mmsi","logic":"=","condition":"<mmsi>"}` |
| Carrier track by carrier | `{"column":"refAviationCarrier","logic":"=","condition":"<carrierId>"}` |
| OSINT related to platform | `{"column":"relatedPlatform","logic":"=","condition":"<platformId>"}` |
| Behavior law by carrier | `{"column":"refAviationCarrier","logic":"=","condition":"<carrierId>"}` |

## Row Normalization

Some responses return rows as maps; some consumers should still tolerate
column-aligned arrays. Normalize both:

```js
export function normalizeRows(details) {
  const names = details?.columnNames || [];
  return (details?.rows || []).map((row) => {
    if (!Array.isArray(row)) return row || {};
    return Object.fromEntries(names.map((name, i) => [name, row[i]]));
  });
}
```

## Field Normalization

- `RawADSData.altitude`, `baroAlt`, or `geoAlt` -> `altFt`. If the source is in
  meters, convert to feet and record the conversion.
- `RawADSData.groundspeed` -> `speedKt` when the source is already knots. If
  source unit is m/s, multiply by `1.943844`.
- `RawADSData.lat/lon` -> `lat/lon`.
- `AircraftCarrierTrackLog.trackInitTime` -> carrier track point `time`.
- `AircraftCarrierTrackLog.longitude/latitude` -> carrier track `lon/lat`.

## Token Handling

The provided token may expire. If a request returns `401`, report
`SOURCE_AUTH_FAILED`; do not ask the UI user for a token.
