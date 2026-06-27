import { Anchor, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { carrierFormation, cityLabels, severityMeta } from "../data/mockFormation";
import { shipPositionAt } from "../geo";
import type { Coordinates, FleetEvent, Ship } from "../types";
import { getCurrentTrackPoint, getSelectedEvent, useFleetStore } from "../useFleetStore";

interface FleetMapOverlaysProps {
  map: MapLibreMap | null;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface Projectable {
  id: string;
  position: Coordinates;
}

function useProjectedCollection<T extends Projectable>(map: MapLibreMap | null, items: T[]) {
  const [points, setPoints] = useState<Array<T & ScreenPoint>>([]);

  useEffect(() => {
    if (!map) {
      setPoints([]);
      return;
    }

    const update = () => {
      setPoints(
        items.map((item) => {
          const projected = map.project(item.position);
          return { ...item, x: projected.x, y: projected.y };
        }),
      );
    };

    update();
    map.on("move", update);
    map.on("zoom", update);
    map.on("resize", update);

    return () => {
      map.off("move", update);
      map.off("zoom", update);
      map.off("resize", update);
    };
  }, [items, map]);

  return points;
}

function useProjectedPoint(map: MapLibreMap | null, position?: Coordinates) {
  const [point, setPoint] = useState<ScreenPoint | null>(null);

  useEffect(() => {
    if (!map || !position) {
      setPoint(null);
      return;
    }

    const update = () => {
      const projected = map.project(position);
      setPoint({ x: projected.x, y: projected.y });
    };

    update();
    map.on("move", update);
    map.on("zoom", update);
    map.on("resize", update);

    return () => {
      map.off("move", update);
      map.off("zoom", update);
      map.off("resize", update);
    };
  }, [map, position]);

  return point;
}

function ShipMarker(props: Ship & ScreenPoint & { heading: number }) {
  const { x, y, heading, ...ship } = props;

  return (
    <div
      className={`ship-marker ${ship.kind} ${ship.status}`}
      style={{ transform: `translate3d(${x}px, ${y}px, 0)` }}
      title={`${ship.name} ${ship.role}`}
    >
      <span style={{ transform: `rotate(${heading}deg)` }}>
        <Anchor size={ship.kind === "carrier" ? 21 : 15} />
      </span>
      <strong>{ship.name}</strong>
    </div>
  );
}

function CityLabels({
  labels,
}: {
  labels: Array<{ id: string; name: string; size?: string } & ScreenPoint>;
}) {
  return (
    <div className="city-layer" aria-hidden="true">
      {labels.map((label) => (
        <span
          key={label.id}
          className={label.size === "major" ? "major" : undefined}
          style={{ transform: `translate3d(${label.x}px, ${label.y}px, 0)` }}
        >
          {label.name}
        </span>
      ))}
    </div>
  );
}

function EventPopup({ event, point }: { event: FleetEvent; point: ScreenPoint }) {
  const meta = severityMeta[event.severity];

  return (
    <article
      className={`map-event-popup ${event.severity}`}
      style={{ transform: `translate3d(${point.x + 20}px, ${point.y - 72}px, 0)` }}
    >
      <header>
        <span>{event.date}</span>
        <em style={{ color: meta.color }}>{event.type}</em>
      </header>
      <strong>{event.title}</strong>
      <p>{event.summary}</p>
      <CircleAlert size={14} />
    </article>
  );
}

export function FleetMapOverlays({ map }: FleetMapOverlaysProps) {
  const dayIndex = useFleetStore((state) => state.dayIndex);
  const selectedEventId = useFleetStore((state) => state.selectedEventId);
  const trackPoint = getCurrentTrackPoint(dayIndex);
  const selectedEvent = getSelectedEvent(selectedEventId, dayIndex);

  const shipItems = useMemo(
    () =>
      carrierFormation.ships.map((ship) => ({
        ...ship,
        position: shipPositionAt(trackPoint, ship),
      })),
    [trackPoint],
  );

  const shipPoints = useProjectedCollection(map, shipItems);
  const cityPoints = useProjectedCollection(map, cityLabels);
  const eventPoint = useProjectedPoint(map, selectedEvent?.coordinate);

  return (
    <div className="map-overlay-root">
      <CityLabels labels={cityPoints} />
      <div className="ship-layer" aria-label="编队舰艇当前位置">
        {shipPoints.map((ship) => (
          <ShipMarker key={ship.id} {...ship} heading={trackPoint.heading} />
        ))}
      </div>
      {selectedEvent && eventPoint ? (
        <EventPopup event={selectedEvent} point={eventPoint} />
      ) : null}
    </div>
  );
}
