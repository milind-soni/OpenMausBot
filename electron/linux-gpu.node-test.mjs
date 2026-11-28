import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { disableWaylandColorManager, linuxDisablesGpu, SOFTWARE_RENDERING_ARG } from "./linux-gpu.mjs";

const only = (...paths) => (p) => paths.includes(p);

test("NVIDIA keeps software rendering", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/proc/driver/nvidia/version") }), true);
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/sys/module/nvidia") }), true);
});

test("Intel, AMD and other drivers use the GPU on X11", () => {
  assert.equal(linuxDisablesGpu({ env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, exists: only() }), false);
});

test("Intel iGPU on Wayland disables GPU (avoids Vulkan crash)", () => {
  const device = "/sys/bus/pci/devices/0000:00:02.0";
  const exists = only(device);
  const readFile = (p) => p === device + "/vendor" ? "0x8086" : "1";
  assert.equal(linuxDisablesGpu({ env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, exists, readFile }), true);
  // Also triggered by WAYLAND_DISPLAY alone
  assert.equal(linuxDisablesGpu({ env: { WAYLAND_DISPLAY: "wayland-0" }, exists, readFile }), true);
});

test("a discrete Intel adapter or secondary integrated adapter does not disable acceleration", () => {
  const env = { XDG_SESSION_TYPE: "wayland" };
  assert.equal(linuxDisablesGpu({ env, exists: only("/sys/bus/pci/devices/0000:03:00.0"), readFile: () => "0x8086" }), false);
  assert.equal(linuxDisablesGpu({ env, exists: only("/sys/bus/pci/devices/0000:00:02.0"), readFile: (p) => p.endsWith("/vendor") ? "0x8086" : "0" }), false);
});
test("AMD on Wayland uses the GPU", () => {
  const exists = only("/sys/bus/pci/devices/0000:00:02.0");
  const readFile = (p) => p === "/sys/bus/pci/devices/0000:00:02.0/vendor" ? "0x1002" : "";
  assert.equal(linuxDisablesGpu({ env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, exists, readFile }), false);
});

test("Intel on X11 uses the GPU", () => {
  const exists = only("/sys/bus/pci/devices/0000:00:02.0");
  const readFile = (p) => p === "/sys/bus/pci/devices/0000:00:02.0/vendor" ? "0x8086" : "";
  assert.equal(linuxDisablesGpu({ env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, exists, readFile }), false);
});

test("OMB_LINUX_GPU overrides detection either way", () => {
  assert.equal(linuxDisablesGpu({ env: { OMB_LINUX_GPU: "off" }, exists: only() }), true);
  assert.equal(linuxDisablesGpu({ env: { OMB_LINUX_GPU: "on" }, exists: only("/sys/module/nvidia") }), false);
});

test("the main window tells its page when it renders without a GPU, so pop-ups drop their blur", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(main, /linuxSoftwareRendering \? \[SOFTWARE_RENDERING_ARG\] : \[\]/);
  assert.equal(SOFTWARE_RENDERING_ARG, "--omb-software-rendering=1");
  assert.match(preload, /softwareRendering: process\.argv\.includes\("--omb-software-rendering=1"\)/);
  assert.match(main, /linuxDisablesGpu\(\) \|\| app\.commandLine\.hasSwitch\("disable-gpu"\)/);
  // My Cloud's page is remote: it needs the flag too.
  assert.match(preload, /const REMOTE_SAFE = new Set\(\[[^\]]*"softwareRendering"/);
});

test("the Wayland color manager is disabled and an existing disable-features list is kept", () => {
  const run = (existing) => {
    const switches = new Map();
    disableWaylandColorManager({ getSwitchValue: () => existing, appendSwitch: (name, value) => switches.set(name, value) });
    return switches.get("disable-features");
  };
  assert.equal(run(""), "WaylandWpColorManagerV1");
  assert.equal(run("Foo,Bar"), "Foo,Bar,WaylandWpColorManagerV1");
});
