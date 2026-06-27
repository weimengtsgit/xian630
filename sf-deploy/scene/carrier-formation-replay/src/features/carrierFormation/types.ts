export type Coordinates = [number, number];

export type ShipKind = "carrier" | "destroyer" | "frigate" | "support";

export type ShipStatus = "normal" | "watch" | "warning";

export type EventType = "接入" | "航行" | "队形" | "告警" | "研判";

export type Severity = "info" | "watch" | "warning" | "critical";

export interface FleetTrackPoint {
  dayIndex: number;
  date: string;
  label: string;
  position: Coordinates;
  heading: number;
  speed: number;
  formationRadiusKm: number;
  phase: string;
}

export interface Ship {
  id: string;
  name: string;
  role: string;
  kind: ShipKind;
  status: ShipStatus;
  offsetBearing: number;
  offsetDistanceKm: number;
}

export interface FleetEvent {
  id: string;
  dayIndex: number;
  date: string;
  type: EventType;
  title: string;
  summary: string;
  coordinate: Coordinates;
  severity: Severity;
  relatedShipIds: string[];
  assessment: string;
}

export interface CarrierFormation {
  id: string;
  name: string;
  mission: string;
  startDate: string;
  endDate: string;
  operatingArea: string;
  carrierShipId: string;
  ships: Ship[];
  track: FleetTrackPoint[];
  events: FleetEvent[];
}

