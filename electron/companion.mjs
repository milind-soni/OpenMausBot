// The companion sidecar is the only part of the app that listens off-machine; the renderer never reaches its control port.
import { app, utilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveCompanionEntry } from "./companion-entry.mjs";
import {
  cleanupCompanionOriginEndpoint,
  companionOriginHealth,
  createCompanionOriginEndpoint,
} from "./companion-origin-gateway.mjs";
import { decodeMoveAsk } from "./move-in-ask.mjs";

export { createMoveInAsks } from "./move-in-ask.mjs";

// Must stay clear of the harness's 8799 and its webhook receiver's 8800.
const CONTROL_PORT = 8811;
const COMPANION_PORT = 8810;

let proc = null;
// New for each sidecar launch and held only by main and the sidecar, so a page served from the control port cannot drive it.
let controlToken = "";
let lastError = null;
let advertisedHostedUrl = null;
let originTarget = null;
let lifecycleListener = () => {};
let moveAskListener = () => {};
const expectedStops = new WeakSet();

const entryPoint = (resourcesPath) =>
  resolveCompanionEntry({
    isPackaged: app.isPackaged,
    resourcesPath,
    appPath: app.getAppPath(),
    exists: fs.existsSync,
  });

const settingsFile = () => path.join(app.getPath("userData"), "companion-settings.json");

function companionSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { enabled: parsed?.enabled === true, keepAwake: parsed?.keepAwake === true };
  } catch {
    return { enabled: false, keepAwake: false };
  }
}

/** Anything unreadable is "off": the flag opens a network listener, so it fails closed. */
export function companionEnabledAtRest() {
  return companionSettings().enabled;
}

export function companionKeepAwakeAtRest() {
  return companionSettings().keepAwake;
}

function rememberCompanionSettings(patch) {
  const file = settingsFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const next = { ...companionSettings(), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
    }
  }
}


export function rememberCompanionEnabled(enabled) {
  rememberCompanionSettings({ enabled });
}

export function rememberCompanionKeepAwake(keepAwake) {
  rememberCompanionSettings({ keepAwake });
}

