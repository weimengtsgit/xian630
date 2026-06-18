import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type LngLatLike,
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";
import type { GeoJSON } from "geojson";
import { carrierFormation } from "../data/mockFormation";
import { circlePolygon } from "../geo";
import type { Coordinates, FleetEvent, FleetTrackPoint } from "../types";
import { getCurrentTrackPoint, getSelectedEvent, useFleetStore } from "../useFleetStore";

interface FleetMapCanvasProps {
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
        "raster-brightness-max": 0.58,
        "raster-contrast": 0.3,
        "raster-saturation": -0.12,
      },
    },
  ],
};

function lineFeature(id: string, coordinates: Coordinates[], played = false) {
  const lineCoordinates =
    coordinates.length > 1 ? coordinates : [coordinates[0], coordinates[0]];

  return {
    type: "Feature" as const,
    properties: { id, played },
    geometry: {
      type: "LineString" as const,
      coordinates: lineCoordinates,
    },
  };
}

function fullRouteCollection() {
  return {
    type: "FeatureCollection" as const,
    features: [
      lineFeature(
        "monthly-route",
        carrierFormation.track.map((point) => point.position),
      ),
    ],
  };
}

function playedRouteCollection(dayIndex: number) {
  return {
    type: "FeatureCollection" as const,
    features: [
      lineFeature(
        "played-route",
        carrierFormation.track
          .slice(0, dayIndex + 1)
          .map((point) => point.position),
        true,
      ),
    ],
  };
}

function dailyPointCollection() {
  return {
    type: "FeatureCollection" as const,
    features: carrierFormation.track.map((point) => ({
      type: "Feature" as const,
      properties: {
        id: `D-${point.dayIndex}`,
        dayIndex: point.dayIndex,
        label: point.label,
      },
      geometry: {
        type: "Point" as const,
        coordinates: point.position,
      },
    })),
  };
}

function eventPointCollection(events: FleetEvent[]) {
  return {
    type: "FeatureCollection" as const,
    features: events.map((event) => ({
      type: "Feature" as const,
      properties: {
        id: event.id,
        dayIndex: event.dayIndex,
        type: event.type,
        severity: event.severity,
        title: event.title,
      },
      geometry: {
        type: "Point" as const,
        coordinates: event.coordinate,
      },
    })),
  };
}

function envelopeCollection(trackPoint: FleetTrackPoint) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {
          id: "formation-envelope",
          radiusKm: trackPoint.formationRadiusKm,
        },
        geometry: {
          type: "Polygon" as const,
          coordinates: [circlePolygon(trackPoint.position, trackPoint.formationRadiusKm)],
        },
      },
    ],
  };
}

function setGeoJson(map: MapLibreMap, sourceId: string, data: object) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data as GeoJSON);
}

export function FleetMapCanvas({ onMapReady }: FleetMapCanvasProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const dayIndex = useFleetStore((state) => state.dayIndex);
  const selectedEventId = useFleetStore((state) => state.selectedEventId);
  const selectEvent = useFleetStore((state) => state.selectEvent);
  const selectedEvent = getSelectedEvent(selectedEventId, dayIndex);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style,
      center: [124.65, 27.75],
      zoom: 5.15,
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
      map.addSource("full-route", {
        type: "geojson",
        data: fullRouteCollection(),
      });

      map.addSource("played-route", {
        type: "geojson",
        data: playedRouteCollection(dayIndex),
      });

      map.addSource("daily-points", {
        type: "geojson",
        data: dailyPointCollection(),
      });

      map.addSource("event-points", {
        type: "geojson",
        data: eventPointCollection(carrierFormation.events),
      });

      map.addSource("formation-envelope", {
        type: "geojson",
        data: envelopeCollection(getCurrentTrackPoint(dayIndex)),
      });

      map.addLayer({
        id: "formation-envelope-fill",
        type: "fill",
        source: "formation-envelope",
        paint: {
          "fill-color": "#67d7ff",
          "fill-opacity": 0.08,
        },
      });

      map.addLayer({
        id: "formation-envelope-line",
        type: "line",
        source: "formation-envelope",
        paint: {
          "line-color": "#67d7ff",
          "line-width": 1.4,
          "line-dasharray": [2, 2],
          "line-opacity": 0.7,
        },
      });

      map.addLayer({
        id: "full-route-shadow",
        type: "line",
        source: "full-route",
        paint: {
          "line-color": "#031624",
          "line-width": 7,
          "line-opacity": 0.68,
        },
      });

      map.addLayer({
        id: "full-route-line",
        type: "line",
        source: "full-route",
        paint: {
          "line-color": "#5d9cb6",
          "line-width": 2,
          "line-opacity": 0.42,
        },
      });

      map.addLayer({
        id: "played-route-glow",
        type: "line",
        source: "played-route",
        paint: {
          "line-color": "#78e5ff",
          "line-width": 7,
          "line-opacity": 0.16,
          "line-blur": 1.2,
        },
      });

      map.addLayer({
        id: "played-route-line",
        type: "line",
        source: "played-route",
        paint: {
          "line-color": "#78e5ff",
          "line-width": 3,
          "line-opacity": 0.94,
        },
      });

      map.addLayer({
        id: "daily-point-dots",
        type: "circle",
        source: "daily-points",
        paint: {
          "circle-radius": 2.4,
          "circle-color": "#9eefff",
          "circle-opacity": 0.48,
        },
      });

      map.addLayer({
        id: "event-point-glow",
        type: "circle",
        source: "event-points",
        paint: {
          "circle-radius": [
            "match",
            ["get", "severity"],
            "critical",
            22,
            "warning",
            18,
            "watch",
            15,
            12,
          ],
          "circle-color": [
            "match",
            ["get", "severity"],
            "critical",
            "#ff5d68",
            "warning",
            "#ff8a5e",
            "watch",
            "#f3c761",
            "#77e4ff",
          ],
          "circle-opacity": 0.18,
          "circle-blur": 0.55,
        },
      });

      map.addLayer({
        id: "event-point-core",
        type: "circle",
        source: "event-points",
        paint: {
          "circle-radius": 6,
          "circle-color": [
            "match",
            ["get", "severity"],
            "critical",
            "#ff5d68",
            "warning",
            "#ff8a5e",
            "watch",
            "#f3c761",
            "#77e4ff",
          ],
          "circle-stroke-color": "#f2fbff",
          "circle-stroke-width": 1.4,
          "circle-opacity": 0.96,
        },
      });

      map.addLayer({
        id: "event-hit",
        type: "circle",
        source: "event-points",
        paint: {
          "circle-radius": 18,
          "circle-color": "#ffffff",
          "circle-opacity": 0,
        },
      });

      map.on("click", "event-hit", (event) => {
        const eventId = event.features?.[0]?.properties?.id as string | undefined;
        if (eventId) {
          selectEvent(eventId);
        }
      });

      map.on("mouseenter", "event-hit", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "event-hit", () => {
        map.getCanvas().style.cursor = "";
      });

      setIsLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onMapReady, selectEvent]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoaded) {
      return;
    }

    setGeoJson(map, "played-route", playedRouteCollection(dayIndex));
    setGeoJson(map, "formation-envelope", envelopeCollection(getCurrentTrackPoint(dayIndex)));
  }, [dayIndex, isLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedEvent) {
      return;
    }

    map.easeTo({
      center: selectedEvent.coordinate as LngLatLike,
      duration: 620,
    });
  }, [selectedEvent]);

  return <div ref={mapContainerRef} className="map-canvas" aria-label="编队航迹地图" />;
}
