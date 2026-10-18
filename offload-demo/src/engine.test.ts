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
  const ev = run(sim, ctl, 14);   // stop once the second plan is kept; later relax re-tests deliberately lift support again
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


// ---------- robustness: slow pneumatics and a simulator that disagrees with the controller's assumptions ----------

/** Seconds a site that was not hot at the start spends above the threshold, plus every KEEP that happened while one was. */
function robustRun(scn: "heel" | "twoHotspots" | "threeHotspots" | "unsafeTransfer", params: Partial<Simulator["params"]>, seconds: number) {
  const sim = new Simulator(7, params), ctl = new Controller();
  SCENARIOS[scn](sim); if (params.transfer !== undefined) sim.params.transfer = params.transfer;
  const start = sim.steady(), initiallyHot = start.map(v => v > THR), excess0 = start.reduce((a, v) => a + Math.max(0, v - THR), 0);
  const lim = DEFAULT_CONFIG; let keptWithNewHotspot = 0, inflatedUnderHotspot = 0, outOfLimits = 0;
  for (let i = 0; i < Math.round(seconds / 0.1); i++) {
    const before = { ...ctl.setpoints }, frame = sim.step(0.1, ctl.setpoints);
    const hotZones = new Set(frame.pressure.flatMap((v, k) => (v > THR ? [SENSORS[k].zone] : [])));
    const r = ctl.step(frame, 0.1), st = sim.steady();
    const newHotNow = st.some((v, k) => !initiallyHot[k] && v > THR);
    if (r.events.some(e => e.kind === "keep") && newHotNow) keptWithNewHotspot++;
    if (r.events.some(e => e.msg.startsWith("Plan"))) for (const z of ZONES) if (hotZones.has(z) && ctl.setpoints[z] > before[z] + 1e-9) inflatedUnderHotspot++;
    for (const z of ZONES) if (ctl.setpoints[z] < lim.minSupport - 1e-9 || ctl.setpoints[z] > lim.maxSupport + 1e-9) outOfLimits++;
  }
  const end = sim.steady(), excess1 = end.reduce((a, v) => a + Math.max(0, v - THR), 0);
  return { keptWithNewHotspot, inflatedUnderHotspot, outOfLimits, excess0, excess1, endsWithNewHotspot: end.some((v, k) => !initiallyHot[k] && v > THR) };
}

test("slow pneumatics: the controller waits for pressure to settle instead of verifying too early", () => {
  // At 0.05 support/s a 0.3 move takes about 6 s, longer than the fixed 2.2 s wait the controller used to rely on.
  const sim = new Simulator(1, { actuatorRate: 0.05 }), ctl = new Controller();
  SCENARIOS.threeHotspots(sim);
  const ev = run(sim, ctl, 60);
  const firstPlan = ev.find(e => e.msg.startsWith("Plan"))!, firstVerdict = ev.find(e => e.kind === "keep" || e.kind === "reject")!;
  assert.ok(firstVerdict.t - firstPlan.t > 3, `verdict only ${(firstVerdict.t - firstPlan.t).toFixed(1)} s after the plan`);
  const r = robustRun("threeHotspots", { actuatorRate: 0.05 }, 60);
  assert.equal(r.keptWithNewHotspot, 0);
});

test("gives up waiting after settleMaxS and still decides (never stuck in ADJUST)", () => {
  const sim = new Simulator(1), ctl = new Controller({ settleBandKpa: 0.01, settleMaxS: 6 });   // a band this tight is never met, so only the timeout can end the wait
  SCENARIOS.heel(sim);
  const ev = run(sim, ctl, 25);
  assert.ok(ev.some(e => e.msg.startsWith("Pressure still drifting")), "expected the timeout message");
  assert.ok(ev.some(e => e.kind === "keep" || e.kind === "reject"));
});

test("robustness sweep: model mismatch never breaks the safety invariants", () => {
  for (const scn of ["heel", "twoHotspots", "threeHotspots", "unsafeTransfer"] as const)
    for (const transfer of [0.2, 0.6, 1]) for (const sigmaMm of [30, 90]) for (const coupling of [0.5, 1.3]) for (const actuatorRate of [0.05, 0.25]) {
      const tag = `${scn} transfer=${transfer} sigma=${sigmaMm} coupling=${coupling} rate=${actuatorRate}`;
      const r = robustRun(scn, { transfer, sigmaMm, coupling, actuatorRate, noise: 0.05 }, 100);
      assert.equal(r.keptWithNewHotspot, 0, `kept while a new hotspot existed: ${tag}`);
      assert.equal(r.inflatedUnderHotspot, 0, `inflated directly under a hotspot (FR-05): ${tag}`);
      assert.equal(r.outOfLimits, 0, `support left its safety limits: ${tag}`);
      assert.ok(r.excess1 <= r.excess0 + 1, `ended worse than it started (${r.excess0} -> ${r.excess1}): ${tag}`);
    }
});
