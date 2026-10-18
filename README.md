# Closed-Loop Smart Insole for Diabetic Foot Ulcer Prevention

A concept for an insole that **senses plantar pressure and temperature, adjusts pneumatic support under the foot, measures again, and keeps or reverses the change**, to help prevent diabetic foot ulcers.

> **Status: concept stage. Everything here is simulated or designed on paper. Nothing has been built or tested on a real foot, and this is not a medical device.** Pressure values and thresholds are illustrative, not clinically validated.

---

## Why this matters

Diabetic neuropathy can hide damaging pressure from the person wearing the shoe. Published figures (see [Sources](#sources)):

| Figure | Source |
|---|---|
| 589 million adults live with diabetes worldwide (2024), 853 million expected by 2050 | IDF Diabetes Atlas, 11th edition |
| 19–34% of people with diabetes develop a foot ulcer in their lifetime | Diabetes Care review |
| About 40% of ulcers recur within a year, about 65% within five years | J Clin Med, 2022 |
| More than 80% of diabetes-related amputations are preceded by a foot ulcer | NICE guideline NG19 |
| About 50% of people who develop a foot ulcer die within five years | NICE guideline NG19 |

Most current products **warn** the wearer. This project explores **acting automatically**, with checks that stop the system from making things worse.

## How it works

```
Sense  ->  Confirm  ->  Plan  ->  Adjust  ->  Verify  ->  Keep or reverse
```

- **Sense:** 11 pressure sensors and 6 temperature sensors in a layered insole.
- **Confirm:** ignore a normal step, act only on sustained load.
- **Plan:** search combined changes across **four bladder zones** (forefoot, medial, lateral, heel) for **1 to 3 simultaneous hotspots**, deflating under a hotspot or inflating around it. A zone that contains a hotspot is never inflated.
- **Verify:** wait until the pressure readings stop drifting (up to 20 s), then average a short window and measure again. Keep the change only if no new hotspot appeared and total excess pressure fell; otherwise reverse it.
- **Learn:** every attempt, including a rejected one, refines the controller's estimate of bladder effectiveness and load transfer, so the next plan is better.
- **Adaptive re-tests:** held adjustments are relaxed in small steps with a hysteresis band and increasing waits, so the system does not cycle at the threshold and returns to natural resting pressure when the load is gone.

### Results so far (simulation only)

| Case       | Hotspot pressures (kPa), before to after                          | Zones moved             |
| ---------- | ----------------------------------------------------------------- | ----------------------- |
| 1 hotspot  | Heel 480 → 350                                                    | heel                    |
| 2 hotspots | Heel 480 → 351, metatarsal 460 → 337                              | forefoot, heel          |
| 3 hotspots | Heel 480 → 355, metatarsal 460 → 347, lateral midfoot 440 → 354   | forefoot, lateral, heel |

Threshold 400 kPa. Each case is kept after about 6 to 7 s of simulated time with no new hotspot (default simulator settings, seed 1). The pressure-transfer model is an **assumption** and must be replaced with bench measurements.

### Stress test against a simulator that disagrees with the controller

The controller assumes one load-transfer behaviour; the simulator is then changed so the assumption is wrong. 432 runs (4 scenarios x transfer 20/60/100% x spread 30/55/90 mm x coupling 0.5/0.9/1.3 x pump speed 0.05/0.25 per s x sensor noise 2/8%), 100 s each:

| Measure                                                   | Fixed 2.2 s wait (old) | Wait for pressure to settle (now) |
| --------------------------------------------------------- | ---------------------- | --------------------------------- |
| Runs fully resolved                                       | 405                    | 404                               |
| Runs ending with a new hotspot somewhere else             | 12                     | 3                                 |
| Plans *kept* while a new hotspot existed                  | 2                      | 1                                 |
| Longest time a previously cool site spent above threshold | 94 s                   | 44 s                              |
| Highest pressure reached at a previously cool site        | 666 kPa                | 557 kPa                           |

This is better, not solved: a rejected trial plan still exposes a neighbouring site above threshold for a few seconds before it is reversed, and one run still kept a plan too early. The automated tests check that the safety invariants hold on a smaller version of this grid.

## What is in this repository

| Path | Contents |
| ---- | -------- |
| `offload-demo/` | TypeScript controller, load-transfer simulator, 20 automated tests, and a web dashboard with scenarios, fault injection and CSV export |
| `insole-cad/` | Concept CAD of the insole (5 layers, 4 bladders, sensor pockets, control box): STL parts, SVG layer outlines, `parameters.json` |
| `esp 32/` | ESP32-S3 controller board design: schematic sheets (PDF and PNG), netlist, BOM, GPIO pin map (`pins.h`) |
| `insole-deck/` | 12-slide pitch deck as SVG slides (`figma-svg/`) and an animated browser presentation (`presentation.html`) |
| `Smart Diabetic-Foot Insole_ Requirements and Risk Register (draft v0.1).html` | Requirements, safety and risk register (open in a browser) |
| `Closed-Loop Insole_ Live 3D Control Simulation.html` | Stand-alone 3D control simulation (open in a browser) |
| `Smart Diabetic-Foot Insole - 3D CAD Viewer.html` | Stand-alone 3D viewer for the CAD (open in a browser) |
| `insole-materials.xlsx` | Materials table |

## Run the simulation

Requires Node 22.18 or newer.

```
cd offload-demo
npm install
npm run dev        # dashboard, usually http://localhost:5173
npm test           # 20 tests on the controller and simulator
npm run typecheck
npm run build      # static site in dist/
```

The dashboard lets you click sensors to add load, apply 1, 2 or 3 hotspot scenarios, inject sensor and leak faults, change thresholds and model parameters, and watch the controller states. GitHub Actions runs the typecheck, tests and build on every push.

## Hardware design (concept)

- **Insole:** about 270 x 85 mm, 6.6 mm stack. Top cover, sensor layer, pneumatic layer with four bladders, base with air channels.
- **Controller board:** ESP32-S3-WROOM-1-N8, 16 pressure and 8 temperature channels through two analog multiplexers, 9 MOSFET drivers (4 fill valves, 4 vent valves, 1 pump), hardware E-stop, USB-C.
- **Safety by design:** E-stop cuts actuator power in hardware, valves are closed when off, pressure is limited in software and by a mechanical relief valve, a lost sensor stops adjusting.

The schematic has **not** been reviewed by an electronics engineer or built. IC pin numbers must be checked against datasheets before layout.

## Limitations

- No physical prototype and no bench or human data.
- The load-transfer behavior in the simulator is assumed.
- Differences from prior work (verified, reversible adjustments, multi-hotspot planning, learning from rejected attempts) are **proposed**. A full literature and patent search has not been done, so novelty is not claimed.
- The controller only sees the pressure sensors. It cannot see how far a bladder has actually moved, so it infers "settled" from the readings. A gauge pressure sensor per bladder (the board has an I2C header for one) would be a more direct check.
- The control box in the CAD shows 4 valve placeholders, but the board drives 8 valves (fill and vent for each zone). One of the two needs updating.
- Not for clinical use. Any use on people needs ethics approval and clinical oversight.

## Roadmap

1. **Month 1, sense:** every sensor measured and shown live.
2. **Month 2, close the loop:** detect a hotspot, adjust, and verify automatically.
3. **Month 3, prove it:** bench validation, 1,000+ inflate and deflate cycles, safety review.

Next steps: clinician input and ethics plan, a small first hardware kit (one sensor, one pump and valve, one bladder), and a proper prior-art search.

## Related work

Alert-only products include the Orpyx insole, the Podimetrics SmartMat and Siren socks. Closed-loop pneumatic offloading has been shown in research (for example the 2025 portable insole system in *Sensors* and work by Hemler et al.). This project builds on that foundation.

## Sources

- IDF Diabetes Atlas, 11th edition: https://idf.org/news-and-resources/news/idf-diabetes-atlas-11th-edition/
- Etiology and epidemiology of diabetic foot ulcers: https://pmc.ncbi.nlm.nih.gov/articles/PMC9797649
- Diabetic Capital Punishment: Time for Amnesty (J Clin Med, 2022): https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9656903/
- NICE guideline NG19, diabetic foot problems: https://www.nice.org.uk/guidance/NG19/chapter/context
- Portable insole system for active offloading (Sensors, 2025): https://www.mdpi.com/1424-8220/25/12/3820
- Intelligent plantar pressure offloading (Hemler et al.): https://pmc.ncbi.nlm.nih.gov/articles/PMC10352841
- Orpyx: https://www.orpyx.com/dfu-prevention

## License

MIT (see `LICENSE`). Change it if you prefer something else, for example CC BY 4.0 for the documents and design files.

## Contact

[Your name, institution and email]
