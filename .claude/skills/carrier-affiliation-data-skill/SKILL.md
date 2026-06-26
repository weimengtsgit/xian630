---
name: carrier-affiliation-data-skill
description: Use when a requirement needs carrier-air-wing affiliation data, ADS-B tracks, carrier positions, carrier aircraft master data, land/sea classification, ontology/DaaS carrier entities, or public fallback sources for carrier-aircraft association analysis. Use real data by default; skip this skill only when the user explicitly requests mock or demo data.
---

# Carrier Affiliation Data Skill

## Overview

Use this skill as the data capability package for carrier-air-wing affiliation
inference. It supplies the raw data boundaries needed by
`affiliation-inference-dashboard`: ADS-B tracks, known carrier positions,
aircraft master data, land/sea classification, and judgement parameters.

This skill is independent from `tide-data-skill`, `deck-wind-data-skill`, and
`ais-density-data-skill`. Consumers select one or more data skills according to
their scenario; there is no cross-skill priority relationship.

## Default Rule

- Use real data by default.
- Skip this skill only when the user explicitly asks for `mock`, `demo data`, or `sample data`.
- Use the customer ontology/DaaS API first when ontology credentials are present.
- Do not ask the final user to type tokens or credentials.
- Do not fabricate ADS-B tracks, carrier positions, aircraft ownership, or
  surface classification to make a demo look complete.
- If a required source is unavailable, return an explicit failure or partial
  provenance warning.

## Current Source Status (as of 2026-06-24)

Some documented sources are currently unreachable — route around them instead of
failing the build:

- **Weather (`meteorological_environment-BT`) — UNAVAILABLE.** Do not call the
  weather list endpoint. If a job needs wind/weather, route to
  `deck-wind-data-skill` (Open-Meteo GFS) and label the provenance accordingly.
- **Ontology MCP (`本体 MCP 接口`, documented in the catalog) — UNAVAILABLE (auth).**
  The ontology docs catalog documents an MCP connection guide (`本体 MCP 接口与连接指南`)
  as an alternative access path. As of now the transport connects (协议通) but token
  auth fails (token不通), so it is unusable. Use the REST entity endpoints
  (`POST /daasDMS/entity/<Entity>/list`) and tier fallbacks instead — those work
  with the committed `ONTOLOGY_AUTH_TOKEN`.

Re-check before relying on these; they may be restored without a skill edit.

## Required Configuration

The ontology connection config is committed with this skill so generated apps do
not need to ask end users for credentials:

```text
.claude/skills/carrier-affiliation-data-skill/config/ontology.env
```

Generated adapters must read:

```text
ONTOLOGY_API_BASE_URL
ONTOLOGY_AUTH_TOKEN
ONTOLOGY_SPACE_ID
ONTOLOGY_SCOPE_TYPE
```

Rules:

- Do not prompt end users for these values.
- Read the committed config file first, then allow deployment environment
  variables to override it.
- Do not print `ONTOLOGY_AUTH_TOKEN` into UI, logs, README, `output.json`,
  generated source comments, screenshots, or warnings.
- Treat missing `ONTOLOGY_AUTH_TOKEN` as `SOURCE_AUTH_MISSING`.
- Prefer a server-side proxy for production. For an internal static-only demo,
  `VITE_ONTOLOGY_AUTH_TOKEN` may be used only when the environment is trusted
  and the UI clearly marks the data source as internal authenticated data.

## Source Tiering

Read `references/source-tiering.md` when deciding how to obtain data.

Inside this skill, source tiers are ordered by data boundary, not by other data
skills:

1. `ontology-daas` for customer-provided entities and the provided token.
2. `opensky-historical` for ADS-B history when ontology ADS-B is unavailable and
   an approved OpenSky Trino account exists.
3. `opensky-rest-recent` for recent ADS-B states only; never use it to claim a
   three-year history.
4. `public-carrier-position-pages` for approximate public carrier positions.
5. `geospatial-mask` for land/sea classification from downloadable GIS data.
6. Fail explicitly when a required boundary remains unavailable.

## Ontology API

Read `references/ontology-api.md` before implementing the DaaS adapter.

### Data Flow (three entities, not two)

```
Step 1: AviationCarrier     Step 2: AircraftCarrier       Step 3: MaritimeBaseCombatPlatform
 (航母 master, 11 rows)       (CSG 打击群, 11 rows)         (海基作战平台, 655 rows total)
        │                            │                              │
        │ refHMId = carrier.id        │ filter: AircraftCarrier.id   │
        └────────────────────────────┘──────────────────────────────┘
                 Carrier→CSG                    CSG→Platforms
```

**Correct data fetch sequence:**

