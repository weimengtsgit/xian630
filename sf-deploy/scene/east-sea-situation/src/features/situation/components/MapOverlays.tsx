import { CornerDownRight, Info, Navigation } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { cityLabels, kindMeta, targets } from "../data/mockSituation";
import { getVisibleTargets, useSituationStore } from "../useSituationStore";
import type { CityLabel, Coordinates, Target } from "../types";

interface MapOverlaysProps {
  map: MapLibreMap | null;
}

interface ScreenPoint {
  x: number;
  y: number;
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

function useProjectedCollection<T extends { id: string; position: Coordinates }>(
  map: MapLibreMap | null,
  items: T[],
) {
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

function TargetCallout({ target, anchor }: { target: Target; anchor: ScreenPoint }) {
  const offset = { x: anchor.x + 26, y: anchor.y - 82 };

  return (
    <>
      <svg className="overlay-lines" aria-hidden="true">
        <line
          x1={anchor.x + 8}
          y1={anchor.y - 6}
          x2={offset.x}
          y2={offset.y + 22}
          className="callout-line"
        />
      </svg>
      <article
        className="target-callout"
        style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
      >
        <header>
          <span>{target.name}</span>
          <Info size={14} />
        </header>
        <dl>
          <div>
            <dt>编号</dt>
            <dd>{target.code}</dd>
          </div>
          <div>
            <dt>类型</dt>
            <dd>{kindMeta[target.kind].label}</dd>
          </div>
          <div>
            <dt>速度</dt>
            <dd>{target.speed} km/h</dd>
          </div>
          <div>
            <dt>置信</dt>
            <dd>{target.confidence}%</dd>
          </div>
        </dl>
      </article>
    </>
  );
}

function CityLabels({ labels }: { labels: Array<CityLabel & ScreenPoint> }) {
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

function TargetLabels({ labels }: { labels: Array<Target & ScreenPoint> }) {
  return (
    <div className="target-label-layer" aria-hidden="true">
      {labels.map((target) => (
        <span
          key={target.id}
          className={target.status}
          style={{ transform: `translate3d(${target.x + 12}px, ${target.y + 8}px, 0)` }}
        >
          {target.name}
        </span>
      ))}
    </div>
  );
}

export function MapOverlays({ map }: MapOverlaysProps) {
  const activeKinds = useSituationStore((state) => state.activeKinds);
  const query = useSituationStore((state) => state.query);
  const selectedTargetId = useSituationStore((state) => state.selectedTargetId);
  const visibleTargets = useMemo(
    () => getVisibleTargets(activeKinds, query),
    [activeKinds, query],
  );

  const selectedTarget = targets.find((target) => target.id === selectedTargetId);
  const selectedPoint = useProjectedPoint(map, selectedTarget?.position);
  const cityPoints = useProjectedCollection(map, cityLabels);
  const targetPoints = useProjectedCollection(map, visibleTargets);

  return (
    <div className="map-overlay-root" aria-hidden="false">
      <CityLabels labels={cityPoints} />
      <TargetLabels labels={targetPoints} />

      {selectedTarget && selectedPoint ? (
        <>
          <TargetCallout target={selectedTarget} anchor={selectedPoint} />
          <div
            className="command-puck"
            style={{
              transform: `translate3d(${selectedPoint.x + 178}px, ${
                selectedPoint.y + 14
              }px, 0)`,
            }}
            title="目标动作"
          >
            <CornerDownRight size={27} />
          </div>
          <div
            className="bearing-chip"
            style={{
              transform: `translate3d(${selectedPoint.x + 150}px, ${
                selectedPoint.y + 10
              }px, 0)`,
            }}
          >
            <Navigation size={12} />
          </div>
        </>
      ) : null}
    </div>
  );
}

