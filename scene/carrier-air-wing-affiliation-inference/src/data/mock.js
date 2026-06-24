// ─────────────────────────────────────────────────────────────────────────────
// Demo data contract + payload assembler for the carrier-air-wing affiliation
// inference dashboard.
//
// MOCK ONLY. No live ADS-B, carrier-position DB, or GIS land/sea mask. The four
// adapter boundaries below (adsbTracks, carrierPositions, classifySurface,
// judgementParameters) are the explicit "未实现的真实数据接入边界": every one of
// them is a distinct, replaceable input that a future real-data skill would
// swap in without touching the judgement core (src/logic/affiliation.js).
//
// Seed data deliberately includes the four required aircraft archetypes:
//   • 高置信度属舰飞机 (single carrier >60%, ≥3 bound)
//   • 疑似交叉部署飞机 (≥2 carriers, none >60%, ≥3 bound)
//   • 数据不足 (<3 bound)
//   • 已离舰 (high-confidence assigned, last bound >30d before `now`)
// ─────────────────────────────────────────────────────────────────────────────

import {
  deriveCandidateEvents,
  bindToCarriers,
  inferAffiliation,
  computeDeparted,
} from "../logic/affiliation.js";

// ─── Customer judgement parameters (demo defaults) ──────────────────────────
export const judgementParameters = {
  associationDistanceNm: 200,
  highConfidenceThreshold: 0.6,
  departedDays: 30,
  nearGroundAltitudeFt: 100,
  minimumBoundAssociations: 3,
};

// ─── Adapter boundary 1: ADS-B historical tracks ────────────────────────────
// Shape: { icao, aircraftType, time, lat, lon, altFt, speedKt }.
// Coordinates are synthetic but realistic for a West-Pacific carrier operating
// area. Times are anchored so that "now" (default = build time) is recent
// relative to most events, while the 已离舰 aircraft's last bound event is
// deliberately >30 days stale.

const DAY = 86_400_000;
// Anchor: payload builds relative to a fixed "now" so the departed aircraft is
// deterministically stale. We use a base epoch and let buildPayload compute.
const BASE = Date.UTC(2024, 5, 15, 0, 0, 0); // 2024-06-15

function t(days, min = 0) {
  return new Date(BASE + days * DAY + min * 60_000).toISOString();
}

// Build a takeoff/landing ADS-B mini-history at a coordinate. Returns a sorted
// ascending-time sample series producing one takeoff or one landing transition.
// Each series ends airborne (cruise) / grounded so concatenating multiple series
// for the same aircraft does NOT create a phantom transition at the seam: a
// cruise→cruise seam is inert, and the landing helper's final near-ground point
// is followed by a takeoff's ground point only when the caller intends a cycle.
function climb(icao, type, startIso, lat, lon) {
  return [
    { icao, aircraftType: type, time: startIso, lat, lon, altFt: 50, speedKt: 30 },
    { icao, aircraftType: type, time: shiftMin(startIso, 1), lat, lon, altFt: 70, speedKt: 120 },
    { icao, aircraftType: type, time: shiftMin(startIso, 2), lat, lon, altFt: 1500, speedKt: 190 },
    { icao, aircraftType: type, time: shiftMin(startIso, 3), lat, lon, altFt: 9500, speedKt: 330 },
    // hold cruise — seam-safe when concatenated with another airborne series
    { icao, aircraftType: type, time: shiftMin(startIso, 4), lat, lon, altFt: 9800, speedKt: 340 },
  ];
}
function descend(icao, type, startIso, lat, lon) {
  return [
    { icao, aircraftType: type, time: startIso, lat, lon, altFt: 8200, speedKt: 300 },
    { icao, aircraftType: type, time: shiftMin(startIso, 1), lat, lon, altFt: 1100, speedKt: 170 },
    { icao, aircraftType: type, time: shiftMin(startIso, 2), lat, lon, altFt: 80, speedKt: 60 },
    { icao, aircraftType: type, time: shiftMin(startIso, 3), lat, lon, altFt: 60, speedKt: 20 },
    // hold near-ground — seam-safe: a following takeoff's ground point is inert
    { icao, aircraftType: type, time: shiftMin(startIso, 4), lat, lon, altFt: 50, speedKt: 15 },
  ];
}
function shiftMin(iso, min) {
  return new Date(Date.parse(iso) + min * 60_000).toISOString();
}

