// Portable core of the insole firmware: no Arduino or ESP-IDF includes, so it can be unit-tested on a PC.
// Everything hardware-specific lives in src/main.cpp.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace insole {

constexpr int kSensors = 11;   // pressure channels, same order as SENSORS in offload-demo/src/core/config.ts
constexpr int kTemps = 6;      // NTC channels, same order as TEMP_SITES (Hallux, Met 1, Met 5, Lateral midfoot, Heel medial, Heel lateral)
constexpr int kZones = 4;      // F, M, L, H
constexpr float kNeutral = 0.5f, kMinSupport = 0.1f, kMaxSupport = 0.9f;   // same limits as the dashboard controller
static const char kZoneLetter[kZones] = {'F', 'M', 'L', 'H'};

// ---------- line protocol (see offload-demo/src/io/device.ts) ----------

namespace detail {
struct Writer {
  char* buf; size_t n; size_t k = 0; bool ok = true;
  void raw(const char* s) { size_t l = strlen(s); if (!ok || k + l >= n) { ok = false; return; } memcpy(buf + k, s, l); k += l; buf[k] = 0; }
  void num(float v, int d) { if (!std::isfinite(v)) { raw("null"); return; } char t[24]; snprintf(t, sizeof t, "%.*f", d, v); raw(t); }
  void uns(uint32_t v) { char t[16]; snprintf(t, sizeof t, "%lu", (unsigned long)v); raw(t); }
};
}  // namespace detail

/** One frame as a JSON line. NaN channels are written as null. `bladder` may be null (no readback: the "b" field is left out).
 *  Returns the length written (including the newline), or -1 if the buffer is too small. */
inline int encodeFrame(char* buf, size_t n, uint32_t tMs, const float p[kSensors], const float nt[kTemps], const float* bladder) {
  detail::Writer w{buf, n};
  if (n) buf[0] = 0;
  w.raw("{\"t\":"); w.uns(tMs); w.raw(",\"p\":[");
  for (int i = 0; i < kSensors; i++) { if (i) w.raw(","); w.num(p[i], 1); }
  w.raw("],\"nt\":[");
  for (int i = 0; i < kTemps; i++) { if (i) w.raw(","); w.num(nt[i], 2); }
  w.raw("]");
  if (bladder) { w.raw(",\"b\":["); for (int i = 0; i < kZones; i++) { if (i) w.raw(","); w.num(bladder[i], 3); } w.raw("]"); }
  w.raw("}\n");
  return w.ok ? (int)w.k : -1;
}

/** Parse {"sp":{"F":0.5,"M":0.5,"L":0.5,"H":0.2}}. All four zones must be present, finite and within 0 to 1; otherwise returns false and out is untouched. */
inline bool parseSetpoints(const char* line, float out[kZones]) {
  const char* sp = strstr(line, "\"sp\""); if (!sp) return false;
  float v[kZones];
  for (int z = 0; z < kZones; z++) {
    char key[5] = {'"', kZoneLetter[z], '"', ':', 0};
    const char* q = strstr(sp, key); if (!q) return false;
    char* end = nullptr; v[z] = strtof(q + 4, &end);
    if (end == q + 4 || !std::isfinite(v[z]) || v[z] < 0.f || v[z] > 1.f) return false;
  }
  for (int z = 0; z < kZones; z++) out[z] = v[z];
  return true;
}

// ---------- sensor conversions (board dividers: see esp32/netlist.csv) ----------

/** NTC on the bottom of a 10k divider from 3V3_A (RN0..RN7 on top). Beta model. NaN if the channel looks open or shorted. */
inline float ntcCelsius(int counts, int adcMax = 4095, float beta = 3950.f, float r0 = 10000.f, float t0C = 25.f) {
  float x = (float)counts / (float)adcMax;
  if (x < 0.01f || x > 0.99f) return NAN;
  float r = 10000.f * x / (1.f - x);
  return 1.f / (1.f / (t0C + 273.15f) + std::log(r / r0) / beta) - 273.15f;
}

/** FSR on top, 10k pull-down (RF0..RF15) to ground. Returns conductance in millisiemens (roughly proportional to force).
 *  No touch reads as zero; a saturated reading is NaN (shorted or faulty). */
inline float fsrConductanceMS(int counts, int adcMax = 4095) {
  float x = (float)counts / (float)adcMax;
  if (x < 0.002f) return 0.f;
  if (x > 0.995f) return NAN;
  float rKohm = 10.f * (1.f - x) / x;
  return 1.f / rKohm;
}

/** Actuator rail voltage from ACT_SENSE (10k/15k divider, so V_ACT = pin voltage / 0.6). The internal ADC is uncalibrated: expect a few percent error. */
inline float actuatorRailV(int counts, int adcMax = 4095, float vref = 3.3f) { return (float)counts / (float)adcMax * vref / 0.6f; }
constexpr float kRailMinV = 4.0f;   // below this the actuator rail is considered off (E-stop pressed or supply lost)

// ---------- valve and pump driver ----------

