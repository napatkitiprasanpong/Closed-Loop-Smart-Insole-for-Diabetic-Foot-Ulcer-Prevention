# Bench plan: first hardware tests

Goal: replace the placeholder numbers in the firmware and simulator with measured ones, and answer the central question (does deflating one bladder lower the pressure at the target without creating a new hotspot?) on a bench rig, with no person involved.

All acceptance numbers below are **suggestions to be confirmed**. Fix them with your supervisor or a clinician before you rely on them.

## Rules for the bench

- No human foot on the insole until stage 6 is done and someone qualified has reviewed the results. Use weights, an indenter and a dummy load.
- Every bladder has a **mechanical relief valve** that opens below the bladder's burst pressure. The firmware has no software pressure limit yet.
- Start every stage with the actuators unpowered and add one thing at a time. Keep the E-stop within reach.
- Log everything: use the dashboard's device mode and **Export CSV**, one file per run, named `YYYY-MM-DD_stage_channel_run.csv`. Replaying these files through the controller (dashboard, "Load CSV replay") is part of the analysis.

## What you need

- Controller board, USB cable, a laptop with Chrome or Edge
- A few FSRs and NTCs from the real design, plus the 10k resistors the board expects
- Calibration weights or a small scale, and a rigid flat indenter of known area (so force becomes pressure)
- A reference thermometer and a cup of ice water and warm water
- One pump, one fill valve, one vent valve, one bladder, tubing, a **relief valve**, and a reference pressure gauge (this also tells you whether to buy a gauge sensor for each bladder)
- A bench supply with current limit for the actuator rail

## Stage 1: power and wiring (no actuators)

1. Check continuity and shorts on both rails before connecting USB. Confirm the 3V3 rails and, with the actuator supply on, `ACT_SENSE` at about 3.0 V for a 5 V rail (V_ACT / 0.6).
2. Flash `firmware/`. Fix whatever does not compile; this is the first time `main.cpp` is built. Check the boot messages (`# UNCALIBRATED ...` is expected).
3. Confirm outputs are low at reset and while the firmware starts (meter or LED on one fill and one vent output).
4. Open the dashboard in device mode and check that 11 pressure and 6 temperature values appear at about 20 Hz.

Pass: all channels respond, none stuck, no actuator output changes at power-up.
Verify the assumptions listed in `firmware/README.md`: mux channel `i` is pressure sensor `i`, NTC channel `k` is the k-th site in `TEMP_SITES`, mux settling is long enough (compare a reading at 0.4 ms against 2 ms after the select change).

## Stage 2: pressure sensor calibration (risk R-04)

For each of the 11 channels, on the real insole stack if possible:

1. Place the indenter on the sensor. Apply 5 to 6 loads spanning the expected range (for example 0, 25, 50, 100, 200, 400 kPa equivalent), up and then back down. Hold each for 30 s and record the last 10 s.
2. Repeat three times. Record **hysteresis** (up versus down) and **repeatability** (run to run).
3. At one mid load, hold for 5 minutes and record **drift**.
4. Fit conductance to pressure per channel (a straight line, or a power law if a line is poor). Write the results into `firmware/src/calibration.h` and set `kCalibrated = true`.

Record: gain, offset, hysteresis %, repeatability %, drift %/min. Pass criteria: to be set (the controller threshold is 400 kPa in the simulator, but that is not a clinical value).

Also check the sensor under a bladder and cover layer: calibrate through the stack, since the stack changes the response.

## Stage 3: temperature sensors

1. Ice water (about 0 °C), room, and warm water (about 35 to 40 °C) against the reference thermometer, 3 minutes each.
2. Compare readings. If the error is more than about 0.5 °C, fit beta or add a per-channel offset.
3. Check that the two heel NTCs read the same in the same water (spread between channels).

## Stage 4: command path and safety behaviour (LED instead of a valve)

Connect an LED with a series resistor to one fill output.

