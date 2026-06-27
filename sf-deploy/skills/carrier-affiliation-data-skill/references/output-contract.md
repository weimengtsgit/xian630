# Output Contract

Return this normalized shape to generated applications or downstream judgement
logic.

```json
{
  "ok": true,
  "meta": {
    "sources": {
      "adsbTracks": "ontology-daas",
      "carrierPositions": "ontology-daas",
      "aircraft": "ontology-daas",
      "surfaceMask": "natural-earth"
    },
    "fetchedAt": "2026-06-24T10:00:00+08:00",
    "warnings": []
  },
  "data": {
    "adsbTracks": [],
    "carrierPositions": [],
    "aircraft": [],
    "surfaceClassifier": "natural-earth",
    "judgementParameters": {}
  }
}
```

## adsbTracks

```ts
type AdsbTrackPoint = {
  icao: string;
  aircraftType?: string;
  callsign?: string;
  time: string;
  lat: number;
  lon: number;
  altFt: number;
  speedKt?: number;
  headingDeg?: number;
  verticalRateFpm?: number;
  source?: string;
};
```

Required for candidate sea takeoff/landing detection.

## carrierPositions

```ts
type CarrierTrack = {
  carrierId: string;
  name: string;
  mmsi?: string;
  source: string;
  confidence?: "high" | "medium" | "low";
  track: Array<{
    time: string;
    lat: number;
    lon: number;
    status?: string;
    approximate?: boolean;
  }>;
};
```

Use exact ontology tracks when available. Public article-derived positions must
set `approximate: true` and `confidence: "low"`.

## aircraft

```ts
type CarrierAircraft = {
  icao: string;
  id?: string;
  name?: string;
  aircraftType?: string;
  callsign?: string;
  mmsi?: string;
  source: string;
};
```

Aircraft master data enriches the UI. Missing aircraft master data must not
block ADS-B event detection when valid ADS-B points exist.

## surfaceClassifier

Provide either a callable classifier in generated code or a declared data source
with a lookup function:

```ts
type SurfaceType = "sea" | "land" | "unknown";
type SurfaceClassification = {
  surfaceType: SurfaceType;
  surfaceConfidence: number;
  source: string;
};
```

Use `unknown` near coastlines or outside dataset coverage.

## judgementParameters

```json
{
  "associationDistanceNm": 200,
  "highConfidenceThreshold": 0.6,
  "departedDays": 30,
  "nearGroundAltitudeFt": 100,
  "minimumBoundAssociations": 3
}
```

These defaults come from the customer scenario. The data skill passes them
through; the dashboard judgement logic applies them.

## Partial Results

Partial results are allowed only when the UI can remain truthful:

- ADS-B loaded but carrier positions unavailable: show events but mark binding
  unavailable.
- carrier positions approximate: allow binding only if the UI labels the result
  as approximate / low confidence.
- surface classifier unavailable: show ADS-B tracks but do not mark events as
  suspected sea takeoff/landing.
