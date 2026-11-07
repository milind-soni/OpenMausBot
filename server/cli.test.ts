import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyStartupPreferences, parseArgs, runAccess, runLogin, runOnboardingCommand, serverEntry, type CliOptions, verifyPhoneEndpoint } from "./cli.ts";
import { browserSignInLines, formatSessions, pairingBlock, qrToString } from "./cli-pairing.ts";
import { readAdminActivityRange } from "./admin-activity.ts";
import { SetupCancelled } from "./cli-prompts.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startControlPlaneStub } from "./testing/control-plane-stub.ts";
import { freePortBlock } from "./testing/ports.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const setup = vi.hoisted(() => ({ runSetup: vi.fn(), isSetupComplete: vi.fn(), readCliStartup: vi.fn(), saveCliStartup: vi.fn() }));
vi.mock("./cli-setup.ts", () => setup);

describe("openmausbot command line", () => {
  it("parses commands and flags, and explains mistakes", () => {
    const serve = parseArgs(["serve", "--port", "9001", "--data-dir", "/tmp/x", "--label", "cab mini", "--tailscale", "--no-pair"], {});
    // --data-dir is resolved against the platform: C:\tmp\x on Windows.
    expect(serve).toMatchObject({ command: "serve", port: 9001, dataDir: resolve("/tmp/x"), label: "cab mini", tailscale: true, pair: false });
    expect(parseArgs(["pair", "--client", "--public-url", "https://h/"], {})).toMatchObject({ command: "pair", client: true, publicUrl: "https://h" });
    expect(parseArgs(["sessions", "revoke", "abc"], {})).toMatchObject({ command: "sessions", revoke: "abc" });
    expect(parseArgs(["pair", "--client", "--ttl", "24h"], {})).toMatchObject({ command: "pair", client: true, pairTtlMs: 86_400_000 });
    expect(parseArgs(["pair", "--ttl", "2d"], {})).toEqual({ error: "--ttl must be a duration from 1m to 24h, such as 90, 90s, 5m or 2h" });
    expect(parseArgs(["pair", "--ttl", "30s"], {})).toMatchObject({ error: expect.stringContaining("from 1m to 24h") });
    expect(parseArgs(["serve", "--ttl", "1h"], {})).toEqual({ error: 'unknown argument "--ttl"' });
    expect(parseArgs(["fleet", "create", "acme", "--admin", "ada@example.test", "--member", "@acme.test", "--member", "bob@acme.test", "--cap", "40", "--memory", "1G", "--dry-run"], {})).toMatchObject({
      command: "fleet", fleetAction: "create", slug: "acme", admins: ["ada@example.test"], members: ["@acme.test", "bob@acme.test"], cap: 40, memory: "1G", dryRun: true,
    });
    expect(parseArgs(["fleet", "users", "acme", "add", "bob@acme.test", "--chat-only"], {})).toMatchObject({ command: "fleet", fleetAction: "users", slug: "acme", fleetUserAction: "add", email: "bob@acme.test", chatOnly: true });
    expect(parseArgs(["fleet", "delete", "acme", "--yes", "--keep-data"], {})).toMatchObject({ fleetAction: "delete", slug: "acme", yes: true, keepData: true });
    expect(parseArgs(["fleet", "init", "--domain", "AgentAda.cc", "--operator", "maus"], {})).toMatchObject({ fleetAction: "init", domain: "agentada.cc", operator: "maus" });
    expect(parseArgs(["fleet", "agent", "--socket", "/run/x.sock", "--group", "maus"], {})).toMatchObject({ fleetAction: "agent", socket: "/run/x.sock", group: "maus" });
    expect(parseArgs(["fleet"], {})).toMatchObject({ error: expect.stringContaining("fleet needs one of") });
    expect(parseArgs(["fleet", "create"], {})).toMatchObject({ error: "fleet create needs a workspace name" });
    expect(parseArgs(["fleet", "users", "acme"], {})).toMatchObject({ error: expect.stringContaining("add|remove") });
    expect(parseArgs(["fleet", "create", "acme", "--cap", "-5"], {})).toMatchObject({ error: expect.stringContaining("--cap") });
    expect(parseArgs([], { OMB_PORT: "8123" })).toMatchObject({ command: "start", port: 8123 });
    expect(parseArgs(["--port", "8125", "--no-open", "--local"], {})).toMatchObject({ command: "start", port: 8125, open: false, local: true });
    expect(parseArgs(["--help"], {})).toMatchObject({ command: "help" });
    expect(parseArgs(["-h"], {})).toMatchObject({ command: "help" });
    expect(parseArgs(["--local", "--tunnel"], {})).toHaveProperty("error");
    expect(parseArgs(["dance"], {})).toEqual({ error: 'unknown command "dance"' });
    expect(parseArgs(["serve", "--port"], {})).toEqual({ error: "--port needs a value" });
    expect(parseArgs(["serve", "--port", "70000"], {})).toEqual({ error: "--port must be 1-65535" });
    expect(parseArgs(["pair", "--public-url", "mini.example"], {})).toEqual({ error: "--public-url must start with http:// or https://" });
    expect(parseArgs(["serve", "--bogus"], {})).toEqual({ error: 'unknown argument "--bogus"' });
    expect(parseArgs(["serve", "--tunnel"], {})).toMatchObject({ command: "serve", tunnel: true });
    expect(parseArgs(["setup", "--data-dir", "/tmp/cli-setup"], {})).toMatchObject({ command: "setup", dataDir: resolve("/tmp/cli-setup") });
    expect(parseArgs(["start", "--port", "8125", "--no-pair"], {})).toMatchObject({ command: "start", port: 8125, pair: false });
    expect(parseArgs(["login", "--email", "a@b.test"], {})).toMatchObject({ command: "login", email: "a@b.test" });
    expect(parseArgs(["logout"], {})).toMatchObject({ command: "logout" });
    expect(parseArgs(["browser", "install", "--with-deps"], {})).toMatchObject({ command: "browser", browserAction: "install", withDeps: true });
    expect(parseArgs(["browser", "status"], {})).toMatchObject({ command: "browser", browserAction: "status" });
    expect(parseArgs(["browser"], {})).toEqual({ error: "browser needs an action: install or status" });
    expect(parseArgs(["serve", "--tailscale", "--tunnel"], {})).toEqual({ error: "choose one of --tailscale (your tailnet) and --tunnel (a public address)" });
    expect(parseArgs(["access", "add", "her@example.test", "--chat-only"], {})).toMatchObject({ command: "access", accessAction: "add", email: "her@example.test", chatOnly: true });
    expect(parseArgs(["access", "list"], {})).toMatchObject({ command: "access", accessAction: "list" });
    expect(parseArgs(["access"], {})).toEqual({ error: "access needs one of: list, add EMAIL [--chat-only], remove EMAIL" });
    expect(parseArgs(["access", "add"], {})).toEqual({ error: "add needs a value" });
    expect(parseArgs(["service", "install", "--domain", "maus.example.com", "--port", "8799"], {})).toMatchObject({ command: "service", serviceAction: "install", domain: "maus.example.com", port: 8799 });
    expect(parseArgs(["service", "uninstall"], {})).toMatchObject({ command: "service", serviceAction: "uninstall" });
    expect(parseArgs(["service", "install", "--sentinel"], {})).toMatchObject({ command: "service", serviceAction: "install", sentinel: true });
    expect(parseArgs(["serve", "--sentinel"], {})).toEqual({ error: expect.stringContaining("--sentinel") });
    expect(parseArgs(["service"], {})).toEqual({ error: expect.stringContaining("service needs one of") });
    expect(parseArgs(["serve", "--domain", "Maus.Example.com"], {})).toMatchObject({ command: "serve", domain: "maus.example.com" });
    expect(parseArgs(["serve", "--domain", "localhost"], {})).toEqual({ error: expect.stringContaining("bare hostname") });
    expect(parseArgs(["serve", "--domain", "maus.example.com", "--tunnel"], {})).toEqual({ error: expect.stringContaining("--domain already gives") });
  });

  it("parses the reseller flags of fleet init, create, brand, rates and billing, and refuses the wrong shape", () => {
    expect(parseArgs(["fleet", "init", "--domain", "agentada.cc", "--reseller-name", "Acme Cloud", "--currency", "eur", "--license-key-file", "/tmp/key"], {})).toMatchObject({
      fleetAction: "init", domain: "agentada.cc", resellerName: "Acme Cloud", currency: "EUR", licenseKeyFile: resolve("/tmp/key"),
    });
    expect(parseArgs(["fleet", "create", "acme", "--admin", "ada@example.test", "--host", "chat.acme.example"], {})).toMatchObject({ fleetAction: "create", slug: "acme", host: "chat.acme.example" });
    expect(parseArgs(["fleet", "brand", "acme", "--brand-name", "Acme", "--tagline", "Ask", "--accent", "#C2510A", "--support-url", "https://acme.example/help", "--logo", "logo.png", "--favicon", "icon.ico", "--clear", "tagline", "--clear", "accent"], {})).toMatchObject({
      fleetAction: "brand", slug: "acme", brandPatch: { name: "Acme", tagline: "Ask", accent: "#C2510A", supportUrl: "https://acme.example/help" },
      logoSource: resolve("logo.png"), faviconSource: resolve("icon.ico"), brandClear: ["tagline", "accent"],
    });
    expect(parseArgs(["fleet", "brand", "--default", "--logo", "https://acme.example/logo.svg"], {})).toMatchObject({ fleetAction: "brand", brandDefault: true, logoSource: "https://acme.example/logo.svg" });
    expect(parseArgs(["fleet", "rates", "--currency", "USD", "--wholesale-workspace", "25", "--wholesale-user", "3.5", "--retail-workspace", "49.00", "--retail-user", "5.00", "--retail-override", "acme=39.00/4.50", "--retail-override", "beta=/6", "--clear-override", "old"], {})).toMatchObject({
      fleetAction: "rates", currency: "USD",
      ratesPatch: {
        wholesale: { workspaceMonthMinor: 2500, userMonthMinor: 350 }, retail: { workspaceMonthMinor: 4900, userMonthMinor: 500 },
        overrides: { acme: { workspaceMonthMinor: 3900, userMonthMinor: 450 }, beta: { userMonthMinor: 600 } }, clearOverrides: ["old"],
      },
    });
    expect(parseArgs(["fleet", "billing", "--month", "2026-09", "--csv", "--detail", "--license-key-file", "/tmp/key"], {})).toMatchObject({ fleetAction: "billing", month: "2026-09", csv: true, detail: true, licenseKeyFile: resolve("/tmp/key") });
    expect(parseArgs(["fleet", "billing"], {})).not.toHaveProperty("slug");
    expect(parseArgs(["fleet", "billing", "--max-users", "2500"], {})).toMatchObject({ fleetAction: "billing", maxUsers: 2500 });
    expect(parseArgs(["fleet", "billing"], {})).not.toHaveProperty("maxUsers");
    expect(parseArgs(["fleet"], {})).toMatchObject({ error: expect.stringContaining("brand NAME|--default, rates, billing") });

    const refused = (args: string[]) => (parseArgs(["fleet", ...args], {}) as { error?: string }).error;
    expect(refused(["billing", "2026-09"])).toBe('unknown argument "2026-09"');
    expect(refused(["rates", "acme"])).toBe('unknown argument "acme"');
    expect(refused(["brand"])).toBe("fleet brand needs a workspace name or --default");
    expect(refused(["brand", "acme", "--default"])).toBe("fleet brand takes a workspace name or --default, not both");
    expect(refused(["brand", "acme", "--clear", "colour"])).toContain("--clear takes one of");
    expect(refused(["brand", "acme", "--logo", "http://acme.example/logo.png"])).toContain("--logo takes");
    expect(refused(["brand", "acme", "--favicon", "https://acme.example/icon.png"])).toContain("not fetched");
    expect(refused(["billing", "--month", "2026-13"])).toContain("--month takes");
    expect(refused(["billing", "--month", "September"])).toContain("--month takes");
    expect(refused(["rates", "--currency", "JPY"])).toContain("not supported");
    expect(refused(["rates", "--retail-user", "5.001"])).toContain("at most two decimals");
    expect(refused(["rates", "--retail-user", "-5"])).toContain("at most two decimals");
    expect(refused(["rates", "--retail-override", "acme"])).toContain("NAME=WORKSPACE/USER");
    expect(refused(["rates", "--retail-override", "acme=/"])).toContain("NAME=WORKSPACE/USER");
    expect(refused(["rates", "--retail-override", "Acme=1/1"])).toContain("NAME=WORKSPACE/USER");
    expect(refused(["rates", "--retail-override", "acme=1/1", "--retail-override", "acme=2/2"])).toContain("twice");
    expect(refused(["rates", "--clear-override", "Not A Name"])).toContain("--clear-override takes");
    expect(refused(["list", "--host", "x.example"])).toBe("only fleet create takes --host");
    expect(refused(["billing", "--wholesale-user", "1"])).toBe("only fleet rates takes the rate flags");
    expect(refused(["create", "acme", "--month", "2026-09"])).toBe("only fleet billing takes --month, --csv and --detail");
    expect(refused(["create", "acme", "--currency", "USD"])).toBe("only fleet init and fleet rates take --currency");
    expect(refused(["create", "acme", "--reseller-name", "Acme"])).toBe("only fleet init takes --reseller-name");
    expect(refused(["billing", "--month"])).toBe("--month needs a value");
    for (const bad of ["0", "10001", "-1", "1.5", "many", "1e3"]) expect(refused(["billing", "--max-users", bad])).toBe("--max-users takes a whole number from 1 to 10000");
    expect(parseArgs(["fleet", "billing", "--max-users", "10000"], {})).toMatchObject({ maxUsers: 10000 });
    expect(refused(["list", "--max-users", "5"])).toBe("only fleet billing takes --max-users");
    expect(refused(["billing", "--max-users"])).toBe("--max-users needs a value");
  });

  it("takes the phone kind non-interactively, because a scripted pair never sees the chooser", () => {
    expect(parseArgs(["pair", "--phone", "android"], {})).toMatchObject({ command: "pair", phone: "android" });
    expect(parseArgs(["pair", "--phone", "iOS"], {})).toMatchObject({ phone: "ios" });
    expect(parseArgs(["pair", "--phone", "blackberry"], {})).toEqual({ error: expect.stringContaining("ios or android") });
  });

  it("prints a scannable block with the link, or says where to type the code", () => {
    const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: "https://mini.example/pair#code=ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 });
    expect(block).toContain("pairing code:  ABCD-EFGH-JKLM");
    expect(block).toContain("open or scan:  https://mini.example/pair#code=ABCD-EFGH-JKLM");
    expect(block).toMatch(/[▀▄█]/);
    const noUrl = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, expiresAt: Date.now(), hint: "set OMB_PUBLIC_URL" });
    expect(noUrl).toContain("/pair on the address you use");
    expect(noUrl).toContain("set OMB_PUBLIC_URL");
    expect(qrToString("https://example.com").length).toBeGreaterThan(200);
  });

  it("adds a link that signs in a browser on this computer, which is no longer the owner by being here", () => {
    const local = "http://127.0.0.1:8799/pair#code=ABCD-EFGH-JKLM";
    const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, localUrl: local, expiresAt: Date.now() + 60_000, hint: "set OMB_PUBLIC_URL" });
    expect(block).toContain(`this computer: ${local}`);
    expect(block).toContain("/pair on the address you use");
    expect(block).not.toContain(qrToString(local));
    const guided = browserSignInLines(local, "ABCD-EFGH-JKLM", Date.now() + 60_000);
    expect(guided).toContain(local);
    expect(guided).toContain("ABCD-EFGH-JKLM");
    expect(guided).toContain("openmausbot pair");
  });

  describe("the two links one pairing window has", () => {
    const url = "https://mini.example/pair#code=ABCD-EFGH-JKLM";
    const invite = `openmausbot://pair?address=https%3A%2F%2Fmini.example&token=omb_pair_${"a".repeat(43)}&name=mini`;
    const block = (over: Record<string, unknown> = {}) =>
      pairingBlock({ code: "ABCD-EFGH-JKLM", url, inviteUrl: invite, expiresAt: Date.now() + 60_000, ...over });

    it("gives an Android phone the app-scheme QR, because its scanner rejects https", () => {
      const out = block({ phone: "android" });
      expect(out).toContain(qrToString(invite));
      expect(out).not.toContain(qrToString(url));
      expect(out).toContain("Scan that in the OpenMausBot app");
      expect(out).toContain(`web browser:   ${url}`);
      expect(out).not.toContain("open or scan:");
    });

    it("gives everyone else the web QR, and still prints the app link rather than only naming it", () => {
      const out = block({ phone: "ios" });
      expect(out).toContain(qrToString(url));
      expect(out).not.toContain(qrToString(invite));
      expect(out).toContain(`phone app:     ${invite}`);
      expect(out).toContain(`open or scan:  ${url}`);
    });

    it("says plainly when an Android phone asked for an app link this server cannot build", () => {
      const out = block({ phone: "android", inviteUrl: null });
      expect(out).toContain(qrToString(url));
      expect(out).toContain("The Android app needs the phone-app link");
      expect(out).toContain("OMB_PUBLIC_URL");
      expect(out).not.toContain("Scan that in the OpenMausBot app");
    });
  });

  it("lists sessions as a table with relative last-seen times", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    const table = formatSessions([
      { id: "a1", label: "My MacBook", scopes: ["admin", "client"], lastSeenAt: now - 30_000, expiresAt: now + 86_400_000 },
      { id: "b2", label: "", scopes: ["client"], lastSeenAt: now - 3 * 3_600_000, expiresAt: now + 86_400_000 },
    ], now);
    expect(table).toContain("My MacBook");
    expect(table).toContain("(unnamed)");
    expect(table).toMatch(/a1\s+My MacBook\s+admin\s+just now/);
    expect(table).toMatch(/b2\s+\(unnamed\)\s+client\s+3 h ago/);
    expect(table).toContain("sessions revoke <id>");
    expect(formatSessions([{ id: "c3", label: "Nightly CI", scopes: ["client"], lastSeenAt: now, expiresAt: now, token: true }], now)).toContain("Nightly CI (token)");
  });

  it("finds the server next to itself: bundled index.js in a package, the TypeScript source in a checkout", () => {
    const checkout = serverEntry(SERVER_DIR);
    expect(checkout.args[0]).toBe("--experimental-strip-types");
    expect(checkout.args[1]).toBe(join(SERVER_DIR, "index.ts"));
    expect(checkout.skillsDir).toBe(join(SERVER_DIR, "..", "skills"));
  });

  it("serve: starts the server, prints the pairing link, and stops on SIGTERM", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-serve-"));
    const port = workerPort(21000, 9000);
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "openmausbot.ts"), "serve", "--port", String(port), "--data-dir", join(home, "data"), "--label", "cli test", "--public-url", "https://mini.example"], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, OMB_WEBHOOK_PORT: String(port + 1), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out).toContain(`OpenMausBot is running on http://127.0.0.1:${port}, reachable at https://mini.example`);
      expect(out).toMatch(/pairing code:  [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
      expect(out).toContain("open or scan:  https://mini.example/pair#code=");
      expect(out).toMatch(/[▀▄█]/);
      const descriptor: any = await (await fetch(`http://127.0.0.1:${port}/.well-known/openmausbot/environment`)).json();
      expect(descriptor.label).toBe("cli test");
      const pairing: any = await (await fetch(`http://127.0.0.1:${port}/api/auth/pairing`)).json();
      expect(pairing.pairings.length).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
    }
    let dead = false;
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      dead = true;
    }
    expect(dead).toBe(true);
  }, 90_000);
});

