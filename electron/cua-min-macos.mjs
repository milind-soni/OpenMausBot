// The pinned @trycua/cua-driver 0.45.4 SDK declares minos 13.0 but links
// ScreenCaptureKit strongly and names SCScreenshotManager (macOS 14) and
// SCRecordingOutput (macOS 15), so dyld cannot load it below 15.
import os from "node:os";

export const CUA_MIN_MACOS = 15;

// Upstream publishes no macOS 12 build, so 12.3 through 14.x run the in-tree
// cua-driver-mac12 helper instead. Darwin 21 is macOS 12, 22 is 13, 23 is 14.
export const LEGACY_MIN_MACOS = 12.3;

export function macDriverKind(osRelease = os.release()) {
  const [major, minor = 0] = osRelease.split(".").map(Number);
  if (major >= 24) return "cua";
  if (major > 21 || (major === 21 && minor >= 4)) return "legacy";
  return "unsupported";
}
