import { useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { EventDetailPanel } from "../features/carrierFormation/components/EventDetailPanel";
import { FleetMapCanvas } from "../features/carrierFormation/components/FleetMapCanvas";
import { FleetMapOverlays } from "../features/carrierFormation/components/FleetMapOverlays";
import { FleetOverviewPanel } from "../features/carrierFormation/components/FleetOverviewPanel";
import { LeftToolbar } from "../features/carrierFormation/components/LeftToolbar";
import { MonthTimeline } from "../features/carrierFormation/components/MonthTimeline";
import { TopBar } from "../features/carrierFormation/components/TopBar";

export function App() {
  const [map, setMap] = useState<MapLibreMap | null>(null);

  return (
    <main className="situation-shell">
      <FleetMapCanvas onMapReady={setMap} />
      <div className="map-vignette" />
      <TopBar />
      <LeftToolbar />
      <FleetOverviewPanel />
      <EventDetailPanel />
      <MonthTimeline />
      <FleetMapOverlays map={map} />
    </main>
  );
}
