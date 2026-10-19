# ESP32-S3 controller board for the closed-loop diabetic-foot insole (concept rev 0.1)

This is a schematic-level design: a netlist, drawn schematic sheets, BOM and pin map. It is **not yet a PCB layout**, and it has not been run through KiCad ERC/DRC or reviewed against every datasheet. Treat it as a design to review, then capture in KiCad.

## What it does
- **MCU:** ESP32-S3-WROOM-1-N8 (8 MB flash, no PSRAM, so IO35-IO37 stay free of PSRAM conflicts). Native USB on IO19/IO20 gives programming and a serial port the web app can use through Web Serial.
- **Sensing:** 16 FSR + 8 NTC channels through two CD74HC4067 muxes sharing select lines, MCP6002 unity-gain buffers, and ADC1 inputs (IO1, IO2). The insole needs 11 FSR + 6 NTC; the rest is spare capacity.
- **Actuation:** 9 low-side AO3400A drivers with flyback diodes: 4 fill valves, 4 vent valves, 1 pump (PWM on IO41).
- **Safety:** a normally-closed E-stop in series with the actuator rail (hardware, independent of firmware), a 2.5 A PTC, and V_ACT sensing on IO5. Gate pull-downs keep every output off at reset.
- **Power:** USB-C 5 V for logic and programming; a separate bench 5 V / battery-module input for the actuator rail. LDO to 3.3 V with a ferrite-filtered analog 3V3_A.
- **Other:** I2C header for a gauge pressure sensor, status/power LEDs, buzzer, debug UART, one expansion header.

## Files
- `esp32s3_insole_board_schematic.pdf` (5 sheets; PNG copies included), `netlist.csv` (118 parts, 91 nets), `BOM.xlsx`, `pins.h`.

## Decisions you should review
1. **Valve type.** Normally-closed fill and vent valves per zone hold pressure when de-energised. A powered vent (or the mechanical relief valve) releases it. If you want fail-to-vent, use different valves and change the driver logic.
2. **Valve count.** The board drives 8 valves (fill + vent for 4 zones). The CAD control box shows only 4 valve placeholders and needs updating.
3. **Actuator rail.** Rated 2.5 A at about 5 V, assuming the pump and valves are 5 V parts. Confirm real current draw and voltage, and check that the AO3400A and flyback diodes suit them.
4. **Analog accuracy.** The ESP32-S3 internal ADC is modest. Divider values (10k) must be tuned to the chosen FSR and NTC. For better accuracy, add an external ADC (for example ADS1115) on the I2C header.
5. **Pressure sensor.** Only an I2C header is defined. Choose a gauge sensor for the bladder pressure range.
6. **Not included yet:** reverse-polarity protection on the bench input, ESD/TVS arrays on J6, and battery charging (use an external protected battery/boost module on the bench input).

## Before ordering a PCB
- Re-create the schematic in KiCad with library symbols; confirm every IC pin number against its datasheet (ESP32-S3 pads are keyed by IO number here).
- Run ERC, then lay out following the floorplan on sheet 5. Check the antenna keep-out, USB pair routing, analog and actuator separation.
- Power-on bring-up: current-limited bench supply, check 3V3 and 3V3_A first, then USB enumeration, then the mux scan, then one valve at a time.

IO usage: IO0-2, 4-21 (not 3), 38-44. Reserved/unused: IO3, IO45, IO46 (strapping), IO26-IO32 (flash), IO35-IO37 (octal-PSRAM variants), IO47/IO48. Using an octal-PSRAM module is fine for this design; it does not use IO35-IO37.