// Carrier operating boxes (sea). CVN-78 near 33N140E, CVN-71 near 30N138E.
const CVN78_BOX = { lat: 33.0, lon: 140.5 };
const CVN71_BOX = { lat: 30.0, lon: 138.0 };
const FAR_SEA = { lat: 25.0, lon: 134.0 }; // sea but >200nm from both carriers

// A1 — 高置信度属舰飞机 (CVN-78). 4 bound to CVN-78, 1 bound to CVN-71.
const A1 = []
  .concat(climb("A1", "F/A-18E", t(-40, 0), 33.05, 140.48))
  .concat(descend("A1", "F/A-18E", t(-38, 120), 33.02, 140.52))
  .concat(climb("A1", "F/A-18E", t(-30, 0), 33.04, 140.50))
  .concat(descend("A1", "F/A-18E", t(-22, 60), 33.01, 140.49))
  .concat(climb("A1", "F/A-18E", t(-10, 0), 30.05, 138.02)) // near CVN-71 (cross sample)

// A2 — 疑似交叉部署飞机. Exactly 2 bound to CVN-78 + 2 bound to CVN-71 (50/50,
// none >60%). Four isolated takeoffs (climb) — two per carrier box. The
// climb→climb seams produce landings at the *next* climb's location, which we
// make bind to the correct carrier by supplying dense, time-matched carrier
// positions for every box visit below.
const A2 = []
  .concat(climb("A2", "F-35C", t(-35, 0), 33.03, 140.51)) // CVN-78 box (takeoff)
  .concat(climb("A2", "F-35C", t(-32, 0), 30.04, 138.01)) // CVN-71 box (takeoff + seam landing)
  .concat(climb("A2", "F-35C", t(-28, 0), 33.02, 140.52)) // CVN-78 box (takeoff + seam landing)
  .concat(climb("A2", "F-35C", t(-25, 0), 30.05, 138.00)) // CVN-71 box (takeoff + seam landing)

// A3 — 数据不足. Only 1 bound + 1 unbound suspected (sea, far).
const A3 = []
  .concat(climb("A3", "EA-18G", t(-12, 0), 33.06, 140.47))
  .concat(climb("A3", "EA-18G", t(-9, 0), FAR_SEA.lat, FAR_SEA.lon)) // unbound

// A4 — 已离舰. High-confidence CVN-78, but last bound >30d before now.
const A4 = []
  .concat(climb("A4", "F/A-18F", t(-70, 0), 33.07, 140.46))
  .concat(descend("A4", "F/A-18F", t(-68, 100), 33.03, 140.50))
  .concat(climb("A4", "F/A-18F", t(-66, 0), 33.05, 140.49))
  .concat(descend("A4", "F/A-18F", t(-64, 40), 33.02, 140.51))

// A5 — extra high-confidence CVN-71 (populates the tree + map).
const A5 = []
  .concat(climb("A5", "E-2D", t(-18, 0), 30.03, 138.00))
  .concat(descend("A5", "E-2D", t(-16, 80), 30.01, 138.02))
  .concat(climb("A5", "E-2D", t(-8, 0), 30.05, 137.98))

// A6 — land/unknown audit points (retained but not suspected).
const A6 = []
  .concat(climb("A6", "MH-60R", t(-11, 0), 36.5, 140.5)) // land (Honshu coast)
  .concat(climb("A6", "MH-60R", t(-7, 0), 22.0, 160.0)) // unknown

export const adsbTracks = [].concat(A1, A2, A3, A4, A5, A6);

