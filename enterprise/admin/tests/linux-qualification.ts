// Opt-in destructive fixture: only on an explicitly disposable Linux machine.
// No services, firewall rules, provider calls or existing workspace paths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultFleetDeps } from "../../../server/fleet-cli.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node --experimental-strip-types enterprise/admin/tests/linux-qualification.ts --run-disposable\nLinux root only. Creates two uniquely named fixture users and /var/tmp/omb-linux-qual-* homes, tests the real fleet file helper, then removes only those resources. Never run on a customer/live host. Does not test systemd, nftables, Caddy or paid providers.");
  process.exit(0);
}
if (args.length !== 1 || args[0] !== "--run-disposable" || process.platform !== "linux" || process.getuid?.() !== 0) {
  console.error("Refusing: requires Linux root and exactly --run-disposable on an explicitly disposable host. Use --help.");
  process.exit(2);
}

const commandOptions = { encoding: "utf8" as const, timeout: 10_000, killSignal: "SIGKILL" as const, maxBuffer: 8192, cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } };
function command(file: string, argv: string[], input?: string) {
  const result = spawnSync(file, argv, { ...commandOptions, input });
  if (result.error || result.status !== 0) throw new Error(`${basename(file)} failed (${result.status ?? "timeout/error"}); output omitted`);
  return result.stdout;
}
function lookup(kind: "passwd" | "group", name: string): string[] | null {
  const result = spawnSync("/usr/bin/getent", [kind, name], commandOptions);
  if (!result.error && result.status === 2) return null;
  if (result.error || result.status !== 0) throw new Error(`getent ${kind} failed; output omitted`);
  return result.stdout.trim().split(":");
}
for (const file of ["/usr/sbin/useradd", "/usr/sbin/userdel", "/usr/sbin/groupdel", "/usr/bin/getent", "/usr/bin/mkfifo"]) {
  if (!statSync(file).isFile()) throw new Error(`Required executable unavailable: ${file}`);
}

const root = mkdtempSync("/var/tmp/omb-linux-qual-");
const rootInode = lstatSync(root).ino;
const marker = randomBytes(24).toString("hex");
writeFileSync(join(root, ".owned-fixture"), marker, { mode: 0o600 });
chmodSync(root, 0o711); // users may traverse, never replace top-level fixture entries
const suffix = randomBytes(6).toString("hex");
const accounts: { name: string; home: string; uid?: number; gid?: number }[] = [];
const checks: string[] = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const errors: string[] = [];
  for (const account of [...accounts].reverse()) {
    try {
      const entry = lookup("passwd", account.name);
      if (entry) {
        if (entry[0] !== account.name || entry[5] !== account.home || Number(entry[2]) <= 0 || (account.uid !== undefined && Number(entry[2]) !== account.uid)) throw new Error(`Refusing changed account ${account.name}`);
        account.gid ??= Number(entry[3]);
        command("/usr/sbin/userdel", [account.name]); // never --remove an account-derived path
      }
      const group = lookup("group", account.name);
      if (group) {
        if (account.gid === undefined || Number(group[2]) !== account.gid || group[3]) throw new Error(`Refusing changed group ${account.name}`);
        command("/usr/sbin/groupdel", [account.name]);
      }
    } catch { errors.push(`inspect fixture account/group ${account.name}`); }
  }
  try {
    const stat = lstatSync(root);
    if (dirname(root) !== "/var/tmp" || !basename(root).startsWith("omb-linux-qual-") || !stat.isDirectory() || stat.uid !== 0 || stat.ino !== rootInode || readFileSync(join(root, ".owned-fixture"), "utf8") !== marker) throw new Error("Fixture ownership changed");
    if (!errors.length) rmSync(root, { recursive: true });
  } catch { errors.push(`inspect fixture directory ${root}`); }
  if (errors.length) throw new Error(`Cleanup incomplete; ${errors.join("; ")}; fixture retained at ${root}`);
  console.log(JSON.stringify({ event: "cleanup-complete", users: accounts.map((account) => account.name), root }));
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) process.once(signal, () => {
  try { cleanup(); } catch (error) { console.error((error as Error).message); }
  process.exit(code);
});
function check(label: string, work: () => void) {
  try { work(); } catch { throw new Error(`Qualification failed: ${label}; contents omitted`); }
  checks.push(label);
  console.log(JSON.stringify({ event: "passed", check: label }));
}

