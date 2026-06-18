import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type LngLatLike,
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";
import type { GeoJSON } from "geojson";
import { relations, targets, zones } from "../data/mockSituation";
import { getVisibleTargets, useSituationStore } from "../useSituationStore";
import type { Coordinates, Relation, Target, Zone } from "../types";

interface MapCanvasProps {
  onMapReady: (map: MapLibreMap) => void;
}

const tileUrl =
  import.meta.env.VITE_MAP_TILE_URL ||
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const style: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256,
      attribution: "Tiles © Esri",
    },
  },
  layers: [
    {
      id: "satellite",
      type: "raster",
      source: "satellite",
      paint: {
        "raster-brightness-min": 0,
        "raster-brightness-max": 0.62,
        "raster-contrast": 0.26,
        "raster-saturation": -0.08,
      },
    },
  ],
};

function destination([lng, lat]: Coordinates, distanceKm: number, bearingDeg: number): Coordinates {
  const radiusKm = 6371;
  const bearing = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const angularDistance = distanceKm / radiusKm;

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

function zoneToFeature(zone: Zone) {
  const ring = Array.from({ length: 72 }, (_, index) =>
    destination(zone.center, zone.radiusKm, index * 5),
  );
  ring.push(ring[0]);

  return {
    type: "Feature" as const,
    properties: {
      id: zone.id,
      name: zone.name,
      level: zone.level,
    },
    geometry: {
      type: "Polygon" as const,
      coordinates: [ring],
    },
  };
}

function targetsToFeatureCollection(visibleTargets: Target[]) {
  return {
    type: "FeatureCollection" as const,
    features: visibleTargets.map((target) => ({
      type: "Feature" as const,
      properties: {
        id: target.id,
        name: target.name,
        kind: target.kind,
        status: target.status,
        code: target.code,
      },
      geometry: {
        type: "Point" as const,
        coordinates: target.position,
      },
    })),
  };
}

function tracksToFeatureCollection(visibleTargets: Target[]) {
  return {
    type: "FeatureCollection" as const,
    features: visibleTargets
      .filter((target) => target.track.length > 1)
      .map((target) => ({
        type: "Feature" as const,
        properties: {
          id: target.id,
          status: target.status,
        },
        geometry: {
          type: "LineString" as const,
          coordinates: target.track.map((point) => point.position),
        },
      })),
  };
}

function relationsToFeatureCollection(visibleTargets: Target[], allRelations: Relation[]) {
  const targetIds = new Set(visibleTargets.map((target) => target.id));

  return {
    type: "FeatureCollection" as const,
    features: allRelations
      .filter(
        (relation) =>
          targetIds.has(relation.fromTargetId) && targetIds.has(relation.toTargetId),
      )
      .map((relation) => {
        const from = targets.find((target) => target.id === relation.fromTargetId);
        const to = targets.find((target) => target.id === relation.toTargetId);

        return {
          type: "Feature" as const,
          properties: {
            id: relation.id,
            label: relation.label,
            strength: relation.strength,
          },
          geometry: {
            type: "LineString" as const,
            coordinates: [from?.position, to?.position].filter(Boolean) as Coordinates[],
          },
        };
      }),
  };
}

function setGeoJson(map: MapLibreMap, sourceId: string, data: object) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data as GeoJSON);
}

