import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveCandidateEvents,
  bindToCarriers,
  inferAffiliation,
  computeDeparted,
  haversineNm,
} from "./affiliation.js";
import * as affiliation from "./affiliation.js";

// ─── Helpers: build synthetic ADS-B tracks ─────────────────────────────────
// A track is an ascending-time series of altitude samples for one aircraft.
// nearGround = <= 100 ft (default nearGroundAltitudeFt). positive = clearly
// airborne. We simulate sustained transitions for takeoff/landing detection.

const T0 = Date.UTC(2024, 5, 1, 0, 0, 0); // 2024-06-01 fixed epoch

function step(min) {
  return new Date(T0 + min * 60_000).toISOString();
}

// build a takeoff: ground (50ft) for a moment, then a sustained climb to cruise.
function takeoffTrack(startMin, baseLat, baseLon) {
  return [
    { icao: "A1", aircraftType: "F-18", time: step(startMin), lat: baseLat, lon: baseLon, altFt: 50, speedKt: 30 },
    { icao: "A1", aircraftType: "F-18", time: step(startMin + 1), lat: baseLat, lon: baseLon, altFt: 60, speedKt: 90 },
    { icao: "A1", aircraftType: "F-18", time: step(startMin + 2), lat: baseLat, lon: baseLon, altFt: 1200, speedKt: 180 },
    { icao: "A1", aircraftType: "F-18", time: step(startMin + 3), lat: baseLat, lon: baseLon, altFt: 9000, speedKt: 320 },
  ];
}

// build a landing: cruise -> sustained descent -> near-ground hold.
function landingTrack(startMin, baseLat, baseLon) {
  return [
    { icao: "A1", aircraftType: "F-18", time: step(startMin), lat: baseLat, lon: baseLon, altFt: 8000, speedKt: 300 },
    { icao: "A1", aircraftType: "F-18", time: step(startMin + 1), lat: baseLat, lon: baseLon, altFt: 1000, speedKt: 160 },
    { icao: "A1", aircraftType: "F-18", time: step(startMin + 2), lat: baseLat, lon: baseLon, altFt: 80, speedKt: 60 },
    { icao: "A1", aircraftType: "F-18", time: step(startMin + 3), lat: baseLat, lon: baseLon, altFt: 70, speedKt: 25 },
  ];
}

// ─── Step 1: sea event detection ───────────────────────────────────────────

test("Step 1: near-ground → positive at sea is a suspected takeoff", () => {
  const tracks = takeoffTrack(0, 35.0, 140.0); // sea coords
  const events = deriveCandidateEvents(tracks, {
    nearGroundAltitudeFt: 100,
    classifySurface: () => "sea",
  });
  assert.ok(events.length >= 1, "should emit at least one event");
  const to = events.find((e) => e.eventType === "takeoff");
  assert.ok(to, "expected a takeoff event");
  assert.equal(to.surfaceType, "sea");
  assert.equal(to.suspected, true, "sea event is suspected");
  assert.equal(to.altitudeTransition.from <= 100, true);
  assert.equal(to.altitudeTransition.to > 100, true);
});

test("Step 1: positive → near-ground at sea is a suspected landing", () => {
  const tracks = landingTrack(10, 35.0, 140.0);
  const events = deriveCandidateEvents(tracks, {
    nearGroundAltitudeFt: 100,
    classifySurface: () => "sea",
  });
  const ld = events.find((e) => e.eventType === "landing");
  assert.ok(ld, "expected a landing event");
  assert.equal(ld.surfaceType, "sea");
  assert.equal(ld.suspected, true);
  assert.equal(ld.altitudeTransition.from > 100, true);
  assert.equal(ld.altitudeTransition.to <= 100, true);
});

test("Step 1: land/unknown transition is retained but NOT suspected", () => {
  const tracks = takeoffTrack(0, 36.0, 140.0); // land coords per mock mask
  const events = deriveCandidateEvents(tracks, {
    nearGroundAltitudeFt: 100,
    classifySurface: () => "land",
  });
  const to = events.find((e) => e.eventType === "takeoff");
  assert.ok(to, "land event still retained for audit");
  assert.equal(to.surfaceType, "land");
  assert.equal(to.suspected, false, "land event must not be suspected");
});

