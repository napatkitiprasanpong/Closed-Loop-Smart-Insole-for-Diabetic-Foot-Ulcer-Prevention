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

**Not done**
- CAD control box still shows 4 valve placeholders (board drives 8). STL and the CAD viewer need regenerating.
- Contact line in README still a placeholder.
- No firmware yet.
- Test files are not type-checked here (no `@types/node` offline); `npm run typecheck` in CI will check them.