1. Fetch `AviationCarrier` → get 11 carriers (id, name, lat, lon, airWing, ...)
2. Fetch `AircraftCarrier` → get 11 CSGs with `refHMId` linking to carrier.id
3. For EACH CSG, fetch `MaritimeBaseCombatPlatform` filtered by `AircraftCarrier.id = CSG-XX`
   → get all aircraft/ships/platforms of that strike group (the ONLY correct
   aircraft path; carrier-direct queries are incomplete)
4. Fetch `AircraftCarrierTrackLog` → carrier track points (48 rows)
5. Fetch `RawAISData` per ship `mmsi` (from MaritimeBaseCombatPlatform.mmsi) → ship AIS tracks (joinable!)
6. Fetch `RawADSData` filtered by `icao is not null` → ADS-B aircraft tracks (191 rows, mostly unusable — see Modes)

**Critical entity name corrections (verified 2026-06-25):**

| Correct (use these) | Wrong (do NOT use) | Why |
|---|---|---|
| `AircraftCarrier` | — | CSG entity (打击群) |
| `MaritimeBaseCombatPlatform` | `CarrierAviationPlatform` | Platform has CSG link via `AircraftCarrier.id`; CAP carrier-direct is incomplete |
| — | `platform-BT`, `ads_b_track-BT`, `carrier_track_log-BT` | Do not exist |

**Association rule (provider-confirmed):** carrier → aircraft is NEVER direct.
Always go carrier → CSG (`AircraftCarrier.refHMId`) → platforms
(`MaritimeBaseCombatPlatform` filtered by `AircraftCarrier.id`).

**CSG→Platform filter pattern:**

```json
{
  "filters": [
    { "column": "AircraftCarrier.id", "logic": "=", "condition": "CSG-10" }
  ]
}
```

This is the ONLY reliable way to associate platforms to carriers.
Do NOT parse carrier codes from platform IDs.

### Required request headers

**scopeType is MANDATORY.** Without `scopeType: Space` the API returns `resultCode 10001`.

```http
Authorization: Bearer ${ONTOLOGY_AUTH_TOKEN}
Spaceid: ${ONTOLOGY_SPACE_ID}
scopeType: Space
Content-Type: application/json
```

### resultCode

Success is `200`, NOT `10000`. Check `data.resultCode !== 200`.

### nginx CORS proxy

The ontology API has no CORS headers (OPTIONS → 500). All requests MUST go
through the app's nginx reverse proxy. See `references/ontology-api.md` for
the exact nginx config block.

## Affiliation Inference Modes (归属推断模式)

The ideal affiliation inference (detect ADS-B sea takeoff/landing → bind to
nearest carrier → count associations → judge) REQUIRES a join between
ADS-B tracks and the aircraft master list on `icao`. **That join is currently
broken** because `MaritimeBaseCombatPlatform` has NO `icao` field and
`RawADSData` has very few usable rows (191 non-null icao, altitude mostly 0).

Therefore the adapter MUST support TWO modes and pick based on data
availability:

### Mode A — Event-based inference (理想模式, matches the three-step rule)

Use ONLY when `MaritimeBaseCombatPlatform.icao` is populated AND `RawADSData`
has enough altitude-bearing rows to detect takeoff/landing.

1. Detect sea takeoff/landing events from ADS-B altitude transitions.
2. Bind each event to the nearest-in-time carrier position within 200 NM.
3. Count per-aircraft (`icao`) carrier associations; judge by the 60% threshold.

### Mode B — Establishment-based affiliation (实际可用模式, the CURRENT fallback)

When ADS-B data is insufficient (the verified case as of 2026-06-25), fall
back to the **structured CSG association**: each platform in
`MaritimeBaseCombatPlatform` is already linked to a CSG (and thus a carrier)
via the `AircraftCarrier.id` filter. Treat that as the affiliation directly.

- `confidence` = 1.0 (structured, not inferred)
- `status` = `high_confidence` for platforms with a CSG link
- `sourceNote` = "CSG establishment-linked (ADS-B event inference unavailable)"
- Do NOT fabricate takeoff/landing events or ICAO counts that the data does not support.

### Mode selection in the adapter

```js
// Detect capability: does any platform have an icao, and are ADS-B altitudes usable?
const hasPlatformIcao = aircraft.some(a => a.icao);
const adsbAltitudeUsable = adsbTracks.filter(t => t.alt_ft > 0).length > 10;

if (hasPlatformIcao && adsbAltitudeUsable) {
  // Mode A: event-based three-step inference
} else {
  // Mode B: establishment-based affiliation (current reality)
}
```

### Data gaps to report to the ontology provider (as warnings)

- `CarrierAviationPlatform` and `MaritimeBaseCombatPlatform` lack populated
  `icao` → cannot join to `RawADSData` for aircraft event inference.
