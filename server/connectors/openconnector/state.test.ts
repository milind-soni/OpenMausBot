// The local OpenConnector state store — explicit account-id mapping, 0600 persistence, and
// the webhook-style seal. Also pins connector-key as a backup-excluded path.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { excludedWorkspaceAuthPath } from "../../workspace-backup-policy.ts";
import {
  CONNECTOR_KEY_FILE,
  OpenConnectorStateStore,
  accountIdForConnection,
  parseConnectionAccountId,
} from "./state.ts";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-oconn-state-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const newStore = () => new OpenConnectorStateStore(join(dir, `state-${Math.random().toString(36).slice(2)}.json`));

describe("account id mapping", () => {
  it("round-trips service and alias, defaulting the alias", () => {
    expect(accountIdForConnection("github")).toBe("oc:github:default");
    expect(parseConnectionAccountId("oc:github:default")).toEqual({ service: "github", alias: "default" });
    expect(parseConnectionAccountId(accountIdForConnection("github", "work"))).toEqual({ service: "github", alias: "work" });
  });

  it("survives underscores in services and printable specials in aliases", () => {
    expect(parseConnectionAccountId(accountIdForConnection("google_calendar", "my cal:main"))).toEqual({
      service: "google_calendar",
      alias: "my cal:main",
    });
    expect(parseConnectionAccountId(accountIdForConnection("bland_ai", "a/b\\c%"))).toEqual({
      service: "bland_ai",
      alias: "a/b\\c%",
    });
  });

  it("rejects malformed ids", () => {
    expect(parseConnectionAccountId("oc:github")).toBeNull();
    expect(parseConnectionAccountId("xx:github:default")).toBeNull();
    expect(parseConnectionAccountId("oc::default")).toBeNull();
    expect(parseConnectionAccountId("nonsense")).toBeNull();
  });
});

