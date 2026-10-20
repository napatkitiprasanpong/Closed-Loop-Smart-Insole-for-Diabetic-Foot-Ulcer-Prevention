// Host tests for lib/insole_core. Build and run: make -C firmware/test/host
#include <cassert>
#include <cstdio>
#include <string>
#include "../../lib/insole_core/insole_core.h"
using namespace insole;

static int checks = 0;
#define CHECK(c) do { ++checks; if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); return 1; } } while (0)
static const float N6[kTemps] = {30, 31, 32, 33, 34, 35};
static const float NEUT[kZones] = {0.5f, 0.5f, 0.5f, 0.5f};

static int countOf(const std::string& s, const std::string& sub) { int n = 0; for (size_t i = s.find(sub); i != std::string::npos; i = s.find(sub, i + 1)) n++; return n; }

int main() {
  // ---- protocol: encode
  float p[kSensors]; for (int i = 0; i < kSensors; i++) p[i] = 100.f + i;
  char buf[512]; float b[kZones] = {0.5f, 0.5f, 0.5f, 0.2f};
  int n = encodeFrame(buf, sizeof buf, 2500, p, N6, b);
  CHECK(n > 0 && buf[0] == '{' && buf[n - 1] == '\n' && buf[n - 2] == '}' && (int)strlen(buf) == n);
  CHECK(std::string(buf).find("\"t\":2500,\"p\":[100.0,101.0") == 1);
  CHECK(std::string(buf).find("\"b\":[0.500,0.500,0.500,0.200]") != std::string::npos);
  CHECK(countOf(buf, "\n") == 1);
  float pn[kSensors]; memcpy(pn, p, sizeof p); pn[4] = NAN;
  n = encodeFrame(buf, sizeof buf, 1, pn, N6, nullptr);
  CHECK(n > 0 && countOf(buf, "null") == 1 && std::string(buf).find("\"b\"") == std::string::npos);
  CHECK(encodeFrame(buf, 40, 1, p, N6, b) == -1);         // buffer too small
  CHECK(encodeFrame(buf, 0, 1, p, N6, b) == -1);

  // ---- protocol: parse
  float sp[kZones] = {9, 9, 9, 9};
  CHECK(parseSetpoints("{\"sp\":{\"F\":0.5,\"M\":0.55,\"L\":0.5,\"H\":0.2}}\n", sp));
  CHECK(sp[0] == 0.5f && sp[1] == 0.55f && sp[3] == 0.2f);
  CHECK(parseSetpoints("{ \"sp\" : {\"H\":0.25,\"L\":0.5,\"M\":0.5,\"F\":0.5} }", sp) && sp[3] == 0.25f);   // any order
  float keep[kZones] = {7, 7, 7, 7}; memcpy(sp, keep, sizeof sp);
  const char* bad[] = {"", "garbage", "{\"sp\":{\"F\":0.5,\"M\":0.5,\"L\":0.5}}", "{\"sp\":{\"F\":0.5,\"M\":0.5,\"L\":0.5,\"H\":1.5}}",
                       "{\"sp\":{\"F\":0.5,\"M\":0.5,\"L\":0.5,\"H\":-0.1}}", "{\"sp\":{\"F\":0.5,\"M\":0.5,\"L\":0.5,\"H\":nan}}", "{\"sp\":{\"F\":x,\"M\":0.5,\"L\":0.5,\"H\":0.5}}"};
  for (const char* s : bad) CHECK(!parseSetpoints(s, sp));
  CHECK(memcmp(sp, keep, sizeof sp) == 0);                 // rejected lines never touch the output

  // ---- sensor conversions
  CHECK(std::fabs(ntcCelsius(2048) - 25.f) < 0.2f);       // half scale = 10k = 25 C
  CHECK(ntcCelsius(1500) > 25.f && ntcCelsius(3000) < 25.f);   // NTC on the bottom: warmer = lower resistance = fewer counts
  CHECK(std::isnan(ntcCelsius(0)) && std::isnan(ntcCelsius(4095)));
  CHECK(fsrConductanceMS(0) == 0.f && std::isnan(fsrConductanceMS(4095)));
  CHECK(fsrConductanceMS(3000) > fsrConductanceMS(1000));  // harder press, higher voltage, higher conductance
  CHECK(std::fabs(fsrConductanceMS(2048) - 0.1f) < 0.002f);// half scale = 10k = 0.1 mS
  CHECK(std::fabs(actuatorRailV(3723) - 5.0f) < 0.1f);     // 3.0 V at the pin = 5.0 V rail

  // ---- driver
  DriverConfig c; ZoneDriver d(c); float t = 0.f; const float dt = 0.05f;
  Outputs o = d.step(dt, t += dt);
  CHECK(o.alarm && !o.fault && o.pump == 0.f);             // before any command: neutral, quiet outputs, host-missing alarm
  for (int z = 0; z < kZones; z++) CHECK(!o.fill[z] && !o.vent[z]);

  float tg[kZones] = {0.5f, 0.5f, 0.5f, 0.2f};              // heel: deflate
  CHECK(d.setTargets(tg, t));
  bool sawVent = false, pumpDuringVent = false;
  for (int i = 0; i < 400; i++) { d.setTargets(tg, t); o = d.step(dt, t += dt); if (o.vent[3]) { sawVent = true; if (o.pump > 0) pumpDuringVent = true; } }
  CHECK(sawVent && !pumpDuringVent);
  CHECK(std::fabs(d.estimate(3) - 0.2f) <= c.deadband + 0.002f);
  CHECK(!o.vent[3] && !o.fill[3] && !o.alarm);             // reached target: valves closed, no alarm

  float up[kZones] = {0.5f, 0.5f, 0.5f, 0.9f}; bool pumpOn = false;
  for (int i = 0; i < 400; i++) { d.setTargets(up, t); o = d.step(dt, t += dt); if (o.fill[3]) { CHECK(o.pump == 1.f); pumpOn = true; } else CHECK(o.pump == 0.f); }
  CHECK(pumpOn); CHECK(std::fabs(d.estimate(3) - 0.9f) <= c.deadband + 0.002f);

  float wild[kZones] = {2.f, -1.f, 0.5f, 0.5f}; d.setTargets(wild, t);   // clamped, not trusted
  CHECK(d.target(0) == kMaxSupport && d.target(1) == kMinSupport);
  float nanv[kZones] = {0.3f, 0.3f, 0.3f, NAN};
  CHECK(!d.setTargets(nanv, t)); CHECK(d.target(0) == kMaxSupport);      // whole command ignored

  // command timeout: heel was left at 0.2, host goes silent
  ZoneDriver d2; t = 0.f; d2.setTargets(tg, t);
  for (int i = 0; i < 300; i++) { d2.setTargets(tg, t); d2.step(dt, t += dt); }
  CHECK(std::fabs(d2.estimate(3) - 0.2f) < 0.03f);
  float tsilent = t; bool alarmed = false;
  for (int i = 0; i < 600; i++) { o = d2.step(dt, t += dt); if (t - tsilent > c.cmdTimeoutS + 0.2f) alarmed = alarmed || o.alarm; }
  CHECK(std::fabs(d2.estimate(3) - kNeutral) <= c.deadband + 0.002f && alarmed && !o.fault);   // back to neutral, alarm on, but not a hard fault

  // rail off: every output off; alarm and fault
  ZoneDriver d3; t = 0.f; d3.setTargets(tg, t); d3.setRailOk(false);
  for (int i = 0; i < 100; i++) { d3.setTargets(tg, t); o = d3.step(dt, t += dt); for (int z = 0; z < kZones; z++) CHECK(!o.fill[z] && !o.vent[z]); CHECK(o.pump == 0.f && o.fault); }
  float e0 = d3.estimate(3); d3.step(dt, t += dt); CHECK(d3.estimate(3) == e0);

  // stall: valve open too long without reaching the target -> closes and latches; new target clears it
  DriverConfig slow; slow.ventRate = 0.001f; ZoneDriver d4(slow); t = 0.f; bool closed = false;
  for (int i = 0; i < 400; i++) { d4.setTargets(tg, t); o = d4.step(dt, t += dt); if (t > slow.maxMoveS + 0.5f && !o.vent[3]) closed = true; }
  CHECK(closed && o.fault);
  float tg2[kZones] = {0.5f, 0.5f, 0.5f, 0.45f}; d4.setTargets(tg2, t); o = d4.step(dt, t += dt); CHECK(!o.fault);

  // pump limit
  DriverConfig lim; lim.fillRate = 0.0005f; lim.maxMoveS = 100.f; lim.maxPumpOnS = 5.f; ZoneDriver d5(lim); t = 0.f; float fillT[kZones] = {0.9f, 0.5f, 0.5f, 0.5f}; bool stopped = false;
  for (int i = 0; i < 400; i++) { d5.setTargets(fillT, t); o = d5.step(dt, t += dt); if (t > 5.2f) { stopped = true; CHECK(o.pump == 0.f && !o.fill[0] && o.fault); } }
  CHECK(stopped);

  // fuzz: fill and vent never together; pump only with a fill; outputs always off when rail is off
  ZoneDriver d6; unsigned s = 12345; t = 0.f;
  auto rnd = [&]() { s = s * 1664525u + 1013904223u; return (float)(s >> 8) / 16777216.f; };
  for (int i = 0; i < 20000; i++) {
    if (i % 7 == 0) { float r[kZones]; for (int z = 0; z < kZones; z++) r[z] = rnd() * 1.4f - 0.2f; d6.setTargets(r, t); }
    d6.setRailOk(rnd() > 0.05f); o = d6.step(dt, t += dt);
    bool anyFill = false; for (int z = 0; z < kZones; z++) { CHECK(!(o.fill[z] && o.vent[z])); anyFill = anyFill || o.fill[z]; }
    CHECK(o.pump == 0.f || anyFill);
  }
  printf("OK: %d checks passed\n", checks); return 0;
}
