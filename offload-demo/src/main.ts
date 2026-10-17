import { Controller } from "./core/controller.ts";
import { SENSORS, NEUTRAL } from "./core/config.ts";
import { ZONES, ZONE_NAMES } from "./core/types.ts";
import type { Frame, LogEvent, Setpoints, Zone } from "./core/types.ts";
import { Simulator } from "./sim/simulator.ts";
import { SCENARIOS } from "./sim/scenarios.ts";
import type { ScenarioName } from "./sim/scenarios.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NS = "http://www.w3.org/2000/svg";
function mk(tag: string, attrs: Record<string, string | number>, parent: Element): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e as SVGElement;
}

// ---------- state ----------
let sim = new Simulator(1), ctl = new Controller();
const neutral = (): Setpoints => ({ F: NEUTRAL, M: NEUTRAL, L: NEUTRAL, H: NEUTRAL });
let frame: Frame = sim.step(0, ctl.setpoints);
let risk: number[] = SENSORS.map(() => 0);
let paused = false, estop = false, speed = 1, acc = 0, simT = 0;
let script: { at: number; fn: () => void }[] | null = null;
let hist: number[] = [];
let rows: string[] = [];

// ---------- foot map ----------
const foot = $("foot") as unknown as SVGSVGElement;
mk("path", { d: "M100 8C70 8 52 30 50 60C45 100 40 140 48 180C52 215 50 250 52 285C54 330 62 385 100 400C140 400 152 360 150 300C148 250 160 210 164 170C170 130 168 80 150 40C140 18 120 8 100 8Z", fill: "none", stroke: "var(--mut)", "stroke-width": 1.5 }, foot);
const ZG: Record<Zone, number[]> = { F: [102, 88, 58, 62, 198, 22], M: [62, 210, 22, 38, 2, 172], L: [125, 222, 38, 36, 198, 268], H: [102, 340, 52, 52, 198, 396] };
const zEl = {} as Record<Zone, SVGElement>, zTx = {} as Record<Zone, SVGElement>;
for (const z of ZONES) {
  const g = ZG[z];
  zEl[z] = mk("ellipse", { cx: g[0], cy: g[1], rx: g[2], ry: g[3], fill: "none", "stroke-dasharray": "4 3", stroke: "var(--mut)" }, foot);
  zTx[z] = mk("text", { x: g[4], y: g[5], "text-anchor": g[4] < 100 ? "start" : "end", "font-size": 9, fill: "var(--tx)" }, foot);
}
const blobs = SENSORS.map((s, i) => {
  const c = mk("circle", { cx: s.x, cy: s.y, r: 19, "fill-opacity": 0.8, style: "cursor:pointer" }, foot);
  const ring = mk("circle", { cx: s.x, cy: s.y, r: 21, fill: "none", stroke: "var(--bad)", "stroke-width": 2.5, opacity: 0, "pointer-events": "none" }, foot);
  const t = mk("text", { x: s.x, y: s.y + 3, "text-anchor": "middle", "font-size": 9, "font-weight": 700, fill: "#fff", "pointer-events": "none" }, foot);
  const tip = mk("title", {}, c);
  c.addEventListener("click", (e: Event) => {
    sim.load[i] = Math.max(0, sim.load[i] + ((e as MouseEvent).shiftKey ? -100 : 100));
    note(`Load at ${s.name}: +${sim.load[i]} kPa`);
  });
  return { c, ring, t, tip };
});

// ---------- panels ----------
const STATES = ["MONITOR", "CONFIRM", "ADJUST", "VERIFY", "PROBE", "REVERSE", "ALERT", "FAULT", "ESTOP"];
for (const s of STATES) { const e = document.createElement("span"); e.className = "chip"; e.id = "c" + s; e.textContent = s === "ESTOP" ? "E-stop" : s[0] + s.slice(1).toLowerCase(); $("chips").appendChild(e); }
const METRICS: [string, string][] = [["mReg", "Hotspot region"], ["mB", "Before (kPa)"], ["mA", "After (kPa)"], ["mE", "Offloading effectiveness"], ["mN", "Highest non-hotspot (kPa)"], ["mH", "Hotspots before → after"], ["mL", "Learned response"], ["mR", "Peak risk score"], ["mT", "Max skin temp rise"]];
for (const [id, label] of METRICS) { const d = document.createElement("div"); d.className = "m"; d.innerHTML = `<b id="${id}">–</b><span>${label}</span>`; $("met").appendChild(d); }

