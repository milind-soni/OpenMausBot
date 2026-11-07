import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  currentUser, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning,
} from "./service-unit.ts";
import { defaultSentinelOut, outRefusal } from "./sentinel/paths.ts";
import { cliCommand } from "./cli-invocation.ts";

export interface ServiceInstallInput {
  action: "install" | "uninstall";
  dataDir: string;
  port: number;
  domain?: string;
  tunnel?: boolean;
  tailscale?: boolean;
  publicUrl?: string;
  lan?: boolean;
  label?: string;
  sentinel?: boolean;
  /** Defaults to the platform's Sentinel folder. */
  sentinelOut?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** Whether a bundled CLI knows the sentinel command. */
  hasSentinel?: (script: string) => boolean;
  script: string;
  node: string;
  /** Under npx: installs `openmausbot@version` into `prefix` and resolves whether npm succeeded. */
  installCopy?: (prefix: string, version: string) => boolean;
  platform?: NodeJS.Platform;
  home?: string;
  user?: string;
}

export interface ServiceIo {
  log(line: string): void;
  error(line: string): void;
}

/** The same `serve` flags the person gave, so the service reaches people the way `serve` did. Not a terminal, `serve`
 * prints no pairing code into the service log. */
export function serviceServeArgs(input: Pick<ServiceInstallInput, "port" | "dataDir" | "domain" | "tunnel" | "tailscale" | "publicUrl" | "lan" | "label">): string[] {
  const args = ["--port", String(input.port), "--data-dir", input.dataDir];
  if (input.domain) args.push("--domain", input.domain);
  else if (input.tunnel) args.push("--tunnel");
  else if (input.tailscale) args.push("--tailscale");
  if (input.publicUrl && !input.domain && !input.tunnel) args.push("--public-url", input.publicUrl);
  if (input.lan) args.push("--lan");
  if (input.label) args.push("--label", input.label);
  return args;
}

export function runServiceCommand(input: ServiceInstallInput, io: ServiceIo): number {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  if (input.sentinel) return runSentinelService(input, platform, home, io);
  const plan = servicePlan(platform, input.dataDir, home);
  if (!plan) {
    io.error("services are written for Linux (systemd) and macOS (launchd); on Windows, use Task Scheduler to run `openmausbot serve` at startup");
    return 1;
  }
  if (input.action === "uninstall") {
    io.log(`to stop and remove the service:`);
    for (const line of plan.deactivate) io.log(`  ${line}`);
    return 0;
  }
  let script = input.script;
  if (unstableInstallWarning(script)) {
    const pinned = pinnedCopy(input, io);
    if (!pinned) return 1;
    script = pinned;
  }
  const spec = {
    node: input.node,
    script,
    serveArgs: serviceServeArgs(input),
    dataDir: input.dataDir,
    user: input.user ?? currentUser(),
    home,
    bindsLowPorts: Boolean(input.domain),
    ...(input.label ? { label: input.label } : {}),
    ...(script !== input.script ? { cliPrefix: "npx openmausbot" } : {}),
  };
  const rendered = platform === "darwin" ? launchdPlist(spec) : systemdUnit(spec);
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.file, rendered, { mode: 0o644 });
  io.log(`wrote ${plan.file}`);
  io.log("");
  io.log(platform === "darwin" ? "to install and start it (runs at login):" : "to install and start it (runs at boot, restarts if it stops):");
  for (const line of plan.activate) io.log(`  ${line}`);
  io.log("");
  if (input.domain && platform === "linux") io.log("the unit grants Caddy the capability for ports 80 and 443, so no setcap is needed under the service");
  io.log(`logs: ${platform === "darwin" ? `${input.dataDir}/logs/service.log` : "journalctl -u openmausbot -f"}`);
  io.log(`change options later by running \`${cliCommand("service install")}\` again with the new ones, then: ${platform === "darwin" ? plan.activate[1] : "sudo systemctl daemon-reload && sudo systemctl restart openmausbot"}`);
  return 0;
}

