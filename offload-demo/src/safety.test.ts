import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "./core/controller.ts";
import { NEUTRAL } from "./core/config.ts";
import { ZONES } from "./core/types.ts";
import type { Frame, LogEvent } from "./core/types.ts";
import { Simulator } from "./sim/simulator.ts";
import { SCENARIOS } from "./sim/scenarios.ts";

function run(sim: Simulator, ctl: Controller, seconds: number, dt = 0.1, each?: (f: Frame) => Frame) {
  const events: LogEvent[] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    let f = sim.step(dt, ctl.setpoints); if (each) f = each(f);
    events.push(...ctl.step(f, dt).events);
  }
  return events;
}
const allNeutral = (ctl: Controller) => ZONES.every(z => ctl.setpoints[z] === NEUTRAL);
const has = (ev: LogEvent[], re: RegExp) => ev.some(e => re.test(e.msg));

test("watchdog: a long gap between frames drops to FAULT with neutral support, then recovers", () => {
  const sim = new Simulator(1), ctl = new Controller(); SCENARIOS.heel(sim);
  run(sim, ctl, 6);
  assert.ok(!allNeutral(ctl), "plan should be under way");
  const r = ctl.step(sim.step(0.1, ctl.setpoints), 2.5);
  assert.equal(r.state, "FAULT"); assert.ok(allNeutral(ctl)); assert.ok(/Watchdog/.test(r.events[0].msg));
  const ev = run(sim, ctl, 1);
  assert.equal(ctl.state === "FAULT", false); assert.ok(has(ev, /recovered/));
});

test("watchdog: onNoData() (frames stopped entirely) goes to FAULT with neutral support, once", () => {
  const sim = new Simulator(1), ctl = new Controller(); SCENARIOS.heel(sim);
  run(sim, ctl, 6);
  const a = ctl.onNoData(), b = ctl.onNoData();
  assert.equal(a.state, "FAULT"); assert.ok(allNeutral(ctl)); assert.equal(a.events.length, 1); assert.equal(b.events.length, 0);
});

test("plausibility: out-of-range pressure or temperature is a fault, not a hotspot", () => {
  for (const [name, mutate] of [
    ["pressure", (f: Frame) => { f.pressure[4] = 5000; }],
    ["negative pressure", (f: Frame) => { f.pressure[4] = -300; }],
    ["temperature", (f: Frame) => { f.temp[2] = 80; }],
  ] as [string, (f: Frame) => void][]) {
    const sim = new Simulator(1), ctl = new Controller(); let n = 0;
    const ev = run(sim, ctl, 5, 0.1, f => { if (++n > 20) mutate(f); return f; });
    assert.equal(ctl.state, "FAULT", name); assert.ok(allNeutral(ctl), name); assert.ok(has(ev, /Implausible/), name);
  }
});

test("stuck sensor: frozen while the others vary -> FAULT; not triggered when everything is steady", () => {
  const sim = new Simulator(1), ctl = new Controller(); let frozen: number | null = null;
  const ev = run(sim, ctl, 30, 0.1, f => { if (frozen === null) frozen = f.pressure[3]; f.pressure[3] = frozen; return f; });
  assert.equal(ctl.state, "FAULT"); assert.ok(has(ev, /stuck/i));
  // noise-free simulator: nothing moves at all, so nothing counts as stuck
  const sim2 = new Simulator(1, { noise: 0 }), ctl2 = new Controller();
  run(sim2, ctl2, 60); assert.equal(ctl2.state, "MONITOR");
});

test("leak: a held zone that loses support raises an alert, returns to neutral and is pinned out of later plans", () => {
  const sim = new Simulator(1), ctl = new Controller(); SCENARIOS.heel(sim);
  run(sim, ctl, 20);
  assert.ok(ctl.setpoints.H < NEUTRAL, "heel adjustment is held");
  sim.leaking.add("H");
  let neutralAtAlert = false;
  const ev = run(sim, ctl, 20, 0.1, f => { if (ctl.leakZones.has("H") && !neutralAtAlert) neutralAtAlert = allNeutral(ctl); return f; });
  assert.ok(has(ev, /leak suspected/), "leak reported"); assert.ok(ctl.leakZones.has("H")); assert.ok(neutralAtAlert, "all zones neutral when the alert fires");
  // while flagged, the planner never moves the leaking zone
  const t = ev.find(e => /leak suspected/.test(e.msg))!.t;
  assert.ok(t < 20 + 15, "reported within about 15 s of the leak starting (got " + t + ")");
  SCENARIOS.clear(sim); sim.leaking.add("H");
  SCENARIOS.heel(sim); sim.load[10] = 400;
  run(sim, ctl, 40, 0.1, () => { assert.equal(ctl.setpoints.H, NEUTRAL); return sim.step(0, ctl.setpoints); });
});

test("leak: flag clears once the zone holds pressure again", () => {
  const sim = new Simulator(1), ctl = new Controller(); SCENARIOS.heel(sim);
  run(sim, ctl, 20); sim.leaking.add("H"); run(sim, ctl, 20);
  assert.ok(ctl.leakZones.has("H"));
  sim.leaking.clear(); sim.support.H = NEUTRAL;   // leak repaired and zone refilled
  const ev = run(sim, ctl, 20);
  assert.ok(!ctl.leakZones.has("H")); assert.ok(has(ev, /Leak cleared/));
  // or acknowledged by the host
  ctl.leakZones.add("L"); ctl.clearLeak("L"); assert.ok(!ctl.leakZones.has("L"));
});

test("leak: slow pneumatics are not mistaken for a leak (support is still closing in on the target)", () => {
  const sim = new Simulator(1, { actuatorRate: 0.03 }), ctl = new Controller(); SCENARIOS.heel(sim);
  const ev = run(sim, ctl, 120);
  assert.ok(!has(ev, /leak/i)); assert.equal(ctl.leakZones.size, 0);
});

test("leak detection is off when the frame has no bladder readback", () => {
  const sim = new Simulator(1), ctl = new Controller(); SCENARIOS.heel(sim);
  run(sim, ctl, 20); sim.leaking.add("H");
  const ev = run(sim, ctl, 30, 0.1, f => { delete f.bladder; return f; });
  assert.ok(!has(ev, /leak suspected/));
});

test("SR-04: no zone stays away from neutral longer than maxActiveS; returns to neutral and alerts", () => {
  const sim = new Simulator(1), ctl = new Controller({ maxActiveS: 40 }); SCENARIOS.heel(sim);
  const ev = run(sim, ctl, 60);
  assert.ok(has(ev, /maximum/), "alert raised"); assert.equal(ctl.state, "ALERT"); assert.ok(allNeutral(ctl));
  const t = ev.find(e => /maximum/.test(e.msg))!.t; assert.ok(t >= 40 && t < 50, "alert at about 40 s (got " + t + ")");
  run(sim, ctl, 30); assert.equal(ctl.state, "ALERT", "load still present: alert stays and zones stay neutral"); assert.ok(allNeutral(ctl));
  SCENARIOS.clear(sim); run(sim, ctl, 10);
  assert.equal(ctl.state, "MONITOR");
});

test("SR-04 can be switched off (maxActiveS = 0) and a normal long hold is fine at the default", () => {
  const sim = new Simulator(1), ctl = new Controller(); SCENARIOS.heel(sim);
  const ev = run(sim, ctl, 300);
  assert.ok(!has(ev, /maximum/));
  const ctl2 = new Controller({ maxActiveS: 0 }), sim2 = new Simulator(1); SCENARIOS.heel(sim2);
  assert.ok(!has(run(sim2, ctl2, 100), /maximum/));
});
