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
- **Plan:** search combined changes across **four bladder zones** (forefoot, medial, lateral, heel) for **1 to 3 simultaneous hotspots**, deflating under a hotspot or inflating around it.
- **Verify:** measure again. Keep the change only if no new hotspot appeared and total excess pressure fell; otherwise reverse it.
- **Learn:** every attempt, including a rejected one, refines the controller's estimate of bladder effectiveness and load transfer, so the next plan is better.
- **Adaptive re-tests:** held adjustments are relaxed in small steps with a hysteresis band and increasing waits, so the system does not cycle at the threshold and returns to natural resting pressure when the load is gone.

### Results so far (simulation only)

| Case | Hotspot pressures (kPa), before to after | Zones moved |
|---|---|---|
| 1 hotspot | Heel 480 → 350 | heel |
| 2 hotspots | Heel 480 → 351, metatarsal 460 → 358 | forefoot, heel |
| 3 hotspots | Heel 480 → 354, metatarsal 460 → 368, lateral midfoot 440 → 377 | forefoot, lateral, heel |

Threshold 400 kPa. Each case is kept in about 5 s of simulated time with no new hotspot. The pressure-transfer model is an **assumption** and must be replaced with bench measurements.

## What is in this repository

| Folder | Contents |
|---|---|
| `simulation/` | TypeScript controller, load-transfer simulator, 17 automated tests, and a web dashboard with scenarios, fault injection and CSV export |
| `cad/` | Concept CAD of the insole (5 layers, 4 bladders, sensor pockets, control box): STL parts and SVG layer outlines |
| `electronics/` | ESP32-S3 controller board design: schematic sheets (PDF), netlist, BOM, GPIO pin map |
| `presentation/` | 18-slide pitch deck as SVG slides and an animated browser presentation |
| `docs/` | Requirements, safety and risk register; materials table |

## Run the simulation

Requires Node 22.18 or newer.

```bash
cd simulation
npm install
npm run dev        # dashboard, usually http://localhost:5173
npm test           # 17 tests on the controller and simulator
npm run typecheck
npm run build      # static site in dist/
```

The dashboard lets you click sensors to add load, apply 1, 2 or 3 hotspot scenarios, inject sensor and leak faults, change thresholds and model parameters, and watch the controller states.

## Hardware design (concept)

- **Insole:** about 270 x 85 mm, 6.6 mm stack. Top cover, sensor layer, pneumatic layer with four bladders, base with air channels.
- **Controller board:** ESP32-S3-WROOM-1-N8, 16 pressure and 8 temperature channels through two analog multiplexers, 9 MOSFET drivers (4 fill valves, 4 vent valves, 1 pump), hardware E-stop, USB-C.
- **Safety by design:** E-stop cuts actuator power in hardware, valves are closed when off, pressure is limited in software and by a mechanical relief valve, a lost sensor stops adjusting.

The schematic has **not** been reviewed by an electronics engineer or built. IC pin numbers must be checked against datasheets before layout.

## Limitations

- No physical prototype and no bench or human data.
- The load-transfer behavior in the simulator is assumed.
- Differences from prior work (verified, reversible adjustments, multi-hotspot planning, learning from rejected attempts) are **proposed**. A full literature and patent search has not been done, so novelty is not claimed.
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

To be chosen. Suggested: MIT for code, CC BY 4.0 for documents and design files.

## Contact

[Your name, institution and email]
