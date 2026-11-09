import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { linuxDisablesGpu, SOFTWARE_RENDERING_ARG } from "./linux-gpu.mjs";

const only = (...paths) => (p) => paths.includes(p);

test("NVIDIA keeps software rendering", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/proc/driver/nvidia/version") }), true);
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/sys/module/nvidia") }), true);
});

test("Intel, AMD and other drivers use the GPU", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only() }), false);
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
