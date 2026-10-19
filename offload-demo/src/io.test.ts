import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "./core/controller.ts";
import { SENSORS, NEUTRAL } from "./core/config.ts";
import { ZONES } from "./core/types.ts";
import type { Frame, LogEvent, Setpoints } from "./core/types.ts";
import { Simulator } from "./sim/simulator.ts";
import { SCENARIOS } from "./sim/scenarios.ts";
import { CSV_HEAD, csvRow } from "./io/session.ts";
import { parseCsv, ReplaySource } from "./io/replay.ts";
import { parseDeviceLine, encodeSetpoints } from "./io/device.ts";

/** Record a heel-hotspot session exactly the way the dashboard exports it. */
function record(seconds: number) {
  const sim = new Simulator(1), ctl = new Controller(); SCENARIOS.heel(sim);
  const rows: string[] = [], frames: Frame[] = []; let t = 0;
  for (let i = 0; i < seconds * 10; i++) {
    t += 0.1; const f = sim.step(0.1, ctl.setpoints); ctl.step(f, 0.1); frames.push(f);
    rows.push(csvRow(t, ctl.state, f, ctl.setpoints, sim.support, 0.5));
  }
  return { csv: CSV_HEAD + "\n" + rows.join("\n"), frames };
}

test("CSV round trip: exported session parses back to the same readings (to export precision)", () => {
  const { csv, frames } = record(10);
  const back = parseCsv(csv);
  assert.equal(back.length, frames.length);
  back.forEach((b, k) => {
    frames[k].pressure.forEach((v, i) => assert.ok(Math.abs(v - b.frame.pressure[i]) <= 0.051));
    for (const z of ZONES) assert.ok(Math.abs((frames[k].bladder as any)[z] - (b.frame.bladder as any)[z]) <= 0.0051);
  });
  assert.ok(back.every(b => Math.abs(b.dt - 0.1) < 0.011));
});

test("replay: the controller reacts to a recorded session the same way it did live", () => {
  const { csv } = record(12), ctl = new Controller(), ev: LogEvent[] = [], rp = new ReplaySource(parseCsv(csv));
  for (let r = rp.read(); r; r = rp.read()) ev.push(...ctl.step(r.frame, r.dt).events);
  assert.ok(ev.some(e => /High pressure at Heel centre/.test(e.msg)));
  assert.ok(ev.some(e => /Plan 1/.test(e.msg)));
  assert.equal(rp.progress, 1); rp.reset(); assert.equal(rp.progress, 0);
});

test("replay: a lost-sensor cell (empty) reads as NaN and the controller faults on it", () => {
  const { csv } = record(3), lines = csv.split("\n"), cols = lines[0].split(","), c = cols.indexOf("p_Midfoot");
  const cells = lines[10].split(","); cells[c] = ""; lines[10] = cells.join(",");
  const fr = parseCsv(lines.join("\n")); assert.ok(Number.isNaN(fr[9].frame.pressure[7]));
  const ctl2 = new Controller(); fr.slice(0, 10).forEach(f => ctl2.step(f.frame, f.dt)); assert.equal(ctl2.state, "FAULT");
});

test("replay: bad files give clear errors", () => {
  assert.throws(() => parseCsv("t_s\n"), /no data rows/);
  assert.throws(() => parseCsv("a,b\n1,2"), /Missing column t_s/);
  assert.throws(() => parseCsv("t_s,p_Hallux\n0,1"), /Missing column p_/);
  const { csv } = record(1), l = csv.split("\n"); l[3] = l[2];
  assert.throws(() => parseCsv(l.join("\r\n")), /time does not increase/);
});

const goodLine = (over: Record<string, unknown> = {}) => JSON.stringify({ t: 2500, p: SENSORS.map((_, i) => 100 + i), nt: [30, 31, 32, 33, 34, 35], b: [0.5, 0.5, 0.5, 0.2], ...over });

test("device protocol: a valid line becomes a frame (ms to s, 6 temps mapped to their sensor sites, bladder by zone)", () => {
  const f = parseDeviceLine(goodLine())!;
  assert.equal(f.t, 2.5); assert.equal(f.pressure.length, SENSORS.length); assert.equal(f.pressure[3], 103);
  assert.equal(f.temp[0], 30); assert.equal(f.temp[2], 31); assert.equal(f.temp[9], 35); assert.ok(Number.isNaN(f.temp[1]));
  assert.equal(f.bladder!.H, 0.2); assert.equal(f.bladder!.F, 0.5);
});

test("device protocol: null channel means lost sensor; optional fields may be absent", () => {
  const p = SENSORS.map((_, i) => 100 + i) as (number | null)[]; p[4] = null;
  const f = parseDeviceLine(JSON.stringify({ t: 10, p }))!;
  assert.ok(Number.isNaN(f.pressure[4])); assert.equal(f.bladder, undefined); assert.ok(f.temp.every(Number.isNaN));
});

test("device protocol: boot messages, truncated lines and wrong-length frames are ignored", () => {
  for (const bad of ["", "ESP-ROM:esp32s3-20210327", "{\"t\":1,\"p\":[1,2", goodLine({ p: [1, 2, 3] }), goodLine({ t: "x" }), "null", "{}"]) assert.equal(parseDeviceLine(bad), null, bad);
});

test("device protocol: setpoints encode as one JSON line, and a device frame drives the controller like any other", () => {
  const sp: Setpoints = { F: 0.5, M: 0.5, L: 0.5, H: 0.2 };
  const line = encodeSetpoints(sp); assert.ok(line.endsWith("\n")); assert.deepEqual(JSON.parse(line), { sp });
  const ctl = new Controller(); const f = parseDeviceLine(goodLine())!;
  const r = ctl.step(f, 0.05); assert.equal(r.state, "MONITOR"); for (const z of ZONES) assert.equal(ctl.setpoints[z], NEUTRAL);
});
