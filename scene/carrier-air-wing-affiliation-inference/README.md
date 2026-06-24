# 航母舰载机归属推断工具

Reference-only scene blueprint for a carrier-air-wing affiliation inference
dashboard. This is a **hidden scene blueprint**, not a visible preset
application and not a copyable code template.

The blueprint preserves the customer's fifth supplied scenario. "航母编队月度航迹复盘"
and "东海目标态势演示" are internal demo scenarios and do not consume customer
scenario numbering.

## Data Boundary

First implementation uses an explicit **mock / demo data contract**. The UI and
judgement rules should present the customer's source framing, but the local
generated application must not require live data access, credentials, a backend
collector, or cloud services.

Future real integrations are delegated to data-access skills/adapters:

- ADS-B historical database adapter:
  - ICAO code
  - timestamp
  - latitude / longitude
  - altitude
  - `speedKt`
  - aircraft type
- Known US carrier position adapter:
  - carrier id / name
  - timestamp
  - latitude / longitude
  - known track segment
- Land/sea mask adapter:
  - `surfaceType: "sea" | "land" | "unknown"`
  - `surfaceConfidence`

## Customer Judgement Rules

### Step 1: Identify Sea Takeoff / Landing

Customer wording:

- Extract all takeoff events where ADS-B altitude goes from zero to positive.
- Extract all landing events where altitude goes from positive to zero.
- Extract the takeoff/landing coordinates.
- If the coordinate is at sea, mark it as `疑似舰载机起降`.

Demo processing may apply near-ground noise handling without changing the
customer framing:

- Treat `<= 100 ft` as the default near-ground threshold.
- Takeoff: near-ground to positive flight state, with short sustained climb.
- Landing: positive flight state to near-ground, with short near-ground hold.
- Only `surfaceType === "sea"` is accepted as a suspected carrier-aircraft event.
- Land and unknown points are retained for audit/detail panels but not counted
  as suspected carrier-aircraft takeoff/landing.

### Step 2: Spatiotemporal Carrier Binding

For each suspected sea takeoff/landing event:

- Compare it with the nearest-in-time known carrier position.
- If distance is below the configured threshold, bind the event to that carrier.
- Customer default distance threshold: **200 nautical miles**.
- Demo data reports:
  - bound carrier
  - distance in nautical miles
  - carrier position timestamp
  - `carrierPositionTimeDeltaMinutes`
  - binding result

The first blueprint version uses nearest-in-time known carrier positions, not
interpolated carrier tracks. Future data-access skills may upgrade the adapter
to interpolated positions without changing the UI contract.

### Step 3: Affiliation Judgement

For each aircraft:

- Count bound associations with each carrier.
- Compute affiliation confidence as:

```text
carrierBoundAssociationsForCarrier / allCarrierBoundAssociationsForAircraft
```

- Unbound suspected events are shown separately and do not dilute the confidence
  denominator.
- Customer default high-confidence threshold: **greater than 60%**.
- Default insufficient-data threshold: fewer than **3** bound associations.

Status labels:

- `高置信度属舰飞机`: one carrier exceeds the configured confidence threshold.
- `疑似交叉部署飞机`: associated with two or more carriers, and no carrier exceeds
  the high-confidence threshold.
- `数据不足`: fewer than the configured minimum bound association count.
- `已离舰`: only for a high-confidence assigned aircraft with no takeoff/landing
  near its assigned carrier for **30 consecutive days**.

All numeric values are judgement parameters. Use customer values as demo
defaults, but allow later versions to read them from user interaction or
external interfaces.

## Required UI Structure

### Left: 疑似舰载机列表

Table columns:

- ICAO code
- aircraft type
- first discovered date
- latest activity date
- total takeoff/landing count
- current inferred carrier
- affiliation confidence
- status label

Controls:

- filter by carrier
- sort by active/stale state, latest activity, confidence, and alert priority
- expandable row showing takeoff/landing timeline and carrier-association change
  chart