describe("terminal onboarding commands", () => {
  const inputTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outputTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const terminal = (enabled: boolean) => {
    Object.defineProperty(process.stdin, "isTTY", { value: enabled, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: enabled, configurable: true });
  };
  afterEach(() => {
    if (inputTty) Object.defineProperty(process.stdin, "isTTY", inputTty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (outputTty) Object.defineProperty(process.stdout, "isTTY", outputTty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });
  const command = (name: "setup" | "start") => parseArgs([name, "--data-dir", join(process.env.HOME!, "onboarding"), "--port", "18451"], {}) as CliOptions;
  const io = () => ({ log: vi.fn(), error: vi.fn(), ask: vi.fn() });
  const preserveEnv = () => vi.stubEnv("OMB_DATA_DIR", process.env.OMB_DATA_DIR);
  const phoneSetup = vi.fn<NonNullable<NonNullable<Parameters<typeof runOnboardingCommand>[3]>["phoneSetup"]>>();
  const running = vi.fn().mockResolvedValue(false);
  const open = vi.fn().mockResolvedValue(true);
  const flow = { phoneSetup, running, open };
  beforeEach(() => {
    phoneSetup.mockImplementation(async (options) => ({ options }));
    running.mockResolvedValue(false);
    open.mockResolvedValue(true);
  });

  it("runs explicit setup once and explains how to start without launching a server", async () => {
    terminal(true);
    preserveEnv();
    const options = command("setup");
    const output = io();
    const serve = vi.fn();
    setup.runSetup.mockImplementation(async () => {
      expect(process.env.OMB_DATA_DIR).toBe(options.dataDir);
      return true;
    });
    expect(await runOnboardingCommand(options, output, serve, flow)).toBe(0);
    expect(setup.runSetup).toHaveBeenCalledWith({ dataDir: options.dataDir, port: options.port });
    expect(setup.isSetupComplete).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("Start with: openmausbot"));
    expect(phoneSetup).toHaveBeenCalledOnce();
    expect(setup.saveCliStartup).toHaveBeenCalledWith(options.dataDir, { access: "local" });
  });

  it("starts after first-time setup and passes through the requested serve options", async () => {
    terminal(true);
    preserveEnv();
    const options = command("start");
    setup.isSetupComplete.mockResolvedValue(false);
    setup.runSetup.mockResolvedValue(true);
    const serve = vi.fn().mockResolvedValue(0);
    expect(await runOnboardingCommand(options, io(), serve, flow)).toBe(0);
    expect(setup.runSetup).toHaveBeenCalledOnce();
    expect(serve).toHaveBeenCalledWith({ ...options, guided: true });
  });

  it("uses completed setup without prompting even when start has no terminal", async () => {
    terminal(false);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(true);
    const serve = vi.fn().mockResolvedValue(7);
    expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(7);
    expect(setup.runSetup).not.toHaveBeenCalled();
    expect(serve).toHaveBeenCalledOnce();
  });

  it.each(["setup", "start"] as const)("refuses an unconfigured %s without a terminal", async (name) => {
    terminal(false);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(false);
    const output = io();
    const serve = vi.fn();
    expect(await runOnboardingCommand(command(name), output, serve, flow)).toBe(1);
    expect(setup.runSetup).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("interactive terminal"));
  });

  it.each([false, new SetupCancelled()])("does not start after setup is cancelled (%s)", async (result) => {
    terminal(true);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(false);
    if (result instanceof Error) setup.runSetup.mockRejectedValue(result);
    else setup.runSetup.mockResolvedValue(result);
    const serve = vi.fn();
    expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(130);
    expect(serve).not.toHaveBeenCalled();
  });

  it("persists an explicitly chosen phone route and uses it on later starts without prompts", async () => {
    terminal(true);
    preserveEnv();
    const options = command("start");
    setup.isSetupComplete.mockResolvedValue(true);
    phoneSetup.mockResolvedValue({ options: { ...options, tunnel: true, client: true }, phone: "android" });
    const serve = vi.fn().mockResolvedValue(0);
    await runOnboardingCommand(options, io(), serve, flow);
    expect(setup.saveCliStartup).toHaveBeenCalledWith(options.dataDir, { access: "tunnel", phone: "android" });
    expect(serve).toHaveBeenLastCalledWith(expect.objectContaining({ tunnel: true, phone: "android", guided: true }));
    phoneSetup.mockClear();
    setup.readCliStartup.mockReturnValue({ access: "tunnel", phone: "android" });
    await runOnboardingCommand(options, io(), serve, flow);
    expect(phoneSetup).not.toHaveBeenCalled();
    expect(serve).toHaveBeenLastCalledWith(expect.objectContaining({ tunnel: true, phone: "android" }));
  });

  it("keeps the provider setup but does not start if phone setup is cancelled", async () => {
    terminal(true);
    preserveEnv();
    setup.runSetup.mockResolvedValue(true);
    phoneSetup.mockRejectedValue(new SetupCancelled());
    const serve = vi.fn();
    const output = io();
    expect(await runOnboardingCommand(command("start"), output, serve, flow)).toBe(130);
    expect(serve).not.toHaveBeenCalled();
    expect(setup.saveCliStartup).not.toHaveBeenCalled();
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("already saved is kept"));
  });

  it("reopens an already-running workspace without setup, pairing, or a second server", async () => {
    terminal(true);
    preserveEnv();
    running.mockResolvedValue(true);
    const serve = vi.fn();
    expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(0);
    expect(open).toHaveBeenCalledWith(18451);
    expect(setup.runSetup).not.toHaveBeenCalled();
    expect(phoneSetup).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("honors --no-pair and --no-open without saving an access choice", async () => {
    terminal(true);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(true);
    const serve = vi.fn().mockResolvedValue(0);
    await runOnboardingCommand({ ...command("start"), pair: false, open: false }, io(), serve, flow);
    expect(phoneSetup).not.toHaveBeenCalled();
    expect(setup.saveCliStartup).not.toHaveBeenCalled();
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ pair: false, open: false }));
  });

  it("does not claim --local changed an already-running public workspace", async () => {
    terminal(true);
    preserveEnv();
    running.mockResolvedValue(true);
    const output = io();
    const serve = vi.fn();
    expect(await runOnboardingCommand({ ...command("start"), local: true }, output, serve, flow)).toBe(1);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("current connection was not changed"));
    expect(open).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("does not persist a credential-bearing explicit URL even when phone setup is skipped", async () => {
    terminal(true);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(true);
    const options = { ...command("start"), publicUrl: "https://user:secret@example.com" };
    const serve = vi.fn();
    await expect(runOnboardingCommand(options, io(), serve, flow)).rejects.toThrow("address was not saved");
    expect(setup.saveCliStartup).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });
});

