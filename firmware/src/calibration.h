// Per-channel pressure calibration: kPa = gain * conductance(mS) + offset.
// PLACEHOLDER VALUES. FSR response varies a lot from sensor to sensor and is not linear over a wide range, so every channel needs its own
// bench calibration with known loads on the final insole stack (risk R-04 in the requirements register). Until then the numbers sent to the
// host are only roughly "kPa-like" and the controller thresholds are meaningless on real hardware.
#pragma once
#include <cmath>
#include "insole_core.h"

constexpr bool kCalibrated = false;   // set true only after a real calibration; the firmware prints a warning at boot while it is false
static const float kGain[insole::kSensors]   = {1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000};
static const float kOffset[insole::kSensors] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

inline float pressureKpa(int channel, float conductanceMS) {
  return std::isfinite(conductanceMS) ? kGain[channel] * conductanceMS + kOffset[channel] : NAN;
}