const LABELS: Record<ScenarioName, string> = { heel: "Heel hotspot", twoHotspots: "2 hotspots (heel + met-1)", threeHotspots: "3 hotspots (heel, met-1, lateral)", hallux: "Hallux hotspot", met1: "Met-1 hotspot", lateral: "Lateral hotspot", unsafeTransfer: "Unsafe-transfer case", gaitSpike: "Normal gait spike", clear: "Clear loads and faults" };
(Object.keys(LABELS) as ScenarioName[]).forEach(k => {
  const b = document.createElement("button"); b.textContent = LABELS[k];
  b.onclick = () => { SCENARIOS[k](sim); note("Scenario: " + LABELS[k]); sync(); };
  $("scen").appendChild(b);
});
SENSORS.forEach(s => $("fSensor").appendChild(new Option(s.name, String(s.id))));
ZONES.forEach(z => $("fZone").appendChild(new Option(ZONE_NAMES[z] + " zone", z)));
$("bDis").onclick = () => {
  const i = +($("fSensor") as HTMLSelectElement).value;
  if (sim.disconnected.delete(i)) note(`${SENSORS[i].name} reconnected`); else { sim.disconnected.add(i); note(`${SENSORS[i].name} disconnected`); }
};
$("bLeak").onclick = () => {
  const z = ($("fZone") as HTMLSelectElement).value as Zone;
  if (sim.leaking.delete(z)) note(`Leak stopped in ${ZONE_NAMES[z]} zone`); else { sim.leaking.add(z); note(`Leak started in ${ZONE_NAMES[z]} zone`); }
};

interface Slider { label: string; min: number; max: number; step: number; get: () => number; set: (v: number) => void }
const SLIDERS: Slider[] = [
  { label: "Hotspot threshold (kPa)", min: 200, max: 600, step: 10, get: () => ctl.cfg.thresholdKpa, set: v => ctl.cfg.thresholdKpa = v },
  { label: "Persistence check (s)", min: 0.5, max: 5, step: 0.5, get: () => ctl.cfg.persistenceS, set: v => ctl.cfg.persistenceS = v },
  { label: "Deflation step", min: 0.1, max: 0.5, step: 0.05, get: () => ctl.cfg.stepFirst, set: v => ctl.cfg.stepFirst = v },
  { label: "First re-test wait (s)", min: 3, max: 30, step: 1, get: () => ctl.cfg.holdS, set: v => ctl.cfg.holdS = v },
  { label: "Longest wait between re-tests (s)", min: 10, max: 120, step: 2, get: () => ctl.cfg.holdMaxS, set: v => ctl.cfg.holdMaxS = v },
  { label: "Release level (fraction of threshold)", min: 0.5, max: 1, step: 0.05, get: () => ctl.cfg.releaseRatio, set: v => ctl.cfg.releaseRatio = v },
  { label: "Load transfer to other zones (share)", min: 0, max: 1, step: 0.05, get: () => sim.params.transfer, set: v => sim.params.transfer = v },
  { label: "Bladder effectiveness", min: 0.3, max: 1.2, step: 0.05, get: () => sim.params.coupling, set: v => sim.params.coupling = v },
  { label: "Sensor noise (%)", min: 0, max: 10, step: 0.5, get: () => sim.params.noise * 100, set: v => sim.params.noise = v / 100 },
  { label: "Risk weight: pressure", min: 0, max: 1, step: 0.05, get: () => ctl.cfg.wp, set: v => ctl.cfg.wp = v },
  { label: "Risk weight: temperature", min: 0, max: 1, step: 0.05, get: () => ctl.cfg.wt, set: v => ctl.cfg.wt = v },
  { label: "Risk weight: duration", min: 0, max: 1, step: 0.05, get: () => ctl.cfg.wd, set: v => ctl.cfg.wd = v },
];
const sliderEls = SLIDERS.map(s => {
  const row = document.createElement("div"); row.className = "sl";
  const inp = document.createElement("input"); inp.type = "range"; inp.min = String(s.min); inp.max = String(s.max); inp.step = String(s.step);
  const val = document.createElement("b"); const lab = document.createElement("span"); lab.textContent = s.label;
  inp.oninput = () => { s.set(+inp.value); val.textContent = (+inp.value).toFixed(2).replace(/\.?0+$/, ""); };
  row.append(lab, inp, val); $("sliders").appendChild(row);
  return { s, inp, val };
});
function sync() { for (const { s, inp, val } of sliderEls) { inp.value = String(s.get()); val.textContent = s.get().toFixed(2).replace(/\.?0+$/, ""); } }