describe("saved startup access", () => {
  const options = () => parseArgs([], {}) as CliOptions;
  it("keeps local launches local and supports a one-time local override", () => {
    expect(applyStartupPreferences(options(), { access: "local" })).toMatchObject({ tunnel: false, tailscale: false, publicUrl: undefined });
    expect(applyStartupPreferences({ ...options(), local: true }, { access: "tunnel", phone: "ios" })).toMatchObject({ tunnel: false, phone: undefined });
  });
  it("explicit route flags take priority over saved settings", () => {
    expect(applyStartupPreferences({ ...options(), tailscale: true }, { access: "tunnel" })).toMatchObject({ tailscale: true, tunnel: false });
  });
  it("refuses a saved URL that embeds a credential or points to localhost", () => {
    for (const publicUrl of ["https://localhost", "https://user:secret@example.com", "https://example.com/pair#code=secret"])
      expect(() => applyStartupPreferences(options(), { access: "public-url", publicUrl })).toThrow("not a valid HTTPS origin");
  });
});

describe("phone endpoint identity", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("checks the public endpoint matches this server without sending credentials", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ environmentId: "fixture" }))
      .mockResolvedValueOnce(Response.json({ environmentId: "fixture" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await verifyPhoneEndpoint(18451, "https://maus.example.com")).toBe(true);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ redirect: "error" });
    expect(fetcher.mock.calls[1]![1]).not.toHaveProperty("headers");
  });
  it("refuses another server or unreachable origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ environmentId: "ours" }))
      .mockResolvedValueOnce(Response.json({ environmentId: "other" })));
    expect(await verifyPhoneEndpoint(18451, "https://maus.example.com")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await verifyPhoneEndpoint(18451, "https://maus.example.com")).toBe(false);
    expect(await verifyPhoneEndpoint(18451, "https://localhost")).toBe(false);
  });
});

