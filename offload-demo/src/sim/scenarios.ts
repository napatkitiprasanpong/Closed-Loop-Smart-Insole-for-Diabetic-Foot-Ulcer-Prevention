import type { Simulator } from "./simulator.ts";

const only = (s: Simulator, loads: Record<number, number>) => { s.load.fill(0); for (const k in loads) s.load[+k] = loads[k]; };

export const SCENARIOS = {
  clear: (s: Simulator) => { s.load.fill(0); s.params.transfer = 0.6; s.leaking.clear(); s.disconnected.clear(); },
  heel: (s: Simulator) => only(s, { 10: 260 }),
  hallux: (s: Simulator) => only(s, { 0: 300 }),
  met1: (s: Simulator) => only(s, { 2: 250 }),
  lateral: (s: Simulator) => only(s, { 6: 330 }),
  /** Two hotspots in different zones: heel and first metatarsal head. */
  twoHotspots: (s: Simulator) => only(s, { 10: 260, 2: 250 }),
  /** Three hotspots in three zones: heel, first metatarsal head and lateral midfoot. */
  threeHotspots: (s: Simulator) => only(s, { 10: 260, 2: 250, 6: 330 }),
  /** Heel hotspot while the lateral midfoot is already heavily loaded and load transfers fully between zones. */
  unsafeTransfer: (s: Simulator) => { only(s, { 10: 260, 6: 250 }); s.params.transfer = 1; },
  gaitSpike: (s: Simulator) => s.spike(10, 300, 0.6),
} as const;

export type ScenarioName = keyof typeof SCENARIOS;
