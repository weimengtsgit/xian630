import type { Coordinates, FleetTrackPoint, Ship } from "./types";

const earthRadiusKm = 6371;

export function destination(
  [lng, lat]: Coordinates,
  distanceKm: number,
  bearingDeg: number,
): Coordinates {
  const bearing = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const angularDistance = distanceKm / earthRadiusKm;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return [(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

export function shipPositionAt(trackPoint: FleetTrackPoint, ship: Ship): Coordinates {
  if (ship.offsetDistanceKm === 0) {
    return trackPoint.position;
  }

  return destination(
    trackPoint.position,
    ship.offsetDistanceKm,
    trackPoint.heading + ship.offsetBearing,
  );
}

export function circlePolygon(center: Coordinates, radiusKm: number, segments = 72) {
  const ring = Array.from({ length: segments }, (_, index) =>
    destination(center, radiusKm, (360 / segments) * index),
  );
  ring.push(ring[0]);

  return ring;
}

export function formatCoordinate([lng, lat]: Coordinates) {
  return `${lat.toFixed(2)}°N / ${lng.toFixed(2)}°E`;
}

export function seaAreaFor([, lat]: Coordinates) {
  if (lat >= 30) {
    return "东海北部";
  }

  if (lat <= 26.2) {
    return "东海南部";
  }

  return "东海中部";
}

