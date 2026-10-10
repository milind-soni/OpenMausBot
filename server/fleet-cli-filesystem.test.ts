import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultFleetDeps, runFleetCommand, type FleetInput } from "./fleet-cli.ts";
import { emptyRegistry, fleetLayout, MANAGED_OPENROUTER } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { readUsage, summarizeUsage, type UsageRow } from "./usage-ledger.ts";

const fixture = vi.hoisted(() => ({ home: "", account: "", calls: [] as { command: string; args: string[]; options: ExecFileSyncOptionsWithStringEncoding }[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => {
      fixture.calls.push({ command, args, options });
      // Only account discovery is synthetic. The actual unprivileged Node helper
      // runs against a disposable home; no useradd, chown or system services run.
      if (command === "/usr/bin/getent") return fixture.account || `omb-acme:x:${process.getuid!()}:${process.getgid!()}:fixture:${fixture.home}:/usr/sbin/nologin\n`;
      return actual.execFileSync(command, args, options);
    },
  };
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fleet tenant filesystem boundary in an isolated home", () => {
  let root: string;
  let data: string;
  let file: string;
  const deps = defaultFleetDeps();

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "omb-fleet-files-")));
    fixture.home = join(root, "acme");
    fixture.account = "";
    fixture.calls = [];
    mkdirSync(fixture.home, { mode: 0o700 });
    data = join(fixture.home, ".openmausbot");
    file = join(data, "config.json");
  });
  afterEach(async () => { await removeTempDir(root); });

  it("creates private tenant files and replaces them atomically through the real bounded child", () => {
    deps.mkdir(data, 0o700, "omb-acme");
    expect(deps.readText(file, "omb-acme")).toBeNull();
    deps.writeText(file, '{"signIn":{"admins":["a@example.test"]}}', 0o600, "omb-acme");
    const oldInode = statSync(file).ino;
    deps.writeText(file, '{"signIn":{"admins":["b@example.test"]}}', 0o600, "omb-acme");
    expect(deps.readText(file, "omb-acme")).toContain("b@example.test");
    expect(statSync(file).ino).not.toBe(oldInode);
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(file).uid).toBe(process.getuid!());
    expect(readdirSync(data)).toEqual(["config.json"]);
    for (const call of fixture.calls.filter((entry) => entry.command === process.execPath)) {
      expect(call.options).toMatchObject({ timeout: 5000, killSignal: "SIGKILL", cwd: "/", env: { PATH: "/usr/bin:/bin" } });
      expect(call.args[0]).toBe("--eval");
      const script = call.args[1]!;
      expect(script.indexOf("process.setgroups([])")).toBeLessThan(script.indexOf("process.setgid(gid)"));
      expect(script.indexOf("process.setgid(gid)")).toBeLessThan(script.indexOf("process.setuid(uid)"));
      expect(script.indexOf("process.setuid(uid)")).toBeLessThan(script.indexOf("check(fs.lstatSync(cursor)"));
      expect(call.args.join(" ")).not.toContain("b@example.test");
    }
  });

  it.each(["symbolic", "hard"])("refuses %s links without reading or modifying their target", (kind) => {
    mkdirSync(data);
    const target = join(root, "outside-secret");
    writeFileSync(target, "fixture-secret");
    if (kind === "symbolic") symlinkSync(target, file); else linkSync(target, file);
    expect(() => deps.readText(file, "omb-acme")).toThrow("could not read workspace file");
    expect(() => deps.writeText(file, "replacement", 0o600, "omb-acme")).toThrow("could not write workspace file");
    expect(readFileSync(target, "utf8")).toBe("fixture-secret");
  });

  it("refuses a linked ancestor and never rewrites another directory", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config.json"), "untouched");
    symlinkSync(outside, data);
    expect(() => deps.readText(file, "omb-acme")).toThrow("could not read workspace file");
    expect(() => deps.writeText(file, "replacement", 0o600, "omb-acme")).toThrow("could not write workspace file");
    expect(() => deps.mkdir(data, 0o700, "omb-acme")).toThrow("could not mkdir workspace file");
    expect(readFileSync(join(outside, "config.json"), "utf8")).toBe("untouched");
  });

  it("rejects special file types and oversized reads without echoing content", () => {
    mkdirSync(data);
    mkdirSync(file);
    expect(() => deps.readText(file, "omb-acme")).toThrow("could not read workspace file");
    const large = join(data, "large.json");
    writeFileSync(large, Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
    expect(() => deps.readText(large, "omb-acme")).toThrow("check ownership, links, file size and permissions");
  });

  it("rejects root identities and paths outside the account home before launching file I/O", () => {
    fixture.account = `omb-acme:x:0:0:fixture:${fixture.home}:/bin/sh`;
    expect(() => deps.writeText(file, "secret", 0o600, "omb-acme")).toThrow("unsafe filesystem identity or path");
    fixture.account = "";
    expect(() => deps.writeText(join(root, "outside"), "secret", 0o600, "omb-acme")).toThrow("unsafe filesystem identity or path");
    expect(() => deps.readText(join(data, "..", "..", "outside"), "omb-acme")).toThrow("unsafe filesystem identity or path");
    expect(fixture.calls.every((call) => call.command === "/usr/bin/getent")).toBe(true);
  });

  it("treats dangling symlinks as existing paths and publishes root-control files atomically", () => {
    const dangling = join(root, "retained");
    symlinkSync(join(root, "missing"), dangling);
    expect(deps.pathExists(dangling)).toBe(true);
    expect(deps.pathExists(join(root, "missing"))).toBe(false);
    const registry = join(root, "fleet.json");
    deps.writeText(registry, '{"version":1}', 0o600);
    const oldInode = statSync(registry).ino;
    deps.writeText(registry, '{"version":2}', 0o600);
    expect(readFileSync(registry, "utf8")).toBe('{"version":2}');
    expect(statSync(registry).ino).not.toBe(oldInode);
    expect(statSync(registry).mode & 0o777).toBe(0o600);
  });

  it("updates managed models through the real tenant helper and refuses a symlink without touching its target", async () => {
    fixture.home = join(root, "var/lib/openmausbot/acme");
    mkdirSync(fixture.home, { recursive: true, mode: 0o700 });
    const directory = join(fixture.home, ".config", "opencode");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "opencode.json");
    const managed = { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://admin.example.test/api/gateway/acme/openrouter/v1", apiKey: "fixture-scoped-key" }, models: {} };
    writeFileSync(path, JSON.stringify({ provider: { [MANAGED_OPENROUTER]: managed, other: { keep: true } }, model: "keep/default" }), { mode: 0o600 });
    const layout = fleetLayout(root);
    const registry = { ...emptyRegistry("example.test"), workspaces: { acme: { slug: "acme", host: "acme.example.test", port: 8810, webhookPort: 8811, status: "running", createdAt: "" } } };
    const files = new Map([[layout.registryFile, JSON.stringify(registry)], [join(layout.instancesDir, "acme.env"), "OMB_ADMIN_URL=https://admin.example.test\nOMB_ADMIN_WORKSPACE=acme\n"]]);
    const fixtureDeps = { ...deps, isRoot: () => true, readText: (name: string, owner?: string) => owner ? deps.readText(name, owner) : files.get(name) ?? null };
    const input: FleetInput = { action: "providers", slug: "acme", openrouterModels: ["provider/model"], admins: [], members: [], dryRun: false, yes: true, keepData: false, node: process.execPath, script: "/fixture/cli.js", root };
    const messages: string[] = [];
    const log = { log: (line: string) => messages.push(line), error: (line: string) => messages.push(line) };
    expect(await runFleetCommand(input, log, fixtureDeps)).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ provider: { [MANAGED_OPENROUTER]: { ...managed, models: { "provider/model": { name: "provider/model" } } }, other: { keep: true } }, model: "keep/default" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const target = join(root, "sibling-private-config");
    writeFileSync(target, "fixture-private-do-not-read");
    renameSync(path, join(directory, "previous.json"));
    symlinkSync(target, path);
    expect(await runFleetCommand(input, log, fixtureDeps)).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("fixture-private-do-not-read");
    expect(messages.join("\n")).not.toMatch(/fixture-scoped-key|fixture-private-do-not-read/);
  });

  const now = new Date("2026-09-11T12:34:56.000Z");
  const usageRow = (overrides: Partial<UsageRow> = {}): UsageRow => ({
    at: "2026-09-03T10:00:00.000Z", botId: "fixture-bot", botName: "fixture-private-name", threadId: "fixture-thread",
    instanceId: "fixture-engine", driverKind: "fixture", model: "fixture-model", input: 10, output: 5, costUsd: 0.25,
    trigger: { kind: "user", email: "fixture-private-email@example.test" }, ...overrides,
  });

  function usageFile() {
    const directory = join(data, "usage");
    mkdirSync(directory, { recursive: true });
    return join(directory, "2026-09.jsonl");
  }

  it("summarizes the current month inside the actual helper without returning raw ledger rows", () => {
    const monthly = usageFile();
    const rows = [
      usageRow({ at: "2026-09-01T00:00:00.000Z", costUsd: 0 }),
      usageRow({ botId: "fixture-other", costUsd: 1.5 }),
      usageRow({ costUsd: null }),
      usageRow({ at: now.toISOString(), costUsd: 0.25 }),
    ];
    writeFileSync(monthly, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const reference = summarizeUsage(readUsage(data, { from: new Date("2026-09-01T00:00:00Z"), to: now }), "bot").total;
    const result = deps.usage(data, "omb-acme", now);
    expect(result).toEqual({ turns: reference.turns, costUsd: reference.costUsd, billableUsd: reference.billableUsd });
    expect(result).toEqual({ turns: 4, costUsd: 1.75, billableUsd: null });
    expect(JSON.stringify(result)).not.toContain("fixture-private");
    const child = fixture.calls.findLast((call) => call.command === process.execPath)!;
    expect(child.options).toMatchObject({ maxBuffer: 8192, timeout: 5000, killSignal: "SIGKILL", env: { PATH: "/usr/bin:/bin" } });
    expect(child.args.join(" ")).not.toContain("fixture-private");
    expect(String(child.options.input)).not.toContain("fixture-private");
  });

  it("ignores malformed, torn and out-of-date records, with inclusive UTC month/start and now boundaries", () => {
    const monthly = usageFile();
    const valid = usageRow({ at: now.toISOString(), costUsd: 0.5 });
    const records: unknown[] = [
      usageRow({ at: "2026-09-01T00:00:00.000Z", costUsd: 0.25 }), valid,
      usageRow({ at: "2026-08-31T23:59:59.999Z", costUsd: 100 }),
      usageRow({ at: "2026-09-11T12:34:56.001Z", costUsd: 200 }),
      usageRow({ at: "2026-10-01T00:00:00.000Z", costUsd: 300 }),
      usageRow({ at: "invalid date", costUsd: 400 }),
      null, [], "fixture-private-secret", {}, { ...valid, botId: null }, { ...valid, model: null },
      { ...valid, input: "10" }, { ...valid, output: null }, { ...valid, trigger: null }, { ...valid, trigger: { kind: 4 } },
    ];
    writeFileSync(monthly, records.map((row) => JSON.stringify(row)).join("\n") + '\nnot JSON: fixture-private-secret\n{"at":"torn-fixture-private-secret');
    // Adjacent months must never be opened by a current-month summary.
    symlinkSync("/dev/zero", join(data, "usage", "2026-08.jsonl"));
    symlinkSync("/dev/zero", join(data, "usage", "2026-10.jsonl"));
    const reference = summarizeUsage(readUsage(data, { from: new Date("2026-09-01T00:00:00Z"), to: now }), "bot").total;
    expect(deps.usage(data, "omb-acme", now)).toEqual({ turns: reference.turns, costUsd: reference.costUsd, billableUsd: null });
    expect(deps.usage(data, "omb-acme", now)).toEqual({ turns: 2, costUsd: 0.75, billableUsd: null });
  });

  it("keeps turns without valid prices unpriced and rejects numeric overflow without exposing rows", () => {
    const monthly = usageFile();
    const rows = [usageRow({ costUsd: null }), usageRow({ costUsd: -5 }), { ...usageRow(), costUsd: "fixture-private-secret" }];
    writeFileSync(monthly, rows.map((row) => JSON.stringify(row)).join("\n"));
    expect(deps.usage(data, "omb-acme", now)).toEqual({ turns: 3, costUsd: null, billableUsd: null });
    writeFileSync(monthly, [usageRow({ costUsd: Number.MAX_VALUE }), usageRow({ costUsd: Number.MAX_VALUE })].map((row) => JSON.stringify(row)).join("\n"));
    expect(() => deps.usage(data, "omb-acme", now)).toThrow(/^could not usage workspace file as omb-acme: check ownership, links, file size and permissions$/);
  });

  it("returns empty totals for missing nested data, missing usage directory and missing month", () => {
    const empty = { turns: 0, costUsd: null, billableUsd: null };
    expect(deps.usage(join(fixture.home, "absent", "nested", ".openmausbot"), "omb-acme", now)).toEqual(empty);
    expect(deps.usage(data, "omb-acme", now)).toEqual(empty);
    mkdirSync(data);
    expect(deps.usage(data, "omb-acme", now)).toEqual(empty);
    const monthly = usageFile();
    expect(deps.usage(data, "omb-acme", now)).toEqual(empty);
    writeFileSync(monthly, "");
    expect(deps.usage(data, "omb-acme", now)).toEqual(empty);
  });

  it.each(["symlink", "fifo", "directory", "hardlink", "ancestor", "oversized"])("refuses an unsafe %s usage ledger promptly without exposing raw content", (kind) => {
    const monthly = usageFile();
    const secret = "fixture-private-ledger-secret";
    const outside = join(root, "outside-ledger");
    writeFileSync(outside, secret);
    let targetData = data;
    if (kind === "symlink") symlinkSync("/dev/zero", monthly);
    else if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [monthly], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "pipe"] });
    else if (kind === "directory") mkdirSync(monthly);
    else if (kind === "hardlink") linkSync(outside, monthly);
    else if (kind === "ancestor") {
      targetData = join(fixture.home, "linked-data");
      symlinkSync(data, targetData);
      writeFileSync(monthly, secret);
    } else writeFileSync(monthly, Buffer.alloc(4 * 1024 * 1024 + 1, secret));
    const start = performance.now();
    expect(() => deps.usage(targetData, "omb-acme", now)).toThrow(/^could not usage workspace file as omb-acme: check ownership, links, file size and permissions$/);
    // Special files must fail on descriptor checks, not wait for the 5s kill deadline.
    expect(performance.now() - start).toBeLessThan(2000);
    expect(readFileSync(outside, "utf8")).toBe(secret);
  });
});
