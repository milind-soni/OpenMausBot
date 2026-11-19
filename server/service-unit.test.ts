import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/openindbot/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/ind/.openindbot", "--domain", "ind.example.com", "--no-pair"],
  dataDir: "/home/ind/.openindbot",
  user: "ind",
  home: "/home/ind",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/openindbot/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/OpenIndBot/server/openindbot.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=OpenIndBot (agentada)");
    expect(unit).toContain("User=ind");
    expect(unit).toContain("Environment=OMB_DATA_DIR=/home/ind/.openindbot");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/openindbot/cli.js serve --port 8799 --data-dir /home/ind/.openindbot --domain ind.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/ind/.openindbot"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/ind/My Data", serveArgs: ["--data-dir", "/home/ind/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/openindbot/cli.js serve --data-dir "/home/ind/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/ind", dataDir: "/Users/ind/.openindbot" });
    expect(plist).toContain("<string>com.openindbot.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>ind.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/ind/.openindbot/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/ind/.npm/_npx/abc123/node_modules/openindbot/cli.js")).toMatch(/npm install -g openindbot/);
    expect(unstableInstallWarning("/usr/lib/node_modules/openindbot/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/ind/.openindbot");
    expect(linux?.installed).toBe("/etc/systemd/system/openindbot.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now openindbot");
    const mac = servicePlan("darwin", "/Users/ind/.openindbot", "/Users/ind");
    expect(mac?.installed).toBe("/Users/ind/Library/LaunchAgents/com.openindbot.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/ind/Library/Application Support/openindbot-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/openindbot/cli.js", dataDir: "/Users/ind/.openindbot", home: "/Users/ind", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/openindbot/cli.js", "sentinel", "--once", "--data-dir", "/Users/ind/.openindbot", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/OpenIndBot/server/openindbot.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.openindbot.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".openindbot/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/ind");
    expect(mac?.files).toEqual([{ name: "com.openindbot.sentinel.plist", installed: "/Users/ind/Library/LaunchAgents/com.openindbot.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/ind/Library/LaunchAgents && cp '/Users/ind/Library/Application Support/openindbot-sentinel/com.openindbot.sentinel.plist' /Users/ind/Library/LaunchAgents/com.openindbot.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.openindbot.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/openindbot/cli.js", dataDir: "/home/ind/My Data", home: "/home/ind", out: "/home/ind/.local/state/openindbot-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/openindbot/cli.js sentinel --once --data-dir "/home/ind/My Data" --out /home/ind/.local/state/openindbot-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/ind");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/ind/.config/systemd/user/openindbot-sentinel.service", "/home/ind/.config/systemd/user/openindbot-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/ind/.local/state/openindbot-sentinel/openindbot-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now openindbot-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/OpenIndBot.app/Contents";
    const present = new Set([`${app}/MacOS/OpenIndBot`, `${app}/Resources/server/openindbot.js`]);
    expect(shippedSentinelCli("darwin", "/Users/ind", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/OpenIndBot`, script: `${app}/Resources/server/openindbot.js` });
    const user = "/Users/ind/Applications/OpenIndBot.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/ind", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/openindbot.js`);
    expect(shippedSentinelCli("linux", "/home/ind", (path) => path.startsWith("/opt/OpenIndBot/"))).toEqual({ node: "/opt/OpenIndBot/openindbot", script: "/opt/OpenIndBot/resources/server/openindbot.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/ind", (path) => path.endsWith("MacOS/OpenIndBot"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/ind", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\ind", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/OpenIndBot`, script: `${app}/Resources/server/openindbot.js`, dataDir: "/Users/ind/.openindbot", home: "/Users/ind", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/omb/cli.js", dataDir: "/home/ind/100% $HOME\\", home: "/home/my ind", out: "/home/my ind/.local/state/openindbot-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my ind"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/ind/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/ind\n[Service]\nExecStartPre=/bin/true", "/home/ind\r", "/home/\0ind"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js", dataDir: "/home/ind/My Data", home: "/home/ind", out: "/home/ind/.local/state/openindbot-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/ind/.config/systemd/user/openindbot-sentinel.service";
    const timer = "/home/ind/.config/systemd/user/openindbot-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/ind", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/ind", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/omb/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/ind", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/ind", fs([]))).toEqual({ status: "not_installed", unit: "/Users/ind/Library/LaunchAgents/com.openindbot.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/ind", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\ind", fs([]))).toEqual({ status: "unsupported" });
  });
});
