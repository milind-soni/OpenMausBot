import { homedir, userInfo } from "node:os";
import { posix } from "node:path";

// Unit files describe a Linux or macOS machine: POSIX paths whatever host renders them (Windows CI included).
const { basename, dirname, join } = posix;

export interface ServiceSpec {
  node: string;
  script: string;
  serveArgs: string[];
  dataDir: string;
  user: string;
  home: string;
  bindsLowPorts: boolean;
  label?: string;
  /** How the person runs the CLI by hand, when it isn't `openmausbot` (a copy installed for the service). */
  cliPrefix?: string;
}

export const SYSTEMD_UNIT_NAME = "openmausbot.service";
export const LAUNCHD_LABEL = "com.openmausbot.serve";

function quoteSystemd(value: string): string {
  // systemd's ExecStart splits on whitespace and understands double quotes.
  return /[\s"\\]/.test(value) ? `"${value.replace(/[\\"]/g, "\\$&")}"` : value;
}

function needsStripTypes(script: string): boolean {
  return script.endsWith(".ts");
}

export function serviceCommand(spec: Pick<ServiceSpec, "node" | "script" | "serveArgs">): string[] {
  return [spec.node, ...(needsStripTypes(spec.script) ? ["--experimental-strip-types"] : []), spec.script, "serve", ...spec.serveArgs];
}

export function systemdUnit(spec: ServiceSpec): string {
  const lines = [
    "# Written by `openmausbot service install`. Re-run it to change the options.",
    "[Unit]",
    `Description=OpenMausBot${spec.label ? ` (${spec.label})` : ""}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${spec.user}`,
    `WorkingDirectory=${spec.home}`,
    `Environment=HOME=${spec.home}`,
    `Environment=OMB_DATA_DIR=${spec.dataDir}`,
    ...(spec.cliPrefix ? [`Environment=${quoteSystemd(`OMB_CLI_PREFIX=${spec.cliPrefix}`)}`] : []),
    `ExecStart=${serviceCommand(spec).map(quoteSystemd).join(" ")}`,
    "Restart=always",
    "RestartSec=3",
    "KillMode=mixed",
    "TimeoutStopSec=30",
  ];
  if (spec.bindsLowPorts) {
    lines.push("# serve --domain: Caddy binds ports 80 and 443 without running as root.");
    lines.push("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    lines.push("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
  }
  lines.push("", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const args = serviceCommand(spec).map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    args,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>HOME</key>",
    `\t\t<string>${xml(spec.home)}</string>`,
    "\t\t<key>OMB_DATA_DIR</key>",
    `\t\t<string>${xml(spec.dataDir)}</string>`,
    ...(spec.cliPrefix ? ["\t\t<key>OMB_CLI_PREFIX</key>", `\t\t<string>${xml(spec.cliPrefix)}</string>`] : []),
    "\t\t<key>PATH</key>",
    `\t\t<string>${xml(join(spec.home, ".local", "bin"))}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>`,
    "\t</dict>",
    "\t<key>WorkingDirectory</key>",
    `\t<string>${xml(spec.home)}</string>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(join(spec.dataDir, "logs", "service.log"))}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(join(spec.dataDir, "logs", "service.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** An `npx` cache path is pruned without notice; a service must not point at it. */
export function unstableInstallWarning(script: string): string | null {
  const normalized = script.replace(/\\/g, "/");
  if (/\/_npx\//.test(normalized) || /\/\.npm\/_npx\//.test(normalized)) {
    return `this command runs from an npx cache (${dirname(script)}), which npm may delete at any time. Install it permanently first (npm install -g openmausbot) and run \`openmausbot service install\` from that install.`;
  }
  return null;
}

export function servicePlan(platform: NodeJS.Platform, dataDir: string, home = homedir()): { file: string; installed: string; activate: string[]; deactivate: string[] } | null {
  if (platform === "linux") {
    const installed = `/etc/systemd/system/${SYSTEMD_UNIT_NAME}`;
    return {
      file: join(dataDir, SYSTEMD_UNIT_NAME),
      installed,
      activate: [`sudo install -m 644 ${join(dataDir, SYSTEMD_UNIT_NAME)} ${installed}`, "sudo systemctl daemon-reload", `sudo systemctl enable --now ${basename(SYSTEMD_UNIT_NAME, ".service")}`],
      deactivate: [`sudo systemctl disable --now ${basename(SYSTEMD_UNIT_NAME, ".service")}`, `sudo rm ${installed}`, "sudo systemctl daemon-reload"],
    };
  }
  if (platform === "darwin") {
    const installed = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    return {
      file: join(dataDir, `${LAUNCHD_LABEL}.plist`),
      installed,
      activate: [`mkdir -p ${dirname(installed)} && cp ${join(dataDir, `${LAUNCHD_LABEL}.plist`)} ${installed}`, `launchctl bootstrap gui/$(id -u) ${installed}`],
      deactivate: [`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, `rm ${installed}`],
    };
  }
  return null;
}

export const SENTINEL_LAUNCHD_LABEL = "com.openmausbot.sentinel";
export const SENTINEL_SYSTEMD_NAME = "openmausbot-sentinel";
export const SENTINEL_INTERVAL_SECONDS = 120;

export type SentinelServiceSpec = Pick<ServiceSpec, "node" | "script" | "dataDir" | "home"> & {
  out: string;
  /** `node` is the desktop app's own executable, run as Node. */
  electronRunAsNode?: boolean;
};

/** The app's executable run as Node (ELECTRON_RUN_AS_NODE) survives app updates and Node upgrades; null for an app predating Sentinel. */
export function shippedSentinelCli(
  platform: NodeJS.Platform, home: string, exists: (path: string) => boolean, hasSentinel: (script: string) => boolean = () => true,
): { node: string; script: string } | null {
  const candidates = platform === "darwin"
    ? ["/Applications/OpenMausBot.app", join(home, "Applications", "OpenMausBot.app")].map((app) => ({
      node: join(app, "Contents", "MacOS", "OpenMausBot"), script: join(app, "Contents", "Resources", "server", "openmausbot.js"),
    }))
    : platform === "linux" ? [{ node: "/opt/OpenMausBot/openmausbot", script: "/opt/OpenMausBot/resources/server/openmausbot.js" }] : [];
  return candidates.find((cli) => exists(cli.node) && exists(cli.script) && hasSentinel(cli.script)) ?? null;
}

export function sentinelCommand(spec: Pick<SentinelServiceSpec, "node" | "script" | "dataDir" | "out">): string[] {
  return [spec.node, ...(needsStripTypes(spec.script) ? ["--experimental-strip-types"] : []), spec.script, "sentinel", "--once", "--data-dir", spec.dataDir, "--out", spec.out];
}

function shellArg(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function sentinelLaunchdPlist(spec: SentinelServiceSpec): string {
  for (const [label, value] of [["home", spec.home], ["node", spec.node], ["script", spec.script], ["data dir", spec.dataDir], ["output", spec.out]] as const) assertUnitValue(label, value);
  const args = sentinelCommand(spec).map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  const log = xml(join(spec.out, "sentinel.log"));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${SENTINEL_LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    args,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>HOME</key>",
    `\t\t<string>${xml(spec.home)}</string>`,
    ...(spec.electronRunAsNode ? ["\t\t<key>ELECTRON_RUN_AS_NODE</key>", "\t\t<string>1</string>"] : []),
    "\t</dict>",
    "\t<key>StartInterval</key>",
    `\t<integer>${SENTINEL_INTERVAL_SECONDS}</integer>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>ProcessType</key>",
    "\t<string>Background</string>",
    "\t<key>LowPriorityIO</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${log}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${log}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** A line break or NUL in a unit file value would start a line of its own. */
function assertUnitValue(label: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error(`the ${label} path contains a line break or NUL, which a service file cannot hold; choose a path without one`);
}

/** systemd: a trailing backslash continues the line, % is a specifier, and ExecStart expands $VARIABLES. */
function systemdQuoted(value: string, command = false): string {
  const escaped = value.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%");
  return `"${command ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

export function sentinelSystemdService(spec: SentinelServiceSpec): string {
  for (const [label, value] of [["home", spec.home], ["node", spec.node], ["script", spec.script], ["data dir", spec.dataDir], ["output", spec.out]] as const) assertUnitValue(label, value);
  return [
    "# Written by `openmausbot service install --sentinel`. Started by its timer.",
    "[Unit]",
    "Description=OpenMausBot Sentinel health scan",
    "",
    "[Service]",
    "Type=oneshot",
    `Environment=${systemdQuoted(`HOME=${spec.home}`)}`,
    ...(spec.electronRunAsNode ? ["Environment=ELECTRON_RUN_AS_NODE=1"] : []),
    `ExecStart=${sentinelCommand(spec).map((arg) => (/^[\w@+=:,./-]+$/.test(arg) ? arg : systemdQuoted(arg, true))).join(" ")}`,
    "Nice=10",
    "IOSchedulingClass=idle",
    "",
  ].join("\n");
}

export function sentinelSystemdTimer(): string {
  return [
    "# Written by `openmausbot service install --sentinel`.",
    "[Unit]",
    "Description=Run the OpenMausBot Sentinel health scan every two minutes",
    "",
    "[Timer]",
    `OnBootSec=${SENTINEL_INTERVAL_SECONDS}s`,
    `OnUnitActiveSec=${SENTINEL_INTERVAL_SECONDS}s`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export function sentinelServicePlan(platform: NodeJS.Platform, out: string, home = homedir()): { files: Array<{ name: string; installed: string }>; activate: string[]; deactivate: string[] } | null {
  if (platform === "linux") {
    const dir = join(home, ".config", "systemd", "user");
    const files = [`${SENTINEL_SYSTEMD_NAME}.service`, `${SENTINEL_SYSTEMD_NAME}.timer`].map((name) => ({ name, installed: join(dir, name) }));
    return {
      files,
      activate: [`mkdir -p ${shellArg(dir)} && cp ${files.map((file) => shellArg(join(out, file.name))).join(" ")} ${shellArg(dir)}/`, "systemctl --user daemon-reload", `systemctl --user enable --now ${SENTINEL_SYSTEMD_NAME}.timer`],
      deactivate: [`systemctl --user disable --now ${SENTINEL_SYSTEMD_NAME}.timer`, `rm ${files.map((file) => shellArg(file.installed)).join(" ")}`, "systemctl --user daemon-reload"],
    };
  }
  if (platform === "darwin") {
    const name = `${SENTINEL_LAUNCHD_LABEL}.plist`;
    const installed = join(home, "Library", "LaunchAgents", name);
    return {
      files: [{ name, installed }],
      activate: [`mkdir -p ${shellArg(dirname(installed))} && cp ${shellArg(join(out, name))} ${shellArg(installed)}`, `launchctl bootstrap gui/$(id -u) ${shellArg(installed)}`],
      deactivate: [`launchctl bootout gui/$(id -u)/${SENTINEL_LAUNCHD_LABEL}`, `rm ${shellArg(installed)}`],
    };
  }
  return null;
}

export function sentinelUnitCommand(text: string): { node: string; script: string } | null {
  let args: string[];
  const plist = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (plist) {
    args = [...plist[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  } else {
    const exec = /^ExecStart=(.*)$/m.exec(text);
    if (!exec) return null;
    // undo systemdQuoted: escapes, then the doubled % and $
    args = [...exec[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)]
      .map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$") : m[2]!));
  }
  const at = args.indexOf("sentinel");
  return at >= 2 ? { node: args[0]!, script: args[at - 1]! } : null;
}

export type SentinelInstallCheck =
  | { status: "ok"; unit: string; node: string; script: string }
  | { status: "stale"; unit: string; node: string; script: string; missing: string[] }
  | { status: "not_installed" | "unreadable"; unit: string }
  | { status: "unsupported" };

/** launchd and systemd fail silently on every run once an app update or Node upgrade moves the node or script. */
export function checkSentinelInstall(platform: NodeJS.Platform, home: string, fs: { exists(path: string): boolean; read(path: string): string }): SentinelInstallCheck {
  const plan = sentinelServicePlan(platform, "", home);
  if (!plan) return { status: "unsupported" };
  const unit = plan.files[0]!.installed;
  if (!fs.exists(unit)) return { status: "not_installed", unit };
  let command: { node: string; script: string } | null;
  try {
    command = sentinelUnitCommand(fs.read(unit));
  } catch {
    command = null;
  }
  if (!command) return { status: "unreadable", unit };
  // on Linux the timer is what runs the service: without it, nothing does
  const missing = [command.node, command.script, ...plan.files.slice(1).map((file) => file.installed)].filter((path) => !fs.exists(path));
  return missing.length ? { status: "stale", unit, ...command, missing } : { status: "ok", unit, ...command };
}

export function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "openmausbot";
  }
}
