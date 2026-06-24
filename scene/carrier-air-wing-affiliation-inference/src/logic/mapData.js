// Pure, side-effect-free map-data adapter.
// Converts event/carrier records into time-windowed GeoJSON FeatureCollections
// and computes map bounds. No React, no DOM.

const isFiniteNumber = (n) => typeof n === "number" && Number.isFinite(n);

const validPoint = (lon, lat) => isFiniteNumber(lon) && isFiniteNumber(lat);

/**
 * Build four time-windowed GeoJSON FeatureCollections from raw events + carriers.
 *
 * @param {object} input
 * @param {Array}  input.events   Raw event records.
 * @param {Array}  input.carriers Carrier records, each with an in-window `track`.
 * @param {number} input.winStart Inclusive window start (ms epoch).
 * @param {number} input.winEnd   Inclusive window end (ms epoch).
 * @returns {{seaEvents:object, auditEvents:object, carrierTracks:object, carrierPositions:object}}
 */
export function buildMapData({ events = [], carriers = [], winStart = -Infinity, winEnd = Infinity } = {}) {
  const inWindow = (time) => {
    const ms = Date.parse(time);
    return ms >= winStart && ms <= winEnd;
  };

  const pointFeature = (event) => ({
    type: "Feature",
    id: event.id,
    properties: { ...event },
    geometry: { type: "Point", coordinates: [event.lon, event.lat] },
  });

  const featureCollection = (features = []) => ({
    type: "FeatureCollection",
    features,
  });

  // --- Events ---
  const seaFeatures = [];
  const auditFeatures = [];

  for (const event of events) {
    if (!inWindow(event.time)) continue;
    if (!validPoint(event.lon, event.lat)) continue;

    if (event.suspected === true) {
      seaFeatures.push(pointFeature(event));
    }
    if (event.surfaceType === "land" || event.surfaceType === "unknown") {
      auditFeatures.push(pointFeature(event));
    }
  }

  // --- Carriers ---
  const carrierTrackFeatures = [];
  const carrierPositionFeatures = [];

  for (const carrier of carriers) {
    const track = Array.isArray(carrier.track) ? carrier.track : [];
    const inWindowSamples = track
      .filter((s) => inWindow(s.time) && validPoint(s.lon, s.lat))
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

    if (inWindowSamples.length >= 2) {
      const coords = inWindowSamples.map((s) => [s.lon, s.lat]);
      carrierTrackFeatures.push({
        type: "Feature",
        properties: { carrierId: carrier.id },
        geometry: { type: "LineString", coordinates: coords },
      });
    }

    if (inWindowSamples.length >= 1) {
      const latest = inWindowSamples[inWindowSamples.length - 1];
      carrierPositionFeatures.push({
        type: "Feature",
        properties: { carrierId: carrier.id },
        geometry: { type: "Point", coordinates: [latest.lon, latest.lat] },
      });
    }
  }

  return {
    seaEvents: featureCollection(seaFeatures),
    auditEvents: featureCollection(auditFeatures),
    carrierTracks: featureCollection(carrierTrackFeatures),
    carrierPositions: featureCollection(carrierPositionFeatures),
  };
}

// Recursively collect all valid [lon, lat] numeric pairs from a FeatureCollection.
const collectCoordinates = (fc, out) => {
  if (!fc || !Array.isArray(fc.features)) return;
  for (const feature of fc.features) {
    const geom = feature && feature.geometry;
    if (!geom) continue;
    const { type, coordinates } = geom;
    if (!Array.isArray(coordinates)) continue;

    if (type === "Point") {
      const [lon, lat] = coordinates;
      if (validPoint(lon, lat)) out.push([lon, lat]);
    } else if (type === "LineString" || type === "MultiPoint") {
      for (const c of coordinates) {
        const [lon, lat] = c;
        if (validPoint(lon, lat)) out.push([lon, lat]);
      }
    } else if (type === "MultiLineString" || type === "Polygon") {
      for (const ring of coordinates) {
        for (const c of ring) {
          const [lon, lat] = c;
          if (validPoint(lon, lat)) out.push([lon, lat]);
        }
      }
    }
  }
};

/**
 * Compute a bounding box enclosing all four collections, in [lon, lat] order.
 * @returns {[[number,number],[number,number]]|null} [[west,south],[east,north]] or null.
 */
export function boundsForMapData(mapData) {
  if (!mapData) return null;

  const coords = [];
  collectCoordinates(mapData.seaEvents, coords);
  collectCoordinates(mapData.auditEvents, coords);
  collectCoordinates(mapData.carrierTracks, coords);
  collectCoordinates(mapData.carrierPositions, coords);

  if (coords.length === 0) return null;

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }

  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}
