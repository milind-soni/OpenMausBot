// This computer's own server for the person's other computers on the tailnet. `tailscale serve` fronts it with HTTPS when
// the tailnet hands out certificates and nothing else holds the port; otherwise the server listens on its tailnet
// addresses itself. Never Funnel: nothing here is reachable from outside the tailnet.
import { execFile, spawn as spawnChild } from "node:child_process";
import fs from "node:fs";

import { tailnetOrigin } from "./tailnet.mjs";
import { tailscaleEnvironment } from "./tailscale-check.mjs";

const HTTPS_PORT = 443;
const OFF = Object.freeze({ on: false, origin: null, https: false, problem: null });

/** Whether `tailscale serve status --json` has anything on `port`, foreground sessions included. Unreadable counts as
 * taken: a share the person made themselves is never replaced on a guess. */
export function servePortTaken(stdout, port = HTTPS_PORT) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const holds = (config) => Boolean(config?.TCP && Object.hasOwn(config.TCP, String(port)));
  return holds(parsed) || Object.values(parsed.Foreground ?? {}).some(holds);
}

const readServeStatus = (cli) =>
  new Promise((resolve) => {
    execFile(cli, ["serve", "status", "--json"], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: tailscaleEnvironment(), windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout ?? "")));
  });

const readCommandLine = (pid) =>
  new Promise((resolve) => {
    const [file, args] = process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]]
      : ["ps", ["-o", "command=", "-p", String(pid)]];
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout ?? "")));
  });

/**
 * Security: whether an organization's policy lets this computer share itself. `managed` is a packaged app running its own
 * server; until its client has read the saved policy nothing is known, and unknown counts as no.
 */
export function remotePolicyAllows({ managed, client }) {
  return !managed || (client?.policyKnown?.() === true && client.policy()?.remoteAccess !== false);
}

/**
 * `check()` is checkTailscale. `allowed()` is false while an organization's policy keeps remote access off. `apply` takes
 * the saved Tailscale route, `attach` each new server process; a server process forgets its share when it exits.
 * `recheck` follows a change in `allowed()`. `markerFile()` notes a running `tailscale serve`, so the next launch can end
 * one a crash left behind.
 */