// ---------- log ----------
function addLog(e: LogEvent | { t: number; kind: string; msg: string }) {
  const d = document.createElement("div"); d.className = e.kind; d.textContent = `[${e.t.toFixed(1)}s] ${e.msg}`;
  const L = $("log"); L.appendChild(d); while (L.children.length > 300) L.removeChild(L.firstChild!); L.scrollTop = L.scrollHeight;
}
const note = (msg: string) => addLog({ t: simT, kind: "demo", msg });

// ---------- simulation loop ----------
function stepOnce(dt = 0.1) {
  simT += dt;
  while (script && script.length && script[0].at <= simT) script.shift()!.fn();
  if (script && !script.length) script = null;
  frame = sim.step(dt, estop ? neutral() : ctl.setpoints);
  if (!estop) { const r = ctl.step(frame, dt); r.events.forEach(addLog); risk = r.risk; }
  const fin = frame.pressure.filter(Number.isFinite);
  hist.push(fin.length ? Math.max(...fin) : 0); if (hist.length > 300) hist.shift();
  if (rows.length < 50000) rows.push([simT.toFixed(1), estop ? "ESTOP" : ctl.state, ...frame.pressure.map(v => v.toFixed(1)), ...frame.temp.map(v => v.toFixed(2)),
    ...ZONES.map(z => ctl.setpoints[z].toFixed(2)), ...ZONES.map(z => sim.support[z].toFixed(2)), Math.max(...risk).toFixed(3)].join(","));
}
const setM = (id: string, v: string) => { $(id).textContent = v; };
function render() {
  const st = estop ? "ESTOP" : ctl.state;
  for (const s of STATES) $("c" + s).className = "chip " + s + (s === st ? " on" : "");
  for (const z of ZONES) { zTx[z].textContent = `${ZONE_NAMES[z]} ${Math.round(sim.support[z] * 100)}%`; const low = sim.support[z] < 0.45; zEl[z].setAttribute("stroke", low ? "var(--ac)" : "var(--mut)"); zEl[z].setAttribute("stroke-width", low ? "3" : "1.5"); }
  const thr = ctl.cfg.thresholdKpa;
  blobs.forEach((b, i) => {
    const v = frame.pressure[i], ok = Number.isFinite(v);
    b.c.setAttribute("fill", ok ? `hsl(${210 - 210 * Math.min(1, v / 600)} 85% 48%)` : "#888");
    b.t.textContent = ok ? String(Math.round(v)) : "×";
    const hot = ok && v > thr; b.ring.setAttribute("opacity", hot ? "1" : "0"); b.ring.setAttribute("class", hot ? "ring" : "");
    b.tip.textContent = `${SENSORS[i].name}: ${ok ? Math.round(v) + " kPa" : "no signal"}, ${frame.temp[i].toFixed(1)} °C, risk ${risk[i].toFixed(2)}`;
  });
  const l = ctl.last;
  if (l) { setM("mReg", l.region); setM("mB", String(Math.round(l.before))); setM("mA", String(Math.round(l.after))); setM("mE", l.effectiveness.toFixed(0) + "% " + (l.outcome === "kept" ? "(kept)" : l.outcome === "partial" ? "(partial)" : "(reversed)")); setM("mN", `${Math.round(l.maxElsewhere)} ${l.maxElsewhereRegion}`); setM("mH", `${l.hotspotsBefore} → ${l.hotspotsAfter}`); }
  setM("mL", `effectiveness ${ctl.est.own.toFixed(2)}, transfer ${Math.round(ctl.est.tau * 100)}%`);
  const rk = Math.max(...risk); setM("mR", `${rk.toFixed(2)} ${SENSORS[risk.indexOf(rk)].name}`);
  setM("mT", ctl.tempBaseline ? "+" + Math.max(0, ...frame.temp.map((v, i) => v - ctl.tempBaseline![i])).toFixed(1) + " °C" : "calibrate first");
  const ty = 90 - thr / 600 * 90;
  $("ch").innerHTML = `<line x1="0" x2="300" y1="${ty}" y2="${ty}" stroke="var(--bad)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/><polyline fill="none" stroke="var(--ac)" stroke-width="2" vector-effect="non-scaling-stroke" points="${hist.map((v, i) => `${i},${90 - Math.min(90, v / 600 * 90)}`).join(" ")}"/>`;
}
setInterval(() => { if (!paused) { acc += speed; while (acc >= 1) { stepOnce(); acc -= 1; } } render(); }, 100);