1. Send setpoints from the dashboard and check the LED follows. Check the clamp (send 1.0 and 0.0: the target must stay within 0.1 to 0.9).
2. Unplug USB or stop sending: within about 1 s the zones must go to neutral and the board must show the alarm.
3. Send a malformed line and a command with one zone missing: both must be ignored.
4. Pull the actuator supply (or press the E-stop): all outputs off, alarm on, and `ACT_SENSE` reads low.
5. Stall test: set `ventRate` very low in a build and confirm the valve closes after 8 s with an alarm.

Pass: every behaviour matches `firmware/README.md`.

## Stage 5: pneumatics, one zone (measure the placeholders)

Connect one pump, fill and vent valve and bladder with the relief valve and reference gauge in line.

1. **Fill rate and vent rate:** command steps between support levels (0.5 to 0.9, 0.9 to 0.5, 0.5 to 0.1, 0.1 to 0.5). Record the gauge pressure against time. Convert to support per second and set `fillRate` and `ventRate` in `DriverConfig`. Repeat 5 times and check the spread.
2. **Map support to pressure:** note the gauge pressure at support 0.1, 0.5 and 0.9. This is what "neutral" actually means physically, and it must be chosen with the relief valve setting in mind.
3. **Leak-down:** close both valves at support 0.9 and 0.1 and record the gauge for 5 minutes. This sets how fast a leak looks, and so the leak detection settings (`leakBand`, `leakS`). The firmware does not send bladder readback yet, so this test is also the argument for or against buying a gauge sensor per bladder.
4. **Estimator drift:** run 20 up and down cycles open-loop, then compare the estimate with the gauge. If the error grows beyond about 0.05 in support units, the open-loop estimate is not good enough on its own.
5. **Over-run test:** hold a fill command until the maximum time rules trip, and watch the gauge to confirm the relief valve limits the pressure.

## Stage 6: the central test (risk R-01), still on the bench

Set up a rigid plate with a pressure sensor over the bladder and sensors on either side, loaded with a weight.

1. With the load on and the bladder at neutral, record all sensors for 30 s.
2. Command deflation of the bladder under the loaded sensor. Record how far the loaded sensor falls and how much pressure moves to its neighbours.
3. Repeat with the load on a neighbour only, and with two loaded sensors.
4. Fit the **measured transfer** (how much load shifts to other sensors per unit of deflation) and compare it with the simulator's single `transfer` value. Enter the measured figure in `offload-demo/src/sim/simulator.ts`, re-run the stress test, and replay the bench CSVs through the controller to see what it would have decided.

5. **Cyclic load:** repeat step 1 and 2 with the weight lifted and replaced about once per second (a stride is roughly 1 to 1.2 s), by hand, a cam or a small actuator. Record at 20 Hz or faster. Check that the controller, with `gaitWindowS` set to about 1.5 s, treats the repeated peaks as sustained and ignores a single lift. Compare the real stance shape with the simulator's half-sine; this is what sets the window and the persistence time.

Pass: the target pressure falls with deflation, no neighbour rises above the threshold, and the simulator with measured parameters reproduces the bench within a margin you set beforehand.

## Where each result goes

| Measured | Goes into |
| --- | --- |
| Per-channel gain, offset, hysteresis | `firmware/src/calibration.h`, then `kCalibrated = true` |
| NTC error | `ntcCelsius` parameters, or a per-channel offset |
| `fillRate`, `ventRate` | `DriverConfig` in `firmware/lib/insole_core/insole_core.h` |
| Support level against gauge pressure, relief valve setting | firmware README, and the mechanical design |
| Leak-down speed | `leakBand`, `leakS` in the dashboard controller config |
| Estimator drift | the decision on a gauge sensor per bladder |
| Transfer between sensors | `transfer` in the simulator, then re-run the stress test |
| Actual sensor noise | `stuckS` and the simulator noise level |

## After the bench

Before any person uses it: clinician input on thresholds and target regions, an ethics plan, an electronics review of the board (KiCad ERC and DRC), and a plan for what happens when a sensor fails mid-use. None of that is covered here.