export function createTailnetShare({ check, allowed = () => true, spawn = spawnChild, serveStatus = readServeStatus, markerFile = () => null, commandLine = readCommandLine, kill = process.kill.bind(process), settleMs = 2_500, answerMs = 5_000, log = () => {} }) {
  let server = null;
  let starting = null;
  let quitting = false;
  let lastAllowed;
  let wanted = null;
  let serving = null;
  let shown = OFF;
  let answered = () => {};
  let httpsBroken = false;
  let queue = Promise.resolve();

  const enqueue = (work) => {
    const next = queue.then(work, work);
    queue = next.then(() => {}, () => {});
    return next;
  };

  /** Tells the server, and waits for what it managed to do. */
  function tell(share) {
    if (!server) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), answerMs);
      timer.unref?.();
      answered = (reply) => { clearTimeout(timer); answered = () => {}; resolve(reply); };
      server.told ||= share !== null;
      try {
        server.proc.postMessage({ type: "openmausbot:tailnet-share", share });
      } catch {
        answered(null);
      }
    });
  }

  const forgetMarker = () => {
    const file = markerFile();
    if (file) fs.rmSync(file, { force: true });
  };

  /** Only a process still running exactly the command noted is ended, so a reused pid is left alone. */
  async function endLeftover() {
    const file = markerFile();
    if (serving || !file) return;
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return;
    }
    const { pid, port } = marker ?? {};
    const command = `serve --https=${HTTPS_PORT} http://127.0.0.1:${port}`;
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(port) && (await commandLine(pid)).includes(command)) {
      log("tailnet: ending a tailscale serve an earlier run left behind");
      try {
        kill(pid, "SIGTERM");
      } catch {
      }
      for (let tries = 0; tries < 30 && (await commandLine(pid)).includes(command); tries++) await new Promise((done) => setTimeout(done, 100));
    }
    forgetMarker();
  }

  async function stopServing() {
    const current = serving;
    serving = null;
    if (!current) return;
    current.stopping = true;
    try {
      current.child.kill("SIGTERM");
    } catch {
    }
    forgetMarker();
    await Promise.race([current.exited, new Promise((done) => setTimeout(done, 3_000).unref?.())]);
  }

  /** The HTTPS origin once `tailscale serve` is up and Tailscale lists it, else null. */
  async function startServing(cli, name, port) {
    if (servePortTaken(await serveStatus(cli))) {
      log("tailnet: port 443 already serves something; listening on the tailnet instead");
      return null;
    }
    let child;
    try {
      child = spawn(cli, ["serve", `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`], { stdio: "ignore", env: tailscaleEnvironment(), windowsHide: true });
    } catch {
      return null;
    }
    starting = child;
    const file = markerFile();
    if (file && child.pid) {
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: child.pid, port }), { mode: 0o600 });
      } catch {
      }
    }
    const exited = new Promise((done) => { child.once("exit", () => done("exited")); child.once("error", () => done("exited")); });
    const early = await Promise.race([exited, new Promise((done) => setTimeout(() => done("running"), settleMs))]);
    if (early !== "running") {
      starting = null;
      forgetMarker();
      log("tailnet: tailscale serve stopped at once; listening on the tailnet instead");
      return null;
    }
    // Serve waits on an enablement link without saying so; only a listed port is a share.
    const listed = servePortTaken(await serveStatus(cli));
    starting = null;
    if (!listed || quitting) {
      child.kill("SIGTERM");
      forgetMarker();
      log("tailnet: tailscale serve did not take the port; listening on the tailnet instead");
      return null;
    }
    const entry = { child, port, name, exited, stopping: false };
    serving = entry;
    void exited.then(() => {
      if (entry.stopping || serving !== entry) return;
      log("tailnet: tailscale serve ended; listening on the tailnet instead");
      serving = null;
      httpsBroken = true;
      forgetMarker();
      void enqueue(reconcile);
    });
    return tailnetOrigin(name, HTTPS_PORT, true);
  }

  async function reconcile() {
    const route = wanted;
    await endLeftover();
    lastAllowed = allowed();
    if (quitting) return shown;
    if (!server || !route?.on || route.computers !== true || !lastAllowed) {
      await stopServing();
      if (server?.told) await tell(null);
      shown = OFF;
      return shown;
    }
    const status = await check();
    const ready = status.state === "ready";
    const name = ready ? status.name : route.name;
    if (!name) {
      await stopServing();
      if (server.told) await tell(null);
      shown = { on: true, origin: null, https: false, problem: status.state };
      return shown;
    }
    if (serving && (serving.port !== server.port || serving.name !== name)) await stopServing();
    const origin = serving
      ? tailnetOrigin(name, HTTPS_PORT, true)
      : ready && status.https && status.cli && !httpsBroken ? await startServing(status.cli, name, server.port) : null;
    if (quitting) return shown;
    const reply = await tell(origin ? { name, served: origin } : { name });
    const reached = reply?.origin ?? null;
    shown = { on: true, origin: reached, https: Boolean(origin), problem: reached ? null : ready ? "not-listening" : status.state };
    return shown;
  }

  return {
    /** The person changed something, or asked to check again: HTTPS gets another try. */
    apply(route) {
      wanted = route ?? null;
      httpsBroken = false;
      return enqueue(reconcile);
    },
    /** A new server process has no share yet. */
    attach(proc, port, route) {
      server = { proc, port, told: false };
      wanted = route ?? null;
      httpsBroken = false;
      return enqueue(reconcile);
    },
    /** The organization's policy may have changed; a share that it now forbids closes, and one it allows again opens. */
    recheck() {
      return allowed() === lastAllowed ? Promise.resolve(shown) : enqueue(reconcile);
    },
    /** The server's answer, and its word when Tailscale's interface comes or goes. */
    receive(message) {
      if (message?.type !== "openmausbot:tailnet-share-state") return false;
      answered(message);
      if (shown.on) shown = { ...shown, origin: message.origin ?? null, problem: message.origin ? null : shown.problem ?? "not-listening" };
      return true;
    },
    state: () => shown,
    /** The app is quitting: `tailscale serve` must not outlive the server it fronts. */
    stop() {
      wanted = null;
      quitting = true;
      try {
        starting?.kill("SIGTERM");
      } catch {
      }
      return stopServing();
    },
  };
}