const exited = (child: ChildProcess) => (child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise<number | null>((done) => child.once("exit", (code) => done(code))));

describe.skipIf(process.platform === "win32")("serve --tunnel", () => {
  const cli = (args: string[], env: NodeJS.ProcessEnv) =>
    spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "openmausbot.ts"), ...args], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("refuses without an account and says what to do; no local-only fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-tunnel-none-"));
    const port = workerPort(21000, 9000);
    const child = cli(["serve", "--tunnel", "--port", String(port), "--data-dir", join(home, "data")], { HOME: home, USERPROFILE: home });
    let err = "";
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    try {
      expect(await exited(child)).toBe(1);
      expect(err).toContain("run `openmausbot login` first");
      let dead = false;
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`);
      } catch {
        dead = true;
      }
      expect(dead).toBe(true);
    } finally {
      await removeTempDir(home);
    }
  }, 30_000);

  it("a fleet credential in the environment serves --tunnel with no account file and no code", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-fleet-"));
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const stub = await startControlPlaneStub();
    const fake = join(home, "cloudflared");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    const port = await freePortBlock([0, 1, 10_000]);
    const originPort = port + 10_000;
    const fleetEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"),
      OMB_CONTROL_PLANE_URL: stub.url,
      OMB_CLOUDFLARED_PATH: fake,
      OMB_TUNNEL_ORIGIN_PORT: String(originPort),
    };
    const rejected = cli(["serve", "--tunnel", "--no-pair", "--port", String(port), "--data-dir", dataDir], {
      ...fleetEnv,
      OMB_INSTALLATION_CREDENTIAL: `omb_install_${"x".repeat(22)}.${"y".repeat(43)}`,
    });
    let err = "";
    rejected.stderr?.on("data", (chunk) => (err += String(chunk)));
    expect(await exited(rejected)).toBe(1);
    expect(err).toContain("was rejected");

    const child = cli(["serve", "--tunnel", "--no-pair", "--port", String(port), "--data-dir", dataDir], {
      ...fleetEnv,
      OMB_INSTALLATION_CREDENTIAL: stub.seedInstallation("fleet box"),
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (out += String(chunk)));
    const gateway = `http://127.0.0.1:${originPort}`;
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes("OpenMausBot is running") && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out).toContain("using the installation credential from OMB_INSTALLATION_CREDENTIAL");
      expect(out).toContain(`reachable at ${stub.endpointUrl}`);
      expect(existsSync(join(dataDir, "tunnel-account.json"))).toBe(false);
      let status = 0;
      const gatewayDeadline = Date.now() + 20_000;
      while (Date.now() < gatewayDeadline && status !== 200) {
        try {
          status = (await fetch(`${gateway}/.well-known/openmausbot/environment`)).status;
        } catch {
          status = 0;
        }
        if (status !== 200) await new Promise((r) => setTimeout(r, 250));
      }
      expect(status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await exited(child);
      await stub.close();
      await removeTempDir(home);
    }
  }, 120_000);

  it("serves at the account's public address through the gateway, where every request is remote", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-tunnel-"));
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const stub = await startControlPlaneStub();
    const fake = join(home, "cloudflared");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    // sign this data dir in, in-process, against the stub
    vi.stubEnv("OMB_CONTROL_PLANE_URL", stub.url);
    const quiet = { log: () => undefined, error: () => undefined, ask: async () => stub.otp };
    expect(await runLogin({ command: "login", port: 1, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false, email: "cli@example.test" }, quiet)).toBe(0);
    vi.unstubAllEnvs();
    const port = await freePortBlock([0, 1, 10_000]);
    const originPort = port + 10_000;
    const child = cli(["serve", "--tunnel", "--port", String(port), "--data-dir", dataDir, "--label", "tunnel test"], {
      HOME: home,
      USERPROFILE: home,
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"),
      OMB_CONTROL_PLANE_URL: stub.url,
      OMB_CLOUDFLARED_PATH: fake,
      OMB_TUNNEL_ORIGIN_PORT: String(originPort),
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (out += String(chunk)));
    const gateway = `http://127.0.0.1:${originPort}`;
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out).toContain(`OpenMausBot is running on http://127.0.0.1:${port}, reachable at ${stub.endpointUrl}`);
      expect(out).toContain(`open or scan:  ${stub.endpointUrl}/pair#code=`);
      expect(stub.calls).toContain("POST /v1/installations/self/endpoint");

      let descriptor: Response | null = null;
      const gatewayDeadline = Date.now() + 20_000;
      while (Date.now() < gatewayDeadline) {
        try {
          descriptor = await fetch(`${gateway}/.well-known/openmausbot/environment`);
          if (descriptor.status === 200) break;
        } catch {
          descriptor = null;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(descriptor?.status, out.match(/^tunnel:.*$/gm)?.join("\n")).toBe(200);
      // A request with no headers, which the loopback listener would take as the owner, is a stranger through the gateway.
      const stranger = await fetch(`${gateway}/api/bots`);
      expect(stranger.status).toBe(403);
      expect(((await stranger.json()) as { error: string }).error).toMatch(/through a proxy/);
      expect(await (await fetch(`${gateway}/api/health`)).json()).toEqual({ app: "openmausbot" });
      expect(typeof ((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { pid: unknown }).pid).toBe("number");
      const match = /pairing code:  ([A-Z2-9-]+)/.exec(out);
      expect(match).toBeTruthy();
      const paired = await fetch(`${gateway}/api/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ code: match?.[1] ?? "", label: "phone" }),
      });
      expect(paired.status).toBe(200);
      const { token } = (await paired.json()) as { token: string };
      const mine = await fetch(`${gateway}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } });
      expect(mine.status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await exited(child);
      await stub.close();
      await removeTempDir(home);
    }
    for (const url of [`${gateway}/api/health`, `http://127.0.0.1:${port}/api/health`]) {
      let dead = false;
      try {
        await fetch(url);
      } catch {
        dead = true;
      }
      expect(dead, url).toBe(true);
    }
  }, 120_000);
});