try {
  for (const side of ["a", "b"]) {
    const account = { name: `omb-qual-${suffix}-${side}`, home: join(root, side), uid: undefined as number | undefined, gid: undefined as number | undefined };
    if (lookup("passwd", account.name) || lookup("group", account.name)) throw new Error("Fixture identity collision; refusing reuse");
    accounts.push(account);
    console.log(JSON.stringify({ event: "creating-fixture-user", name: account.name, home: account.home }));
    command("/usr/sbin/useradd", ["--system", "--no-create-home", "--user-group", "--home-dir", account.home, "--shell", "/usr/sbin/nologin", account.name]);
    const entry = lookup("passwd", account.name)!;
    account.uid = Number(entry[2]); account.gid = Number(entry[3]);
    assert.ok(account.uid > 0 && account.gid > 0 && entry[5] === account.home);
    mkdirSync(account.home, { mode: 0o700 });
    chownSync(account.home, account.uid, account.gid); // freshly created root-controlled directory only
  }
  const [a, b] = accounts;
  assert.notEqual(a.uid, b.uid);
  assert.notEqual(a.gid, b.gid);
  const deps = defaultFleetDeps();
  const data = join(a.home, ".openmausbot");
  const config = join(data, "config.json");
  const sibling = join(b.home, "private.txt");
  deps.writeText(sibling, "fixture-sibling-sentinel", 0o600, b.name);
  check("real root-to-tenant mkdir/write/read and uid/gid ownership", () => {
    deps.mkdir(data, 0o700, a.name);
    deps.writeText(config, '{"signIn":{"admins":["fixture@example.test"]}}', 0o600, a.name);
    assert.equal(JSON.parse(deps.readText(config, a.name)!).signIn.admins.length, 1);
    const stat = lstatSync(config);
    assert.equal(stat.uid, a.uid); assert.equal(stat.gid, a.gid); assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(lstatSync(sibling).uid, b.uid);
  });
  check("distinct tenant uid cannot read sibling file or regain root", () => {
    const probe = String.raw`const fs=require("node:fs"), a=JSON.parse(fs.readFileSync(0,"utf8")); process.setgroups([]); process.setgid(a.gid); process.setuid(a.uid); if(process.getgroups().some(g=>g===0)) throw Error("root group retained"); try{process.setuid(0); throw Error("root restored")}catch(e){if(e.code!=="EPERM")throw e} try{fs.readFileSync(a.file);throw Error("sibling readable")}catch(e){if(e.code!=="EACCES")throw e} process.stdout.write("denied");`;
    assert.equal(command(process.execPath, ["--eval", probe], JSON.stringify({ uid: a.uid, gid: a.gid, file: sibling })), "denied");
  });
  const now = new Date("2026-09-11T12:00:00Z");
  deps.mkdir(join(data, "usage"), 0o700, a.name);
  const month = join(data, "usage", "2026-09.jsonl");
  check("real unprivileged monthly summary", () => {
    deps.writeText(month, JSON.stringify({ at: now.toISOString(), botId: "fixture", model: "fixture", input: 1, output: 1, costUsd: 0.25, trigger: { kind: "owner" } }) + "\n", 0o600, a.name);
    assert.deepEqual(deps.usage(data, a.name, now), { turns: 1, costUsd: 0.25, billableUsd: null });
  });
  const sentinel = join(root, "root-only-sentinel");
  writeFileSync(sentinel, "fixture-root-sentinel", { mode: 0o600 });
  for (const kind of ["root-file-symlink", "device-symlink", "fifo", "oversized"] as const) check(`refuse ${kind} without modifying sentinel`, () => {
    unlinkSync(month);
    if (kind.endsWith("symlink")) symlinkSync(kind === "device-symlink" ? "/dev/zero" : sentinel, month);
    else {
      if (kind === "fifo") command("/usr/bin/mkfifo", [month]);
      else writeFileSync(month, Buffer.alloc(4 * 1024 * 1024 + 1));
      chownSync(month, a.uid!, a.gid!); // known newly-created fixture inode, never a symlink
    }
    assert.throws(() => deps.usage(data, a.name, now));
    assert.equal(readFileSync(sentinel, "utf8"), "fixture-root-sentinel");
  });
  check("tenant config symlink cannot redirect a privileged write", () => {
    unlinkSync(config); symlinkSync(sentinel, config);
    assert.throws(() => deps.writeText(config, "replacement", 0o600, a.name));
    assert.equal(readFileSync(sentinel, "utf8"), "fixture-root-sentinel");
  });
  console.log(JSON.stringify({ event: "qualification-passed", checks: checks.length, platform: process.platform, node: process.version, identities: accounts.map(({ name, uid, gid }) => ({ name, uid, gid })) }));
} catch (error) {
  console.error((error as Error).message.slice(0, 500));
  process.exitCode = 1;
} finally {
  try { cleanup(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
