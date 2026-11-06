import { readFileSync } from "node:fs";

/** /proc hides other users' processes (`hidepid=invisible`, spelled `hidepid=2` before Linux 5.8). */
export function procHidepid(mounts: () => string = () => readFileSync("/proc/mounts", "utf8")): boolean {
  try { return /^proc \/proc proc [^\n]*\bhidepid=(?:2|invisible)\b/m.test(mounts()); } catch { return false; }
}
