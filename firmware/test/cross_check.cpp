// Cross-language check helper. `cross_check emit` prints one frame line; `cross_check parse` reads a setpoint line on stdin and prints the parsed values.
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include "../lib/insole_core/insole_core.h"
using namespace insole;
int main(int argc, char** argv) {
  if (argc > 1 && !strcmp(argv[1], "emit")) {
    float p[kSensors], nt[kTemps] = {30, 31, 32, 33, 34, NAN}, b[kZones] = {0.5f, 0.5f, 0.5f, 0.2f}; for (int i = 0; i < kSensors; i++) p[i] = i == 4 ? NAN : 100.f + i;
    char buf[512]; encodeFrame(buf, sizeof buf, 2500, p, nt, b); fputs(buf, stdout); return 0;
  }
  std::string line; std::getline(std::cin, line); float sp[kZones];
  if (!parseSetpoints(line.c_str(), sp)) { puts("REJECTED"); return 1; }
  printf("%.3f %.3f %.3f %.3f\n", sp[0], sp[1], sp[2], sp[3]); return 0;
}
