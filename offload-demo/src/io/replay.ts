import { SENSORS } from "../core/config.ts";
import { ZONES } from "../core/types.ts";
import type { Frame, Zone } from "../core/types.ts";

export interface TimedFrame { frame: Frame; dt: number }

const num = (s: string | undefined) => { if (s === undefined) return NaN; const t = s.trim(); return t === "" ? NaN : Number(t); };

/**
 * Parse a session CSV into frames. Reads the dashboard's own "Export CSV" file, or a log written by the device with the same
 * column names: t_s, p_<sensor name> (all 11 required), temp_<sensor name> (optional), act_<zone F/M/L/H> (optional bladder readback).
 * An empty or non-numeric pressure cell is read as a lost sensor (NaN).
 */
export function parseCsv(text: string): TimedFrame[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(l => l.trim() !== "");
  if (lines.length < 2) throw new Error("The file has no data rows.");
  const head = lines[0].split(",").map(h => h.trim()), col = (name: string) => head.indexOf(name);
  const tCol = col("t_s");
  if (tCol < 0) throw new Error("Missing column t_s.");
  const pCols = SENSORS.map(s => { const c = col("p_" + s.name); if (c < 0) throw new Error(`Missing column p_${s.name}.`); return c; });
  const tempCols = SENSORS.map(s => col("temp_" + s.name));
  const actCols = ZONES.map(z => col("act_" + z));
  const out: TimedFrame[] = []; let prev = NaN;
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(",");
    const t = num(cells[tCol]); if (!Number.isFinite(t)) throw new Error(`Row ${r + 1}: bad time value.`);
    if (Number.isFinite(prev) && t <= prev) throw new Error(`Row ${r + 1}: time does not increase (${t} after ${prev}).`);
    const frame: Frame = { t, pressure: pCols.map(c => num(cells[c])), temp: tempCols.map(c => c < 0 ? NaN : num(cells[c])) };
    if (actCols.some(c => c >= 0)) { const b: Partial<Record<Zone, number>> = {}; ZONES.forEach((z, i) => { if (actCols[i] >= 0) b[z] = num(cells[actCols[i]]); }); frame.bladder = b; }
    out.push({ frame, dt: Number.isFinite(prev) ? t - prev : NaN }); prev = t;
  }
  const first = out.length > 1 ? out[1].dt : 0.1; out[0].dt = first;   // first row has no predecessor: reuse the next gap
  return out;
}

/** Plays recorded frames back one at a time. The controller runs on them open-loop: its commands are shown but cannot change the data. */
export class ReplaySource {
  private i = 0;
  readonly frames: TimedFrame[];
  constructor(frames: TimedFrame[]) { this.frames = frames; }
  read(): TimedFrame | null { return this.i < this.frames.length ? this.frames[this.i++] : null; }
  get progress() { return this.frames.length ? this.i / this.frames.length : 1; }
  reset() { this.i = 0; }
}