describe("state persistence", () => {
  it("persists connections and app OAuth records with 0600 permissions", () => {
    const file = join(dir, "persist-state.json");
    const store = new OpenConnectorStateStore(file);
    store.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", status: "ACTIVE", updatedAt: "t1" });
    store.upsertAppOAuth({ service: "github", clientId: "cid", scopes: ["repo"], sealedClientSecret: "sealed", updatedAt: "t1" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = new OpenConnectorStateStore(file);
    expect(reloaded.listConnections()).toEqual([{ accountId: "oc:github:work", service: "github", alias: "work", status: "ACTIVE", updatedAt: "t1" }]);
    expect(reloaded.findAppOAuth("github")).toMatchObject({ clientId: "cid", sealedClientSecret: "sealed" });
  });

  it("removes one record or a whole service", () => {
    const store = newStore();
    store.upsertConnection({ accountId: "oc:github:a", service: "github", status: "ACTIVE", updatedAt: "t" });
    store.upsertConnection({ accountId: "oc:github:b", service: "github", status: "ACTIVE", updatedAt: "t" });
    store.upsertConnection({ accountId: "oc:slack:c", service: "slack", status: "ACTIVE", updatedAt: "t" });
    expect(store.removeConnectionsForService("github")).toBe(2);
    expect(store.listConnections().map((record) => record.accountId)).toEqual(["oc:slack:c"]);
    expect(store.removeConnection("oc:slack:c")).toBe(true);
    expect(store.removeConnection("oc:slack:c")).toBe(false);
  });

  it("does not reuse records from a different runtime URL", () => {
    const file = join(dir, `scoped-${Math.random().toString(36).slice(2)}.json`);
    const first = new OpenConnectorStateStore(file, "https://first.example.test");
    first.upsertConnection({ accountId: "oc:github:default", service: "github", status: "ACTIVE", updatedAt: "t" });
    const readRaw = JSON.parse(readFileSync(file, "utf8"));
    expect(readRaw.runtimeUrl).toBe("https://first.example.test");

    const second = new OpenConnectorStateStore(file, "https://second.example.test");
    expect(second.listConnections()).toEqual([]);
    const before = readFileSync(file, "utf8");
    expect(() => second.upsertConnection({
      accountId: "oc:github:default",
      service: "github",
      status: "ACTIVE",
      updatedAt: "wrong-runtime",
    })).toThrow(/different runtime URL/);
    expect(() => second.upsertAppOAuth({
      service: "github",
      clientId: "cid",
      updatedAt: "wrong-runtime",
    })).toThrow(/different runtime URL/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(new OpenConnectorStateStore(file, "https://first.example.test").listConnections()).toHaveLength(1);
  });

  it("updates connections only when the expected request id still owns the row", () => {
    const file = join(dir, `cas-${Math.random().toString(36).slice(2)}.json`);
    const store = new OpenConnectorStateStore(file);
    const record = {
      accountId: "oc:github:work",
      service: "github",
      alias: "work",
      connectionRequestId: "request-1",
      status: "pending",
      updatedAt: "old",
    };
    store.upsertConnection(record);
    expect(store.updateConnectionIf(record.accountId, "stale", () => ({
      ...record,
      status: "connected",
      updatedAt: "stale",
    }))).toBeNull();
    expect(store.findConnectionByAccountId(record.accountId)?.status).toBe("pending");

    store.upsertConnection({ ...record, connectionRequestId: "request-2" });
    expect(store.updateConnectionIf(record.accountId, "request-1", () => ({
      ...record,
      status: "connected",
      updatedAt: "replaced",
    }))).toBeNull();
    expect(store.findConnectionByAccountId(record.accountId)).toMatchObject({
      connectionRequestId: "request-2",
      status: "pending",
    });

    expect(store.updateConnectionIf(record.accountId, "request-2", (current) => ({
      ...current,
      status: "connected",
      updatedAt: "current",
    }))).toMatchObject({ connectionRequestId: "request-2", status: "connected" });

    store.removeConnection(record.accountId);
    expect(store.updateConnectionIf(record.accountId, "request-2", () => ({
      ...record,
      status: "connected",
      updatedAt: "revived",
    }))).toBeNull();
    expect(store.findConnectionByAccountId(record.accountId)).toBeNull();
  });

  it("serializes simultaneous cross-process writers under the SQLite lock", async () => {
    const file = join(dir, `locked-${Math.random().toString(36).slice(2)}.json`);
    const former = new OpenConnectorStateStore(file);
    former.upsertConnection({ accountId: "oc:github:old", service: "github", status: "ACTIVE", updatedAt: "old" });
    const moduleUrl = JSON.stringify(pathToFileURL(join(import.meta.dirname, "state.ts")).href);
    const startWriter = (index: number) => {
      const child = spawn(process.execPath, [
        "--experimental-strip-types", "--input-type=module", "-e",
        `const index = ${index};
         const { OpenConnectorStateStore } = await import(${moduleUrl});
         const store = new OpenConnectorStateStore(${JSON.stringify(file)});
         store.upsertConnection({
           accountId: "oc:service:" + index,
           service: "service",
           alias: String(index),
           status: "ACTIVE",
           updatedAt: "writer-" + index,
         });
         process.exit(0);`,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      return new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer ${index} exited ${code}: ${output}`)));
      });
    };
    await Promise.all([1, 2, 3, 4].map(startWriter));
    former.upsertConnection({ accountId: "oc:github:old", service: "github", status: "ACTIVE", updatedAt: "newer" });
    const reloaded = new OpenConnectorStateStore(file);
    expect(reloaded.findConnectionByAccountId("oc:github:old")).toMatchObject({ updatedAt: "newer" });
    expect(reloaded.listConnections()).toHaveLength(5);
    for (let index = 1; index <= 4; index += 1) {
      expect(reloaded.findConnectionByAccountId(`oc:service:${index}`)).toMatchObject({ updatedAt: `writer-${index}` });
    }
    expect(statSync(`${file}.lock.db`).mode & 0o777).toBe(0o600);
    expect(excludedWorkspaceAuthPath("openconnector-state.json.lock")).toBe(true);
    expect(excludedWorkspaceAuthPath("openconnector-state.json.lock.db")).toBe(true);
    expect(excludedWorkspaceAuthPath("openconnector-state.json.lock.db-journal")).toBe(true);
    expect(excludedWorkspaceAuthPath("openconnector-state.json.lock.db-wal")).toBe(true);
    expect(excludedWorkspaceAuthPath("openconnector-state.json.lock.db-shm")).toBe(true);
    expect(excludedWorkspaceAuthPath("openconnector-state.json.123.05a7b3e0-1234-4abc-8def-0123456789ab.tmp")).toBe(true);
  });

  it("reads a missing or corrupt file as empty", () => {
    const store = newStore();
    expect(store.listConnections()).toEqual([]);
    const file = join(dir, "corrupt.json");
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(new OpenConnectorStateStore(file).listConnections()).toEqual([]);
  });
});

describe("secret sealing", () => {
  it("seals and unseals without persisting plaintext", () => {
    const store = newStore();
    const sealed = store.sealSecret("super-secret-value");
    expect(sealed).not.toContain("super-secret-value");
    expect(store.unsealSecret(sealed)).toBe("super-secret-value");
  });

  it("keeps the key in a 0600 file beside the state file, excluded from backups", () => {
    const store = newStore();
    store.sealSecret("x");
    const keyFile = join(dir, CONNECTOR_KEY_FILE);
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(excludedWorkspaceAuthPath(CONNECTOR_KEY_FILE)).toBe(true);
    expect(excludedWorkspaceAuthPath(`connector-key.12.05a7b3e0-1234-4abc-8def-0123456789ab.tmp`)).toBe(true);
  });

  it("unseals nothing when the key is gone or the seal is tampered", () => {
    const store = newStore();
    const sealed = store.sealSecret("value");
    const keyFile = join(dir, CONNECTOR_KEY_FILE);
    const original = readFileSync(keyFile, "utf8");
    try {
      rmSync(keyFile);
      expect(store.unsealSecret(sealed)).toBeNull();
    } finally {
      writeFileSync(keyFile, original, { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    }
    const elsewhere = new OpenConnectorStateStore(join(mkdtempSync(join(tmpdir(), "omb-oconn-other-")), "state.json"));
    expect(elsewhere.unsealSecret(sealed)).toBeNull();
    expect(store.unsealSecret("garbage-base64!")).toBeNull();
    expect(store.unsealSecret(undefined)).toBeNull();
  });
});