describe("openmausbot access", () => {
  it("edits the sign-in allow-list in config.json without a running server", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-access-"));
    const dataDir = join(home, "data");
    const out: string[] = [];
    const err: string[] = [];
    const io = { log: (line: string) => out.push(line), error: (line: string) => err.push(line), ask: async () => "" };
    const base = { command: "access" as const, port: 1, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false };
    try {
      expect(await runAccess({ ...base, accessAction: "list" }, io)).toBe(0);
      expect(out.at(-1)).toMatch(/pairing codes only/);
      expect(await runAccess({ ...base, accessAction: "add", email: "Her@Example.test" }, io)).toBe(0);
      expect(await runAccess({ ...base, accessAction: "add", email: "@agentada.test", chatOnly: true }, io)).toBe(0);
      expect(await runAccess({ ...base, accessAction: "add", email: "not-an-email" }, io)).toBe(2);
      const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
      expect(saved.signIn).toEqual({ admins: ["her@example.test"], members: ["@agentada.test"] });
      expect(await runAccess({ ...base, accessAction: "add", email: "her@example.test", chatOnly: true }, io)).toBe(0);
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).signIn).toEqual({ admins: [], members: ["@agentada.test", "her@example.test"] });
      out.length = 0;
      expect(await runAccess({ ...base, accessAction: "list" }, io)).toBe(0);
      expect(out.join("\n")).toMatch(/@agentada.test\s+chat and approvals/);
      expect(await runAccess({ ...base, accessAction: "remove", email: "her@example.test" }, io)).toBe(0);
      expect(await runAccess({ ...base, accessAction: "remove", email: "her@example.test" }, io)).toBe(1);
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).signIn).toEqual({ admins: [], members: ["@agentada.test"] });
      const rows = readAdminActivityRange(dataDir, { from: new Date(Date.now() - 600_000), to: new Date(Date.now() + 600_000) });
      expect(rows.map((row) => [row.action, row.actor.kind, row.changed])).toEqual([
        ["people.update", "cli", ["signIn.members"]],
        ["people.update", "cli", ["signIn.admins", "signIn.members"]],
        ["people.update", "cli", ["signIn.members"]],
      ]);
      expect(rows[0]!.after).toEqual({ "signIn.members": ["@agentada.test"] });
    } finally {
      await removeTempDir(home);
    }
  });
});

