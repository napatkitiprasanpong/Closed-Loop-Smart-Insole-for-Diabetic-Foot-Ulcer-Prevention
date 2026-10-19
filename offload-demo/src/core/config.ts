import type { Sensor } from "./types.ts";

export const NEUTRAL = 0.5;

export const SENSORS: Sensor[] = [
  { id: 0, name: "Hallux", x: 78, y: 48, zone: "F", baseKpa: 140 },
  { id: 1, name: "Toes 2-5", x: 125, y: 68, zone: "F", baseKpa: 70 },
  { id: 2, name: "Met 1", x: 68, y: 128, zone: "F", baseKpa: 210 },
  { id: 3, name: "Met 3", x: 103, y: 120, zone: "F", baseKpa: 230 },
  { id: 4, name: "Met 5", x: 138, y: 135, zone: "F", baseKpa: 150 },
  { id: 5, name: "Medial arch", x: 60, y: 210, zone: "M", baseKpa: 90 },
  { id: 6, name: "Lateral midfoot", x: 138, y: 215, zone: "L", baseKpa: 110 },
  { id: 7, name: "Midfoot", x: 100, y: 232, zone: "L", baseKpa: 60 },
  { id: 8, name: "Heel medial", x: 82, y: 325, zone: "H", baseKpa: 200 },
  { id: 9, name: "Heel lateral", x: 122, y: 325, zone: "H", baseKpa: 190 },
  { id: 10, name: "Heel centre", x: 102, y: 365, zone: "H", baseKpa: 220 },
];

/** All values are illustrative prototype settings, not clinically validated thresholds. */
export interface ControllerConfig {
  thresholdKpa: number;   // pressure above this counts as a hotspot
  persistenceS: number;   // must stay high this long to rule out a normal gait event
  stepFirst: number;      // deflation step on first attempt
  stepRetry: number;      // smaller step on the retry
  stabilizeS: number;     // wait for pneumatics to settle
  verifyS: number;        // measure-again window (readings are averaged over this window)
  settleWindowS: number;  // readings count as settled when the mean of the last window matches the mean of the window 2 windows earlier
  settleBandKpa: number;  // largest allowed change between those two window means, at any sensor
  settleMaxS: number;     // give up waiting for the pneumatics to settle after this long and verify anyway
  reverseS: number;       // time allowed for a reversal
  maxAttempts: number;    // plans applied per episode (kept, partial or rejected)
  marginRatio: number;    // planner aims for predicted pressure below this fraction of the threshold
  improveMin: number;     // an adjustment must cut total excess pressure by at least this fraction
  moveCost: number;       // planner penalty per unit of support change (prefers small moves)
  priorOwn: number;       // starting guess: how strongly a bladder relieves its own zone
  priorTransfer: number;  // starting guess: share of removed load re-applied elsewhere
  sigmaMm: number;        // assumed spread of transferred load between sensors
  stiffGain: number;      // how much more load an inflated neighbour takes
  relaxStepMax: number;   // largest relax step when re-tests keep passing
  minSupport: number;     // hard safety limits on zone support
  maxSupport: number;
  holdS: number;          // base wait before first re-test of a held adjustment
  holdMaxS: number;       // longest wait between re-tests (the wait doubles after each failed re-test)
  probeIntervalS: number; // wait between consecutive successful re-tests on the way back to neutral
  releaseRatio: number;   // a re-test only passes if the zone peak stays below this fraction of the threshold (hysteresis)
  reliefStep: number;     // size of each re-test step back toward neutral
  wp: number; wt: number; wd: number;  // risk-score weights
  dtRef: number;          // temperature rise (°C) that counts as full temperature risk
  durRef: number;         // seconds above threshold that count as full duration risk
  // ---- safety limits (SR-04, SR-05, watchdog, leak detection). All values are prototype settings, TBD with clinician and bench data.
  maxActiveS: number;     // SR-04: longest a zone may stay away from neutral. After this the system returns to neutral and alerts (0 = off)
  watchdogS: number;      // longest allowed gap between frames; a longer gap is treated as lost data (0 = off)
  pMinKpa: number;        // SR-05: a pressure reading outside [pMinKpa, pMaxKpa] is implausible and puts the system in FAULT
  pMaxKpa: number;
  tempMinC: number;       // SR-05: a finite temperature reading outside this range is implausible
  tempMaxC: number;
  stuckS: number;         // SR-05: a sensor reading exactly the same for this long while most others keep changing is stuck (0 = off; assumes real ADC noise)
  leakBand: number;       // bladder readback this far from its setpoint (and not closing in) counts as a leak
  leakS: number;          // ... for this long (0 = off)
  alertHoldS: number;     // after an activation-time alert, the alert cannot clear for this long (lets the zones settle back to neutral first)
  leakClearS: number;     // a flagged zone is cleared again after reading within the band for this long
}

export const DEFAULT_CONFIG: ControllerConfig = {
  thresholdKpa: 400, persistenceS: 2, stepFirst: 0.35, stepRetry: 0.2,
  stabilizeS: 2.2, verifyS: 0.8, settleWindowS: 0.8, settleBandKpa: 12, settleMaxS: 20, reverseS: 1.8, maxAttempts: 3,
  marginRatio: 0.92, improveMin: 0.2, moveCost: 300, priorOwn: 0.8, priorTransfer: 0.4, sigmaMm: 45, stiffGain: 1, relaxStepMax: 0.25,
  minSupport: 0.1, maxSupport: 0.9, holdS: 6, holdMaxS: 64, probeIntervalS: 2, releaseRatio: 0.85, reliefStep: 0.1,
  wp: 0.6, wt: 0.2, wd: 0.2, dtRef: 2.5, durRef: 30,
  maxActiveS: 600, watchdogS: 1, pMinKpa: -20, pMaxKpa: 1500, tempMinC: 10, tempMaxC: 50, stuckS: 15,
  leakBand: 0.12, leakS: 6, leakClearS: 5, alertHoldS: 10,
};

/** Which pressure sensors have a temperature sensor beside them in the hardware design (6 NTCs, same order as the board). */
export const TEMP_SITES: number[] = [0, 2, 4, 6, 8, 9];
