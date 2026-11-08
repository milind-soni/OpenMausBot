// Omarchy (Arch + Hyprland) support for "This computer". Every other Wayland desktop stays blocked: only Hyprland with
// Cua's own compositor plugin gives the agent seats of its own, so the person's pointer and keyboard are never shared.
// https://cua.ai/docs/cua-sdk/guides/omarchy
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const OMARCHY_GUIDE_URL = "https://cua.ai/docs/cua-sdk/guides/omarchy";
const HYPRCTL = "/usr/bin/hyprctl";
const PACMAN = "/usr/bin/pacman";
const SYSTEM_DRIVER = "/usr/bin/cua-driver";
const SYSTEM_DRIVER_PACKAGE = "cua-driver-bin";
const PROBE_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const PLUGIN_REQUIRED_MESSAGE =
  "To use This computer on Omarchy, install and enable cua-hyprland-plugin, reload Hyprland, then try again " +
  `(Cua's Omarchy guide: ${OMARCHY_GUIDE_URL}).`;

function desktopNames(env) {
  return [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP]
    .flatMap((value) => String(value ?? "").toLowerCase().split(":"))
    .filter(Boolean);
}

/** A Hyprland session: Hyprland's own instance signature, and the desktop names it as Hyprland. */
function isHyprlandSession(env = process.env) {
  const signature = String(env.HYPRLAND_INSTANCE_SIGNATURE ?? "");
  return /^[A-Za-z0-9_.-]{1,200}$/.test(signature) && desktopNames(env).includes("hyprland");
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Read `hyprctl -j cua:status`. Active only when the input build of the plugin is loaded into this compositor (ABI
 * match), configured on, and its input transport is up. A loaded discovery-only module, a disabled plugin, a stale
 * module after a Hyprland update, or anything unreadable is not active.
 */
function parseCuaPluginStatus(stdout) {
  let status;
  try {
    status = JSON.parse(String(stdout ?? ""));
  } catch {
    return "inactive";
  }
  if (!isObject(status) || status.name !== "cua-hyprland-plugin") return "inactive";
  const input = status.input;
  const active =
    status.state === "input_v3_candidate" &&
    status.configured === true &&
    isObject(status.abi) && status.abi.match === true &&
    isObject(status.transport) && status.transport.ready === true &&
    isObject(input) && input.transport_ready === true && input.test_only !== true &&
    Number.isSafeInteger(input.protocol) && input.protocol >= 3;
  return active ? "active" : "inactive";
}

/** Run a fixed system binary with no shell, a short deadline and bounded output. */
function runBounded(command, args, { env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve({ exitCode: null, stdout: "" });
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        stdout = "";
        finish(null);
      }
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Whether Cua's Hyprland plugin is active in this session. Uses the system hyprctl only, never one from PATH. */
async function probeCuaHyprlandPlugin({ env = process.env, run = runBounded, exists = fs.existsSync } = {}) {
  if (!isHyprlandSession(env) || !exists(HYPRCTL)) return "inactive";
  const result = await run(HYPRCTL, ["-j", "cua:status"], {
    env: { ...env, LANG: "C", LC_ALL: "C" },
  });
  return result.exitCode === 0 ? parseCuaPluginStatus(result.stdout) : "inactive";
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether pacman's database says the cua-driver-bin package owns `file`. Returns that package version, or null.
 * pacman prints `/usr/bin/cua-driver is owned by cua-driver-bin 0.41.3-1`.
 */
async function systemDriverPackageVersion(file = SYSTEM_DRIVER, { run = runBounded, exists = fs.existsSync } = {}) {
  if (typeof file !== "string" || !file.startsWith("/") || !exists(PACMAN) || !exists(file)) return null;
  const result = await run(PACMAN, ["-Qo", file], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  if (result.exitCode !== 0) return null;
  const owned = new RegExp(`^${escapeRegExp(file)} is owned by ${SYSTEM_DRIVER_PACKAGE} (\\S+)$`);
  return owned.exec(String(result.stdout).trim())?.[1] ?? null;
}

module.exports = {
  HYPRCTL,
  OMARCHY_GUIDE_URL,
  PACMAN,
  PLUGIN_REQUIRED_MESSAGE,
  SYSTEM_DRIVER,
  SYSTEM_DRIVER_PACKAGE,
  isHyprlandSession,
  parseCuaPluginStatus,
  probeCuaHyprlandPlugin,
  runBounded,
  systemDriverPackageVersion,
};
