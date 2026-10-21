import type { CtlState, Frame, LogEvent, Setpoints, StepResult, Verification, Zone } from "./types.ts";
import { ZONES, ZONE_NAMES } from "./types.ts";
import type { ControllerConfig } from "./config.ts";
import { DEFAULT_CONFIG, NEUTRAL, SENSORS } from "./config.ts";
import { kernel, redistribute } from "./model.ts";

type Log = (kind: LogEvent["kind"], msg: string) => void;
const pct = (x: number) => Math.round(x * 100) + "%";
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Explainable risk score: wp*P + wt*dT + wd*D, each term normalised and capped. */
export function riskScore(pNorm: number, dT: number, durS: number,
  c: Pick<ControllerConfig, "wp" | "wt" | "wd" | "dtRef" | "durRef">): number {
  return c.wp * clamp(pNorm, 0, 1.5) + c.wt * clamp(dT / c.dtRef, 0, 1.5) + c.wd * clamp(durS / c.durRef, 0, 1.5);
}

interface Plan { p0: number[]; s0: Setpoints; s1: Setpoints; hot: number[]; excess0: number }

/**
 * Closed-loop offloading controller (no UI, no hardware). Handles several simultaneous hotspots:
 *  1. PLAN: search combined support changes for all four zones using a small load-transfer model, aiming to bring every
 *     hotspot under the threshold without pushing any other sensor over it (deflate under, or inflate around).
 *  2. APPLY and wait, then VERIFY with fresh measurements: keep, keep as partial, or reverse.
 *  3. LEARN: every attempt (kept or rejected) refines two model parameters (bladder effectiveness and share of load
 *     transferred), so a rejected attempt makes the next plan better. Pressure drives the loop; temperature and
 *     duration feed the risk score only.
 */
