import { useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { LeftToolbar } from "../features/situation/components/LeftToolbar";
import { MapCanvas } from "../features/situation/components/MapCanvas";
import { MapOverlays } from "../features/situation/components/MapOverlays";
import { TargetPanel } from "../features/situation/components/TargetPanel";
import { TimelineOverlay } from "../features/situation/components/TimelineOverlay";
import { TopBar } from "../features/situation/components/TopBar";

export function App() {
  const [map, setMap] = useState<MapLibreMap | null>(null);

  return (
    <main className="situation-shell">
      <MapCanvas onMapReady={setMap} />
      <div className="map-vignette" />
      <TopBar />
      <LeftToolbar />
      <TargetPanel />
      <TimelineOverlay />
      <MapOverlays map={map} />
    </main>
  );
}

