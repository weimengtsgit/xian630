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

All list endpoints use the same request shape:

```json
{
  "columns": ["id", "name"],
  "pageParam": {"pageIndex": 1, "limit": 200},
  "rowType": "map",
  "filters": [{"column": "id", "logic": "=", "condition": "value"}]
}
```

All list responses normalize from:

```text
details.columnNames + details.rows
```

into object arrays keyed by `columnNames`.

## Output Contract

Read `references/output-contract.md` before wiring generated UI data providers.
The normalized output must provide:

- `adsbTracks`: `{ icao, aircraftType, time, lat, lon, altFt, speedKt, callsign }`
- `carrierPositions`: `{ carrierId, name, track: [{ time, lat, lon }] }`
- `aircraft`: `{ icao, name, aircraftType, callsign, mmsi }`
- `surfaceClassifier`: callable or declared source for `sea | land | unknown`
- `judgementParameters`: association distance, confidence threshold, departed
  days, near-ground altitude, and minimum bound associations.

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