export function MapCanvas({ onMapReady }: MapCanvasProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const didSkipInitialFocusRef = useRef(false);
  const [isLoaded, setIsLoaded] = useState(false);

  const activeKinds = useSituationStore((state) => state.activeKinds);
  const query = useSituationStore((state) => state.query);
  const selectedTargetId = useSituationStore((state) => state.selectedTargetId);
  const setSelectedTargetId = useSituationStore((state) => state.setSelectedTargetId);

  const visibleTargets = useMemo(
    () => getVisibleTargets(activeKinds, query),
    [activeKinds, query],
  );
  const selectedTarget = targets.find((target) => target.id === selectedTargetId);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style,
      center: [124.05, 28.3],
      zoom: 5.35,
      minZoom: 3.2,
      maxZoom: 9,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    mapRef.current = map;
    onMapReady(map);

    map.on("load", () => {
      map.addSource("zones", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: zones.map(zoneToFeature),
        },
      });

      map.addLayer({
        id: "zone-fill",
        type: "fill",
        source: "zones",
        paint: {
          "fill-color": [
            "match",
            ["get", "level"],
            "critical",
            "#ff4f57",
            "warning",
            "#f2a34f",
            "#55d3ff",
          ],
          "fill-opacity": [
            "match",
            ["get", "level"],
            "critical",
            0.24,
            "warning",
            0.18,
            0.12,
          ],
        },
      });

      map.addLayer({
        id: "zone-line",
        type: "line",
        source: "zones",
        paint: {
          "line-color": [
            "match",
            ["get", "level"],
            "critical",
            "#ff6a5e",
            "warning",
            "#f3c761",
            "#6ee7ff",
          ],
          "line-width": 1.2,
          "line-opacity": 0.72,
        },
      });

      map.addSource("relations", {
        type: "geojson",
        data: relationsToFeatureCollection(targets, relations),
      });

      map.addLayer({
        id: "relation-lines",
        type: "line",
        source: "relations",
        paint: {
          "line-color": "#67d7ff",
          "line-width": 1,
          "line-dasharray": [2, 2],
          "line-opacity": 0.58,
        },
      });

      map.addSource("tracks", {
        type: "geojson",
        data: tracksToFeatureCollection(targets),
      });

      map.addLayer({
        id: "track-lines-shadow",
        type: "line",
        source: "tracks",
        paint: {
          "line-color": "#031624",
          "line-width": 5,
          "line-opacity": 0.55,
        },
      });

      map.addLayer({
        id: "track-lines",
        type: "line",
        source: "tracks",
        paint: {
          "line-color": [
            "match",
            ["get", "status"],
            "alert",
            "#ffb15e",
            "identified",
            "#77e4ff",
            "#79f2aa",
          ],
          "line-width": 2,
          "line-opacity": 0.82,
        },
      });

      map.addSource("targets", {
        type: "geojson",
        data: targetsToFeatureCollection(targets),
      });

      map.addLayer({
        id: "target-glow",
        type: "circle",
        source: "targets",
        paint: {
          "circle-radius": ["case", ["==", ["get", "status"], "alert"], 24, 18],
          "circle-color": [
            "match",
            ["get", "status"],
            "alert",
            "#ff685c",
            "identified",
            "#6ee7ff",
            "#82e49c",
          ],
          "circle-opacity": 0.2,
          "circle-blur": 0.6,
        },
      });

      map.addLayer({
        id: "target-core",
        type: "circle",
        source: "targets",
        paint: {
          "circle-radius": ["case", ["==", ["get", "status"], "alert"], 8, 6],
          "circle-color": [
            "match",
            ["get", "kind"],
            "air",
            "#79ddff",
            "surface",
            "#f4c45f",
            "#7feb9b",
          ],
          "circle-stroke-color": "#e5fbff",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.96,
        },
      });

      map.addLayer({
        id: "target-hit",
        type: "circle",
        source: "targets",
        paint: {
          "circle-radius": 18,
          "circle-color": "#ffffff",
          "circle-opacity": 0,
        },
      });

      map.on("click", "target-hit", (event) => {
        const feature = event.features?.[0];
        const targetId = feature?.properties?.id as string | undefined;
        if (targetId) {
          setSelectedTargetId(targetId);
        }
      });

      map.on("mouseenter", "target-hit", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "target-hit", () => {
        map.getCanvas().style.cursor = "";
      });

      setIsLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onMapReady, setSelectedTargetId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoaded) {
      return;
    }

    setGeoJson(map, "targets", targetsToFeatureCollection(visibleTargets));
    setGeoJson(map, "tracks", tracksToFeatureCollection(visibleTargets));
    setGeoJson(map, "relations", relationsToFeatureCollection(visibleTargets, relations));
  }, [isLoaded, visibleTargets]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedTarget) {
      return;
    }

    if (!didSkipInitialFocusRef.current) {
      didSkipInitialFocusRef.current = true;
      return;
    }

    map.easeTo({
      center: selectedTarget.position as LngLatLike,
      zoom: Math.max(map.getZoom(), 5.8),
      duration: 720,
    });
  }, [selectedTarget]);

  return <div ref={mapContainerRef} className="map-canvas" aria-label="态势地图" />;
}