// ─── Adapter boundary 2: known carrier positions ────────────────────────────
// Shape: { id, name, track:[{time,lat,lon}] }. No interpolation — Step 2 uses
// nearest-in-time known positions only.
export const carrierPositions = [
  {
    id: "CVN-78",
    name: "CVN-78 杰拉尔德·R·福特号",
    track: [
      { time: t(-42, 0), lat: 33.05, lon: 140.50 },
      { time: t(-40, 0), lat: 33.04, lon: 140.51 },
      { time: t(-38, 120), lat: 33.03, lon: 140.52 },
      { time: t(-30, 0), lat: 33.04, lon: 140.50 },
      { time: t(-22, 60), lat: 33.02, lon: 140.49 },
      { time: t(-20, 90), lat: 33.01, lon: 140.50 },
      { time: t(-70, 0), lat: 33.06, lon: 140.48 },
      { time: t(-68, 100), lat: 33.05, lon: 140.50 },
      { time: t(-66, 0), lat: 33.05, lon: 140.49 },
      { time: t(-64, 40), lat: 33.03, lon: 140.51 },
      { time: t(-35, 0), lat: 33.03, lon: 140.51 },
      { time: t(-28, 0), lat: 33.02, lon: 140.52 }, // A2 cross-deploy box visit (CVN-78)
    ],
  },
  {
    id: "CVN-71",
    name: "CVN-71 西奥多·罗斯福号",
    track: [
      { time: t(-28, 0), lat: 30.04, lon: 138.01 },
      { time: t(-14, 30), lat: 30.02, lon: 138.03 },
      { time: t(-18, 0), lat: 30.03, lon: 138.00 },
      { time: t(-16, 80), lat: 30.01, lon: 138.02 },
      { time: t(-8, 0), lat: 30.05, lon: 137.98 },
      { time: t(-10, 0), lat: 30.04, lon: 138.00 },
      { time: t(-33, 200), lat: 30.04, lon: 138.01 }, // A2 cross-deploy landing
      { time: t(-30, 0), lat: 30.04, lon: 138.01 },   // A2 cross-deploy takeoff
      { time: t(-25, 0), lat: 30.05, lon: 138.00 },   // A2 cross-deploy box visit (CVN-71)
    ],
  },
];

// ─── Adapter boundary 3: land/sea mask ──────────────────────────────────────
// classifySurface(lat, lon) -> "sea" | "land" | "unknown". The mock mask treats
// the West-Pacific operating box as sea, the Honshu coast band as land, and the
// open central Pacific as unknown (sparse data). A real adapter would call a GIS
// raster/vector service.
export function classifySurface(lat, lon) {
  // Honshu coast land band (~36-37N, near 140-141E)
  if (lat >= 35.8 && lat <= 37.5 && lon >= 139.5 && lon <= 142.0) return "land";
  // Sparse central Pacific -> unknown
  if (lat <= 22.0 && lon >= 158.0) return "unknown";
  // Operating area -> sea
  return "sea";
}

// ─── buildPayload(now) — assembles the README "Mock Payload Shape" ───────────
export function buildPayload(now = new Date().toISOString()) {
  const sourceState = {
    adsbSource: "ADS-B 历史数据库（mock）",
    carrierPositionSource: "美航母已知位置库（mock）",
    landSeaMaskSource: "海陆掩膜（mock）",
    dataWindowYears: 3,
    lastLoadedAt: now,
  };

  // Step 1
  const candidateEvents = deriveCandidateEvents(adsbTracks, {
    nearGroundAltitudeFt: judgementParameters.nearGroundAltitudeFt,
    classifySurface,
  });

  // Step 2
  const events = bindToCarriers(candidateEvents, carrierPositions, {
    associationDistanceNm: judgementParameters.associationDistanceNm,
  });

  // Step 3
  let aircraft = inferAffiliation(events, {
    highConfidenceThreshold: judgementParameters.highConfidenceThreshold,
    minimumBoundAssociations: judgementParameters.minimumBoundAssociations,
  });

  // Departed overlay (only high-confidence assigned can become 已离舰)
  aircraft = aircraft.map((a) =>
    computeDeparted(
      { ...a },
      events,
      carrierPositions,
      { departedDays: judgementParameters.departedDays },
      now
    )
  );

  // carriers for the payload (id/name + track)
  const carriers = carrierPositions.map((c) => ({
    id: c.id,
    name: c.name,
    track: c.track,
  }));

  return {
    sourceState,
    judgementParameters,
    aircraft,
    carriers,
    events,
  };
}
