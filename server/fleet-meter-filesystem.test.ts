import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultFleetDeps } from "./fleet-cli.ts";
import { meterLedgerText } from "./fleet-metering.ts";
import { meterTenantPeople } from "./fleet-tenant-io.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { UsageRow, UsageTrigger } from "./usage-ledger.ts";

const fixture = vi.hoisted(() => ({
  home: "",
  calls: [] as { command: string; args: string[]; options: ExecFileSyncOptionsWithStringEncoding }[],
  spawns: [] as { command: string; args: string[]; options: { cwd?: string; env?: Record<string, string> } }[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: { cwd?: string; env?: Record<string, string> }) => {
      fixture.spawns.push({ command, args, options });
      return actual.spawn(command, args, options as never);
    },
    execFileSync: (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => {
      fixture.calls.push({ command, args, options });
      // Only account discovery is synthetic: the metering child itself is real and runs against a disposable home.
      if (command === "/usr/bin/getent") return `omb-acme:x:${process.getuid!()}:${process.getgid!()}:fixture:${fixture.home}:/usr/sbin/nologin\n`;
      return actual.execFileSync(command, args, options);
    },
  };
});

const SECRET = "fixture-private-message-text";
const row = (trigger: UsageTrigger, overrides: Partial<UsageRow> = {}): UsageRow => ({
  at: "2026-09-10T10:00:00.000Z", botId: "b", botName: SECRET, threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m",
  input: 10, output: 5, costUsd: 0.25, trigger, ...overrides,
});
const lines = (rows: unknown[]) => rows.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n") + "\n";

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fleet people metering in an isolated home", () => {
  let root: string;
  let data: string;
  let ledger: string;
  const deps = defaultFleetDeps();
  const month = "2026-09";
  const meter = (maxUsers?: number, dir = data) => deps.people!(dir, "omb-acme", month, maxUsers);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "omb-fleet-meter-")));
    fixture.home = join(root, "acme");
    fixture.calls = [];
    fixture.spawns = [];
    mkdirSync(fixture.home, { mode: 0o700 });
    data = join(fixture.home, ".openmausbot");
    mkdirSync(join(data, "usage"), { recursive: true });
    ledger = join(data, "usage", `${month}.jsonl`);
  });
  afterEach(async () => { await removeTempDir(root); });

  const unsafe = /could not meter people as omb-acme/;

  it("counts a ledger as the workspace's own user and agrees with the in-process twin", async () => {
    const text = lines([
      row({ kind: "user", email: "Ada@X.test", label: "Ada's phone" }), row({ kind: "user", email: "ada@x.test" }, { costUsd: 0.5 }),
      row({ kind: "user", label: "Bo's iPhone" }), row({ kind: "user" }), row({ kind: "owner" }, { costUsd: 1 }),
      row({ kind: "routine", routineId: "r", email: "ada@x.test" }, { costUsd: 0.125 }), row({ kind: "owner", email: "stranger@x.test" }),
      row({ kind: "user", email: "ghost@x.test" }, { outcome: { status: "error" } }),
      row({ kind: "user", email: "ada@x.test" }, { at: "2026-08-31T23:59:59.999Z" }), row({ kind: "user", email: "late@x.test" }, { at: "2026-10-01T00:00:00.000Z" }),
      "{torn", "[]",
    ]) + '{"at":"2026-09-02T00:00:00Z","botId":"b","mod';
    writeFileSync(ledger, text);
    const config = JSON.stringify({ signIn: { admins: ["ada@x.test"], members: ["bo@x.test", "@acme.test"] }, anthropic: { key: SECRET } });
    writeFileSync(join(data, "config.json"), config, { mode: 0o600 });
    const result = await meter();
    expect(result).toEqual(meterLedgerText(text, month, undefined, config));
    expect(result).toMatchObject({ turns: 8, ignoredLines: 3, unattributedTurns: 1, seats: { emails: 2, domains: 1 } });
    expect(result.people.map((person) => [person.id, person.asked, person.attributed])).toEqual([["ada@x.test", 2, 3], ["device:bo's iphone", 1, 1]]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("matches the twin across chunk boundaries, multibyte labels and an overlong line", async () => {
    const rows: unknown[] = [];
    for (let index = 0; index < 12_000; index++) rows.push(row(index % 3 === 0 ? { kind: "user", email: `user${index % 400}@x.test` } : index % 3 === 1 ? { kind: "user", label: `Gerät ${index % 50} 日本語` } : { kind: "routine", routineId: "r", email: `user${index % 400}@x.test` }, { threadId: "x".repeat(40) }));
    rows.splice(5_000, 0, JSON.stringify({ ...row({ kind: "owner" }), padding: "y".repeat(1024 * 1024 + 10) }));
    const text = lines(rows);
    expect(Buffer.byteLength(text)).toBeGreaterThan(3 * 1024 * 1024);
    writeFileSync(ledger, text);
    const result = await meter(1000);
    expect(result).toEqual(meterLedgerText(text, month, 1000));
    expect(result.ignoredLines).toBe(1);
    expect(result.people.length).toBe(450);
  }, 30_000);

  it("reports a final line that has no newline, and a missing trailing newline never joins two rows", async () => {
    const text = lines([row({ kind: "user", email: "a@x.test" })]).trimEnd();
    writeFileSync(ledger, text);
    expect((await meter()).people).toHaveLength(1);
  });

  it.each(["missing data directory", "missing usage directory", "missing month file", "empty month file"])("counts %s as nobody", async (kind) => {
    let target = data;
    if (kind === "missing data directory") target = join(fixture.home, "absent", ".openmausbot");
    else if (kind === "missing usage directory") { target = join(fixture.home, "bare"); mkdirSync(target); }
    else if (kind === "missing month file") writeFileSync(join(data, "other.jsonl"), "");
    else writeFileSync(ledger, "");
    expect(await meter(undefined, target)).toEqual({ v: 1, month, turns: 0, costUsd: null, ignoredLines: 0, unattributedTurns: 0, people: [], seats: { emails: 0, domains: 0 } });
  });

  it("reads the sign-in lists inside the child and returns only their sizes", async () => {
    writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: ["boss@x.test"], members: ["@secret-company.test"] } }));
    const result = await meter();
    expect(result.seats).toEqual({ emails: 1, domains: 1 });
    expect(JSON.stringify(result)).not.toMatch(/boss|secret-company/);
    expect(fixture.calls.map((call) => `${call.args.join(" ")}${String(call.options.input ?? "")}`).join("\n")).not.toMatch(/boss|secret-company/);
  });

  it("treats a sign-in file that is not JSON as no seats rather than as a failure", async () => {
    writeFileSync(join(data, "config.json"), "{ broken");
    expect((await meter()).seats).toEqual({ emails: 0, domains: 0 });
  });

  it.each(["symlink", "hardlink", "directory", "fifo", "ancestor", "oversized", "config symlink", "config hardlink"])("refuses an unsafe %s promptly, without echoing a byte of it", async (kind) => {
    const outside = join(root, "outside");
    writeFileSync(outside, lines([row({ kind: "user", email: "a@x.test" })]));
    let target = data;
    if (kind === "symlink") symlinkSync(outside, ledger);
    else if (kind === "hardlink") linkSync(outside, ledger);
    else if (kind === "directory") mkdirSync(ledger);
    else if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [ledger], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "pipe"] });
    else if (kind === "ancestor") {
      target = join(fixture.home, "linked-data");
      symlinkSync(data, target);
      writeFileSync(ledger, lines([row({ kind: "user", email: "a@x.test" })]));
    } else if (kind === "oversized") {
      writeFileSync(ledger, "");
      truncateSync(ledger, 256 * 1024 * 1024 + 1);
    } else if (kind === "config symlink") symlinkSync(outside, join(data, "config.json"));
    else linkSync(outside, join(data, "config.json"));
    const start = performance.now();
    const failure = await meter(undefined, target).then(() => null, (error: Error) => error);
    expect(failure?.message).toMatch(unsafe);
    expect(failure?.message).not.toContain("a@x.test");
    expect(performance.now() - start).toBeLessThan(3000);
    expect(readFileSync(outside, "utf8")).toContain("a@x.test");
  });

  it("names the reasons an operator can act on, and otherwise says what to check", async () => {
    writeFileSync(ledger, "");
    truncateSync(ledger, 256 * 1024 * 1024 + 1);
    await expect(meter()).rejects.toThrow("workspace ledger exceeds 256 MiB");
    symlinkSync(join(root, "elsewhere"), join(data, "config.json"));
    writeFileSync(ledger, "");
    await expect(meter()).rejects.toThrow("check ownership, links, file size and permissions");
  });

  it("fails closed on 1001 people, and counts them when the limit is raised", async () => {
    const text = lines(Array.from({ length: 1001 }, (_, index) => row({ kind: "user", email: `u${index}@x.test` })));
    writeFileSync(ledger, text);
    await expect(meter()).rejects.toThrow("more than 1000 distinct people asked this workspace");
    await expect(meter(1000)).rejects.toThrow(unsafe);
    expect((await meter(1001)).people).toHaveLength(1001);
    expect((await meter(10_000)).people).toHaveLength(1001);
    expect(() => meterTenantPeople(data, "omb-acme", month, 10_001)).toThrow("1 to 10000");
  });

  it("fails closed when a total would overflow", async () => {
    writeFileSync(ledger, lines([row({ kind: "owner" }, { costUsd: Number.MAX_VALUE }), row({ kind: "owner" }, { costUsd: Number.MAX_VALUE })]));
    await expect(meter()).rejects.toThrow("workspace usage total exceeds numeric range");
  });

  it("opens only the requested month, never a neighbour", async () => {
    symlinkSync("/dev/zero", join(data, "usage", "2026-08.jsonl"));
    symlinkSync("/dev/zero", join(data, "usage", "2026-10.jsonl"));
    writeFileSync(ledger, lines([row({ kind: "user", email: "a@x.test" })]));
    expect((await meter()).people).toHaveLength(1);
  });

  it("refuses a malformed month before starting anything", () => {
    expect(() => meterTenantPeople(data, "omb-acme", "2026-9")).toThrow("YYYY-MM");
    expect(fixture.calls).toEqual([]);
  });

  it("refuses a path outside the account home and a root identity before any child starts", async () => {
    await expect(meterTenantPeople(join(root, "outside"), "omb-acme", month)).rejects.toThrow("unsafe filesystem identity or path");
    await expect(meterTenantPeople(data, "root;rm", month)).rejects.toThrow();
    expect(fixture.calls.every((call) => call.command === "/usr/bin/getent")).toBe(true);
  });

  it("launches a bare node with no environment, the root directory as cwd, and drops privileges before touching a file", async () => {
    writeFileSync(ledger, lines([row({ kind: "user", email: "a@x.test" })]));
    await meter();
    expect(fixture.spawns).toHaveLength(1);
    const [spawned] = fixture.spawns;
    expect(spawned).toMatchObject({ command: process.execPath, options: { cwd: "/", env: { PATH: "/usr/bin:/bin" } } });
    expect(spawned!.args[0]).toBe("--eval");
    const script = spawned!.args[1]!;
    expect(script.indexOf("process.setgroups([])")).toBeLessThan(script.indexOf("process.setgid(gid)"));
    expect(script.indexOf("process.setgid(gid)")).toBeLessThan(script.indexOf("process.setuid(uid)"));
    expect(script.indexOf("process.setuid(uid)")).toBeLessThan(script.indexOf("fs.lstatSync(cursor)"));
  });

  it("keeps message text out of every argument", async () => {
    writeFileSync(ledger, lines([row({ kind: "user", email: "a@x.test" })]));
    await meter();
    expect(JSON.stringify([fixture.calls, fixture.spawns])).not.toContain(SECRET);
    expect(fixture.calls.every((call) => call.command === "/usr/bin/getent")).toBe(true);
  });
});
