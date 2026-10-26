import fs from "node:fs";

// Chromium's GPU process crashed on NVIDIA/libGLES and left an invisible window intercepting input, so NVIDIA keeps
// software rendering. Elsewhere software rendering costs about a CPU core whenever the UI animates.
export function linuxDisablesGpu({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.OMB_LINUX_GPU === "off") return true;
  if (env.OMB_LINUX_GPU === "on") return false;
  return exists("/proc/driver/nvidia/version") || exists("/sys/module/nvidia");
}
