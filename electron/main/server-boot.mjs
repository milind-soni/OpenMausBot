// Extracted from electron/main.mjs: the packaged server boot subsystem,
// verbatim — the utility-server child fork and identity probe, the
// two-pass port-fallback boot, the desktop mutation-token header, the
// phone-secret key sync and private save routing, and the managed-composio
// credential sync. Server runtime state (SERVER_PORT/serverProc/serverReady)
// lives in server-runtime.mjs and is mutated through its imported setters.
// The bindings this region only borrows — the supervisor, the
// trusted-approval coordinator, the data-dir lease, the conflict flag and
// the saveWorkspaceCredential function — are created by main.mjs top-level
// code that runs after this module evaluates, so they cross the boundary
// through the wiring-time deps below (the environments.mjs
// wireEnvironmentsDeps pattern). serverStartConflictOnly stays in main.mjs:
// both this module (startServerPackaged) and main.mjs (the supervisor's
// onReady recovery callback) assign it, so main.mjs keeps the binding and
// passes a setter here.

import { app, session, utilityProcess } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import {
  managedComposioAccess,
  managedComposioChildEnvironment,
} from "../managed-composio.mjs";
import {
  createPhoneSecretSaveCoordinator,
  decodePhoneSecretSaveRequest,
  phoneSecretPrivateKeyMessage,
} from "../phone-secret-identity.mjs";
import { pollServerIdentity } from "../server-boot-probe.mjs";
import { workspaceCredentialEnv } from "../workspace-credentials.mjs";
import { phoneSecretIdentity } from "./companion-connection.mjs";
import {
  desktopMutationToken,
  desktopShutdownStarted,
  managedDesktopRelay,
  syncDesktopMutationToken,
} from "./company-backup.mjs";
import { slog } from "./crash-log.mjs";
import {
  composioBrokerUrl,
  credentialStoreUnavailable,
  desktopDataDir,
  secureCredentials,
} from "./secure-config.mjs";
import {
  SERVER_PORT,
  serverProc,
  serverReady,
  setServerPort,
  stopUtilityServer,
  utilityServerExits,
} from "./server-runtime.mjs";

const require = createRequire(import.meta.url);
const { DESKTOP_MUTATION_HEADER } = require("../desktop-server-auth.cjs");

// Live reads into main.mjs's module state; wired once by main.mjs at module
// load. Value deps are zero-arg getters (the environments.mjs convention);
// saveWorkspaceCredential is a hoisted function declaration in main.mjs and
// is stored as the function itself. The defaults would only ever apply if a
// call somehow preceded the wiring.
const deps = {
  setServerStartConflictOnly: () => {},
  desktopDataDirLease: () => null,
  serverSupervisor: () => null,
  trustedApprovalMode: () => null,
  saveWorkspaceCredential: async () => {
    throw new Error("server boot deps are not wired");
  },
};

export function wireServerBootDeps(reads) {
  Object.assign(deps, reads);
}

/** Run one private cleanup request at most once and acknowledge only after
 * Chromium confirms its session data is gone. Duplicate retries join the
 * same promise; a retry whose success ACK was lost receives a cached ACK. */

function syncPhoneSecretKey(proc) {
  const message = phoneSecretPrivateKeyMessage(phoneSecretIdentity);
  if (!message) return;
  try {
    proc.postMessage(message);
  } catch (error) {
    slog(`phone credential key sync failed: ${error?.message ?? error}`);
  }
}

function installDesktopMutationHeader() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    let ownsTarget = false;
    try {
      const target = new URL(details.url);
      ownsTarget = serverReady && target.protocol === "http:" &&
        target.hostname === "127.0.0.1" &&
        Number(target.port || 80) === SERVER_PORT;
    } catch {}
    if (!ownsTarget) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        [DESKTOP_MUTATION_HEADER]: desktopMutationToken,
      },
    });
  });
}

const savePhoneSecretOnce = createPhoneSecretSaveCoordinator((target, value) =>
  deps.saveWorkspaceCredential(target, value),
);

function receivePhoneSecretSave(proc, rawMessage) {
  const request = decodePhoneSecretSaveRequest(rawMessage);
  if (!request) return false;
  void savePhoneSecretOnce(request).then((result) => {
    try {
      proc.postMessage(result);
    } catch (error) {
      slog(`phone credential save result failed: ${error?.message ?? error}`);
    }
  });
  return true;
}

