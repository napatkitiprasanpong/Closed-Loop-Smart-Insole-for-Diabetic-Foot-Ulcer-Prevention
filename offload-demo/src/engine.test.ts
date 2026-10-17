import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller, riskScore } from "./core/controller.ts";
import { DEFAULT_CONFIG, NEUTRAL, SENSORS } from "./core/config.ts";
import { ZONES } from "./core/types.ts";
import type { LogEvent } from "./core/types.ts";
import { Simulator } from "./sim/simulator.ts";
import { SCENARIOS } from "./sim/scenarios.ts";

const THR = DEFAULT_CONFIG.thresholdKpa;
/** Run the sim + controller loop for `seconds`, collecting events. */
function run(sim: Simulator, ctl: Controller, seconds: number, dt = 0.1, each?: () => void) {
  const events: LogEvent[] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const r = ctl.step(sim.step(dt, ctl.setpoints), dt);
    events.push(...r.events);
    each?.();
  }
  return events;
}
const peaks = (sim: Simulator) => sim.steady();

test("no load: stays in MONITOR and never moves a zone", () => {
  const sim = new Simulator(1), ctl = new Controller();
  const ev = run(sim, ctl, 20);
  assert.equal(ctl.state, "MONITOR"); assert.equal(ev.length, 0);
  for (const z of ZONES) assert.equal(ctl.setpoints[z], NEUTRAL);
});

test("sustained heel hotspot is offloaded, verified and kept", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.heel(sim);
  const ev = run(sim, ctl, 8);
  assert.ok(ev.some(e => e.kind === "keep"));
  assert.equal(ctl.state, "MONITOR");
  assert.equal(ctl.last?.outcome, "kept");
  assert.ok(ctl.last!.effectiveness > 20, `effectiveness ${ctl.last!.effectiveness}`);
  assert.ok(ctl.last!.after < THR);
  assert.ok(sim.support.H < NEUTRAL);
});

test("short gait spike is ignored (persistence check)", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.gaitSpike(sim);
  const ev = run(sim, ctl, 10);
  assert.ok(ev.some(e => e.msg.startsWith("Short gait event")));
  assert.equal(ctl.state, "MONITOR");
  for (const z of ZONES) assert.equal(ctl.setpoints[z], NEUTRAL);
});

test("two hotspots in different zones are resolved together, with no false rejection", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.twoHotspots(sim);
  const ev = run(sim, ctl, 9);
  assert.equal(ev.filter(e => e.kind === "reject").length, 0);
  assert.equal(ctl.last?.outcome, "kept");
  assert.equal(ctl.last?.hotspotsBefore, 2); assert.equal(ctl.last?.hotspotsAfter, 0);
  assert.ok(sim.support.H < NEUTRAL && sim.support.F < NEUTRAL);
  assert.ok(Math.max(...peaks(sim)) < THR);
});

test("three hotspots: big reduction, and no new hotspot is created anywhere else", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.threeHotspots(sim);
  const before = peaks(sim).reduce((a, v) => a + Math.max(0, v - THR), 0);
  const ev = run(sim, ctl, 14);
  const p = peaks(sim), after = p.reduce((a, v) => a + Math.max(0, v - THR), 0);
  assert.ok(before > 0 && after <= 0.5 * before, `excess ${before} -> ${after}`);
  const initiallyHot = new Set([10, 2, 6]);
  p.forEach((v, i) => { if (!initiallyHot.has(i)) assert.ok(v < THR, `new hotspot at ${SENSORS[i].name}: ${v}`); });
  assert.ok(["MONITOR", "PROBE", "ALERT"].includes(ctl.state));
  if (ctl.state === "ALERT") assert.ok(ev.some(e => e.kind === "alert"));
});

test("unsafe transfer: first plan rejected and reversed, controller learns the stronger transfer, second plan works", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.unsafeTransfer(sim);
  const prior = ctl.est.tau;
  const ev = run(sim, ctl, 20);
  assert.ok(ev.some(e => e.kind === "reject"), "expected a rejection");
  assert.ok(ctl.est.tau > prior + 0.15, `learned transfer ${ctl.est.tau}`);
  const plans = ev.filter(e => e.msg.startsWith("Plan"));
  assert.ok(plans.length >= 2 && plans[1].msg !== plans[0].msg.replace("Plan 1", "Plan 2"), "second plan should differ from the rejected one");
  const p = peaks(sim);
  assert.ok(p[6] < THR && p[10] < THR, `lateral ${p[6]}, heel ${p[10]}`);
  assert.ok(["MONITOR", "PROBE", "ALERT"].includes(ctl.state));
});

test("learning moves the model toward this foot's real response", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.heel(sim);
  const prior = ctl.est.tau;
  run(sim, ctl, 8);
  assert.ok(Math.abs(ctl.est.tau - sim.params.transfer) < Math.abs(prior - sim.params.transfer));
  assert.ok(ctl.est.own > 0.6 && ctl.est.own < 1.2);
});