struct DriverConfig {
  float fillRate = 0.10f;      // estimated support gained per second with a fill valve open and the pump on. PLACEHOLDER: measure on the bench
  float ventRate = 0.12f;      // estimated support lost per second with a vent valve open. PLACEHOLDER
  float deadband = 0.02f;      // valves close within this distance of the target
  float maxMoveS = 8.f;        // longest a valve may stay open for one move; then it closes and an alarm is raised (stall or leak)
  float cmdTimeoutS = 1.f;     // no valid command for this long: every zone is driven to neutral
  float maxPumpOnS = 20.f;     // longest continuous pump run
};

struct Outputs { bool fill[kZones]; bool vent[kZones]; float pump; bool alarm; bool fault; };   // alarm = fault or no recent command; fault = a real problem (stall, pump limit, rail off)

/**
 * Open-loop zone driver. There is no per-zone bladder pressure sensor yet, so the support level of each zone is ESTIMATED by integrating valve
 * open time. That estimate drifts, and it is wrong after an E-stop or a leak. A gauge sensor per bladder should replace it (then also send
 * the "b" field so the host can detect leaks). Safety rules enforced here, independent of the host:
 *   - commands are clamped to [kMinSupport, kMaxSupport]; a command with a non-finite value is ignored as a whole
 *   - no valid command within cmdTimeoutS drives every zone to neutral
 *   - a zone's fill and vent valves are never open together; the pump runs only while a fill valve is open
 *   - a valve open longer than maxMoveS closes and latches an alarm until the target changes
 *   - pump runs at most maxPumpOnS in a row, then stops and latches an alarm until no fill is requested
 *   - if the actuator rail is off, every output is off
 */
class ZoneDriver {
 public:
  explicit ZoneDriver(DriverConfig c = DriverConfig()) : cfg_(c) { for (int z = 0; z < kZones; z++) { est_[z] = kNeutral; tgt_[z] = kNeutral; } }

  /** Accept new targets. Returns false (and changes nothing) if any value is not finite. */
  bool setTargets(const float t[kZones], float nowS) {
    for (int z = 0; z < kZones; z++) if (!std::isfinite(t[z])) return false;
    for (int z = 0; z < kZones; z++) {
      float v = t[z] < kMinSupport ? kMinSupport : (t[z] > kMaxSupport ? kMaxSupport : t[z]);
      if (std::fabs(v - tgt_[z]) > 1e-6f) { moveT_[z] = 0; moveFault_[z] = false; }
      tgt_[z] = v;
    }
    lastCmdS_ = nowS; haveCmd_ = true; return true;
  }
  void setRailOk(bool ok) { railOk_ = ok; }

  Outputs step(float dt, float nowS) {
    Outputs o{}; o.pump = 0.f;
    const bool timedOut = !haveCmd_ || (nowS - lastCmdS_) > cfg_.cmdTimeoutS;
    timedOut_ = timedOut;
    bool anyFill = false;
    for (int z = 0; z < kZones; z++) {
      float target = timedOut ? kNeutral : tgt_[z];
      float err = target - est_[z];
      if (!railOk_) continue;                                   // no actuator power: nothing moves, estimate frozen
      if (std::fabs(err) <= cfg_.deadband) { moveT_[z] = 0; continue; }
      if (moveFault_[z]) continue;
      moveT_[z] += dt;
      if (moveT_[z] > cfg_.maxMoveS) { moveFault_[z] = true; continue; }
      if (err > 0) { o.fill[z] = true; anyFill = true; est_[z] += cfg_.fillRate * dt; }
      else { o.vent[z] = true; est_[z] -= cfg_.ventRate * dt; }
      est_[z] = est_[z] < 0.f ? 0.f : (est_[z] > 1.f ? 1.f : est_[z]);
    }
    if (!anyFill) { pumpOnS_ = 0.f; pumpFault_ = false; }
    else if (!pumpFault_) { pumpOnS_ += dt; if (pumpOnS_ > cfg_.maxPumpOnS) pumpFault_ = true; }
    if (anyFill && !pumpFault_) o.pump = 1.f;
    if (pumpFault_) for (int z = 0; z < kZones; z++) o.fill[z] = false;   // no pump, so filling stops too
    bool mf = false; for (int z = 0; z < kZones; z++) mf = mf || moveFault_[z];
    o.fault = mf || pumpFault_ || !railOk_;
    o.alarm = o.fault || timedOut;
    return o;
  }
  float estimate(int z) const { return est_[z]; }
  float target(int z) const { return tgt_[z]; }
  bool timedOut() const { return timedOut_; }

 private:
  DriverConfig cfg_;
  float est_[kZones], tgt_[kZones], moveT_[kZones] = {0, 0, 0, 0}; bool moveFault_[kZones] = {false, false, false, false};
  float lastCmdS_ = 0.f, pumpOnS_ = 0.f; bool haveCmd_ = false, railOk_ = true, timedOut_ = true, pumpFault_ = false;
};

}  // namespace insole