test("Step 1: unknown surface retained but not suspected", () => {
  const tracks = takeoffTrack(0, 20.0, 160.0);
  const events = deriveCandidateEvents(tracks, {
    nearGroundAltitudeFt: 100,
    classifySurface: () => "unknown",
  });
  assert.equal(events.some((e) => e.suspected === false), true);
});

// ─── Step 2: spatiotemporal carrier binding ────────────────────────────────

test("Step 2: event within 200nm of nearest-in-time carrier position binds", () => {
  const events = [
    {
      id: "e1", icao: "A1", eventType: "takeoff",
      time: step(0), lat: 35.0, lon: 140.0,
      altitudeTransition: { from: 50, to: 1200 }, speedKt: 180,
      surfaceType: "sea", suspected: true,
    },
  ];
  const carriers = [
    { id: "CVN1", name: "CVN-1", track: [{ time: step(0), lat: 35.2, lon: 140.2 }] },
  ];
  const bound = bindToCarriers(events, carriers, { associationDistanceNm: 200 });
  assert.equal(bound[0].bindingStatus, "bound");
  assert.equal(bound[0].boundCarrierId, "CVN1");
  assert.ok(typeof bound[0].distanceNm === "number");
  assert.ok(bound[0].distanceNm < 200);
  assert.ok(typeof bound[0].carrierPositionTimeDeltaMinutes === "number");
});

test("Step 2: event beyond 200nm is unbound", () => {
  const events = [
    {
      id: "e2", icao: "A2", eventType: "takeoff",
      time: step(0), lat: 35.0, lon: 140.0,
      altitudeTransition: { from: 50, to: 1200 }, speedKt: 180,
      surfaceType: "sea", suspected: true,
    },
  ];
  const carriers = [
    // ~ far away (>200nm): ~10 deg lat ≈ 600nm
    { id: "CVN2", name: "CVN-2", track: [{ time: step(0), lat: 45.0, lon: 140.0 }] },
  ];
  const bound = bindToCarriers(events, carriers, { associationDistanceNm: 200 });
  assert.equal(bound[0].bindingStatus, "unbound");
  assert.equal(bound[0].boundCarrierId, null);
  assert.ok(bound[0].distanceNm >= 200);
});

test("Step 2: nearest-IN-TIME (not nearest-in-space) carrier is chosen", () => {
  // Event at t=0. CarrierA is spatially closer but its position is 2 hours off;
  // CarrierB is spatially farther but its position is at exactly t=0.
  // The contract says nearest-in-time wins.
  const events = [
    {
      id: "e3", icao: "A3", eventType: "takeoff",
      time: step(0), lat: 35.0, lon: 140.0,
      altitudeTransition: { from: 50, to: 1200 }, speedKt: 180,
      surfaceType: "sea", suspected: true,
    },
  ];
  const carriers = [
    {
      id: "CLOSE-BUT-LATE", name: "x",
      track: [{ time: step(120), lat: 35.1, lon: 140.1 }], // 120 min later, very close
    },
    {
      id: "FAR-BUT-ON-TIME", name: "y",
      track: [{ time: step(0), lat: 36.0, lon: 141.0 }], // exact time, ~90nm away
    },
  ];
  const bound = bindToCarriers(events, carriers, { associationDistanceNm: 200 });
  assert.equal(bound[0].bindingStatus, "bound");
  assert.equal(bound[0].boundCarrierId, "FAR-BUT-ON-TIME");
});

// ─── Step 3: affiliation judgement ─────────────────────────────────────────

test("Step 3: denominator = bound events only; unbound excluded", () => {
  const events = [
    ev("b1", "A1", "takeoff", "CVN1", "bound"),
    ev("b2", "A1", "landing", "CVN1", "bound"),
    ev("b3", "A1", "takeoff", "CVN1", "bound"),
    ev("u1", "A1", "takeoff", null, "unbound"), // unbound — must NOT count
  ];
  const res = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a1 = res.find((r) => r.icao === "A1");
  assert.equal(a1.carrierProbabilities.length, 1);
  assert.equal(a1.carrierProbabilities[0].carrierId, "CVN1");
  assert.equal(a1.carrierProbabilities[0].associationCount, 3);
  assert.equal(a1.carrierProbabilities[0].probability, 1);
  assert.equal(a1.unboundSuspectedEventCount, 1, "unbound reported separately");
  assert.equal(a1.status, "高置信度属舰飞机");
});

