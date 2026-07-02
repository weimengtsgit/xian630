const PRIORITY = [
  { layer: "alert-points", kind: "alert" },
  { layer: "vessel-points", kind: "target" },
  { layer: "ais-gaps", kind: "ais-gap" },
  { layer: "track-segments", kind: "segment" },
  { layer: "monitored-area-fill", kind: "area" },
  { layer: "monitored-area-outline", kind: "area" },
];

export function resolveMapClickAction(features = []) {
  for (const { layer, kind } of PRIORITY) {
    const match = features.find((feature) => feature?.layer?.id === layer);
    if (!match) continue;
    const props = match.properties || {};
    if (kind === "alert") return { kind, id: props.id, targetMmsi: props.targetMmsi };
    if (kind === "target") return { kind, mmsi: props.mmsi };
    if (kind === "ais-gap") return { kind, id: props.id, targetMmsi: props.targetMmsi };
    if (kind === "segment") return { kind, id: props.id, targetMmsi: props.targetMmsi };
    if (kind === "area") return { kind, id: props.id };
  }
  return null;
}

export function isSatelliteSourceError(event) {
  return event?.sourceId === "satellite";
}
