// Closed-loop insole controller board: sensor scan, JSON-line link to the host, valve and pump outputs.
//
// STATUS: never compiled and never run on hardware. The logic it calls (lib/insole_core) is unit-tested on a PC; this file is only pin,
// ADC and timing glue and needs bring-up on a real board. Read firmware/README.md before powering any actuator.
#include <Arduino.h>
#include <esp_idf_version.h>
#include "esp_task_wdt.h"
#include "pins.h"
#include "insole_core.h"
#include "calibration.h"

using namespace insole;

static const uint8_t kFillPin[kZones] = {PIN_FILL1, PIN_FILL2, PIN_FILL3, PIN_FILL4};   // zone order F, M, L, H
static const uint8_t kVentPin[kZones] = {PIN_VENT1, PIN_VENT2, PIN_VENT3, PIN_VENT4};
static const uint8_t kMuxSel[4] = {PIN_MUX_S0, PIN_MUX_S1, PIN_MUX_S2, PIN_MUX_S3};

static const uint32_t kScanPeriodMs = 50;      // 20 Hz frames (requirement PR-01 asks for at least 20 Hz; the scan itself takes about 10 ms)
static const uint32_t kPumpPwmHz = 20000;
static ZoneDriver driver;
static float pressure[kSensors], temp[kTemps];
static char rx[160]; static size_t rxLen = 0;

static void outputsOff() {
  for (int z = 0; z < kZones; z++) { digitalWrite(kFillPin[z], LOW); digitalWrite(kVentPin[z], LOW); }
  digitalWrite(PIN_BUZZER, LOW);
}

static void setPump(float duty) {
  uint32_t v = (uint32_t)(duty * 255.f + 0.5f);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_PUMP_PWM, v);
#else
  ledcWrite(0, v);
#endif
}

static int readAvg(uint8_t pin, int n = 4) { long s = 0; for (int i = 0; i < n; i++) s += analogRead(pin); return (int)(s / n); }

/** Scan all muxed channels: 11 FSRs, and 6 NTCs read together on the same select lines. */
static void scan() {
  digitalWrite(PIN_MUX_EN_N, LOW);
  for (int ch = 0; ch < kSensors; ch++) {
    for (int b = 0; b < 4; b++) digitalWrite(kMuxSel[b], (ch >> b) & 1);
    delayMicroseconds(400);                                    // settling, the board notes say about 0.3 ms
    pressure[ch] = pressureKpa(ch, fsrConductanceMS(readAvg(PIN_FSR_ADC)));
    if (ch < kTemps) temp[ch] = ntcCelsius(readAvg(PIN_NTC_ADC));
  }
}

static void pollHost(float nowS) {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') { rx[rxLen] = 0; float sp[kZones]; if (rxLen && parseSetpoints(rx, sp)) driver.setTargets(sp, nowS); rxLen = 0; }
    else if (rxLen < sizeof rx - 1) rx[rxLen++] = c;
    else rxLen = 0;                                            // runaway line: drop it
  }
}

void setup() {
  // Outputs first, forced off, before anything else can go wrong. (They are also pulled low in hardware at reset.)
  for (int z = 0; z < kZones; z++) { pinMode(kFillPin[z], OUTPUT); pinMode(kVentPin[z], OUTPUT); }
  pinMode(PIN_BUZZER, OUTPUT); pinMode(PIN_LED_STATUS, OUTPUT); outputsOff();
  for (int b = 0; b < 4; b++) pinMode(kMuxSel[b], OUTPUT);
  pinMode(PIN_MUX_EN_N, OUTPUT); digitalWrite(PIN_MUX_EN_N, HIGH);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_PUMP_PWM, kPumpPwmHz, 8);
#else
  ledcSetup(0, kPumpPwmHz, 8); ledcAttachPin(PIN_PUMP_PWM, 0);
#endif
  setPump(0.f);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_FSR_ADC, ADC_11db); analogSetPinAttenuation(PIN_NTC_ADC, ADC_11db); analogSetPinAttenuation(PIN_ACT_SENSE, ADC_11db);

  // Hardware watchdog: if loop() ever stalls the chip resets, which drops every valve and the pump to their off state.
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wc = {2000, 0, true}; esp_task_wdt_reconfigure(&wc);
#else
  esp_task_wdt_init(2, true);
#endif
  esp_task_wdt_add(NULL);

  Serial.begin(115200);
  if (!kCalibrated) Serial.println("# UNCALIBRATED: pressure values are placeholders (see calibration.h)");   // not JSON: the host ignores it
  Serial.println("# insole firmware skeleton started");
}

void loop() {
  static uint32_t lastScan = 0, lastLoop = 0; uint32_t ms = millis(); float nowS = ms / 1000.f;
  float dt = (ms - lastLoop) / 1000.f; lastLoop = ms; if (dt > 0.2f) dt = 0.2f;
  esp_task_wdt_reset();

  pollHost(nowS);
  driver.setRailOk(actuatorRailV(readAvg(PIN_ACT_SENSE, 2)) >= kRailMinV);
  Outputs o = driver.step(dt, nowS);
  for (int z = 0; z < kZones; z++) { digitalWrite(kFillPin[z], o.fill[z]); digitalWrite(kVentPin[z], o.vent[z]); }
  setPump(o.pump);
  digitalWrite(PIN_BUZZER, o.fault && ((ms / 250) & 1));       // pulsing buzzer on a real fault only, quiet while merely waiting for the host
  digitalWrite(PIN_LED_STATUS, o.alarm ? ((ms / 500) & 1) : HIGH);

  if (ms - lastScan >= kScanPeriodMs) {
    lastScan = ms; scan();
    char line[256]; int n = encodeFrame(line, sizeof line, ms, pressure, temp, nullptr);   // no bladder readback yet: leak detection stays off
    if (n > 0) Serial.write((const uint8_t*)line, n);
  }
}
