import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMapData, boundsForMapData } from "./mapData.js";

test("buildMapData keeps suspected sea events and audit events separate", () => {
  const data = buildMapData({
    events: [
      { id: "sea", icao: "A1", eventType: "takeoff", time: "2024-06-01T00:00:00.000Z", lat: 30, lon: 140, suspected: true, bindingStatus: "bound" },
      { id: "land", icao: "A2", eventType: "landing", time: "2024-06-01T00:00:00.000Z", lat: 36, lon: 140, surfaceType: "land", suspected: false },
    ],
    carriers: [],
    winStart: Date.parse("2024-05-31T00:00:00.000Z"),
    winEnd: Date.parse("2024-06-02T00:00:00.000Z"),
  });

  assert.equal(data.seaEvents.features.length, 1);
  assert.equal(data.auditEvents.features.length, 1);
  assert.deepEqual(data.seaEvents.features[0].geometry.coordinates, [140, 30]);
});

test("buildMapData clips carrier tracks to the replay window", () => {
  const data = buildMapData({
    events: [],
    carriers: [{ id: "CVN-78", name: "Ford", track: [
      { time: "2024-06-01T00:00:00.000Z", lat: 30, lon: 140 },
      { time: "2024-06-02T00:00:00.000Z", lat: 31, lon: 141 },
      { time: "2024-06-03T00:00:00.000Z", lat: 32, lon: 142 },
    ] }],
    winStart: Date.parse("2024-06-01T00:00:00.000Z"),
    winEnd: Date.parse("2024-06-02T00:00:00.000Z"),
  });

  assert.deepEqual(data.carrierTracks.features[0].geometry.coordinates, [[140, 30], [141, 31]]);
  assert.deepEqual(data.carrierPositions.features[0].geometry.coordinates, [141, 31]);
});

test("boundsForMapData encloses points and tracks in longitude-latitude order", () => {
  const bounds = boundsForMapData({
    seaEvents: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [140, 30] } }] },
    auditEvents: { type: "FeatureCollection", features: [], },
    carrierTracks: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[138, 29], [142, 32]] } }] },
    carrierPositions: { type: "FeatureCollection", features: [], },
  });

  assert.deepEqual(bounds, [[138, 29], [142, 32]]);
});