test("Step 3: >60% single carrier → 高置信度属舰", () => {
  const events = [
    ev("b1", "A1", "takeoff", "CVN1", "bound"),
    ev("b2", "A1", "takeoff", "CVN1", "bound"),
    ev("b3", "A1", "takeoff", "CVN1", "bound"),
    ev("b4", "A1", "takeoff", "CVN2", "bound"),
  ];
  const res = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a1 = res.find((r) => r.icao === "A1");
  // CVN1 = 3/4 = 0.75 > 0.6
  assert.equal(a1.status, "高置信度属舰飞机");
  assert.equal(a1.inferredCarrierId, "CVN1");
  assert.ok(a1.confidence > 0.6);
});

test("Step 3: ≥2 carriers none >60% → 疑似交叉部署", () => {
  const events = [
    ev("b1", "A2", "takeoff", "CVN1", "bound"),
    ev("b2", "A2", "takeoff", "CVN1", "bound"),
    ev("b3", "A2", "takeoff", "CVN2", "bound"),
    ev("b4", "A2", "takeoff", "CVN2", "bound"),
  ];
  const res = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a2 = res.find((r) => r.icao === "A2");
  assert.equal(a2.status, "疑似交叉部署飞机");
  assert.equal(a2.inferredCarrierId, null);
  assert.equal(a2.carrierProbabilities.length, 2);
  // each 0.5, none > 0.6
  assert.equal(a2.carrierProbabilities[0].probability, 0.5);
});

test("Step 3: <3 bound → 数据不足", () => {
  const events = [
    ev("b1", "A3", "takeoff", "CVN1", "bound"),
    ev("b2", "A3", "takeoff", "CVN1", "bound"),
    // only 2 bound
    ev("u1", "A3", "takeoff", null, "unbound"),
  ];
  const res = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a3 = res.find((r) => r.icao === "A3");
  assert.equal(a3.status, "数据不足");
});

test("Step 3: audit-only aircraft is excluded from suspected aircraft inference", () => {
  const events = [
    {
      ...ev("audit-1", "AUDIT-ONLY", "takeoff", null, "unbound"),
      suspected: false,
      surfaceType: "land",
    },
  ];

  const res = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });

  assert.equal(res.some((aircraft) => aircraft.icao === "AUDIT-ONLY"), false);
});

test("Step 3: confidence probability = boundFor / totalBound", () => {
  const events = [
    ev("b1", "A4", "takeoff", "CVN1", "bound"),
    ev("b2", "A4", "takeoff", "CVN1", "bound"),
    ev("b3", "A4", "takeoff", "CVN2", "bound"),
    ev("b4", "A4", "takeoff", "CVN2", "bound"),
    ev("b5", "A4", "takeoff", "CVN2", "bound"),
  ];
  const res = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a4 = res.find((r) => r.icao === "A4");
  const cvn1 = a4.carrierProbabilities.find((c) => c.carrierId === "CVN1");
  const cvn2 = a4.carrierProbabilities.find((c) => c.carrierId === "CVN2");
  assert.equal(cvn1.probability, 2 / 5);
  assert.equal(cvn2.probability, 3 / 5);
});

test("Association timeline keeps suspected events in chronological carrier order", () => {
  const timeline = affiliation.buildCarrierAssociationTimeline([
    evDated("e2", "A1", "landing", "CVN2", "bound", step(20)),
    { ...evDated("audit", "A1", "takeoff", null, "unbound", step(10)), suspected: false },
    evDated("e1", "A1", "takeoff", "CVN1", "bound", step(0)),
  ], "A1");

  assert.deepEqual(
    timeline.map((event) => [event.id, event.carrierId]),
    [["e1", "CVN1"], ["e2", "CVN2"]]
  );
});

