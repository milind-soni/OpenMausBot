// The `openmausbot service` command, kept separate from cli.ts so it can be
// tested with explicit inputs: it renders the unit for this platform, writes
// it next to the data, and prints the commands that install it.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { currentUser, launchdPlist, servicePlan, systemdUnit, unstableInstallWarning } from "./service-unit.ts";

export interface ServiceInstallInput {
  action: "install" | "uninstall";
  dataDir: string;
  port: number;
  domain?: string;
  tunnel?: boolean;
  tailscale?: boolean;
  label?: string;
  /** This CLI's own entry, as node saw it (process.argv[1]) and node itself (process.execPath). */
  script: string;
  node: string;
  platform?: NodeJS.Platform;
  home?: string;
  user?: string;
}

export interface ServiceIo {
  log(line: string): void;
  error(line: string): void;
}

/** The `serve` arguments the service repeats, from the options given to `service install`. */
export function serviceServeArgs(input: Pick<ServiceInstallInput, "port" | "dataDir" | "domain" | "tunnel" | "tailscale" | "label">): string[] {
  const args = ["--port", String(input.port), "--data-dir", input.dataDir, "--no-pair"];
  if (input.domain) args.push("--domain", input.domain);
  else if (input.tunnel) args.push("--tunnel");
  else if (input.tailscale) args.push("--tailscale");
  if (input.label) args.push("--label", input.label);
  return args;
}

export function runServiceCommand(input: ServiceInstallInput, io: ServiceIo): number {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
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
  const warning = unstableInstallWarning(input.script);
  if (warning) {
    io.error(warning);
    return 1;
  }
  const spec = {
    node: input.node,
    script: input.script,
    serveArgs: serviceServeArgs(input),
    dataDir: input.dataDir,
    user: input.user ?? currentUser(),
    home,
    bindsLowPorts: Boolean(input.domain),
    ...(input.label ? { label: input.label } : {}),
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
  io.log(`change options later by running \`openmausbot service install\` again with the new ones, then: ${platform === "darwin" ? plan.activate[1] : "sudo systemctl daemon-reload && sudo systemctl restart openmausbot"}`);
  return 0;
}