async function startServerOn(port) {
  if (desktopShutdownStarted) return { proc: null, abort: true };
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const childEnv = managedComposioChildEnvironment(composioBrokerUrl(), secureCredentials, {
    ...process.env,
    // The desktop parent owns the durable data-directory lease. Each utility
    // server gets only a private capability that validates that same live
    // owner; fallback-port children must not race to replace the parent lease.
    ...deps.desktopDataDirLease().utilityServerLeaseEnvironment(),
    OMB_DATA_DIR: desktopDataDir(),
    // A packaged utility child must never fall back to a descriptor inherited
    // from the launching shell. It starts fail-closed until this exact main
    // process sends the private in-memory connection after spawn.
    OMB_DESKTOP_PARENT: "1",
    OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
    OMB_RESOURCES_PATH: process.resourcesPath,
    OMB_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
    OMB_PORT: String(port),
    // the server advertises this to remote clients so version skew is visible
    OMB_APP_VERSION: app.getVersion(),
    OMB_USER_DATA: app.getPath("userData"),
    ...(secureCredentials.composioApiKey
      ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
      : {}),
    // "we could not read your keys" must not reach the UI as "you have none"
    OMB_CREDENTIAL_STORE: credentialStoreUnavailable ? "unavailable" : "ok",
    // one env var per stored workspace secret (xai/box/voice/OpenCode Go);
    // the server prefers these over config.json, whose plaintext fields
    // the boot migration has deleted
    ...workspaceCredentialEnv(secureCredentials),
  });
  delete childEnv.OMB_BROWSER_CONNECTION;
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveServerExit;
  utilityServerExits.set(proc, new Promise((resolve) => {
    resolveServerExit = resolve;
  }));
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.on("message", (message) => {
    if (!deps.serverSupervisor().isCurrent(proc)) return;
    try {
      if (deps.trustedApprovalMode().receive(proc, message)) return;
      if (managedDesktopRelay.receive(proc, message)) return;
      if (receivePhoneSecretSave(proc, message)) return;
    } catch (error) {
      slog(`desktop private sync rejected: ${error?.message ?? error}`);
    }
  });
  proc.once("spawn", () => {
    slog(`spawned pid=${proc.pid}`);
    if (!deps.serverSupervisor().isCurrent(proc)) return;
    syncDesktopMutationToken(proc);
    syncPhoneSecretKey(proc);
  });
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    deps.trustedApprovalMode().rejectProcess(proc);
    managedDesktopRelay.rejectProcess(proc);
    resolveServerExit();
    slog(`exited code=${code}`);
  });
  deps.serverSupervisor().watch(proc);
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  // The budget is wall-clock, not a fixed poll count: a healthy boot can take
  // well past 20s on cold machines or when pre-listen network calls stall
  // (issue #506), and reaping an about-to-listen child reads to the user as
  // "something else is using its ports" even though nothing was on them.
  // The probe itself is deadline-bounded (a hung health endpoint cannot wedge
  // us here forever) and reports WHY it gave up, so the error page can tell
  // port conflict apart from slow startup.
  const identity = await pollServerIdentity({
    port,
    // Getter, not value: proc.pid stays undefined until the async `spawn`
    // event fires, and capturing it here would make the probe judge our own
    // child a "foreign owner" on its first health answer.
    pid: () => proc.pid,
    bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
    isExited: () => exited || desktopShutdownStarted,
  });
  if (identity.outcome === "ready" && deps.serverSupervisor().isCurrent(proc)) return { proc };
  if (identity.outcome === "exited") {
    slog(`child on port ${port} exited before answering /api/health`);
  } else {
    slog(
      identity.outcome === "foreign-owner"
        ? `port ${port} answered health checks from another process`
        : `child on port ${port} did not answer /api/health within ${SERVER_BOOT_TIMEOUT_MS / 1000}s`,
    );
  }
  const stopped = await stopUtilityServer(proc);
  if (!stopped) {
    slog(`child on port ${port} did not exit after termination; refusing to start a sibling server`);
  }
  return { proc: null, reason: stopped ? identity.outcome : "stuck-child", abort: !stopped };
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  let everyPortForeignOwned = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      if (desktopShutdownStarted) return false;
      const started = await startServerOn(port);
      if (started.proc) {
        setServerPort(port);
        if (deps.serverSupervisor().ready(started.proc)) return true;
      }
      if (started.abort) return false;
      // A child that exited or timed out is not evidence of a port conflict —
      // only "another process answered health checks" is.
      if (started.reason !== "foreign-owner") everyPortForeignOwned = false;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  deps.setServerStartConflictOnly(everyPortForeignOwned);
  return false;
}

function syncManagedComposioCredentials() {
  if (!serverProc) return;
  try {
    serverProc.postMessage({
      type: "openmausbot:managed-composio",
      access: managedComposioAccess(composioBrokerUrl(), secureCredentials),
    });
  } catch (error) {
    slog(`connected-apps credential sync failed: ${error?.message ?? error}`);
  }
}

// How long one packaged-server child gets to answer /api/health before the
// parent reaps it and tries the next port. Wall-clock, deliberately generous:
// first boots write data dirs and pre-listen network calls (managed composio,
// workspace credentials) can stall a healthy child far past 20s on some
// machines, which used to surface as the misleading "ports are busy" page.
const SERVER_BOOT_TIMEOUT_MS = 60_000;

export {
  installDesktopMutationHeader,
  startServerOn,
  startServerPackaged,
  syncManagedComposioCredentials,
};