describe.skipIf(process.platform === "win32")("serve --domain", () => {
  it("runs a managed Caddy for the domain and serves the pairing link there", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-domain-"));
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const fake = join(home, "fake-caddy");
    writeFileSync(fake, `#!/bin/sh\necho "$@" > "${join(home, "caddy-args.txt")}"\necho $$ > "${join(home, "caddy.pid")}"\nexec sleep 300\n`, { mode: 0o755 });
    const port = workerPort(21000, 9000);
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "openmausbot.ts"), "serve", "--domain", "omb.example.test", "--port", String(port), "--data-dir", dataDir], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, OMB_WEBHOOK_PORT: String(port + 1), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"), OMB_CADDY_PATH: fake },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (out += String(chunk)));
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out).toContain(`OpenMausBot is running on http://127.0.0.1:${port}, reachable at https://omb.example.test`);
      expect(out).toContain("https: Caddy serves https://omb.example.test");
      expect(out).toContain("open or scan:  https://omb.example.test/pair#code=");
      const args = readFileSync(join(home, "caddy-args.txt"), "utf8").trim();
      expect(args).toMatch(/^run --config .*Caddyfile --adapter caddyfile$/);
      const caddyfile = readFileSync(join(dataDir, "caddy", "Caddyfile"), "utf8");
      expect(caddyfile).toContain("omb.example.test {");
      expect(caddyfile).toContain(`reverse_proxy 127.0.0.1:${port}`);
      expect(caddyfile).toContain(`reverse_proxy 127.0.0.1:${port + 1}`);
    } finally {
      // Cleanup must not mask the real failure: a server that never reached
      // the Caddy step has no pid file, and the assertions above already
      // named what actually went wrong.
      const caddyPid = existsSync(join(home, "caddy.pid")) ? Number(readFileSync(join(home, "caddy.pid"), "utf8").trim() || "0") : 0;
      child.kill("SIGTERM");
      await exited(child);
      await new Promise((r) => setTimeout(r, 300));
      if (caddyPid) expect(() => process.kill(caddyPid, 0)).toThrow();
      await removeTempDir(home);
    }
  }, 120_000);
});