export class Controller {
  cfg: ControllerConfig;
  state: CtlState = "MONITOR";
  setpoints: Setpoints = { F: NEUTRAL, M: NEUTRAL, L: NEUTRAL, H: NEUTRAL };
  last?: Verification;
  tempBaseline: number[] | null = null;
  /** Current estimate of this foot's response (learned online). */
  est: { own: number; tau: number };
  private K: number[][];
  private clock = 0;
  private stateT = 0;
  private tgt = -1;
  private attempt = 0;
  private plan?: Plan;
  private dur: number[] = SENSORS.map(() => 0);
  private holdT: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };
  private holdNeed: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };
  private backoff: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };
  private relaxStep: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };
  private probeZone: Zone | null = null;
  private probePrev = NEUTRAL;
  private quiet = 0;
  private margin: number;   // planning margin; tightens after each rejected plan, resets for a new episode
  private risk: number[] = SENSORS.map(() => 0);
  private hist: { t: number; p: number[] }[] = [];   // recent readings, used to tell when pressures have stopped changing
  // safety monitors
  private activeT: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };   // SR-04: time each zone has continuously been away from neutral
  private lastVal: number[] = []; private sameT: number[] = [];          // stuck-sensor detection
  private lastCmd: Record<Zone, number> = { F: NEUTRAL, M: NEUTRAL, L: NEUTRAL, H: NEUTRAL };
  private leakBest: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };
  private leakT: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };
  private leakOk: Record<Zone, number> = { F: 0, M: 0, L: 0, H: 0 };
  /** Zones currently flagged as leaking. The planner keeps them at neutral until they read normally again. */
  leakZones = new Set<Zone>();
  private alertT = 0;
  private pk: { t: number; p: number[] }[] = [];   // raw readings inside the peak-hold window (walking mode)

  constructor(cfg: Partial<ControllerConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    if (this.cfg.gaitWindowS < 0 || (this.cfg.gaitWindowS > 0 && this.cfg.gaitWindowS >= this.cfg.persistenceS)) throw new Error(`gaitWindowS (${this.cfg.gaitWindowS}) must be 0 or shorter than persistenceS (${this.cfg.persistenceS}), or a single step would count as sustained`);
    this.est = { own: this.cfg.priorOwn, tau: this.cfg.priorTransfer };
    this.K = kernel(this.cfg.sigmaMm); this.margin = this.cfg.marginRatio;
    this.resetHold();
  }

  /** Patient-specific baseline: records resting skin temperature at each site. */
  calibrate(frame: Frame) { this.tempBaseline = frame.temp.slice(); }

  step(frame: Frame, dt: number): StepResult {
    const events: LogEvent[] = [];
    const log: Log = (kind, msg) => events.push({ t: +this.clock.toFixed(2), kind, msg });
    this.clock += dt; this.stateT += dt;
    const raw = frame.pressure, c = this.cfg;
    let verification: Verification | undefined;

    if (c.watchdogS > 0 && dt > c.watchdogS) {
      if (this.state !== "FAULT") this.enterFault(`Watchdog: no data for ${dt.toFixed(1)} s. All zones returned to neutral support.`, log);
      return this.result(events);
    }
    const bad = raw.some(v => !Number.isFinite(v)) ? "Sensor reading lost. All zones returned to neutral support." : this.implausible(frame, dt);
    if (bad) {
      if (this.state !== "FAULT") this.enterFault(bad, log);
      return this.result(events);
    }
    if (this.state === "FAULT") { this.go("MONITOR"); log("info", "Sensors recovered. Monitoring resumed."); }
    const p = this.peakHold(raw);   // equal to raw unless walking mode is on

    this.hist.push({ t: this.clock, p: p.slice() });
    while (this.hist.length > 1 && this.hist[0].t < this.clock - 3 * c.settleWindowS - dt) this.hist.shift();

    if (this.checkLeaks(frame, dt, log) || this.checkActiveTime(dt, log)) return this.result(events);

    const lvl = 0.97 * c.thresholdKpa;   // hold band just under the trigger level, so a sensor hovering at the threshold counts as still high
    p.forEach((v, i) => { this.dur[i] = v > lvl ? this.dur[i] + dt : Math.max(0, this.dur[i] - dt); });
    this.risk = p.map((v, i) => {
      const dT = this.tempBaseline && Number.isFinite(frame.temp[i]) ? frame.temp[i] - this.tempBaseline[i] : 0;
      return riskScore(v / c.thresholdKpa, dT, this.dur[i], c);
    });

    switch (this.state) {
      case "MONITOR": {
        if (this.quiet > 0) { this.quiet -= dt; break; }
        let k = -1, m = c.thresholdKpa;
        p.forEach((v, i) => { if (v > m) { m = v; k = i; } });
        if (k >= 0) {
          this.tgt = k; this.go("CONFIRM");
          log("info", `High pressure at ${SENSORS[k].name} (${Math.round(p[k])} kPa). Checking persistence.`);
        } else this.relax(dt, log);
        break;
      }
      case "CONFIRM":
        if (p.every(v => v <= lvl)) { log("info", "Short gait event, not sustained. No action."); this.tgt = -1; this.go("MONITOR"); }
        else if (this.dur.some(d => d >= c.persistenceS)) { this.attempt = 0; this.margin = c.marginRatio; this.begin(p, log); }
        break;
      case "ADJUST":
        if (this.stateT >= c.stabilizeS && (this.settled() || this.stateT >= c.settleMaxS)) {
          const late = !this.settled();
          this.go("VERIFY"); log("info", late ? "Pressure still drifting after the maximum wait. Measuring anyway." : "Pressure stabilised. Measuring again.");
        }
        break;
      case "VERIFY":
        if (this.stateT >= c.verifyS) verification = this.verify(this.mean(c.verifyS), log);
        break;
      case "REVERSE":
        if (this.stateT >= c.reverseS && (this.settled() || this.stateT >= c.settleMaxS)) {
          if (this.attempt >= c.maxAttempts) this.raiseAlert("Safe redistribution not achieved. Previous support restored; user/clinician notified.", log);
          else this.begin(p, log);
        }
        break;
      case "PROBE":
        if (this.stateT >= c.stabilizeS + c.verifyS && (this.settled() || this.stateT >= c.settleMaxS)) this.finishProbe(this.mean(c.verifyS), log);
        break;
      case "ALERT":
        if (this.alertT > 0) { this.alertT -= dt; break; }
        if (p.every(v => v <= c.thresholdKpa)) { this.attempt = 0; this.tgt = -1; this.resetHold(); this.go("MONITOR"); log("info", "Load cleared. Monitoring resumed."); }
        break;
    }
    return this.result(events, verification);
  }


  /** Walking mode: the highest reading of each sensor over the last gaitWindowS. Steady load passes through unchanged, a load that returns every
   *  stride stays high between steps, and a single step falls away after the window (which is shorter than the persistence time). */
  private peakHold(raw: number[]): number[] {
    const w = this.cfg.gaitWindowS; if (w <= 0) return raw;
    this.pk.push({ t: this.clock, p: raw.slice() });
    while (this.pk.length > 1 && this.pk[0].t < this.clock - w) this.pk.shift();
    return raw.map((_, i) => { let m = -Infinity; for (const r of this.pk) if (r.p[i] > m) m = r.p[i]; return m; });
  }

  /** Put every zone at neutral and drop any plan in progress. */
  private safeState() {
    this.neutralise(); this.tgt = -1; this.attempt = 0; this.plan = undefined; this.probeZone = null; this.quiet = 0; this.resetHold(); this.hist = [];
    for (const z of ZONES) this.activeT[z] = 0;
    this.alertT = 0; this.pk = [];
  }

  private enterFault(msg: string, log: Log) { this.safeState(); this.go("FAULT"); log("fault", msg); }

  /** Host/technician acknowledgement: the leak in this zone has been repaired, allow it to be used again. */
  clearLeak(z: Zone) { this.leakZones.delete(z); this.leakT[z] = 0; this.leakOk[z] = 0; this.leakBest[z] = Infinity; }

  /** Called by the host when frames stop arriving at all (the step() gap check cannot run without a frame). */
  onNoData(): StepResult {
    const events: LogEvent[] = [];
    if (this.state !== "FAULT") this.enterFault("Watchdog: data stopped. All zones returned to neutral support.", (kind, msg) => events.push({ t: +this.clock.toFixed(2), kind, msg }));
    return this.result(events);
  }

  /** SR-05: reading out of range, or a sensor frozen while the others keep moving. Returns a message, or null if all readings are plausible. */
  private implausible(f: Frame, dt: number): string | null {
    const c = this.cfg, p = f.pressure;
    for (let i = 0; i < p.length; i++) if (p[i] < c.pMinKpa || p[i] > c.pMaxKpa) return `Implausible reading at ${SENSORS[i].name} (${Math.round(p[i])} kPa). All zones returned to neutral support.`;
    for (let i = 0; i < f.temp.length; i++) { const v = f.temp[i]; if (Number.isFinite(v) && (v < c.tempMinC || v > c.tempMaxC)) return `Implausible temperature at ${SENSORS[i]?.name ?? "site " + i} (${v.toFixed(1)} °C). All zones returned to neutral support.`; }
    if (c.stuckS <= 0) return null;
    if (this.lastVal.length !== p.length) { this.lastVal = p.slice(); this.sameT = p.map(() => 0); return null; }
    p.forEach((v, i) => { this.sameT[i] = v === this.lastVal[i] ? this.sameT[i] + dt : 0; this.lastVal[i] = v; });
    const alive = this.sameT.filter(t => t < 1).length;
    if (alive >= 3) for (let i = 0; i < p.length; i++) if (this.sameT[i] >= c.stuckS) return `Sensor stuck: ${SENSORS[i].name} has not changed for ${Math.round(this.sameT[i])} s while others vary. All zones returned to neutral support.`;
    return null;
  }

  /** Leak detection from bladder readback (only when the frame carries it). Returns true if it just raised an alert. */
  private checkLeaks(f: Frame, dt: number, log: Log): boolean {
    const c = this.cfg; if (!f.bladder || c.leakS <= 0) return false;
    let tripped: Zone | null = null;
    for (const z of ZONES) {
      const rb = f.bladder[z]; if (rb === undefined || !Number.isFinite(rb)) continue;
      const sp = this.setpoints[z], dev = Math.abs(rb - sp);
      if (Math.abs(sp - this.lastCmd[z]) > 1e-9) { this.lastCmd[z] = sp; this.leakBest[z] = dev; this.leakT[z] = 0; this.leakOk[z] = 0; continue; }
      if (dev < this.leakBest[z] - 0.01) { this.leakBest[z] = dev; this.leakT[z] = 0; }   // still closing in on the target: pneumatics are just slow
      else if (dev > c.leakBand) this.leakT[z] += dt; else { this.leakT[z] = 0; this.leakBest[z] = Math.min(this.leakBest[z], dev); }
      this.leakOk[z] = dev <= c.leakBand ? this.leakOk[z] + dt : 0;
      if (this.leakZones.has(z)) {
        if (this.leakOk[z] >= c.leakClearS) { this.leakZones.delete(z); this.leakT[z] = 0; log("info", `Leak cleared: ${ZONE_NAMES[z]} zone reads normally again.`); }
      } else if (this.leakT[z] >= c.leakS) tripped = z;
    }
    if (tripped === null) return false;
    const cmd = this.setpoints[tripped];
    this.leakZones.add(tripped); this.safeState(); this.go("ALERT");
    for (const z of ZONES) { this.lastCmd[z] = this.setpoints[z]; this.leakBest[z] = Infinity; this.leakT[z] = 0; this.leakOk[z] = 0; }
    log("alert", `ALERT: leak suspected in the ${ZONE_NAMES[tripped]} zone (support reads ${pct(f.bladder[tripped] as number)}, commanded ${pct(cmd)}). All zones returned to neutral; this zone will not be used until it holds pressure.`);
    return true;
  }

  /** SR-04: no zone stays away from neutral longer than maxActiveS. Returns true if it just raised an alert. */
  private checkActiveTime(dt: number, log: Log): boolean {
    const c = this.cfg; if (c.maxActiveS <= 0) return false;
    let over: Zone | null = null;
    for (const z of ZONES) {
      this.activeT[z] = Math.abs(this.setpoints[z] - NEUTRAL) > 1e-9 ? this.activeT[z] + dt : 0;
      if (this.activeT[z] >= c.maxActiveS) over = z;
    }
    if (over === null) return false;
    this.safeState(); this.go("ALERT"); this.alertT = c.alertHoldS;
    log("alert", `ALERT: the ${ZONE_NAMES[over]} zone was held away from neutral for ${c.maxActiveS} s (maximum). All zones returned to neutral; user/clinician notified. Relieve the load to resume.`);
    return true;
  }

  /** Mean reading per sensor over the last `w` seconds (smooths sensor noise before a keep/reject decision). */
  private mean(w: number, back = 0): number[] {
    const hi = this.clock - back, lo = hi - w, rows = this.hist.filter(h => h.t > lo && h.t <= hi + 1e-9);
    if (!rows.length) return this.hist[this.hist.length - 1].p.slice();
    return SENSORS.map((_, i) => rows.reduce((a, r) => a + r.p[i], 0) / rows.length);
  }

  /** True when no sensor mean changed by more than settleBandKpa between the last window and the window one window-length earlier. */
  private settled(): boolean {
    const w = this.cfg.settleWindowS;
    if (this.hist.length < 2 || this.hist[0].t > this.clock - 3 * w + 1e-9) return false;   // not enough history yet
    const a = this.mean(w), b = this.mean(w, 2 * w);
    return a.every((v, i) => Math.abs(v - b[i]) <= this.cfg.settleBandKpa);
  }

  private go(s: CtlState) { this.state = s; this.stateT = 0; }
  private neutralise() { for (const z of ZONES) this.setpoints[z] = NEUTRAL; }
  private hotspots(p: number[]) { return p.map((v, i) => i).filter(i => p[i] > this.cfg.thresholdKpa).sort((a, b) => p[b] - p[a]); }
  private excess(p: number[]) { return p.reduce((a, v) => a + Math.max(0, v - this.cfg.thresholdKpa), 0); }

  // ---------- model, planning, learning ----------
  /** Predict sensor pressures after support changes s0 -> s1, from the measured pressures p at s0. */
  private predict(p: number[], s0: Setpoints, s1: Setpoints, own = this.est.own, tau = this.est.tau): number[] {
    const d = p.map((v, i) => {
      const z = SENSORS[i].zone, k0 = 1 - own * (NEUTRAL - s0[z]), k1 = 1 - own * (NEUTRAL - s1[z]);
      return v * (k1 / Math.max(0.05, k0) - 1);
    });
    const comp = redistribute(d, s1, tau, this.K, this.cfg.stiffGain);
    return p.map((v, i) => Math.max(0.05 * v, v + d[i] + comp[i]));
  }

  /** Search combined changes of all four zones; returns null if nothing is predicted to help. */
  private makePlan(p: number[]): { s1: Setpoints; pred: number[] } | null {
    const c = this.cfg, s0 = this.setpoints, m = this.margin * c.thresholdKpa;
    // FR-05: never inflate directly under a hotspot. A zone that holds a hotspot may only stay put or deflate.
    const hotZones = new Set(this.hotspots(p).map(i => SENSORS[i].zone));
    const cand = ZONES.map(z => { if (this.leakZones.has(z)) return [s0[z]]; const set = new Set<number>(); const top = hotZones.has(z) ? 0 : 0.2501; for (let d = -0.4; d <= top; d += 0.05) set.add(+clamp(s0[z] + d, c.minSupport, c.maxSupport).toFixed(3)); return [...set]; });
    const costOf = (pred: number[], s1: Setpoints) => {
      let e = 0; for (const v of pred) if (v > m) e += (v - m) ** 2;
      let mv = 0; for (const z of ZONES) mv += Math.abs(s1[z] - s0[z]);
      return e + c.moveCost * mv;
    };
    const baseCost = costOf(p, s0);
    let best: { s1: Setpoints; pred: number[]; cost: number } | null = null;
    for (const a of cand[0]) for (const b of cand[1]) for (const cc of cand[2]) for (const d of cand[3]) {
      const s1: Setpoints = { F: a, M: b, L: cc, H: d }, pred = this.predict(p, s0, s1), cost = costOf(pred, s1);
      if (!best || cost < best.cost) best = { s1, pred, cost };
    }
    return best && best.cost < baseCost - 1 ? { s1: best.s1, pred: best.pred } : null;
  }

  /** Refine bladder effectiveness and load-transfer share from what actually happened. */
  private learn(p0: number[], s0: Setpoints, s1: Setpoints, p1: number[]) {
    let mv = 0; for (const z of ZONES) mv += Math.abs(s1[z] - s0[z]);
    if (mv < 0.05) return;
    let bestE = Infinity, bo = this.est.own, bt = this.est.tau;
    for (let own = 0.3; own <= 1.3001; own += 0.05) for (let tau = 0; tau <= 1.2001; tau += 0.05) {
      const pr = this.predict(p0, s0, s1, own, tau); let e = 0;
      for (let i = 0; i < p0.length; i++) e += (pr[i] - p1[i]) ** 2;
      if (e < bestE) { bestE = e; bo = own; bt = tau; }
    }
    this.est.own = 0.5 * this.est.own + 0.5 * bo; this.est.tau = 0.5 * this.est.tau + 0.5 * bt;
  }

  private begin(p: number[], log: Log) {
    const hot = this.hotspots(p);
    if (!hot.length) { this.go("MONITOR"); return; }
    const pl = this.makePlan(p);
    if (!pl) { this.raiseAlert(`No safe redistribution available for ${hot.length} hotspot${hot.length > 1 ? "s" : ""}. Current support held.`, log); return; }
    const s0 = { ...this.setpoints }; this.attempt++;
    this.plan = { p0: p.slice(), s0, s1: pl.s1, hot, excess0: this.excess(p) };
    this.setpoints = { ...pl.s1 };
    const ch = ZONES.filter(z => Math.abs(pl.s1[z] - s0[z]) > 1e-9);
    for (const z of ch) this.holdT[z] = 0;
    this.go("ADJUST");
    log("info", `Plan ${this.attempt}: ${hot.length} hotspot${hot.length > 1 ? "s" : ""} (${hot.slice(0, 3).map(i => SENSORS[i].name).join(", ")}). ` +
      ch.map(z => `${ZONE_NAMES[z]} ${pct(s0[z])} → ${pct(pl.s1[z])}`).join(", ") + `. Predicted peak ${Math.round(Math.max(...pl.pred))} kPa.`);
  }

  private verify(p: number[], log: Log): Verification {
    const c = this.cfg, pl = this.plan as Plan, thr = c.thresholdKpa;
    const w = pl.hot[0], before = pl.p0[w], after = p[w];
    let nt = 0, ni = -1; p.forEach((v, i) => { if (!pl.hot.includes(i) && v > nt) { nt = v; ni = i; } });
    const lvl = 0.97 * thr;
    const newHot = p.map((v, i) => i).filter(i => !pl.hot.includes(i) && p[i] > lvl);
    const remaining = p.map((v, i) => i).filter(i => p[i] > lvl), ex1 = this.excess(p);
    this.learn(pl.p0, pl.s0, pl.s1, p);
    const improved = ex1 <= (1 - c.improveMin) * pl.excess0 + 1e-9;
    const ok = newHot.length === 0 && improved;
    const v: Verification = {
      region: SENSORS[w].name, before, after, effectiveness: (before - after) / before * 100,
      hotspotsBefore: pl.hot.length, hotspotsAfter: remaining.length, excessBefore: pl.excess0, excessAfter: ex1,
      maxElsewhere: nt, maxElsewhereRegion: ni >= 0 ? SENSORS[ni].name : "–", outcome: !ok ? "reversed" : remaining.length ? "partial" : "kept",
    };
    this.last = v;
    const est = `Learned response: bladder effectiveness ${this.est.own.toFixed(2)}, load transfer ${pct(this.est.tau)}.`;
    if (ok) {
      for (const z of ZONES) if (Math.abs(pl.s1[z] - pl.s0[z]) > 1e-9) { this.backoff[z] = 0; this.holdNeed[z] = c.holdS; this.holdT[z] = 0; }
      if (!remaining.length) {
        log("keep", `KEEP: ${pl.hot.length} hotspot${pl.hot.length > 1 ? "s" : ""} resolved. Worst: ${SENSORS[w].name} ${Math.round(before)} → ${Math.round(after)} kPa. Highest elsewhere ${Math.round(nt)} kPa. ${est}`);
        this.attempt = 0; this.tgt = -1; this.plan = undefined; this.go("MONITOR");
      } else {
        log("keep", `KEEP (partial): excess ${Math.round(pl.excess0)} → ${Math.round(ex1)} kPa, ${remaining.length} hotspot${remaining.length > 1 ? "s" : ""} remain. ${est}`);
        if (this.attempt < c.maxAttempts) this.begin(p, log);
        else this.raiseAlert(`${remaining.length} hotspot${remaining.length > 1 ? "s" : ""} could not be fully offloaded safely. Best adjustment held; user/clinician notified.`, log);
      }
    } else {
      log("reject", newHot.length ? `REJECT: pressure moved to ${newHot.map(i => `${SENSORS[i].name} (${Math.round(p[i])} kPa)`).join(", ")}. Reversing. ${est}` : `REJECT: hotspots not reduced enough. Reversing. ${est}`);
      this.margin = Math.max(0.78, this.margin - 0.04);   // be more conservative next time
      this.setpoints = { ...pl.s0 }; this.go("REVERSE");
    }
    return v;
  }

  private raiseAlert(msg: string, log: Log) { this.go("ALERT"); log("alert", "ALERT: " + msg); }

  // ---------- adaptive re-test of held adjustments ----------
  private resetHold() { for (const z of ZONES) { this.holdT[z] = 0; this.backoff[z] = 0; this.holdNeed[z] = this.cfg.holdS; this.relaxStep[z] = this.cfg.reliefStep; } }

  private relax(dt: number, log: Log) {
    for (const z of ZONES) {
      if (Math.abs(this.setpoints[z] - NEUTRAL) < 1e-9) { this.holdT[z] = 0; this.backoff[z] = 0; this.holdNeed[z] = this.cfg.holdS; this.relaxStep[z] = this.cfg.reliefStep; continue; }
      this.holdT[z] += dt;
      if (this.holdT[z] >= this.holdNeed[z]) { this.startProbe(z, log); return; }
    }
  }

  private startProbe(z: Zone, log: Log) {
    const sp = this.setpoints[z], st = this.relaxStep[z];
    this.probePrev = sp; this.probeZone = z;
    this.setpoints[z] = sp < NEUTRAL ? Math.min(NEUTRAL, sp + st) : Math.max(NEUTRAL, sp - st);
    this.go("PROBE");
    log("info", `Re-test: relaxing ${ZONE_NAMES[z]} zone ${pct(sp)} → ${pct(this.setpoints[z])} to see whether the load has gone.`);
  }

  private finishProbe(p: number[], log: Log) {
    const c = this.cfg, z = this.probeZone as Zone, release = c.releaseRatio * c.thresholdKpa;
    let zoneMax = 0, others = 0;
    p.forEach((v, i) => { if (SENSORS[i].zone === z) zoneMax = Math.max(zoneMax, v); else others = Math.max(others, v); });
    this.holdT[z] = 0; this.probeZone = null;
    if (zoneMax < release && others < c.thresholdKpa) {
      this.backoff[z] = 0; this.holdNeed[z] = c.probeIntervalS; this.relaxStep[z] = Math.min(c.relaxStepMax, this.relaxStep[z] * 2);
      const back = Math.abs(this.setpoints[z] - NEUTRAL) < 1e-9;
      log("info", back ? `Load gone: ${ZONE_NAMES[z]} zone back at natural resting pressure.` : `Re-test passed (zone peak ${Math.round(zoneMax)} kPa, release level ${Math.round(release)}). Support now ${pct(this.setpoints[z])}.`);
      if (back) this.holdNeed[z] = c.holdS;
    } else {
      this.setpoints[z] = this.probePrev; this.backoff[z]++; this.relaxStep[z] = c.reliefStep;
      this.holdNeed[z] = Math.min(c.holdS * 2 ** this.backoff[z], c.holdMaxS); this.quiet = 1.5;
      log("info", `Load still present in the ${ZONE_NAMES[z]} zone (zone peak ${Math.round(zoneMax)} kPa, release level ${Math.round(release)}). Keeping support at ${pct(this.probePrev)}; next re-test in ${this.holdNeed[z]} s.`);
    }
    this.go("MONITOR");
  }

  private result(events: LogEvent[], verification?: Verification): StepResult {
    return { state: this.state, setpoints: { ...this.setpoints }, risk: this.risk.slice(), events, verification };
  }
}
