import type { Frame, Setpoints, Zone } from "../core/types.ts";
import { ZONES } from "../core/types.ts";
import { NEUTRAL, SENSORS } from "../core/config.ts";
import { kernel, redistribute } from "../core/model.ts";

export interface SimParams {
  transfer: number;      // share of removed load re-applied on other zones (0 to 1; 1 conserves total force)
  noise: number;         // fractional sensor noise (0.02 = ±2%)
  coupling: number;      // how strongly a zone's own support changes pressure over it
  actuatorRate: number;  // support change per second
  leakRate: number;      // support lost per second in leaking zones
  sigmaMm: number;       // spread of transferred load between sensors
  stiffGain: number;     // extra load taken by inflated neighbours
}

export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Software stand-in for the insole. Foot load is conserved when a zone is relieved: the pressure removed over a deflated
 * zone is re-applied on nearby sensors of other zones (by distance and stiffness), so offloading one region can load another.
 */
export class Simulator {
  params: SimParams = { transfer: 0.6, noise: 0.02, coupling: 0.9, actuatorRate: 0.25, leakRate: 0.05, sigmaMm: 55, stiffGain: 1 };
  load: number[] = SENSORS.map(() => 0);
  disconnected = new Set<number>();
  leaking = new Set<Zone>();
  support: Setpoints = { F: NEUTRAL, M: NEUTRAL, L: NEUTRAL, H: NEUTRAL };
  private p = SENSORS.map(s => s.baseKpa);
  private temp = SENSORS.map(() => 32);
  private transients: { i: number; amount: number; left: number }[] = [];
  private t = 0;
  private rnd: () => number;
  private K: number[][]; private Ksigma: number;

  constructor(seed = 1, params: Partial<SimParams> = {}) {
    this.rnd = mulberry32(seed); Object.assign(this.params, params);
    this.Ksigma = this.params.sigmaMm; this.K = kernel(this.Ksigma);
  }

  spike(i: number, amount: number, seconds: number) { this.transients.push({ i, amount, left: seconds }); }

  /** Noise-free steady-state pressures for the current loads and support levels. */
  steady(): number[] {
    const q = this.params;
    if (q.sigmaMm !== this.Ksigma) { this.Ksigma = q.sigmaMm; this.K = kernel(q.sigmaMm); }
    const delta = {} as Record<Zone, number>; for (const z of ZONES) delta[z] = NEUTRAL - this.support[z];
    const f0 = SENSORS.map((s, i) => s.baseKpa + this.load[i] + this.transients.filter(x => x.i === i && x.left > 0).reduce((a, x) => a + x.amount, 0));
    const d = f0.map((v, i) => -q.coupling * delta[SENSORS[i].zone] * v);
    const comp = redistribute(d, this.support, q.transfer, this.K, q.stiffGain);
    return f0.map((v, i) => Math.max(0.05 * v, v + d[i] + comp[i]));
  }

  step(dt: number, sp: Setpoints): Frame {
    const q = this.params;
    this.t += dt;
    for (const z of ZONES) {
      const d = sp[z] - this.support[z];
      this.support[z] += Math.max(-q.actuatorRate * dt, Math.min(q.actuatorRate * dt, d));
      if (this.leaking.has(z)) this.support[z] = Math.max(0, this.support[z] - q.leakRate * dt);
    }
    for (const tr of this.transients) tr.left -= dt;
    const alpha = 1 - Math.exp(-dt / 0.1), target = this.steady();
    SENSORS.forEach((_, i) => {
      this.p[i] += (target[i] * (1 + (this.rnd() - 0.5) * 2 * q.noise) - this.p[i]) * alpha;
      const tt = 32 + Math.max(0, Math.min(1, (this.p[i] - 300) / 200)) * 3;
      this.temp[i] += (tt - this.temp[i]) * dt / 20;
    });
    this.transients = this.transients.filter(x => x.left > 0);
    return { t: this.t, pressure: this.p.map((v, i) => (this.disconnected.has(i) ? NaN : v)), temp: this.temp.map(v => v + (this.rnd() - 0.5) * 0.1) };
  }
}
