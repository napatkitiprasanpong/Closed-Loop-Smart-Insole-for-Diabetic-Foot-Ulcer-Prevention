import { SENSORS, TEMP_SITES } from "../core/config.ts";
import { ZONES } from "../core/types.ts";
import type { Frame, Setpoints, Zone } from "../core/types.ts";

/**
 * Line protocol between the controller board and the dashboard (one JSON object per line, UTF-8, newline-terminated).
 *
 *   device -> host   {"t":12345,"p":[...11 kPa...],"nt":[...6 deg C...],"b":[F,M,L,H]}
 *       t   milliseconds since boot (increasing)
 *       p   11 pressure channels in sensor-id order (see SENSORS); null = channel lost
 *       nt  6 temperature channels in the order of TEMP_SITES; null = channel lost (optional)
 *       b   bladder support readback per zone in the order F, M, L, H, scaled 0 to 1 like the setpoints (optional; enables leak detection)
 *   host -> device   {"sp":{"F":0.5,"M":0.5,"L":0.5,"H":0.2}}
 *       Support level per zone, 0 to 1. The firmware must clamp these, enforce its own pressure limit, and drive all zones to neutral if
 *       it receives nothing for about 1 s.
 *
 * Any line that is not a valid frame (boot messages, debug prints) is ignored.
 */
export function parseDeviceLine(line: string): Frame | null {
  const s = line.trim(); if (!s.startsWith("{")) return null;
  let o: any; try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o.t !== "number" || !Array.isArray(o.p) || o.p.length !== SENSORS.length) return null;
  const val = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : NaN;
  const temp = SENSORS.map(() => NaN);
  if (Array.isArray(o.nt)) TEMP_SITES.forEach((site, k) => { if (k < o.nt.length) temp[site] = val(o.nt[k]); });
  const f: Frame = { t: o.t / 1000, pressure: o.p.map(val), temp };
  if (Array.isArray(o.b) && o.b.length === ZONES.length) { const b: Partial<Record<Zone, number>> = {}; ZONES.forEach((z, i) => { b[z] = val(o.b[i]); }); f.bladder = b; }
  return f;
}

export function encodeSetpoints(sp: Setpoints): string {
  return JSON.stringify({ sp: Object.fromEntries(ZONES.map(z => [z, +sp[z].toFixed(3)])) }) + "\n";
}
