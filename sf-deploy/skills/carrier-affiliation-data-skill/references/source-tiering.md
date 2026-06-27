# Source Tiering

Use these tiers inside `carrier-affiliation-data-skill`. They do not define a
priority relationship with other data skills.

## Tier 1: ontology-daas

Use customer ontology/DaaS when credentials are present. This is the preferred
source for:

- ADS-B raw records via `RawADSData/list`
- carrier tracks via `AircraftCarrierTrackLog/list`
- carrier master data via `AviationCarrier/list`
- aircraft master data via `CarrierAviationPlatform/list`
- related OSINT via `MediaReport/list`
- behavior laws via `CarrierStrikeGroupOperationalBehaviorLaws/list`

Failure modes:

- missing token -> `SOURCE_AUTH_MISSING`
- 401/403 -> `SOURCE_AUTH_FAILED`
- malformed `details.rows` -> `SOURCE_RESPONSE_INVALID`

> **Access path = REST endpoints only.** Tier 1 means the REST entity endpoints
> (`POST /daasDMS/entity/<Entity>/list`) with the committed `ONTOLOGY_AUTH_TOKEN`,
> which work. The ontology MCP path (`本体 MCP 接口与连接指南`, in the docs catalog)
> is **not** part of Tier 1 and must not be conflated with it: as of 2026-06-24 the
> MCP transport connects but token auth fails (协议通 / token不通), so it is
> unavailable. Do not drop to lower tiers merely because MCP is down — the REST
> endpoints still serve Tier 1.

## Tier 2: opensky-historical

Use OpenSky historical data only when the consumer has approved OpenSky Trino
access. It is suitable for ADS-B history because `state_vectors_data4` provides
time, `icao24`, `lat`, `lon`, velocity, heading, vertical rate, callsign,
onground, and altitude fields.

Rules:

- Always filter on the partition column (`hour`) and small time windows.
- Do not run global or multi-day unbounded scans.
- Convert velocity from m/s to knots and altitude from meters to feet.
- If access is not approved, return `HISTORICAL_ACCESS_REQUIRED`.

## Tier 3: opensky-rest-recent

Use OpenSky REST only for recent state vectors or short diagnostic checks.
Authenticated state history is limited and cannot satisfy a three-year
historical scenario.

Rules:

- Use for current/near-current `icao24` or bounding-box state vectors.
- Do not claim it provides the requested multi-year history.
- Surface rate-limit and coverage warnings.

## Tier 4: public-carrier-position-pages

Use public pages only as approximate carrier-position fallback. USNI Fleet and
Marine Tracker is acceptable for approximate positions and narrative status.

Rules:

- Label every point as `approximate`.
- Record article URL and publication date.
- Do not treat page-derived positions as precise track truth.
- Do not use public pages to fabricate missing daily tracks.

## Tier 5: geospatial-mask

Use downloadable GIS data for land/sea classification when the ontology has no
surface classifier. Acceptable sources include Natural Earth physical vectors
for coarse land/coastline/ocean classification and higher-precision datasets
when available.

Rules:

- Return `sea`, `land`, or `unknown`.
- Preserve the classifier source and resolution.
- Use `unknown` when precision is insufficient near coasts.

## Tier 6: fail-explicitly

Fail when core data cannot be obtained truthfully.

Examples:

- ADS-B track source unavailable for the requested time range.
- no carrier positions and no acceptable public approximate fallback.
- no land/sea classifier for a scenario requiring sea takeoff/landing.

Do not silently return mock data unless `dataPolicy=mock_data` or the caller
explicitly sets `useMock=true`.
