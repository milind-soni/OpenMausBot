// `serve`: locating the server entry, planning tailscale/tunnel/domain access,
// supervising the child process, and pairing at startup.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

import { ensureCaddy, startCaddy, type RunningCaddy } from "../caddy.ts";
import { SetupCancelled } from "../cli-prompts.ts";
import {
  cleanupTunnelOrigin,
  createTunnelAccount,
  createTunnelOrigin,
  describeTunnelAccount,
  describeTunnelState,
  ensureCloudflared,
  FLEET_CREDENTIAL_ENV,
  fleetAccess,
  fleetCredential,
  guardianEntry,
  startTunnel,
  tunnelAccess,
  type CompanionOriginEndpoint,
  type ManagedTunnelAccess,
  type RunningTunnel,
} from "../tunnel.ts";
import { explainTailscaleFailure, tailscaleServe, tailscaleServeOff, tailscaleStatus, type TailscaleStatus } from "../tailscale.ts";
import { message, openDashboard, serverUp } from "./client.ts";
import { HERE, serverVersion, type CliOptions } from "./options.ts";
import { mintPairing, showPhonePairing } from "./pairing.ts";

/** Where the server bundle lives relative to this file: next to it in the
 * npm package and the image (dist-server/), or the TypeScript source in a
 * checkout. */
export function serverEntry(here = HERE): { command: string; args: string[]; staticDir: string | null; skillsDir: string | null } {
  const bundled = join(here, "index.js");
  const root = resolve(here, "..");
  if (existsSync(bundled)) {
    const staticDir = [join(root, "dist"), join(here, "..", "ui")].find((d) => existsSync(join(d, "index.html"))) ?? null;
    const skillsDir = existsSync(join(root, "skills")) ? join(root, "skills") : null;
    return { command: process.execPath, args: [bundled], staticDir, skillsDir };
  }
  const source = join(here, "index.ts");
  const staticDir = existsSync(join(root, "dist", "index.html")) ? join(root, "dist") : null;
  return { command: process.execPath, args: ["--experimental-strip-types", source], staticDir, skillsDir: existsSync(join(root, "skills")) ? join(root, "skills") : null };
}

interface TunnelPlan {
  access: ManagedTunnelAccess;
  binary: string;
  guardian: string;
  origin: CompanionOriginEndpoint;
}

/** Everything `--tunnel` needs before the server starts, or the one reason
 * it cannot have it. Fails closed: no silent fallback to a local-only server. */
async function planTunnel(options: CliOptions, log: (line: string) => void): Promise<TunnelPlan | { error: string }> {
  let access: ManagedTunnelAccess | null = null;
  const credential = fleetCredential();
  if (credential) {
    // A fleet-started container: the credential is the whole identity.
    log(`tunnel: using the installation credential from ${FLEET_CREDENTIAL_ENV}`);
    try {
      access = await fleetAccess({ credential });
    } catch (error) {
      return { error: `--tunnel: ${message(error)}` };
    }
  } else {
    const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
    if (account.credentials.status === "unavailable") return { error: `${account.credentials.file} exists but could not be read; fix or remove it` };
    if (!describeTunnelAccount(account.credentials.read()).email) {
      return { error: "no account on this machine yet: run `openmausbot login` first, then `openmausbot serve --tunnel`" };
    }
    // A fresh connector token when the control plane answers; the saved one otherwise.
    try {
      const state = await account.service.retry();
      if (state.message && !tunnelAccess(account.credentials.read())) log(`tunnel: ${state.message}`);
    } catch (error) {
      log(`tunnel: control plane not reachable right now (${message(error)}); using the saved address`);
    }
    access = tunnelAccess(account.credentials.read());
    if (!access) return { error: "this machine has no public address; run `openmausbot login` again" };
  }
  let binary: string;
  try {
    binary = await ensureCloudflared({ dataDir: options.dataDir, log });
  } catch (error) {
    return { error: `--tunnel: ${message(error)}` };
  }
  const guardian = guardianEntry();
  if (!guardian) return { error: "--tunnel: the connector guardian is missing from this install" };
  return { access, binary, guardian, origin: createTunnelOrigin() };
}