// ─── Departed alert ────────────────────────────────────────────────────────

test("Departed: high-confidence assigned aircraft with last bound >30d → 已离舰", () => {
  const now = new Date(T0 + 45 * 86_400_000).toISOString(); // 45 days after T0
  const events = [
    evDated("b1", "A1", "takeoff", "CVN1", "bound", step(0)),
    evDated("b2", "A1", "takeoff", "CVN1", "bound", step(10)),
    evDated("b3", "A1", "takeoff", "CVN1", "bound", step(20)),
  ];
  const inference = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a1 = inference.find((r) => r.icao === "A1");
  const carriers = [{ id: "CVN1", name: "CVN-1" }];
  computeDeparted(a1, events, carriers, { departedDays: 30 }, now);
  assert.equal(a1.status, "已离舰");
});

test("Departed: high-confidence but last bound within 30d stays assigned", () => {
  const now = new Date(T0 + 20 * 86_400_000).toISOString(); // 20 days
  const events = [
    evDated("b1", "A1", "takeoff", "CVN1", "bound", step(0)),
    evDated("b2", "A1", "takeoff", "CVN1", "bound", step(10)),
    evDated("b3", "A1", "takeoff", "CVN1", "bound", step(20)),
  ];
  const inference = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a1 = inference.find((r) => r.icao === "A1");
  computeDeparted(a1, events, [{ id: "CVN1", name: "CVN-1" }], { departedDays: 30 }, now);
  assert.equal(a1.status, "高置信度属舰飞机");
});

test("Departed: never applied to cross-deploy", () => {
  const now = new Date(T0 + 45 * 86_400_000).toISOString();
  const events = [
    evDated("b1", "A2", "takeoff", "CVN1", "bound", step(0)),
    evDated("b2", "A2", "takeoff", "CVN1", "bound", step(10)),
    evDated("b3", "A2", "takeoff", "CVN2", "bound", step(20)),
    evDated("b4", "A2", "takeoff", "CVN2", "bound", step(30)),
  ];
  const inference = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a2 = inference.find((r) => r.icao === "A2");
  computeDeparted(a2, events, [{ id: "CVN1", name: "x" }, { id: "CVN2", name: "y" }], { departedDays: 30 }, now);
  assert.equal(a2.status, "疑似交叉部署飞机", "cross-deploy must NOT become departed");
});

test("Departed: never applied to insufficient", () => {
  const now = new Date(T0 + 45 * 86_400_000).toISOString();
  const events = [
    evDated("b1", "A3", "takeoff", "CVN1", "bound", step(0)),
    evDated("b2", "A3", "takeoff", "CVN1", "bound", step(10)),
  ];
  const inference = inferAffiliation(events, {
    highConfidenceThreshold: 0.6,
    minimumBoundAssociations: 3,
  });
  const a3 = inference.find((r) => r.icao === "A3");
  computeDeparted(a3, events, [{ id: "CVN1", name: "x" }], { departedDays: 30 }, now);
  assert.equal(a3.status, "数据不足", "insufficient must NOT become departed");
});

// ─── haversine sanity ──────────────────────────────────────────────────────

test("haversineNm: same point = 0", () => {
  assert.equal(haversineNm(35, 140, 35, 140), 0);
});

test("haversineNm: 1 degree lat ≈ 60nm", () => {
  const d = haversineNm(35, 140, 36, 140);
  assert.ok(d > 59 && d < 61, `got ${d}`);
});

// ─── helpers ───────────────────────────────────────────────────────────────

function ev(id, icao, eventType, carrierId, bindingStatus) {
  return evDated(id, icao, eventType, carrierId, bindingStatus, step(0));
}

function evDated(id, icao, eventType, carrierId, bindingStatus, time) {
  return {
    id, icao, eventType, time,
    lat: 35, lon: 140,
    altitudeTransition: { from: 50, to: 1200 },
    speedKt: 180, surfaceType: "sea", suspected: true,
    boundCarrierId: carrierId, bindingStatus,
    distanceNm: bindingStatus === "bound" ? 50 : 9999,
    carrierPositionTimeDeltaMinutes: 0,
  };
}
