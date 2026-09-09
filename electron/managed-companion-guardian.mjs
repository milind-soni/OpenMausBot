// Parent-death guardian for the managed Companion origin.
//
// Electron launches this small Node process with an open stdin pipe. It owns
// both the stable loopback gateway and cloudflared. If Electron crashes, the
// pipe reaches EOF; the guardian invalidates forwarding, kills cloudflared,
// and only then releases port 8812. An orphan connector can therefore never
// expose whatever process happens to bind a reusable local port later.
import { spawn } from "node:child_process";
import path from "node:path";

import {
  createCompanionOriginGateway,
  MANAGED_COMPANION_ORIGIN_PORT,
  validCompanionOriginTarget,
} from "./companion-origin-gateway.mjs";

const copyEnvironmentValue = (source, target, names) => {
  const entries = Object.entries(source);
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (found) target[found[0]] = found[1];
  }
};

/** cloudflared gets OS process plumbing only. An allowlist strips every
 * TUNNEL_*, CF_*, CLOUDFLARED_*, proxy, config, logging, protocol, and secret
 * variable without relying on an inevitably incomplete blocklist. */
export function minimalCloudflaredEnvironment(
  environment = process.env,
  platform = process.platform,
) {
  const minimal = {};
  copyEnvironmentValue(environment, minimal, ["PATH"]);
  if (platform === "win32") {
    copyEnvironmentValue(environment, minimal, ["SystemRoot", "WINDIR", "TEMP", "TMP"]);
  }
  return minimal;
}

/** Environment for launching this file through the packaged Electron binary
 * in Node mode. It is just as narrow as the connector environment. */
export function minimalGuardianEnvironment(
  environment = process.env,
  platform = process.platform,
) {
  return {
    ...minimalCloudflaredEnvironment(environment, platform),
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const delay = (milliseconds) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

async function terminateConnector(child, graceMs = 250) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const exit = new Promise((resolve) => {
    const finish = () => {
      if (exited) return;
      exited = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", () => {
      // An asynchronous spawn failure has no process to wait for. Once a pid
      // exists, an error event alone is not proof that the OS process died;
      // retaining the gateway is the fail-closed choice until `exit` arrives.
      if (!Number.isSafeInteger(child.pid)) finish();
    });
  });
  try {
    child.kill("SIGTERM");
  } catch {}
  await Promise.race([exit, delay(graceMs)]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  // Do not release the gateway on a timer. Holding the loopback port is the
  // fail-closed state until the OS confirms cloudflared is dead.
  await exit;
}

function ownerLoss(ownerInput, signalSource) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ kind: "owner" });
    };
    ownerInput.once("end", finish);
    ownerInput.once("close", finish);
    ownerInput.once("error", finish);
    signalSource.once("SIGINT", finish);
    signalSource.once("SIGTERM", finish);
    ownerInput.resume?.();
  });
}

/** Run one guardian lifetime. Exported for deterministic lifecycle tests. */
export async function runManagedCompanionGuardian({
  cloudflaredBinary,
  tokenFile,
  target,
  originPort = MANAGED_COMPANION_ORIGIN_PORT,
  environment = process.env,
  platform = process.platform,
  ownerInput = process.stdin,
  signalSource = process,
  spawnProcess = spawn,
  isTargetAlive = ({ pid }) => processIsAlive(pid),
  createGateway = createCompanionOriginGateway,
} = {}) {
  if (!path.isAbsolute(cloudflaredBinary ?? "") || !path.isAbsolute(tokenFile ?? "")) {
    throw new Error("The managed connector paths are invalid");
  }
  if (!validCompanionOriginTarget(target, platform)) {
    throw new Error("The managed companion origin target is invalid");
  }
  if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65_535) {
    throw new Error("The managed companion origin port is invalid");
  }

  const gateway = createGateway({
    target,
    originPort,
    isTargetAlive,
  });
  await gateway.start();

  let connector;
  try {
    connector = spawnProcess(
      cloudflaredBinary,
      [
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "info",
        "--output",
        "json",
        "run",
        "--token-file",
        tokenFile,
      ],
      {
        env: minimalCloudflaredEnvironment(environment, platform),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch (error) {
    gateway.invalidate();
    await gateway.close();
    throw error;
  }

  const connectorExit = new Promise((resolve) => {
    connector.once("exit", (code) => resolve({ kind: "connector", code: code ?? 1 }));
    connector.once("error", () => {
      if (!Number.isSafeInteger(connector.pid)) {
        resolve({ kind: "connector", code: 1 });
      }
    });
  });
  const outcome = await Promise.race([connectorExit, ownerLoss(ownerInput, signalSource)]);

  gateway.invalidate();
  if (outcome.kind === "owner") await terminateConnector(connector);
  await gateway.close();
  return outcome.kind === "connector" ? outcome.code : 0;
}

export function guardianArguments(argv) {
  if (argv.length !== 5) throw new Error("The managed companion guardian arguments are invalid");
  const [cloudflaredBinary, tokenFile, socketPath, rawPid, rawPort] = argv;
  const pid = Number(rawPid);
  const originPort = Number(rawPort);
  const target = { pid, socketPath };
  if (!validCompanionOriginTarget(target)) {
    throw new Error("The managed companion guardian target is invalid");
  }
  return { cloudflaredBinary, tokenFile, target, originPort };
}

// Executed as a process through managed-companion-guardian-main.mjs. This file
// is a library on purpose: managed-companion-tunnel.mjs imports an environment
// helper from it, and anything that bundles that module (the headless CLI's
// entries) would otherwise inline a "run when executed directly" check that
// is true for the bundle itself.