test("sensor loss triggers FAULT with neutral support, and recovers", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.heel(sim);
  run(sim, ctl, 3);
  sim.disconnected.add(3);
  const ev = run(sim, ctl, 1);
  assert.equal(ctl.state, "FAULT"); assert.ok(ev.some(e => e.kind === "fault"));
  for (const z of ZONES) assert.equal(ctl.setpoints[z], NEUTRAL);
  sim.disconnected.clear(); run(sim, ctl, 1);
  assert.notEqual(ctl.state, "FAULT");
});

test("setpoints never leave the configured safety limits", () => {
  const cfg = { minSupport: 0.3, maxSupport: 0.7 };
  const sim = new Simulator(2), ctl = new Controller(cfg);
  SCENARIOS.threeHotspots(sim);
  run(sim, ctl, 30, 0.1, () => { for (const z of ZONES) assert.ok(ctl.setpoints[z] >= cfg.minSupport - 1e-9 && ctl.setpoints[z] <= cfg.maxSupport + 1e-9); });
});

test("after a multi-zone adjustment, all zones return to natural resting pressure once the load is gone", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.threeHotspots(sim);
  run(sim, ctl, 8);
  SCENARIOS.clear(sim);
  const ev = run(sim, ctl, 70);
  for (const z of ZONES) assert.equal(ctl.setpoints[z], NEUTRAL, `zone ${z}`);
  assert.equal(ctl.state, "MONITOR");
  assert.ok(ev.filter(e => e.msg.startsWith("Load gone")).length >= 3);
});

test("persistent load: re-tests back off, no deflate/inflate looping at the threshold", () => {
  const sim = new Simulator(1), ctl = new Controller();
  SCENARIOS.heel(sim);
  const ev = run(sim, ctl, 200);
  const plans = ev.filter(e => e.msg.startsWith("Plan")).length, probes = ev.filter(e => e.msg.startsWith("Re-test:"));
  assert.equal(plans, 1, "only one offloading plan");
  assert.equal(ev.filter(e => e.kind === "reject").length, 0);
  assert.ok(probes.length >= 2 && probes.length <= 6, `probes ${probes.length}`);
  assert.ok(sim.support.H <= 0.3, `heel support ${sim.support.H}`);
  const t = probes.map(e => e.t);
  for (let i = 2; i < t.length; i++) assert.ok(t[i] - t[i - 1] > t[i - 1] - t[i - 2] - 0.5);
});

test("a sensor hovering at the threshold does not cause log spam or flapping", () => {
  const sim = new Simulator(3), ctl = new Controller();
  sim.load[6] = THR - sim.params.coupling * 0 - SENSORS[6].baseKpa + 2;   // lateral midfoot sits right at the threshold
  const ev = run(sim, ctl, 40);
  assert.ok(ev.length < 12, `events ${ev.length}`);
});

test("hysteresis: a relax step that lands between release level and threshold is rejected", () => {
  const sim = new Simulator(1), ctl = new Controller({ releaseRatio: 0.85 });
  SCENARIOS.heel(sim);
  const ev = run(sim, ctl, 25);
  assert.ok(ev.some(e => e.msg.startsWith("Load still present")));
  assert.ok(ctl.setpoints.H < NEUTRAL);
});

test("transfer model: removed load is re-applied elsewhere (conserved at 100%, partly lost at 0%)", () => {
  const total = (tau: number) => { const s = new Simulator(1, { noise: 0, transfer: tau }); const a = s.steady().reduce((x, v) => x + v, 0); s.support.H = 0.15; return [a, s.steady().reduce((x, v) => x + v, 0)]; };
  const [a1, b1] = total(1), [a0, b0] = total(0);
  assert.ok(Math.abs(b1 - a1) / a1 < 0.01, `tau=1 total ${a1} -> ${b1}`);
  assert.ok((a0 - b0) / a0 > 0.05, `tau=0 total ${a0} -> ${b0}`);
});

test("transfer model: inflating neighbouring zones takes some load off a hotspot (a modest effect)", () => {
  const s = new Simulator(1, { noise: 0 }); s.load[10] = 260;
  const h0 = s.steady()[10]; s.support.M = 0.8; s.support.L = 0.8;
  assert.ok(s.steady()[10] < h0 - 1, `heel ${h0} -> ${s.steady()[10]}`);
});

test("risk score rises with pressure, temperature rise and duration", () => {
  const c = DEFAULT_CONFIG, base = riskScore(0.5, 0, 0, c);
  assert.ok(riskScore(0.9, 0, 0, c) > base); assert.ok(riskScore(0.5, 2, 0, c) > base); assert.ok(riskScore(0.5, 0, 20, c) > base);
});

test("temperature rise above calibrated baseline raises risk without moving pressure control", () => {
  const sim = new Simulator(3), ctl = new Controller();
  run(sim, ctl, 2); ctl.calibrate(sim.step(0.1, ctl.setpoints));
  SCENARIOS.heel(sim); sim.params.coupling = 0;
  const r0 = ctl.step(sim.step(0.1, ctl.setpoints), 0.1).risk[10];
  run(sim, ctl, 25);
  assert.ok(ctl.step(sim.step(0.1, ctl.setpoints), 0.1).risk[10] > r0);
});
