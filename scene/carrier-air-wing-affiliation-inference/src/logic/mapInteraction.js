const firstFeature = (features, layerId) =>
  features.find((feature) => feature?.layer?.id === layerId);

const eventAction = (feature, kind) => {
  const eventId = feature?.properties?.id;
  return eventId == null ? null : { kind, eventId };
};

const carrierAction = (feature) => {
  const carrierId = feature?.properties?.carrierId;
  return carrierId == null ? null : { kind: "carrier", carrierId };
};

// Resolve a single intentional action from MapLibre's overlapping rendered features.
// A carrier marker remains the deliberate carrier-selection target. Event points take
// precedence over a line beneath them, so a track cannot suppress event drill-down.
export function resolveMapClickAction(features = []) {
  const position = carrierAction(firstFeature(features, "carrier-positions"));
  if (position) return position;

  const sea = eventAction(firstFeature(features, "sea-events"), "event");
  if (sea) return sea;

  const audit = eventAction(firstFeature(features, "audit-events"), "audit");
  if (audit) return audit;

  return carrierAction(firstFeature(features, "carrier-tracks"));
}

export function isSatelliteSourceError(event) {
  return event?.sourceId === "satellite";
}
