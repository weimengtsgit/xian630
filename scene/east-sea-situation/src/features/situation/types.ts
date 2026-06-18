export type Coordinates = [number, number];

export type TargetKind = "air" | "surface" | "facility";

export type TargetStatus = "tracking" | "alert" | "identified";

export interface TrackPoint {
  time: string;
  position: Coordinates;
  speed: number;
  heading: number;
}

export interface SituationEvent {
  id: string;
  time: string;
  title: string;
  detail: string;
}

export interface Target {
  id: string;
  name: string;
  code: string;
  kind: TargetKind;
  status: TargetStatus;
  position: Coordinates;
  discoveredAt: string;
  owner: string;
  confidence: number;
  heading: number;
  speed: number;
  summary: string;
  visual: "jet" | "carrier" | "radar" | "ship";
  track: TrackPoint[];
  events: SituationEvent[];
}

export interface Zone {
  id: string;
  name: string;
  center: Coordinates;
  radiusKm: number;
  level: "watch" | "warning" | "critical";
}

export interface Relation {
  id: string;
  fromTargetId: string;
  toTargetId: string;
  label: string;
  strength: number;
}

export interface CityLabel {
  id: string;
  name: string;
  position: Coordinates;
  size?: "major" | "normal";
}