// ---------- run controls ----------
function reset() {
  sim = new Simulator(1); ctl = new Controller(); frame = sim.step(0, ctl.setpoints); risk = SENSORS.map(() => 0);
  simT = 0; hist = []; rows = []; script = null; estop = false; $("log").innerHTML = ""; sync(); setM("mReg", "–"); ["mB", "mA", "mE", "mN"].forEach(id => setM(id, "–"));
}
function guided() {
  reset(); const S = SCENARIOS;
  const at = (t: number, msg: string, fn: () => void) => ({ at: t, fn: () => { note("Demo: " + msg); fn(); sync(); } });
  speed = 2; (document.getElementById("sSpeed") as HTMLSelectElement).value = "2";
  script = [
    at(1, "normal gait spike. The persistence check should ignore it", () => S.gaitSpike(sim)),
    at(5, "three hotspots at once (heel, met-1, lateral midfoot). One combined plan", () => S.threeHotspots(sim)),
    at(30, "loads cleared. Re-tests step every zone back to natural resting pressure", () => S.clear(sim)),
    at(85, "two hotspots in different zones (heel and met-1)", () => S.twoHotspots(sim)),
    at(110, "loads cleared", () => S.clear(sim)),
    at(160, "heel hotspot with strong load transfer onto a loaded lateral midfoot. Expect rejection, learning, a better plan", () => S.unsafeTransfer(sim)),
    at(195, "loads cleared", () => S.clear(sim)),
    at(200, "sensor 4 disconnected. Expect fault and neutral support", () => sim.disconnected.add(3)),
    at(204, "sensor reconnected", () => sim.disconnected.clear()),
  ];
}
$("bGuided").onclick = guided;
$("bPause").onclick = () => { paused = !paused; $("bPause").textContent = paused ? "Resume" : "Pause"; };
$("bStep").onclick = () => { if (paused) stepOnce(); };
($("sSpeed") as HTMLSelectElement).onchange = e => { speed = +(e.target as HTMLSelectElement).value; };
$("bStop").onclick = () => { estop = !estop; $("bStop").textContent = estop ? "Release E-STOP" : "E-STOP"; addLog({ t: simT, kind: estop ? "alert" : "info", msg: estop ? "E-STOP: controller bypassed, all zones driven to neutral." : "E-stop released. Controller resumed." }); };
$("bCal").onclick = () => { ctl.calibrate(frame); note("Baseline skin temperature recorded for all sites"); };
$("bReset").onclick = reset;
$("bCsv").onclick = () => {
  const head = ["t_s", "state", ...SENSORS.map(s => "p_" + s.name), ...SENSORS.map(s => "temp_" + s.name), ...ZONES.map(z => "cmd_" + z), ...ZONES.map(z => "act_" + z), "peak_risk"].join(",");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([head + "\n" + rows.join("\n")], { type: "text/csv" })); a.download = "offload-session.csv"; a.click();
};
sync(); note("Ready. Press Guided demo, or apply scenarios and change parameters.");