async function control(method, urlPath, body, { timeoutMs = 4_000 } = {}) {
  const options = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-openmausbot-control-token": controlToken },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers["content-type"] = "application/json";
  }
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${urlPath}`, options);
  if (!res.ok && res.status !== 404) throw new Error(`companion control ${res.status}`);
  return res.json();
}

export function companionRunning() {
  return proc !== null;
}

/** Public state only: the connector credential never enters this module. */
export function companionAdvertisedHostedUrl() {
  return proc ? advertisedHostedUrl : null;
}

/** Main-process only: must never cross IPC into the renderer. */
export function companionOriginTarget() {
  return proc && originTarget ? { ...originTarget } : null;
}

/** The listener runs synchronously on exit and invalidates the guardian before this module removes the socket path. */
export function setCompanionLifecycleListener(listener = () => {}) {
  lifecycleListener = listener;
}

export function setCompanionMoveAskListener(listener = () => {}) {
  moveAskListener = listener;
}

// Lifecycle transitions run one at a time: every guard below is a check followed by an await.
let transition = Promise.resolve();

const serialize = (work) => {
  const next = transition.then(work, work);
  // The chain must never carry a rejection forward, or one failure poisons every later transition.
  transition = next.then(
    () => {},
    () => {},
  );
  return next;
};

/** Resolves with the panel's state; a failed start is a message, never a thrown error. */
let e2eHooks = { initialMessage: () => null, tokenRejected: () => {}, changed: () => {} };

/** The end-to-end connection's part: its configuration goes to every new sidecar over the port, a refused relay token
 * comes back the same way, and pairing changes may need the relay. */
export function setCompanionE2EHooks(hooks) {
  e2eHooks = { ...e2eHooks, ...hooks };
}

/** In-memory port only. False when no sidecar runs. */
export function postCompanionMessage(message) {
  if (!proc) return false;
  try {
    proc.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

export function startCompanion(options) {
  return serialize(() => start(options));
}

export function stopCompanion() {
  return serialize(() => stop());
}

async function start({ resourcesPath, harnessPort, mutationToken, hostedUrl = null, secretPublicKey = null, log }) {
  if (proc) return companionState();
  lastError = null;
  const resolved = entryPoint(resourcesPath);
  if (!resolved) {
    lastError = app.isPackaged
      ? "the companion is missing from this build"
      : "the companion sources are missing from this checkout";
    return companionState();
  }
  log?.(`companion fork ${resolved.entry}`);

  let allocatedOrigin;
  try {
    allocatedOrigin = createCompanionOriginEndpoint();
  } catch {
    lastError = "the private companion origin could not be created";
    return companionState();
  }
  let cleanedOrigin = false;
  const cleanupOrigin = () => {
    if (cleanedOrigin) return;
    cleanedOrigin = true;
    cleanupCompanionOriginEndpoint(allocatedOrigin);
  };

  // Never inherit an endpoint from the launch environment: main passes one only after verifying the connector.
  const childEnvironment = { ...process.env };
  delete childEnvironment.OMB_COMPANION_HOSTED_URL;
  delete childEnvironment.OMB_COMPANION_INTERNAL_ORIGIN;
  delete childEnvironment.OMB_PHONE_SECRET_PUBLIC_KEY;
  if (hostedUrl) childEnvironment.OMB_COMPANION_HOSTED_URL = hostedUrl;
  childEnvironment.OMB_COMPANION_INTERNAL_ORIGIN = allocatedOrigin.socketPath;
  if (/^[A-Za-z0-9_-]{87}$/.test(String(secretPublicKey ?? ""))) {
    childEnvironment.OMB_PHONE_SECRET_PUBLIC_KEY = secretPublicKey;
  }

  controlToken = randomBytes(32).toString("base64url");
  let child;
  try {
    child = utilityProcess.fork(resolved.entry, [], {
      env: {
        ...childEnvironment,
        OMB_PORT: String(harnessPort),
        OMB_COMPANION_PORT: String(COMPANION_PORT),
        OMB_CONTROL_PORT: String(CONTROL_PORT),
      },
      execArgv: resolved.execArgv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    cleanupOrigin();
    lastError = "the companion process could not be started";
    return companionState();
  }
  child.once("spawn", () => {
    // Never expose this capability in argv, environment, logs or the renderer.
    try {
      child.postMessage({ type: "openmausbot:companion-mutation-token", token: mutationToken, controlToken });
      const e2e = e2eHooks.initialMessage();
      if (e2e) child.postMessage(e2e);
    } catch {
      log?.("companion authorization could not be initialized");
      child.kill();
    }
  });
  child.on("message", (message) => {
    const ask = decodeMoveAsk(message);
    if (ask) moveAskListener(ask);
    if (message?.type === "openmausbot:companion-e2e-token-rejected") e2eHooks.tokenRejected();
  });
  child.stdout?.on("data", (d) => log?.(`[companion] ${String(d).trimEnd()}`));
  child.stderr?.on("data", (d) => log?.(`[companion err] ${String(d).trimEnd()}`));

  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    if (proc === child) {
      proc = null;
      advertisedHostedUrl = null;
      originTarget = null;
      lifecycleListener({
        type: "exit",
        expected: expectedStops.has(child),
        pid: child.pid,
      });
    }
    cleanupOrigin();
    log?.(`companion exited code=${code}`);
  });

  for (let i = 0; i < 40; i++) {
    if (exited) {
      lastError = "the companion could not start — check the log";
      return companionState();
    }
    try {
      const state = await control("GET", "/state");
      // A hand-started or leftover sidecar answers the port the same way: match the pid.
      if (state?.pid !== undefined && child.pid !== undefined && state.pid !== child.pid) {
        try {
          child.kill();
        } catch {
        }
        lastError = `port ${CONTROL_PORT} is already serving another companion — stop it and try again`;
        return companionState();
      }
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new Error("child pid unavailable");
      }
      const target = { pid: child.pid, socketPath: allocatedOrigin.socketPath };
      if (!(await companionOriginHealth(target))) throw new Error("private origin not ready");
      proc = child;
      advertisedHostedUrl = hostedUrl;
      originTarget = Object.freeze(target);
      return companionState();
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    child.kill();
  } catch {
  }
  lastError = "the companion did not come up in time";
  return companionState();
}

/** stopCompanion's body, run inside the transition queue. */
async function stop() {
  const child = proc;
  proc = null;
  advertisedHostedUrl = null;
  originTarget = null;
  lastError = null;
  if (!child) return companionState();
  expectedStops.add(child);
  try {
    child.kill();
  } catch {
  }
  // kill() only asks: wait, bounded, for the exit so the next start does not race the port.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    setTimeout(finish, 5_000).unref?.();
  });
  return companionState();
}

/** Callers publish only after public health verification succeeds. */
export function setCompanionHostedUrl(endpoint) {
  return serialize(async () => {
    if (!proc) return companionState();
    const state = await control("PUT", "/hosted-endpoint", { url: endpoint || null });
    advertisedHostedUrl = endpoint || null;
    return state;
  });
}

export async function companionState() {
  const keepAwake = companionKeepAwakeAtRest();
  if (!proc) {
    const state = {
      enabled: false,
      keepAwake,
      port: COMPANION_PORT,
      devices: [],
      connectedDeviceIds: [],
      pairing: null,
    };
    if (lastError) state.error = lastError;
    return state;
  }
  try {
    const state = await control("GET", "/state");
    return { enabled: true, keepAwake, ...state };
  } catch {
    return {
      enabled: true,
      keepAwake,
      port: COMPANION_PORT,
      devices: [],
      connectedDeviceIds: [],
      pairing: null,
      error: "the companion is not responding",
    };
  }
}

export async function companionRefreshTailscale() {
  if (!proc) return companionState();
  try {
    // The sidecar's Tailscale CLI hunt is bounded to 5 s; allow more here.
    const state = await control("POST", "/tailscale/refresh", undefined, { timeoutMs: 6_000 });
    return {
      enabled: true,
      keepAwake: companionKeepAwakeAtRest(),
      ...state,
    };
  } catch {
    const state = await companionState();
    return {
      ...state,
      error: state.error ?? "Tailscale could not be checked.",
    };
  }
}

/** A conditional close cannot erase a newer code created after the renderer began cancelling. */
export async function companionPairing(open, expectedToken) {
  if (!proc) return companionState();
  const conditionalClose = !open && expectedToken !== undefined;
  const candidate = String(expectedToken ?? "");
  const token = /^omb_pair_[A-Za-z0-9_-]{43}$/.test(candidate)
    ? candidate
    : "invalid-pairing-token";
  const path = conditionalClose
    ? `/pairing?expectedToken=${encodeURIComponent(token)}`
    : "/pairing";
  try {
    const state = await control(open ? "POST" : "DELETE", path);
    e2eHooks.changed();
    return {
      enabled: true,
      keepAwake: companionKeepAwakeAtRest(),
      ...state,
    };
  } catch {
    const state = await companionState();
    return {
      ...state,
      error: state.error ?? "Phone pairing could not be updated.",
    };
  }
}

export async function companionRevoke(deviceId) {
  if (!proc) return companionState();
  // the id came from the renderer, so it does not get to shape a path
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control("DELETE", `/devices/${deviceId}`).catch(() => {});
  e2eHooks.changed();
  return companionState();
}

/** A fresh code while the pairing screen stays open; the previous one keeps its last seconds. */
export async function companionPairingRenew() {
  if (!proc) return companionState();
  try {
    return { enabled: true, keepAwake: companionKeepAwakeAtRest(), ...(await control("POST", "/pairing/renew")) };
  } catch {
    return companionPairing(true);
  }
}

/** "any" or "local" (Wi-Fi and Tailscale only). */
export async function companionDeviceRoutes(deviceId, routes) {
  if (!proc) return companionState();
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? "")) || (routes !== "any" && routes !== "local")) return companionState();
  await control("PUT", `/devices/${deviceId}/routes`, { routes }).catch(() => {});
  e2eHooks.changed();
  return companionState();
}

export async function companionCloudDesktopAccess(deviceId, allowed) {
  if (!proc) return companionState();
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control(allowed ? "POST" : "DELETE", `/devices/${deviceId}/cloud-desktop`).catch(() => {});
  return companionState();
}

/** `expiresAt` names the ask the owner answered, so a yes never grants a newer one. */
export async function companionMoveAccess(deviceId, allowed, expiresAt) {
  if (!proc || !/^[\w-]{1,128}$/.test(String(deviceId ?? "")) || !Number.isFinite(expiresAt)) return;
  await control(allowed ? "POST" : "DELETE", allowed ? `/devices/${deviceId}/move?expiresAt=${expiresAt}` : `/devices/${deviceId}/move`);
}

/** Browser access is its own per-device grant, never inherited from VM access. */
export async function companionBrowserControlAccess(deviceId, allowed) {
  if (!proc) return companionState();
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control(allowed ? "POST" : "DELETE", `/devices/${deviceId}/browser-control`);
  return companionState();
}
