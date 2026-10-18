# Offload demo – closed-loop diabetic-foot offloading

Software-first prototype of the controller in the project plan. No hardware needed.

## Run
Requires Node 22.18+ (runs TypeScript directly).

    npm install
    npm run dev       # opens the dashboard (usually http://localhost:5173)
    npm test          # 20 tests on the controller and simulator
    npm run typecheck
    npm run build     # static site in dist/, deployable to Vercel / GitHub Pages / Netlify

## Controller behaviour notes
- **Several hotspots at once.** The controller plans one combined move for all four zones: it searches support changes (deflate under a hotspot, or inflate around it) using a small load-transfer model, aiming to bring every hotspot under the threshold without pushing any other sensor over it.
- **Verify and learn.** After the change it waits until sensor readings settle (the mean of the last `settleWindowS` stays within `settleBandKpa` of the mean two windows earlier, with a `settleMaxS` timeout), then measures again on an averaged window. The adjustment is kept if no new hotspot appeared and total excess pressure fell by at least 20% (partial results are kept and re-planned), otherwise it is reversed. Every attempt, kept or rejected, refines two learned parameters (bladder effectiveness and the share of load transferred to other zones), so a rejected plan improves the next one.
- **Hard rules in the planner.** Support always stays within `minSupport` to `maxSupport`, and a zone that holds a hotspot is never inflated (requirement FR-05).
- **Adaptive re-tests.** A held adjustment is relaxed one step toward neutral after a wait; the step only passes if the zone peak stays below `releaseRatio` x threshold. A failed re-test is undone and the wait doubles (up to `holdMaxS`); passing steps grow, so an unloaded zone returns to natural resting pressure quickly.
- **Simulator transfer model.** Pressure removed over a deflated zone is re-applied on nearby sensors of other zones, weighted by distance and by how stiff the receiving zone is (an inflated zone carries more). A slider sets the share transferred (100% conserves total force). The controller assumes a slightly different spread than the simulator, so it has to learn.

## Structure
- `src/core/`   controller (state machine, risk score, fault handling), config, shared types. No UI or hardware code.
- `src/sim/`    simulated insole (pressure transfer between zones, noise, temperature, faults) and scenario presets.
- `src/main.ts` + `index.html`  dashboard: foot map, controls, fault injection, chart, event log, CSV export.
- `src/engine.test.ts`  behaviour tests: keep, reject + reverse + alert, gait-spike filter, sensor-loss fault, safety limits, slow pneumatics, settle timeout, and a model-mismatch sweep that checks the safety invariants.

All thresholds and weights are illustrative prototype settings, not clinically validated values.
