import fs from "node:fs";

// Chromium's GPU process crashed on NVIDIA/libGLES and left an invisible window intercepting input, so NVIDIA keeps
// software rendering. Elsewhere software rendering costs about a CPU core whenever the UI animates.
// Intel iGPU on Wayland also crashes: Vulkan is enabled but wayland_surface_factory rejects it.
export function linuxDisablesGpu({ env = process.env, exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  if (env.OMB_LINUX_GPU === "off") return true;
  if (env.OMB_LINUX_GPU === "on") return false;
  if (exists("/proc/driver/nvidia/version") || exists("/sys/module/nvidia")) return true;
  // Intel iGPU on Wayland: GPU process crashes with "wayland_surface_factory.cc: 'is not compatible with Vulkan'".
  if (isWayland(env) && isIntelIgpu(exists, readFile)) return true;
  return false;
}

function isWayland(env) {
  return String(env.XDG_SESSION_TYPE ?? "").toLowerCase() === "wayland" || !!env.WAYLAND_DISPLAY;
}

function isIntelIgpu(exists, readFile) {
  const device = "/sys/bus/pci/devices/0000:00:02.0";
  if (!exists(device)) return false;
  try {
    return readFile(`${device}/vendor`, "utf8").trim() === "0x8086" &&
      readFile(`${device}/boot_vga`, "utf8").trim() === "1";
  } catch {
    return false;
  }
}

// The main window's page is told so its glass pop-ups drop the backdrop blur, which is redrawn on the CPU here.
export const SOFTWARE_RENDERING_ARG = "--omb-software-rendering=1";

// Chromium in Electron 43 binds KWin's wp_color_manager_v1 and logs "Unable to set image transfer function" on Plasma 6 Wayland.
export function disableWaylandColorManager(commandLine) {
  const disabled = commandLine.getSwitchValue("disable-features");
  commandLine.appendSwitch("disable-features", [disabled, "WaylandWpColorManagerV1"].filter(Boolean).join(","));
}