Default ordering:

1. `已离舰`
2. `高置信度属舰飞机`
3. `疑似交叉部署飞机`
4. `数据不足`

Within the same status, sort by latest activity descending.

### Upper Right: 航母归属关系树

Tree display:

- carrier node
- child aircraft nodes
- confidence
- latest takeoff/landing time
- status badge

Clicking an aircraft jumps to the left-side detail row.

### Lower Right: 起降热力地图

Use a global equirectangular map projection so future global ADS-B and carrier
position adapters remain visible without changing the UI contract.

Map layers:

- red sea takeoff/landing heat points
- blue known carrier tracks
- optional land/unknown event audit points
- timeline replay control

Hover/click details:

- ICAO code
- aircraft type
- event type: takeoff / landing
- event time
- altitude transition
- coordinates
- surface classification
- bound carrier
- distance to carrier
- carrier-position time delta
- binding result

## Cross-Panel Interaction

- Selecting an aircraft in the left table highlights its relationship-tree node
  and heat-map events.
- Selecting a carrier in the relationship tree filters the aircraft table and
  highlights that carrier's blue track.
- Selecting a heat-map event expands the corresponding aircraft row and shows
  the event binding details.
- Timeline replay controls map points and carrier-track window display. It does
  not rewrite the left-side total statistics; the selected detail panel may show
  hits within the current replay window.

## Mock Payload Shape

```js
{
  sourceState: {
    adsbSource: "ADS-B 历史数据库（mock）",
    carrierPositionSource: "美航母已知位置库（mock）",
    landSeaMaskSource: "海陆掩膜（mock）",
    dataWindowYears: 3,
    lastLoadedAt: ISO
  },
  judgementParameters: {
    associationDistanceNm: 200,
    highConfidenceThreshold: 0.6,
    departedDays: 30,
    nearGroundAltitudeFt: 100,
    minimumBoundAssociations: 3
  },
  aircraft: [{
    icao,
    aircraftType,
    firstSeenDate,
    latestActivityDate,
    totalTakeoffLandingCount,
    inferredCarrierId,
    confidence,
    status,
    unboundSuspectedEventCount,
    carrierProbabilities: [{ carrierId, associationCount, probability }]
  }],
  carriers: [{
    id,
    name,
    track: [{ time, lat, lon }]
  }],
  events: [{
    id,
    icao,
    eventType,
    time,
    lat,
    lon,
    altitudeTransition,
    speedKt,
    surfaceType,
    surfaceConfidence,
    boundCarrierId,
    distanceNm,
    carrierPositionTimeDeltaMinutes,
    bindingStatus
  }]
}
```

## Generation Profile

```json
{
  "base": ["software-factory-app"],
  "domain": ["defense-operations-ui"],
  "pattern": [
    "command-dashboard",
    "maritime-alert-dashboard",
    "affiliation-inference-dashboard"
  ],
  "blueprintRefs": ["carrier-air-wing-affiliation-inference"]
}
```

## Naming Rule

Generated applications must follow the current Factory naming rule:

- The model supplies a concise `normalizedScenarioName`, for example
  `航母舰载机归属推断工具`.
- Factory appends a trusted 4-character uppercase Base36 random serial.
- Readable example: `航母舰载机归属推断工具-K7M2`.
- No `demo01` / `demo02` naming.

## Acceptance Focus

- Customer's three-step judgement flow is visible and traceable.
- 200 nautical miles, 60%, 30 days, near-ground threshold, and minimum-sample
  count are displayed as judgement parameters.
- The table, relationship tree, and heat map are all visible in the first
  operational viewport.
- Selecting any aircraft, carrier, or heat-map event updates the other relevant
  panels.
- Mock data includes at least one high-confidence aircraft, one suspected
  cross-deployment aircraft, one insufficient-data aircraft, and one departed
  alert.