export async function runServe(options: CliOptions, log: (line: string) => void = console.log): Promise<number> {
  const { browserEngineStatus, describeBrowserEngine } = await import("../browser-engine.ts");
  if (await serverUp(options.port)) {
    console.error(`something already answers on http://127.0.0.1:${options.port}; use \`openmausbot pair\` against it, or --port for a second server`);
    return 1;
  }
  let publicUrl = options.publicUrl;
  let tailscale: TailscaleStatus | null = null;
  if (options.tailscale) {
    const probe = await tailscaleStatus();
    if ("failure" in probe) {
      console.error(`--tailscale: ${explainTailscaleFailure(probe.failure)}`);
      return 1;
    }
    tailscale = probe.status;
  }
  let plan: TunnelPlan | null = null;
  if (options.tunnel) {
    const planned = await planTunnel(options, log);
    if ("error" in planned) {
      console.error(planned.error);
      return 1;
    }
    plan = planned;
    if (publicUrl && publicUrl !== plan.access.endpoint) log(`note: --public-url is ignored with --tunnel; the address is ${plan.access.endpoint}`);
    publicUrl = plan.access.endpoint;
  }
  let caddyBinary: string | null = null;
  if (options.domain) {
    try {
      caddyBinary = await ensureCaddy({ dataDir: options.dataDir, log });
    } catch (error) {
      console.error(`--domain: ${message(error)}`);
      return 1;
    }
    publicUrl = `https://${options.domain}`;
  }
  const entry = serverEntry();
  if (!entry.staticDir) log("note: no built UI found next to the server; the API runs but browsers get no page (build with `pnpm exec vite build`)");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMB_DATA_DIR: options.dataDir,
    OMB_PORT: String(options.port),
    OMB_WEBHOOK_PORT: process.env.OMB_WEBHOOK_PORT || String(options.port + 1),
  };
  if (options.local) delete env.OMB_PUBLIC_URL;
  if (entry.staticDir) env.OMB_STATIC_DIR = entry.staticDir;
  if (entry.skillsDir && !process.env.OMB_SKILLS_DIR) env.OMB_SKILLS_DIR = entry.skillsDir;
  if (options.label && !process.env.OMB_ENVIRONMENT_LABEL) env.OMB_ENVIRONMENT_LABEL = options.label;
  if (plan) env.OMB_TUNNEL_SOCKET = plan.origin.socketPath;
  let logPath: string | undefined;
  let logFd: number | undefined;
  let tailscaleServing = false;
  let tailscaleAttempted = false;
  let startupCancelled = false;
  const cancelStartup = () => { startupCancelled = true; };
  process.on("SIGINT", cancelStartup);
  process.on("SIGTERM", cancelStartup);
  let child: ChildProcess;
  try {
    if (options.guided) {
      const logsDir = join(options.dataDir, "logs");
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      logPath = join(logsDir, `server-${Date.now()}-${process.pid}.log`);
      logFd = openSync(logPath, "wx", 0o600);
      log("\nStarting your workspace…");
    }
    if (tailscale) {
      tailscaleAttempted = true;
      const served = await tailscaleServe(tailscale, options.port);
      // The CLI can finish enabling background serving while cancellation is
      // arriving. Wait for that bounded command, then undo it before exiting.
      if (startupCancelled) throw new SetupCancelled();
      if ("failure" in served) throw new Error(`--tailscale: ${explainTailscaleFailure(served.failure)}`);
      tailscaleServing = true;
      publicUrl = served.origin;
      log(`tailscale: serving https://${tailscale.dnsName} → http://127.0.0.1:${options.port} (only your tailnet can reach it)`);
    }
    if (startupCancelled) throw new SetupCancelled();
    if (publicUrl) env.OMB_PUBLIC_URL = publicUrl;
    child = spawn(entry.command, entry.args, { env, stdio: ["ignore", logFd ?? "inherit", logFd ?? "inherit"] });
  } catch (error) {
    if ((tailscaleServing || (startupCancelled && tailscaleAttempted)) && tailscale) await tailscaleServeOff(tailscale).catch(() => undefined);
    if (plan) cleanupTunnelOrigin(plan.origin);
    if (error instanceof SetupCancelled) {
      log("Startup cancelled. No server was started; your saved work is unchanged.");
      return 130;
    }
    throw error;
  } finally {
    if (logFd !== undefined) closeSync(logFd);
    process.removeListener("SIGINT", cancelStartup);
    process.removeListener("SIGTERM", cancelStartup);
  }
  let exited: number | null = null;
  const childExit = new Promise<number>((done) => {
    child.once("error", () => { exited = 1; done(1); });
    child.once("exit", (code, signal) => { exited = code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1); done(exited); });
  });
  let tunnel: RunningTunnel | null = null;
  let caddy: RunningCaddy | null = null;
  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      // The gateway and the edge stop accepting before the server they forward to goes away.
      if (tunnel) await tunnel.stop().catch(() => undefined);
      if (caddy) await caddy.stop().catch(() => undefined);
      if (tailscaleServing && tailscale) await tailscaleServeOff(tailscale).catch(() => undefined);
      if (exited === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        timer.unref();
        await childExit;
        clearTimeout(timer);
      }
      if (plan) cleanupTunnelOrigin(plan.origin);
    })();
    return stopping;
  };
  const onSignal = () => { void stop(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && exited === null && !stopping) {
      if (await serverUp(options.port, child.pid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (exited !== null) {
      if (exited !== 0) log(`OpenMausBot could not start.${logPath ? ` Details: ${logPath}` : " See the output above."}`);
      return exited;
    }
    if (stopping) return await childExit;
    if (!(await serverUp(options.port, child.pid))) {
      console.error(`OpenMausBot did not become ready within a minute.${logPath ? ` Details: ${logPath}` : " See its output above."}`);
      await stop();
      return 1;
    }
    if (stopping || exited !== null) return await childExit;
    if (options.domain && caddyBinary) {
      try {
        caddy = await startCaddy({ binary: caddyBinary, dataDir: options.dataDir, domain: options.domain, appPort: options.port, webhookPort: Number(env.OMB_WEBHOOK_PORT), log });
        log(`https: Caddy serves ${publicUrl} → http://127.0.0.1:${options.port}; it gets the certificate from Let's Encrypt once DNS for ${options.domain} points at this machine`);
        void caddy.exited.then((code) => {
          if (!stopping) log(`caddy: stopped (exit ${code ?? "signal"}); ${publicUrl} is no longer served. Stop and start the server again.`);
        });
      } catch (error) {
        console.error(`--domain: ${message(error)}`);
        await stop();
        return 1;
      }
    }
    if (plan && child.pid) {
      tunnel = startTunnel({
        dataDir: options.dataDir,
        access: plan.access,
        originTarget: { pid: child.pid, socketPath: plan.origin.socketPath },
        binaryPath: plan.binary,
        guardian: plan.guardian,
        onState: (state) => log(describeTunnelState(state, plan.access.endpoint)),
      });
      tunnel.started.catch((error: unknown) => log(`tunnel: ${message(error)}`));
    }
    log("");
    log(`OpenMausBot is running on http://127.0.0.1:${options.port}${publicUrl ? `, reachable at ${publicUrl}` : ""}`);
    if (options.guided) {
      log("Your bots and conversations are saved automatically.");
      log(`Details if you need help: ${logPath}`);
      if (options.open !== false && !await openDashboard(options.port)) log("Open the local address above in a browser on this computer.");
    } else {
      log(`data: ${options.dataDir}`);
      log(describeBrowserEngine(browserEngineStatus({ dataDir: options.dataDir })));
    }
    if (options.pair && options.phone) {
      log("");
      if (tunnel) {
        // A connector may take a moment to become reachable; no pairing secret
        // is created or sent to the public address until identity is verified.
        log("Preparing the phone connection…");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([tunnel.started.catch(() => undefined), childExit,
          new Promise((done) => { timer = setTimeout(done, 15_000); })]);
        if (timer) clearTimeout(timer);
      }
      if (!stopping && exited === null) await showPhonePairing(options, publicUrl, log);
    } else if (options.pair && !options.guided) {
      log("");
      log(await mintPairing(options.port, { label: options.label ? `${options.label} owner` : undefined, client: options.client, publicUrl: publicUrl ?? undefined }));
      log("");
      log("another device later:  openmausbot pair --label \"Kitchen iPad\"");
    }
    log(options.guided ? "\nKeep this terminal open while using your bots. Ctrl+C stops the server, not your saved work." : "stop with Ctrl+C");
    if (options.guided) log("Next time: openmausbot · Change AI or phone setup: openmausbot setup · Pair another phone: openmausbot pair");
    return await childExit;
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