/** npm prunes its npx cache, so a service runs a copy of this exact version kept beside the data instead. */
function pinnedCopy(input: ServiceInstallInput, io: ServiceIo): string | null {
  let version: string | undefined;
  try {
    version = JSON.parse(readFileSync(join(dirname(input.script), "..", "package.json"), "utf8")).version;
  } catch {
    version = undefined;
  }
  const prefix = join(input.dataDir, "app", version ?? "latest");
  const command = `npm install --prefix ${prefix} openmausbot@${version ?? "latest"}`;
  io.log(`this run comes from npx's cache, which npm prunes: installing openmausbot ${version ?? ""} into ${prefix} for the service`.replace("  ", " "));
  const installed = (input.installCopy ?? installWithNpm)(prefix, version ?? "latest");
  const script = join(prefix, "node_modules", "openmausbot", "dist-server", "openmausbot.js");
  if (installed && (input.exists ?? existsSync)(script)) return script;
  io.error(`could not install that copy. Run this, then the same service install command again from it:\n  ${command}\n  node ${script} service install …`);
  return null;
}

function installWithNpm(prefix: string, version: string): boolean {
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(npm, ["install", "--prefix", prefix, `openmausbot@${version}`, "--no-audit", "--no-fund"], { stdio: "inherit" }).status === 0;
}

function bundleHasSentinel(script: string): boolean {
  try {
    return readFileSync(script, "utf8").includes("--check-install");
  } catch {
    return false;
  }
}

function runSentinelService(input: ServiceInstallInput, platform: NodeJS.Platform, home: string, io: ServiceIo): number {
  const out = input.sentinelOut ?? defaultSentinelOut(input.dataDir, platform, home, input.env ?? process.env);
  const plan = sentinelServicePlan(platform, out, home);
  if (!plan) {
    // printed for the person to run, never executed: /TR takes the whole
    // command line as one argument, with its own quotes escaped
    const command = sentinelCommand({ ...input, out }).map((arg) => `\\"${arg}\\"`).join(" ");
    io.error("services are written for Linux (systemd) and macOS (launchd); on Windows, use Task Scheduler to run Sentinel every two minutes:");
    io.error(`  schtasks /Create /SC MINUTE /MO 2 /TN "OpenMausBot Sentinel" /TR "${command}"`);
    return 1;
  }
  if (input.action === "uninstall") {
    io.log("to stop and remove the Sentinel schedule:");
    for (const line of plan.deactivate) io.log(`  ${line}`);
    return 0;
  }
  const refusal = outRefusal(out, input.dataDir);
  if (refusal) {
    io.error(refusal);
    return 1;
  }
  const shipped = shippedSentinelCli(platform, home, input.exists ?? existsSync, input.hasSentinel ?? bundleHasSentinel);
  if (!shipped) {
    const warning = unstableInstallWarning(input.script);
    if (warning) {
      io.error(warning);
      return 1;
    }
  }
  const spec = shipped
    ? { ...shipped, electronRunAsNode: true, dataDir: input.dataDir, home, out }
    : { node: input.node, script: input.script, dataDir: input.dataDir, home, out };
  io.log(shipped ? `runs the desktop app's own CLI: ${shipped.script}` : `runs ${input.script} with ${input.node}; if either moves (a new checkout, a Node upgrade), run this again`);
  let rendered: Record<string, string>;
  try {
    rendered = platform === "darwin"
      ? { [plan.files[0]!.name]: sentinelLaunchdPlist(spec) }
      : { [plan.files[0]!.name]: sentinelSystemdService(spec), [plan.files[1]!.name]: sentinelSystemdTimer() };
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  // launchd opens the log itself and will not create its folder
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const file of plan.files) {
    writeFileSync(join(out, file.name), rendered[file.name]!, { mode: 0o644 });
    io.log(`wrote ${join(out, file.name)}`);
  }
  io.log("");
  io.log("to install it (a read-only health scan every two minutes, at login and after):");
  for (const line of plan.activate) io.log(`  ${line}`);
  io.log("");
  io.log(`issues: ${join(out, "issues.jsonl")}`);
  io.log(`logs: ${platform === "darwin" ? join(out, "sentinel.log") : "journalctl --user -u openmausbot-sentinel"}`);
  io.log("after an app update or a Node upgrade, check the schedule still points at both: openmausbot sentinel --check-install");
  return 0;
}
