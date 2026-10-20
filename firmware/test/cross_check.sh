#!/bin/sh
# Checks that the firmware's C++ protocol code and the dashboard's TypeScript agree. Needs g++ and Node 22+.
set -e
cd "$(dirname "$0")"
g++ -std=c++17 -o /tmp/cross_check cross_check.cpp
/tmp/cross_check emit > /tmp/frame.txt
cat > /tmp/xc.ts <<'EOF'
import { readFileSync } from "node:fs";
import { parseDeviceLine, encodeSetpoints } from "/ROOT/offload-demo/src/io/device.ts";
const f = parseDeviceLine(readFileSync("/tmp/frame.txt", "utf8"))!;
if (!f || f.t !== 2.5 || f.pressure[3] !== 103 || !Number.isNaN(f.pressure[4]) || f.temp[0] !== 30 || !Number.isNaN(f.temp[9]) || f.bladder!.H !== 0.2) { console.error("C++ frame NOT understood by TypeScript", f); process.exit(1); }
console.log("C++ frame -> TypeScript: OK");
process.stdout.write(encodeSetpoints({ F: 0.5, M: 0.55, L: 0.5, H: 0.2 }));
EOF
sed -i "s#/ROOT#$(cd .. && cd .. && pwd)#" /tmp/xc.ts
node /tmp/xc.ts > /tmp/xc.out
head -1 /tmp/xc.out
[ "$(tail -1 /tmp/xc.out | /tmp/cross_check parse)" = "0.500 0.550 0.500 0.200" ] && echo "TypeScript setpoints -> C++: OK"
