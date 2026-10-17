export type Zone = "F" | "M" | "L" | "H";
export const ZONES: Zone[] = ["F", "M", "L", "H"];
export const ZONE_NAMES: Record<Zone, string> = { F: "forefoot", M: "medial", L: "lateral", H: "heel" };

export interface Sensor { id: number; name: string; x: number; y: number; zone: Zone; baseKpa: number }

/** One reading from any data source (simulator, replay file, or hardware). NaN = sensor lost. */
export interface Frame { t: number; pressure: number[]; temp: number[] }

/** Support level per pneumatic zone: 0 = fully deflated, 0.5 = neutral, 1 = fully inflated. */
export type Setpoints = Record<Zone, number>;

export type CtlState = "MONITOR" | "CONFIRM" | "ADJUST" | "VERIFY" | "REVERSE" | "PROBE" | "ALERT" | "FAULT";

export interface LogEvent { t: number; kind: "info" | "keep" | "reject" | "alert" | "fault"; msg: string }

export interface Verification {
  region: string; before: number; after: number; effectiveness: number;   // worst hotspot of the plan
  hotspotsBefore: number; hotspotsAfter: number; excessBefore: number; excessAfter: number;  // excess = kPa above threshold, summed
  maxElsewhere: number; maxElsewhereRegion: string;                       // highest sensor that was NOT a hotspot before
  outcome: "kept" | "partial" | "reversed";
}

export interface StepResult {
  state: CtlState; setpoints: Setpoints; risk: number[];
  events: LogEvent[]; verification?: Verification;
}
