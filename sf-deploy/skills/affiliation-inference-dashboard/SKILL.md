---
name: affiliation-inference-dashboard
description: Use when generating dashboards that infer aircraft, vessel, unit, or asset affiliation from observed events, spatiotemporal associations, confidence thresholds, relationship trees, timelines, heat maps, and stale-activity alerts.
---

# Affiliation Inference Dashboard

Use this skill with `software-factory-app`, `defense-operations-ui`, and
`command-dashboard` when the confirmed requirement asks the generated
application to infer parent-child or ownership relationships from historical
activity events.

## Must Do

- Preserve the customer's judgement rules, thresholds, labels, and stated data
  sources as the default scenario framing.
- Treat thresholds, distance windows, minimum sample counts, and stale-activity
  windows as configurable judgement parameters. Use the customer's values as
  demo defaults.
- Keep the first version static and self-contained with a mock data provider
  shaped for future real data adapters.
- Separate raw observed events, filtered candidate events, bound associations,
  inferred affiliation results, and alert state in the data model.
- Make the confidence calculation explicit, including numerator, denominator,
  threshold, and excluded/unbound events.
- Include at least one relationship view, one timeline or event history view,
  and one spatial aggregation view when the scenario includes spatial events.
- Provide clear status labels, not only color: high-confidence affiliation,
  suspected cross-deployment, insufficient data, and stale/departed alerts when
  relevant.
- Add drill-down details that explain why a selected entity received its current
  status.

## Carrier Air-Wing Affiliation Pattern

For the carrier-aircraft affiliation scenario:

- Use ADS-B historical tracks as a mock adapter boundary with ICAO code, time,
  latitude, longitude, altitude, speed, and aircraft type.
- Use known carrier positions as a separate mock adapter boundary with carrier
  id/name, time, latitude, longitude, and track segment.
- Detect suspected carrier-aircraft takeoff/landing events from near-ground to
  positive altitude transitions and positive altitude to near-ground transitions.
  Keep the customer wording "高度从零到正值 / 正值归零" visible; demo processing
  may apply a near-ground noise threshold.
- Classify event coordinates as sea/land/unknown before accepting a suspected
  carrier-aircraft event. Demo data should carry this classification explicitly.
- Bind each accepted event to the nearest-in-time known carrier position when
  the distance is below the configured threshold. Default: 200 nautical miles.
- Compute carrier affiliation confidence as:
  `carrierBoundAssociationsForCarrier / allCarrierBoundAssociationsForAircraft`.
  Unbound suspected events are shown separately and do not dilute the denominator.
- Default high-confidence affiliation threshold: greater than 60%.
- Default insufficient-data minimum sample count: fewer than 3 bound
  associations.
- Mark "疑似交叉部署飞机" when an aircraft has associations with two or more
  carriers and no carrier exceeds the high-confidence threshold.
- Mark "已离舰" only for a high-confidence assigned aircraft that has no
  takeoff/landing near its assigned carrier for 30 consecutive days.

## Required Views

- Left panel: suspected carrier-aircraft list with ICAO code, aircraft type,
  first seen date, latest activity date, total takeoff/landing count, inferred
  carrier, confidence, filter by carrier, active/stale sorting, and expandable
  timeline + carrier-change chart.
- Upper-right panel: carrier affiliation relationship tree showing carriers and
  child aircraft, confidence, and latest takeoff/landing time.
- Lower-right panel: global takeoff/landing heat map showing red sea events and
  blue carrier tracks, with timeline replay and hover/click details.
- Cross-panel interactions:
  - Selecting an aircraft highlights its relationship-tree node and heat-map
    events.
  - Selecting a carrier filters the aircraft list and highlights that carrier's
    track.
  - Selecting a map event expands the corresponding aircraft row and shows
    event, carrier, distance, time-delta, and binding details.

## Must Not Do

- Do not require live ADS-B access, carrier-position feeds, credentials, or a
  backend collector in the first generated application.
- Do not describe the generated app as a real intelligence system; keep mock
  data boundaries explicit while preserving the customer's judgement framing.
- Do not use `demo01` / `demo02` names. The model supplies a normalized scenario
  name and Factory appends a trusted random serial.
- Do not apply "已离舰" to suspected cross-deployment or insufficient-data
  aircraft.
- Do not treat unbound suspected events as evidence against a carrier's
  confidence share.
