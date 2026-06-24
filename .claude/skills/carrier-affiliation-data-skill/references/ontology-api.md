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

## Headers

Use these headers on ontology/DaaS requests:

```http
Authorization: Bearer ${ONTOLOGY_AUTH_TOKEN}
Spaceid: ${ONTOLOGY_SPACE_ID}
scopeType: ${ONTOLOGY_SCOPE_TYPE}
Content-Type: application/json
```

If the backend expects the raw JWT without `Bearer`, retry once with
`Authorization: ${ONTOLOGY_AUTH_TOKEN}` and record the fallback in provenance.

## Endpoint Base

The documentation page is:

```text
http://ceshi.projects.bingosoft.net:8081/ontology_docs/?doc=catalog
```

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

## Request Shape

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
