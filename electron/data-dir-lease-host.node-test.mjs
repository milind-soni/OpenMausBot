// The desktop's server child and the lease its parent hands it: the parent's boot and machine ids travel with the
// capability, so the child does not read them again, and Windows does not match its own parent to the lease by creation time.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDataDirLease, consumeHostIdentity, creationTimeNeeded } from "./data-dir-lease.mjs";

const MODULE_URL = new URL("./data-dir-lease.mjs", import.meta.url).href;
const LEASE_NAME = "openmausbot-server.lease";
const roots = [];
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function temporaryDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), "omb-electron-lease-host-"));
  roots.push(root);
  return { dataDir: path.join(root, "data") };
}

function runNode(source, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a delegated child takes the parent's boot and machine ids from its environment, once, instead of reading them again", async () => {
  const { dataDir } = temporaryDirectory();
  const parent = acquireDataDirLease(dataDir);
  try {
    const handed = parent.utilityServerLeaseEnvironment();
    const [hostName, host] = Object.entries(handed).find(([name]) => name.endsWith("_HOST"));
    const record = JSON.parse(readFileSync(path.join(dataDir, LEASE_NAME), "utf8"));
    assert.equal(host, `${record.boot ?? "-"} ${record.machine ?? "-"}`);
    // The child reads the ids from the environment, then the lease it writes carries the parent's; both variables are gone.
    const child = await runNode(`
      const { acquireDataDirLeaseForProcess } = await import(${JSON.stringify(MODULE_URL)});
      const lease = acquireDataDirLeaseForProcess(${JSON.stringify(dataDir)});
      const { readFileSync } = await import("node:fs");
      const own = JSON.parse(readFileSync(${JSON.stringify(path.join(dataDir, ".openmausbot-server-child", LEASE_NAME))}, "utf8"));
      process.stdout.write(JSON.stringify({ boot: own.boot, machine: own.machine, left: Object.keys(process.env).filter((name) => name.startsWith("OPENMAUSBOT_INTERNAL")) }));
      lease.release();
    `, handed);
    assert.equal(child.code, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { boot: record.boot ?? null, machine: record.machine ?? null, left: [] });
    assert.ok(hostName);
  } finally {
    parent.release();
  }
});

test("a handed host identity is taken only when well formed, and is removed from the environment", () => {
  const name = "OPENMAUSBOT_INTERNAL_DATA_DIR_HOST";
  const boot = randomUUID(), machine = "a".repeat(32);
  const environment = { [name]: `${boot} ${machine}` };
  assert.deepEqual(consumeHostIdentity(environment), { boot, machine });
  assert.equal(name in environment, false);
  assert.deepEqual(consumeHostIdentity({ [name]: "- -" }), { boot: null, machine: null });
  assert.deepEqual(consumeHostIdentity({ [name]: "bad/boot nothex" }), { boot: undefined, machine: undefined });
  assert.equal(consumeHostIdentity({ [name]: `${boot} ${machine} extra` }), null);
  assert.equal(consumeHostIdentity({}), null);
});

test("only Windows asks a live pid's creation time, and never for the parent that handed this process the record", () => {
  assert.equal(creationTimeNeeded("win32", 4242, null), true);
  assert.equal(creationTimeNeeded("win32", 4242, 77), true);
  assert.equal(creationTimeNeeded("win32", 4242, 4242), false);
  assert.equal(creationTimeNeeded("win32", 4242, 0), true);
  for (const platform of ["darwin", "linux"]) assert.equal(creationTimeNeeded(platform, 4242, null), false);
});
