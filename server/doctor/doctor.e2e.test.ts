// Real server: a data folder damaged in every way the doctor repairs, then repaired by `openmausbot doctor --data --fix`
// or by the server's own first start of a new version, after which the server starts with its bots back.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");
const UUID = "0b4d8f7a-3c2e-4f1a-9b6d-5e7c8a9f0d1e";
const WAL_BYTES = 70 * 1024 * 1024;

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "omb-doctor-e2e-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI } } },
  }));
  return home;
}

async function boot(home: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: verificationServerEnvironment(process.env, home, port), stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 30_000, interval: 50 }).toBe(true);
  const get = async (path: string) => {
    const response = await fetch(base + path, { headers: { origin: base } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  return { get, output: () => output, stop: () => waitForExit(child, { signal: "SIGTERM" }) };
}

function doctor(home: string, ...args: string[]) {
  const done = spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "server/openmausbot.ts"), "doctor", "--data", "--json", ...args], {
    cwd: ROOT, env: verificationServerEnvironment(process.env, home, 1), encoding: "utf8", timeout: 120_000,
  });
  return { code: done.status, report: JSON.parse(done.stdout) as { ok: boolean; checks: { id: string; status: string; fixable: boolean }[]; backup: string | null } };
}

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

/** Every kind of damage the doctor repairs. Returns the bots.json the server had. */
function damage(home: string): string {
  const bots = readFileSync(join(home, "bots.json"), "utf8");
  const dead = deadPid();
  // A save of bots.json cut short, its whole temp file still there.
  writeFileSync(join(home, "bots.json"), bots.slice(0, Math.floor(bots.length / 2)));
  writeFileSync(join(home, `bots.json.${dead}.${UUID}.tmp`), bots);
  // Another save that never finished.
  writeFileSync(join(home, `webhooks.json.${dead}.${randomUUID()}.tmp`), "{}");
  // A lease a killed server left.
  writeFileSync(join(home, "openmausbot-server.lease"), `${JSON.stringify({ version: 1, pid: dead, host: hostname(), token: randomUUID(), createdAt: Date.now() })}\n`, { mode: 0o600 });
  // A run record whose server.json was never written.
  mkdirSync(join(home, "engine-runs", "f".repeat(32)), { recursive: true });
  writeFileSync(join(home, "engine-runs", "f".repeat(32), "server.json"), "");
  // Folders gone.
  for (const name of ["events", "native"]) rmSync(join(home, name), { recursive: true, force: true });
  // A private file others can read.
  if (process.platform !== "win32") chmodSync(join(home, "config.json"), 0o644);
  // A write-ahead log no server folded back (a process killed while it held the database).
  const filler = spawnSync(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE IF NOT EXISTS doctor_e2e (x TEXT)");
    const insert = db.prepare("INSERT INTO doctor_e2e VALUES (?)");
    for (let n = 0; n < ${Math.ceil(WAL_BYTES / 100_000)}; n += 1) insert.run("x".repeat(100000));
    process.kill(process.pid, "SIGKILL");
  `, join(home, "messages.db")]);
  expect(filler.status === 0 && filler.signal === null).toBe(false);
  expect(statSync(join(home, "messages.db-wal")).size).toBeGreaterThan(64 * 1024 * 1024);
  // The data as an older version left it, so the next start is a new version's first.
  writeFileSync(join(home, "doctor-state.json"), JSON.stringify({ version: "0.0.1", summary: { at: "", version: "0.0.1", checked: 0, fixed: [], problems: [] } }));
  return bots;
}

const FIXED = ["lease", "folders", "registry", "temp-files", "engine-runs", "messages-db", ...(process.platform === "win32" ? [] : ["secret-modes"])];

async function serverHasItsBots(home: string, bots: string) {
  const server = await boot(home);
  const listed = (await server.get("/api/bots?messages=0")).bots as { id: string }[];
  expect(listed.map((bot) => bot.id).sort()).toEqual((JSON.parse(bots) as { id: string }[]).map((bot) => bot.id).sort());
  return server;
}

it("openmausbot doctor --data finds each problem, --fix repairs them all, and the server starts with its bots", async () => {
  const home = freshHome();
  const first = await boot(home);
  await first.stop();
  const bots = damage(home);

  const looked = doctor(home);
  expect(looked.code).toBe(8);
  for (const id of FIXED) expect(looked.report.checks.find((check) => check.id === id), id).toMatchObject({ status: "problem", fixable: true });
  expect(looked.report.backup).toBeNull();

  const fixed = doctor(home, "--fix");
  expect(fixed.report.checks.filter((check) => check.status !== "ok" && check.status !== "fixed")).toEqual([]);
  expect(fixed.code).toBe(0);
  for (const id of FIXED) expect(fixed.report.checks.find((check) => check.id === id)!.status, id).toBe("fixed");
  expect(existsSync(join(fixed.report.backup!, "bots.json"))).toBe(true);
  // Folded back: emptied, or removed as the last connection closed.
  const wal = join(home, "messages.db-wal");
  expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);

  await serverHasItsBots(home, bots);
}, 180_000);

it("a new version's first start repairs the same damage itself and reports it in the health report", async () => {
  const home = freshHome();
  const first = await boot(home);
  await first.stop();
  const bots = damage(home);

  const server = await serverHasItsBots(home, bots);
  const health = await server.get("/api/health");
  // The server retires a dead lease itself as it takes the lease, before the doctor runs; ensureDirs() makes the folders.
  expect(health.doctor).toMatchObject({ thisStart: true, problems: [] });
  for (const id of FIXED.filter((id) => id !== "lease" && id !== "folders")) expect(health.doctor.fixed).toContain(id);
  expect(server.output()).toMatch(/\[doctor\] registry: bots\.json is damaged.* Fixed: put back bots\.json/);
  expect(existsSync(join(home, `bots.json`))).toBe(true);
}, 180_000);
