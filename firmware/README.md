# Firmware skeleton

Firmware for the controller board in `esp32/` (ESP32-S3-WROOM-1-N8). It scans the sensors, talks to the dashboard over USB serial, and drives the valves and pump.

**Status: skeleton. `src/main.cpp` has never been compiled or run on hardware.** The portable logic in `lib/insole_core` is tested on a PC.

## What is here

| Path | What it is | Tested? |
| --- | --- | --- |
| `lib/insole_core/insole_core.h` | JSON-line protocol, FSR/NTC/rail conversions, and the valve and pump driver with its safety rules | Yes, on a PC: `make -C firmware/test/host` (101k checks including a fuzz test) |
| `test/cross_check.sh` | Checks that the C++ protocol code and the dashboard's TypeScript agree in both directions | Yes (needs g++ and Node 22+) |
| `src/main.cpp` | Pin setup, mux scan, ADC reads, serial loop, outputs, hardware watchdog | **No** |
| `src/calibration.h` | Per-channel pressure calibration | **Placeholder values** |
| `platformio.ini` | Build config (`pio run`). It pulls `pins.h` from `../esp32/` | **No** |

## Protocol

One JSON object per line, 115200 baud over the USB serial port. Full description in `offload-demo/src/io/device.ts`.

- Board to host: `{"t":ms,"p":[11 kPa],"nt":[6 deg C],"b":[F,M,L,H]}`. `null` marks a lost channel. `b` is left out because the board has no bladder pressure sensor yet, so the dashboard's leak detection stays off.
- Host to board: `{"sp":{"F":0.5,"M":0.5,"L":0.5,"H":0.2}}` (support level per zone, 0 to 1).

## Safety rules enforced on the board

These do not depend on the dashboard:

- Commands are clamped to 0.1 to 0.9. A command with any non-finite or out-of-range value is ignored as a whole.
- No valid command for 1 s drives every zone back to neutral.
- A zone's fill and vent valves are never open together, and the pump runs only while a fill valve is open.
- A valve open longer than 8 s closes and latches an alarm until the target changes. The pump runs at most 20 s in a row.
- If the actuator rail (ACT_SENSE) reads below 4 V, every output is off.
- Outputs are forced off first thing in `setup()`, pulled low in hardware at reset, and a 2 s hardware watchdog resets the chip if `loop()` stalls.

## Known gaps before this can touch a person

1. **No bladder pressure feedback.** Support is estimated by adding up valve-open time (`fillRate`, `ventRate` are placeholders). The estimate drifts, and is wrong after an E-stop or a leak. A gauge sensor per bladder is needed, and a mechanical relief valve is the only real pressure limit until then.
2. **Pressure calibration is a placeholder** (`calibration.h`). The firmware prints a warning at boot while `kCalibrated` is false.
3. **Assumptions to check on the real board:** FSR channel `i` on the mux is pressure sensor `i`; NTC channel `k` is the `k`-th site in `TEMP_SITES`; NTC beta 3950 and 10k at 25 C; mux settling 0.4 ms; the ADC is uncalibrated, so the rail threshold has a few percent error.
4. **Watchdog and PWM setup** use different APIs in different Arduino-ESP32 versions; both branches are written but untried.
5. **Pump has no pressure limit in software** and the E-stop is only observed through the rail sensor.
6. No over-the-air update, no configuration storage, no power management.

## Bring-up order

1. Build and flash with no valves or pump connected. Watch the serial output in the dashboard's device mode (Chrome or Edge) and check the 11 pressure and 6 temperature channels against known loads and a thermometer.
2. Connect one LED in place of one valve. Send setpoints from the dashboard and check the timeout, the clamp and the alarm behaviour.
3. Connect one valve, one pump and one bladder with a mechanical relief valve, and measure `fillRate` and `ventRate`.
4. Only then connect the full insole.
