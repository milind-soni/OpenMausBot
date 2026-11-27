// On Electron's death the stdin pipe hits EOF: the guardian invalidates forwarding, kills cloudflared, and only then
// releases port 8812, so an orphan connector never exposes whatever binds that port later.
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

/** An allowlist of OS process plumbing: every TUNNEL_*, CF_*, CLOUDFLARED_*, proxy, config and secret variable is stripped. */
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
      // Once a pid exists an `error` event does not prove the process died: keep the gateway until `exit`.
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
  // Never release the gateway on a timer: holding the port is the fail-closed state until cloudflared is dead.
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

// A library on purpose: a "run when executed directly" check here would fire inside any bundle that imports it.
