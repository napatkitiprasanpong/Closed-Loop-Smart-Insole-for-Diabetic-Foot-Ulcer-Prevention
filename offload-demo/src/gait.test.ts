import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "./core/controller.ts";
import { SENSORS } from "./core/config.ts";
import type { LogEvent } from "./core/types.ts";
import { Simulator } from "./sim/simulator.ts";
import { SCENARIOS } from "./sim/scenarios.ts";

const WALK = { gaitPeriodS: 1.1, sensorTauS: 0.02 };   // about 20 Hz sampling needs a fast sensor response to see a 0.3 s stance
const DT = 0.05;

function walk(sim: Simulator, ctl: Controller, seconds: number) {
  const events: LogEvent[] = []; const tail: number[] = []; const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const f = sim.step(DT, ctl.setpoints); events.push(...ctl.step(f, DT).events);
    if (i >= n - Math.round(3 / DT)) tail.push(Math.max(...f.pressure.filter(Number.isFinite)));
  }
  return { events, peak: Math.max(...tail) };
}
const has = (ev: LogEvent[], re: RegExp) => ev.some(e => re.test(e.msg));

test("gait load model: standing is constant; walking loads heel before forefoot, once per stride, never above the step peak", () => {
  const stand = new Simulator(1); assert.ok(SENSORS.every((_, i) => stand.gaitFactor(i) === 1));
  const sim = new Simulator(1, WALK); const heel = 10, toe = 0;
  const first: number[] = SENSORS.map(() => -1), seen: number[] = SENSORS.map(() => 0); let prev = SENSORS.map(() => 0);
  for (let k = 0; k < Math.round(1.1 / 0.005); k++) {
    sim.step(0.005, { F: 0.5, M: 0.5, L: 0.5, H: 0.5 });
    SENSORS.forEach((_, i) => { const g = sim.gaitFactor(i); assert.ok(g >= 0 && g <= 1); if (g > 0 && prev[i] === 0) { seen[i]++; if (first[i] < 0) first[i] = k * 0.005; } prev[i] = g; });
  }
  assert.ok(first[heel] < first[toe], "heel strikes before toes");
  assert.ok(seen.every(n => n === 1 || n === 0), "at most one loading per stride per sensor");
});

test("walking: without peak-hold the controller calls every stride a 'short gait event' and never acts on a 480 kPa heel", () => {
  const sim = new Simulator(1, WALK), ctl = new Controller(); SCENARIOS.heel(sim);
  const r = walk(sim, ctl, 60);
  assert.ok(!has(r.events, /Plan 1/)); assert.ok(r.events.filter(e => /Short gait event/.test(e.msg)).length > 20);
  assert.ok(r.peak > 400, "pressure is still above the threshold at the end (" + Math.round(r.peak) + ")");
});

test("walking: with peak-hold the heel overload is detected, offloaded and kept; peak ends below the threshold", () => {
  const sim = new Simulator(1, WALK), ctl = new Controller({ gaitWindowS: 1.5 }); SCENARIOS.heel(sim);
  const r = walk(sim, ctl, 60);
  assert.ok(has(r.events, /Plan 1/) && has(r.events, /KEEP/) && !has(r.events, /ALERT/));
  assert.ok(r.peak <= 400, "peak " + Math.round(r.peak));
});

test("walking: several scenarios and seeds all end below the threshold with no alert and no fault", () => {
  for (const seed of [1, 2, 3, 4, 5]) for (const sc of ["heel", "twoHotspots", "threeHotspots"] as const) {
    const sim = new Simulator(seed, WALK), ctl = new Controller({ gaitWindowS: 1.5 }); SCENARIOS[sc](sim);
    const r = walk(sim, ctl, 90);
    assert.ok(!has(r.events, /ALERT|fault/i), `${sc} seed ${seed}: alert or fault`);
    assert.ok(r.peak <= 400, `${sc} seed ${seed}: peak ${Math.round(r.peak)} kPa`);
  }
});

test("walking: one stride of overload is a short event, not a plan", () => {
  const sim = new Simulator(1, WALK), ctl = new Controller({ gaitWindowS: 1.5 });
  walk(sim, ctl, 5);
  sim.spike(10, 300, 1.0);   // heel centre, one stride
  const r = walk(sim, ctl, 15);
  assert.ok(!has(r.events, /Plan 1/), "no plan for a single stride");
});

test("walking: sensor fault checks do not fire falsely on a normal walking signal", () => {
  const sim = new Simulator(1, WALK), ctl = new Controller({ gaitWindowS: 1.5 });
  const r = walk(sim, ctl, 120);
  assert.ok(!has(r.events, /stuck|Implausible|Watchdog|lost/i)); assert.equal(ctl.state, "MONITOR");
});

test("peak-hold leaves standing behaviour working", () => {
  const sim = new Simulator(1), ctl = new Controller({ gaitWindowS: 1.5 }); SCENARIOS.heel(sim);
  let ev: LogEvent[] = []; for (let i = 0; i < 600; i++) ev.push(...ctl.step(sim.step(0.1, ctl.setpoints), 0.1).events);
  assert.ok(has(ev, /KEEP/) && !has(ev, /ALERT/)); assert.ok(Math.max(...sim.steady()) <= 400);
});

test("config check: a peak-hold window as long as the persistence time is rejected", () => {
  assert.throws(() => new Controller({ gaitWindowS: 2.5 }), /gaitWindowS/);
  assert.throws(() => new Controller({ gaitWindowS: -1 }), /gaitWindowS/);
  assert.doesNotThrow(() => new Controller({ gaitWindowS: 1.5 }));
});
