import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runServiceCommand, serviceServeArgs } from "./service-cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("openmausbot service", () => {
  let dir: string;
  const out: string[] = [];
  const err: string[] = [];
  const io = { log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-service-"));
    out.length = 0;
    err.length = 0;
  });
  afterEach(() => removeTempDir(dir));

  it("repeats the serve options the person gave, --public-url and --lan included", () => {
    expect(serviceServeArgs({ port: 8799, dataDir: "/d", domain: "a.example.com", tunnel: true, label: "x" })).toEqual(["--port", "8799", "--data-dir", "/d", "--domain", "a.example.com", "--label", "x"]);
    expect(serviceServeArgs({ port: 1, dataDir: "/d", tailscale: true })).toEqual(["--port", "1", "--data-dir", "/d", "--tailscale"]);
    expect(serviceServeArgs({ port: 1, dataDir: "/d", publicUrl: "https://maus.example.com", lan: true })).toEqual(["--port", "1", "--data-dir", "/d", "--public-url", "https://maus.example.com", "--lan"]);
  });

  it("writes the unit next to the data and prints how to install it; under npx, runs a copy kept beside the data", () => {
    const code = runServiceCommand({ action: "install", dataDir: dir, port: 8799, domain: "maus.example.com", script: "/usr/lib/node_modules/openmausbot/cli.js", node: "/usr/bin/node", platform: "linux", home: "/home/maus", user: "maus" }, io);
    expect(code).toBe(0);
    const unit = readFileSync(join(dir, "openmausbot.service"), "utf8");
    expect(unit).toContain("--domain maus.example.com");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(out.join("\n")).toContain("sudo systemctl enable --now openmausbot");
    expect(out.join("\n")).toContain("no setcap is needed");

    out.length = 0;
    const npx = { action: "install" as const, dataDir: join(dir, "x"), port: 8799, publicUrl: "https://maus.example.com", script: "/home/maus/.npm/_npx/deadbeef/node_modules/openmausbot/dist-server/openmausbot.js", node: "/usr/bin/node", platform: "linux" as const, home: "/home/maus", user: "maus" };
    const installs: string[] = [];
    expect(runServiceCommand({ ...npx, installCopy: (prefix) => { installs.push(prefix); return false; } }, io)).toBe(1);
    expect(err.join("\n")).toContain(`npm install --prefix ${join(dir, "x", "app", "latest")} openmausbot@latest`);
    expect(existsSync(join(dir, "x", "openmausbot.service"))).toBe(false);
    expect(runServiceCommand({ ...npx, installCopy: (prefix) => { installs.push(prefix); return true; }, exists: () => true }, io)).toBe(0);
    const pinned = readFileSync(join(dir, "x", "openmausbot.service"), "utf8");
    const script = join(dir, "x", "app", "latest", "node_modules", "openmausbot", "dist-server", "openmausbot.js");
    expect(pinned).toContain(`ExecStart=/usr/bin/node ${/[\s"\\]/.test(script) ? `"${script.replace(/[\\"]/g, "\\$&")}"` : script} serve`);
    expect(pinned).toContain("--public-url https://maus.example.com");
    expect(pinned).not.toContain("--no-pair");
    expect(pinned).toContain('Environment="OMB_CLI_PREFIX=npx openmausbot"');
    expect(installs).toEqual([join(dir, "x", "app", "latest"), join(dir, "x", "app", "latest")]);
  });

  it("writes a launchd agent on macOS and explains uninstall on both", () => {
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, tunnel: true, script: "/opt/homebrew/lib/node_modules/openmausbot/cli.js", node: "/opt/homebrew/bin/node", platform: "darwin", home: "/Users/maus" }, io)).toBe(0);
    expect(readFileSync(join(dir, "com.openmausbot.serve.plist"), "utf8")).toContain("<string>--tunnel</string>");
    expect(out.join("\n")).toContain("launchctl bootstrap");
    out.length = 0;
    expect(runServiceCommand({ action: "uninstall", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "linux" }, io)).toBe(0);
    expect(out.join("\n")).toContain("sudo systemctl disable --now openmausbot");
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "win32" }, io)).toBe(1);
  });

  it("--sentinel writes the scan's own schedule into its own folder, not the data dir, and only prints how to install it", () => {
    const sentinelOut = join(dir, "sentinel-state");
    const dataDir = join(dir, "data");
    const base = { action: "install" as const, dataDir, port: 8799, sentinel: true, sentinelOut, script: "/usr/lib/node_modules/openmausbot/cli.js", node: "/usr/bin/node", exists: () => false };
    expect(runServiceCommand({ ...base, platform: "darwin", home: "/Users/maus" }, io)).toBe(0);
    const plist = readFileSync(join(sentinelOut, "com.openmausbot.sentinel.plist"), "utf8");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(plist).toContain(`<string>${sentinelOut}</string>`);
    expect(out.join("\n")).toContain("openmausbot sentinel --check-install");
    expect(existsSync(dataDir)).toBe(false);
    expect(out.join("\n")).toContain("launchctl bootstrap gui/$(id -u) /Users/maus/Library/LaunchAgents/com.openmausbot.sentinel.plist");
    expect(out.join("\n")).toContain(`issues: ${join(sentinelOut, "issues.jsonl")}`);

    out.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: "/home/maus" }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "openmausbot-sentinel.service"), "utf8")).toContain("sentinel --once --data-dir");
    expect(readFileSync(join(sentinelOut, "openmausbot-sentinel.timer"), "utf8")).toContain("OnUnitActiveSec=120s");
    expect(out.join("\n")).toContain("systemctl --user enable --now openmausbot-sentinel.timer");
    expect(existsSync(dataDir)).toBe(false);

    out.length = 0;
    expect(runServiceCommand({ ...base, action: "uninstall", platform: "linux", home: "/home/maus" }, io)).toBe(0);
    expect(out.join("\n")).toContain("systemctl --user disable --now openmausbot-sentinel.timer");

    // Windows gets a schtasks line, with the platform's own folder as --out
    expect(runServiceCommand({ ...base, sentinelOut: undefined, platform: "win32", dataDir: "C:\\Users\\maus\\.openmausbot", home: "C:\\Users\\maus", env: {} }, io)).toBe(1);
    expect(err.join("\n")).toContain('schtasks /Create /SC MINUTE /MO 2 /TN "OpenMausBot Sentinel" /TR "\\"/usr/bin/node\\" \\"/usr/lib/node_modules/openmausbot/cli.js\\" \\"sentinel\\"');
    expect(err.join("\n")).toContain("\\\"--out\\\" \\\"C:\\Users\\maus\\AppData\\Local\\openmausbot-sentinel\\\"");
  });

  // Simulates a Linux install with the host's paths; on Windows those are backslash paths no Linux unit has.
  it.skipIf(process.platform === "win32")("--sentinel refuses an output folder the scan itself would refuse, before writing anything", () => {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    const base = { action: "install" as const, dataDir, port: 8799, sentinel: true, script: "/usr/lib/node_modules/openmausbot/cli.js", node: "/usr/bin/node", exists: () => false };
    // XDG_STATE_HOME pointing into the data dir makes the default land there
    expect(runServiceCommand({ ...base, platform: "linux", home: join(dir, "home"), env: { XDG_STATE_HOME: join(dataDir, "state") } }, io)).toBe(1);
    expect(err.join("\n")).toContain("refusing to write issues inside the data dir");
    expect(existsSync(join(dataDir, "state"))).toBe(false);
    // a path no unit file can hold
    err.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: join(dir, "home"), sentinelOut: join(dir, "out"), dataDir: `${dataDir}\nExecStartPre=/bin/true` }, io)).toBe(1);
    expect(err.join("\n")).toContain("line break or NUL");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("--sentinel prefers the installed app's own CLI over a checkout, which an update or Node upgrade would strand", () => {
    const sentinelOut = join(dir, "sentinel-state");
    const app = "/Applications/OpenMausBot.app/Contents";
    const checkout = { action: "install" as const, dataDir: join(dir, "data"), port: 8799, sentinel: true, sentinelOut, script: "/src/OpenMausBot/server/openmausbot.ts", node: "/home/maus/.nvm/versions/node/v24.0.0/bin/node", platform: "darwin" as const, home: "/Users/maus" };
    expect(runServiceCommand({ ...checkout, exists: (path) => path.startsWith(app), hasSentinel: () => true }, io)).toBe(0);
    const plist = readFileSync(join(sentinelOut, "com.openmausbot.sentinel.plist"), "utf8");
    expect(plist).toContain(`<string>${app}/MacOS/OpenMausBot</string>`);
    expect(plist).toContain(`<string>${app}/Resources/server/openmausbot.js</string>`);
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(plist).not.toContain("openmausbot.ts");
    expect(out.join("\n")).toContain("runs the desktop app's own CLI");

    // an installed app from before Sentinel, or none: the checkout it was run
    // from, with a warning that it can move
    out.length = 0;
    expect(runServiceCommand({ ...checkout, exists: (path) => path.startsWith(app), hasSentinel: () => false }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "com.openmausbot.sentinel.plist"), "utf8")).not.toContain("ELECTRON_RUN_AS_NODE");
    out.length = 0;
    expect(runServiceCommand({ ...checkout, exists: () => false }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "com.openmausbot.sentinel.plist"), "utf8")).toContain("<string>--experimental-strip-types</string>");
    expect(out.join("\n")).toContain("if either moves (a new checkout, a Node upgrade), run this again");
  });
});
