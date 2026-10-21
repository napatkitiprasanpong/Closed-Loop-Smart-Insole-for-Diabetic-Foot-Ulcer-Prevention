# Changes in this round

**Repo hygiene**
- Added `.gitignore` (node_modules, dist, logs) and `.github/workflows/ci.yml` (typecheck, test, build on every push). `node_modules/` is not in this copy; remove it from git history with `git rm -r --cached offload-demo/node_modules`.
- Renamed files without spaces: `esp 32/` to `esp32/`, and the three HTML files to `control-simulation-3d.html`, `cad-viewer.html`, `requirements-and-risk-register.html`. README table updated.
- Moved the old 18-slide deck zip and an older plan-view image into `archive/` (the zip was an older deck, not a duplicate of `insole-deck/`).

**Controller safety (all new, with tests in `src/safety.test.ts`)**
- SR-04 activation-time cap, watchdog (gap check and `onNoData()`), plausibility and stuck-sensor checks (SR-05), leak detection from optional bladder readback, with leaking zones pinned to neutral in the planner.
- Simulator: zones now stop moving when they reach target (like the board's closed valves), so leaks are visible. Frames carry the bladder readback. Results for the heel, 2-hotspot, 3-hotspot and unsafe-transfer scenarios are unchanged.

**Data sources (tests in `src/io.test.ts`)**
- CSV replay of recorded sessions, shared CSV format with the dashboard export, device JSON line protocol, Web Serial link (port handling untested on hardware), data-source selector in the dashboard.

**Firmware skeleton (`firmware/`)**
- Portable core with the board's JSON line protocol, sensor conversions and a valve and pump driver with safety rules (clamp, command timeout, no fill with vent, stall and pump limits, rail-off). 101k host checks pass (`make -C firmware/test/host`). `test/cross_check.sh` confirms the C++ and dashboard protocol code agree in both directions.
- `src/main.cpp` (pins, mux scan, serial loop, hardware watchdog) is written but **never compiled or run on hardware**. Pressure calibration is a placeholder.

**CAD**
- Control box now has 8 valve placeholders (fill and vent per zone) to match the board: `insole-cad/stl/control_box_components.stl` and the model embedded in `cad-viewer.html`. The STL is still watertight (checked). I could not open the viewer in a browser here, so please look at it once.

**Walking load (new feature, with tests in `src/gait.test.ts`)**
- Found a real gap: under a walking load the controller logged "short gait event" at every stride and never acted on a 480 kPa heel overload. Added a peak-hold window (`gaitWindowS`, off by default) and a simulator walking mode (`gaitPeriodS`, `gaitStance`, `sensorTauS`), plus a "Walking load" button in the dashboard. Heel, two- and three-hotspot scenarios over five seeds resolve with no alert; a single stride is still ignored. The stride model is schematic, not measured gait.

**Deck and register**
- Deck (HTML and the 12 Figma SVGs, same text): safety slide now lists the software monitors and no longer claims a software pressure limit; test count 17 to 46; electronics, proof and roadmap footers updated. I could not render the slides here, so please look at slides 8 to 11 once.
- Requirements register v0.2: status column on the safety table (SR-04 and SR-05 marked implemented in simulation only; SR-03 marked not met today), new status rows (safety monitors, firmware, bench plan, walking load), artifacts table updated. No requirement or target changed.

**Docs**
- `docs/bench-plan.md`: six-stage plan for the first hardware tests (wiring, FSR and NTC calibration, command and safety behaviour, pneumatics, the central offloading test) and a table of where each measured number goes. Acceptance numbers in it are suggestions, not agreed values.

**Not done**
- Contact line in README still a placeholder.
- Firmware `main.cpp` not compiled; no bladder pressure feedback; calibration placeholder.
- Test files are not type-checked here (no `@types/node` offline); `npm run typecheck` in CI will check them.
