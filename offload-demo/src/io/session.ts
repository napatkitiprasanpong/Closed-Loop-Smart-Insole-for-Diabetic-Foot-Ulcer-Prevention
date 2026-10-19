import { SENSORS } from "../core/config.ts";
import { ZONES } from "../core/types.ts";
import type { Frame, Setpoints } from "../core/types.ts";

/** Column layout of the session CSV (written by the dashboard, read back by parseCsv in replay.ts). */
export const CSV_HEAD = ["t_s", "state", ...SENSORS.map(s => "p_" + s.name), ...SENSORS.map(s => "temp_" + s.name),
  ...ZONES.map(z => "cmd_" + z), ...ZONES.map(z => "act_" + z), "peak_risk"].join(",");

export function csvRow(t: number, state: string, frame: Frame, cmd: Setpoints, act: Setpoints, peakRisk: number): string {
  const cell = (v: number, d: number) => Number.isFinite(v) ? v.toFixed(d) : "";
  return [t.toFixed(1), state, ...frame.pressure.map(v => cell(v, 1)), ...frame.temp.map(v => cell(v, 2)),
    ...ZONES.map(z => cmd[z].toFixed(2)), ...ZONES.map(z => act[z].toFixed(2)), peakRisk.toFixed(3)].join(",");
}