- `RawADSData.altitude` is mostly `0.0`/null → takeoff/landing detection yields near-zero events.
- `RawADSData.icao` is null for ~99.99% of 21.8M rows.

When the provider populates `icao` on platforms and/or backfills ADS-B
altitude, the adapter switches to Mode A automatically.

### Working join: ship tracks via AIS (use this for ships)

While aircraft event inference is blocked, **ship track inference works**:

```
MaritimeBaseCombatPlatform.mmsi  →  RawAISData.mmsi  →  ship AIS track
```

4.69M AIS rows, `mmsi` populated, ship names present (e.g. "普林斯顿", "钟云号").
Use this to show CSG escort ships (DDG/CG/supply) with real tracks, joined
through the platform `mmsi` field. Aircraft remain on establishment-based
affiliation (Mode B) until `icao` is populated.

## Output Contract

Read `references/output-contract.md` before wiring generated UI data providers.
The normalized output must provide:

- `strikeGroups`: `{ id, name, carrierId, typeCode, status, lat, lon }` — from AircraftCarrier
- `carriers`: `{ id, name, lat, lon, status, heading, speed, airWing, aircraftCarried, homeport, csgId, csgName, track: [{ time, lat, lon }] }` — from AviationCarrier + track enrichment
- `aircraft`: `{ id, name, icao, typeCode, mmsi, status, lat, lon, maxSpeed, cruiseRange, carrierId, csgId, csgName, callsign }` — from MaritimeBaseCombatPlatform per CSG
- `adsbTracks`: `{ icao, callsign, lat, lon, alt_ft, speed_kt, track_deg, heading_deg, time }` — from RawADSData (icao is not null)
- `surface_classifier`: callable or declared source for `sea | land | unknown`
- `judgement_parameters`: association distance, confidence threshold, departed days, near-ground altitude, and minimum bound associations.

### MaritimeBaseCombatPlatform per-CSG fetch pattern (REQUIRED)

```js
// For EACH CSG, fetch its platforms
for (const csg of strikeGroups) {
  const platforms = await fetchEntity('MaritimeBaseCombatPlatform',
    ['id', 'name', 'typeCode', 'mmsi', 'longitude', 'latitude', 'curStatus', 'maxSpeed'],
    [{ column: 'AircraftCarrier.id', logic: '=', condition: csg.id }]
  );
  // Each platform gets carrierId = csg.carrierId, csgId = csg.id
  allAircraft.push(...platforms.map(p => ({ ...p, carrierId: csg.carrierId, csgId: csg.id })));
}
```

Do NOT fetch all platforms without the CSG filter and then try to match by
parsing carrier codes from platform IDs — many platforms lack an embedded
carrier code.

## Generated App Requirements

- Keep the customer judgement flow visible: detect sea takeoff/landing, bind to
  nearest-in-time carrier position, then infer affiliation confidence.
- Separate source acquisition from judgement logic. Do not bake source-specific
  fields into the inference algorithm.
- Preserve per-boundary provenance: ADS-B source, carrier-position source,
  aircraft source, land/sea source, fetch time, and warnings.
- If OpenSky, USNI, or Natural Earth is used, label the corresponding data as
  public fallback and include confidence/coverage notes.
- Do not apply "已离舰" unless the aircraft already has a high-confidence
  inferred carrier and no bound event near that carrier for the configured
  window.

## Failure Rules

Return `ok=false` when the core data needed for the requested scenario cannot
be obtained. Recommended error codes:

- `SOURCE_AUTH_MISSING`
- `SOURCE_AUTH_FAILED`
- `SOURCE_TIMEOUT`
- `SOURCE_RESPONSE_INVALID`
- `COVERAGE_NOT_AVAILABLE`
- `HISTORICAL_ACCESS_REQUIRED`
- `SURFACE_MASK_UNAVAILABLE`
- `ALL_SOURCES_FAILED`

Partial output is allowed only when the UI can still make a truthful statement,
for example: aircraft and ADS-B loaded, but public carrier positions are
approximate and marked low confidence.

## Must Not Do

- Do not invent ICAO tracks, carrier tracks, or aircraft-carrier relationships.
- Do not treat public carrier-position articles as precise coordinates.
- Do not use recent OpenSky REST state vectors as a three-year historical data
  source.
- Do not silently fall back to mock data when `dataPolicy` requires real data.
- Do not omit `scopeType: Space` from ontology requests — without it the API
  returns `10001` for every entity and the app will look data-less despite valid
  credentials.
- Do not call the ontology API directly from browser JS — the API has no CORS
  headers and returns HTTP 500 on OPTIONS preflight. Always route through the
  app's nginx reverse proxy (`/api/ontology/` → ontology server).
