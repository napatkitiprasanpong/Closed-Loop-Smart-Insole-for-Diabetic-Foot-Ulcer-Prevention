import type { Setpoints, Zone } from "./types.ts";
import { NEUTRAL, SENSORS } from "./config.ts";

/** Sensor positions in millimetres (same frame as the CAD: origin at heel tip, toe toward +Y). */
export const SENSOR_MM: number[][] = SENSORS.map(s => [(s.x - 100) * 0.69, (400 - s.y) * 0.69]);

/** Distance kernel between sensors: exp(-d^2 / 2 sigma^2), zero on the diagonal. */
export function kernel(sigmaMm: number): number[][] {
  return SENSOR_MM.map((a, i) => SENSOR_MM.map((b, m) => i === m ? 0 : Math.exp(-((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) / (2 * sigmaMm * sigmaMm))));
}

/**
 * Load transfer. d[i] is the direct pressure change at sensor i (negative = relieved, positive = loaded more).
 * A share `tau` of every change is re-applied with opposite sign to sensors in OTHER zones, weighted by distance and by
 * how stiff each receiving zone is (an inflated zone carries more). tau = 1 conserves total force.
 */
export function redistribute(d: number[], support: Setpoints, tau: number, K: number[][], stiffGain: number): number[] {
  const stiff = (z: Zone) => Math.max(0.2, Math.min(2, 1 + stiffGain * (support[z] - NEUTRAL) * 2));
  const comp = d.map(() => 0);
  for (let i = 0; i < d.length; i++) {
    if (d[i] === 0) continue;
    let denom = 0;
    for (let m = 0; m < d.length; m++) if (SENSORS[m].zone !== SENSORS[i].zone) denom += K[i][m] * stiff(SENSORS[m].zone);
    if (denom < 1e-9) continue;
    for (let m = 0; m < d.length; m++) if (SENSORS[m].zone !== SENSORS[i].zone) comp[m] += -tau * d[i] * K[i][m] * stiff(SENSORS[m].zone) / denom;
  }
  return comp;
}
