#!/usr/bin/env bash
set -euo pipefail

# This runs only the bundled offline thread fixture. CI creates and deletes
# its own simulators; no phone is paired and no desktop data is opened.
cd "$(dirname "$0")/../ios"

runtime_id=$(xcrun simctl list runtimes -j | python3 -c '
import json, sys
runtimes = json.load(sys.stdin)["runtimes"]
available = [r for r in runtimes if r.get("isAvailable") and r.get("identifier", "").startswith("com.apple.CoreSimulator.SimRuntime.iOS")]
if not available: raise SystemExit("No available iOS simulator runtime")
available.sort(key=lambda r: tuple(int(part) for part in r["version"].split(".")))
print(available[-1]["identifier"])
')

device_type() {
  xcrun simctl list devicetypes -j | python3 -c '
import json, sys
kind = sys.argv[1]
types = json.load(sys.stdin)["devicetypes"]
preferred = "iPhone 17 Pro" if kind == "iphone" else "iPad Pro 13-inch (M5)"
matches = [t for t in types if t["name"] == preferred]
if not matches:
    matches = [t for t in types if t["name"].startswith("iPhone") and "Pro" in t["name"]] if kind == "iphone" else [t for t in types if t["name"].startswith("iPad Pro")]
if not matches: raise SystemExit("No available " + kind + " simulator type")
print(matches[-1]["identifier"])
' "$1"
}

created_ids=()
cleanup() {
  for simulator_id in "${created_ids[@]}"; do
    xcrun simctl shutdown "$simulator_id" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator_id" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

for kind in iphone ipad; do
  simulator_id=$(xcrun simctl create "omb-ios-threads-${kind}-${GITHUB_RUN_ID}" "$(device_type "$kind")" "$runtime_id")
  created_ids+=("$simulator_id")
  xcodebuild \
    -project OpenMausCompanion.xcodeproj \
    -scheme OpenMausCompanion \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=${simulator_id}" \
    -derivedDataPath "${RUNNER_TEMP}/omb-ios-threads-build" \
    -resultBundlePath "${RUNNER_TEMP}/omb-ios-threads-${kind}.xcresult" \
    -parallel-testing-enabled NO \
    -only-testing:OpenMausCompanionUITests/ThreadNavigationUITests \
    CODE_SIGNING_ALLOWED=NO test
done
