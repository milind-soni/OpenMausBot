import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Scenario = "lost-response" | "restart-after-5xx" | "in-progress" | "recovered-box";

const JOURNAL_MODULE_URL = pathToFileURL(join(process.cwd(), "server", "box-create-idempotency.ts")).href;

function journalWorker(dataDir: string, source: string) {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    source,
  ], {
    env: { ...process.env, OMB_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = once(child, "exit");
  return { child, lines, exited, stderr: () => stderr };
}

async function workerLine(
  worker: ReturnType<typeof journalWorker>,
  label: string,
): Promise<string> {
  const line = await worker.lines.next();
  if (line.done) throw new Error(`${label} exited before replying: ${worker.stderr()}`);
  return line.value;
}

async function expectCleanWorkerExit(
  worker: ReturnType<typeof journalWorker>,
  label: string,
): Promise<void> {
  const [code, signal] = await worker.exited;
  expect({ code, signal, stderr: worker.stderr() }, label).toEqual({ code: 0, signal: null, stderr: "" });
}

describe("Box create idempotency", () => {
  let api: Server;
  let scenario: Scenario = "lost-response";
  let allowRecovery = false;
  let acceptedKey = "";
  let createCount = 0;
  let failDesktop = false;
  const createKeys: string[] = [];
  const renameBodies: unknown[] = [];
  const deletedBoxes: string[] = [];

  const boxId = () => scenario === "lost-response"
    ? "bx_23456789"
    : scenario === "recovered-box"
      ? "bx_jkmnpqrs"
      : "bx_abcdefgh";

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, boxes: [] }));
        }
        if (url.pathname === "/api/box/v1/boxes" && req.method === "POST") {
          createCount += 1;
          const key = String(req.headers["idempotency-key"] ?? "");
          createKeys.push(key);
          expect(JSON.parse(raw)).toEqual({ ttlSeconds: 8 * 60 * 60, noEnv: true });
          if (!acceptedKey) acceptedKey = key;
          if (key !== acceptedKey) {
            res.writeHead(409);
            return res.end(JSON.stringify({ ok: false, code: "idempotency_key_reused" }));
          }

          if (scenario === "lost-response" && createCount === 1) {
            // The provider accepted the create, but the response disappeared.
            req.socket.destroy();
            return;
          }
          if (scenario === "restart-after-5xx" && !allowRecovery) {
            res.writeHead(503);
            return res.end(JSON.stringify({ ok: false, message: "accepted but response unavailable" }));
          }
          if (scenario === "in-progress" && createCount <= 3) {
            res.writeHead(409);
            return res.end(JSON.stringify({ ok: false, code: "idempotency_in_progress" }));
          }
          res.writeHead(201);
          return res.end(JSON.stringify({ ok: true, box: { id: boxId(), state: "ready" } }));
        }
        if (url.pathname === `/api/box/v1/boxes/${boxId()}` && req.method === "PATCH") {
          renameBodies.push(JSON.parse(raw));
          return res.end(JSON.stringify({ ok: true, box: { id: boxId(), state: "ready" } }));
        }
        if (url.pathname === `/api/box/v1/boxes/${boxId()}` && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, box: { id: boxId(), state: "ready" } }));
        }
        if (url.pathname.endsWith("/commands") && req.method === "POST") {
          return res.end(JSON.stringify({ ok: true, exitCode: 0, stdout: "ready", stderr: "" }));
        }
        if (url.pathname.endsWith("/desktop") && req.method === "POST") {
          if (failDesktop) {
            res.writeHead(503);
            return res.end(JSON.stringify({ ok: false, message: "desktop temporarily unavailable" }));
          }
          return res.end(JSON.stringify({ ok: true, desktopUrl: "https://desktop.example/session" }));
        }
        if (url.pathname === `/api/box/v1/boxes/${boxId()}` && req.method === "DELETE") {
          deletedBoxes.push(boxId());
          res.writeHead(202);
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(404).end(JSON.stringify({ ok: false, message: `unexpected ${req.method} ${url.pathname}` }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as AddressInfo).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
  });

  beforeEach(() => {
    allowRecovery = false;
    acceptedKey = "";
    createCount = 0;
    failDesktop = false;
    createKeys.length = 0;
    renameBodies.length = 0;
    deletedBoxes.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("retries a lost response with the same key and renames the recovered Box", async () => {
    scenario = "lost-response";
    vi.resetModules();
    const { provisionBox } = await import("./box.ts");

    const result = await provisionBox({ box: { token: "box_test" } } as any, "lost-response-bot", "Lost Response");

    expect(result.boxId).toBe("bx_23456789");
    expect(createKeys).toHaveLength(2);
    expect(createKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(createKeys).size).toBe(1);
    expect(renameBodies).toEqual([{ name: expect.stringMatching(/^ogb-[0-9a-f]{12}-lostres-[0-9a-f]{6}$/) }]);
  });

  it("reuses the durable key after a 5xx and module restart", async () => {
    scenario = "restart-after-5xx";
    vi.resetModules();
    let { provisionBox } = await import("./box.ts");

    await expect(
      provisionBox({ box: { token: "box_test" } } as any, "restart-5xx-bot", "Restart Recovery"),
    ).rejects.toThrow(/accepted but response unavailable/);
    expect(createKeys).toHaveLength(2);
    expect(new Set(createKeys).size).toBe(1);

    allowRecovery = true;
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
    const result = await provisionBox(
      { box: { token: "box_test" } } as any,
      "restart-5xx-bot",
      "Restart Recovery",
    );

    expect(result.boxId).toBe("bx_abcdefgh");
    expect(createKeys).toHaveLength(3);
    expect(new Set(createKeys).size).toBe(1);
    expect(renameBodies).toEqual([{ name: expect.stringMatching(/^ogb-[0-9a-f]{12}-restart-[0-9a-f]{6}$/) }]);
  });

  it("waits for an in-progress idempotent create and keeps the same key", async () => {
    scenario = "in-progress";
    vi.resetModules();
    const { provisionBox } = await import("./box.ts");

    const result = await provisionBox({ box: { token: "box_test" } } as any, "in-progress-bot", "In Progress");

    expect(result.boxId).toBe("bx_abcdefgh");
    expect(createKeys).toHaveLength(4);
    expect(new Set(createKeys).size).toBe(1);
  });

  it("never deletes a Box recovered from a previous provisioning attempt", async () => {
    scenario = "recovered-box";
    vi.resetModules();
    let { provisionBox } = await import("./box.ts");

    const first = await provisionBox({ box: { token: "box_test" } } as any, "recovered-bot", "Recovered");
    expect(first.boxId).toBe("bx_jkmnpqrs");
    expect(createCount).toBe(1);

    failDesktop = true;
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
    await expect(
      provisionBox({ box: { token: "box_test" } } as any, "recovered-bot", "Recovered"),
    ).rejects.toThrow(/desktop link could not be created/);

    expect(createCount).toBe(1);
    expect(deletedBoxes).toEqual([]);
  });

  it("fails closed when an ambiguous request has outlived the provider key", async () => {
    scenario = "restart-after-5xx";
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      vi.resetModules();
      let { provisionBox } = await import("./box.ts");
      await expect(
        provisionBox({ box: { token: "box_test" } } as any, "expired-5xx-bot", "Expired Recovery"),
      ).rejects.toThrow(/accepted but response unavailable/);
      expect(createKeys).toHaveLength(2);

      now.mockReturnValue(startedAt + 24 * 60 * 60 * 1_000 + 1);
      allowRecovery = true;
      vi.resetModules();
      ({ provisionBox } = await import("./box.ts"));
      await expect(
        provisionBox({ box: { token: "box_test" } } as any, "expired-5xx-bot", "Expired Recovery"),
      ).rejects.toThrow(/older than ascii\.dev's 24-hour retry window/i);

      expect(createKeys).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps key-only and remembered-ID attempts unresolved until provider naming succeeds", async () => {
    vi.resetModules();
    const {
      beginBoxCreate,
      boxCreateRecoverySnapshot,
      hasUnresolvedBoxCreate,
      rememberCreatedBox,
      resolveBoxCreate,
      retireDeletedBoxCreate,
    } = await import("./box-create-idempotency.ts");
    const botId = "deletion-guard-bot";
    const attempt = beginBoxCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));

    expect(hasUnresolvedBoxCreate(botId)).toBe(true);
    const pending = boxCreateRecoverySnapshot().find((record) => record.botId === botId);
    expect(pending).toEqual({ botId, resolved: false });
    expect(JSON.stringify(pending)).not.toContain(attempt.request.idempotencyKey);
    expect(JSON.stringify(pending)).not.toContain(attempt.request.requestBody);
    const remembered = rememberCreatedBox(attempt.request, "bx_3456789a");
    expect(hasUnresolvedBoxCreate(botId)).toBe(true);
    expect(boxCreateRecoverySnapshot().find((record) => record.botId === botId)).toEqual({
      botId,
      boxId: "bx_3456789a",
      resolved: false,
    });

    resolveBoxCreate(remembered);
    expect(hasUnresolvedBoxCreate(botId)).toBe(false);
    expect(boxCreateRecoverySnapshot().find((record) => record.botId === botId)).toEqual({
      botId,
      boxId: "bx_3456789a",
      resolved: true,
    });

    retireDeletedBoxCreate("bx_3456789a");
    expect(boxCreateRecoverySnapshot().find((record) => record.botId === botId)).toBeUndefined();
  });

  it("adopts the same legacy Box once, supersedes pending state, and refuses conflicting ownership", async () => {
    vi.resetModules();
    const {
      adoptResolvedBox,
      beginBoxCreate,
      boxCreateRecoverySnapshot,
      hasUnresolvedBoxCreate,
      retireDeletedBoxCreate,
    } = await import("./box-create-idempotency.ts");
    const boxId = "bx_56789abc";
    const botId = "legacy-journal-owner";
    try {
      beginBoxCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
      expect(hasUnresolvedBoxCreate(botId)).toBe(true);
      adoptResolvedBox(botId, boxId);
      adoptResolvedBox(botId, boxId);
      expect(hasUnresolvedBoxCreate(botId)).toBe(false);
      expect(boxCreateRecoverySnapshot().filter((record) => record.botId === botId)).toEqual([
        { botId, boxId, resolved: true },
      ]);

      adoptResolvedBox(botId, "bx_6789abcd");
      expect(boxCreateRecoverySnapshot().filter((record) => record.botId === botId)).toEqual([
        { botId, boxId: "bx_6789abcd", resolved: true },
      ]);
      expect(() => adoptResolvedBox("other-legacy-owner", "bx_6789abcd")).toThrow(/another bot/i);
      expect(boxCreateRecoverySnapshot().filter((record) => record.botId === botId)).toEqual([
        { botId, boxId: "bx_6789abcd", resolved: true },
      ]);
    } finally {
      retireDeletedBoxCreate(boxId);
      retireDeletedBoxCreate("bx_6789abcd");
    }
  });

  it("serializes two processes that primed independent journal caches", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-box-journal-processes-"));
    const requestBody = JSON.stringify({ ttlSeconds: 7_200, noEnv: true });
    const source = `
      const journal = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
      journal.hasUnresolvedBoxCreate("multiprocess-primer");
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => {
        const result = journal.beginBoxCreate("multiprocess-bot", ${JSON.stringify(requestBody)});
        process.stdout.write(JSON.stringify(result) + "\\n");
      });
    `;
    const first = journalWorker(dataDir, source);
    const second = journalWorker(dataDir, source);
    try {
      expect(await workerLine(first, "first journal worker")).toBe("ready");
      expect(await workerLine(second, "second journal worker")).toBe("ready");

      // Both long-lived processes loaded the empty journal before either
      // mutation. The old in-memory cache deterministically minted two keys.
      first.child.stdin.end("begin\n");
      second.child.stdin.end("begin\n");
      const [firstResult, secondResult] = await Promise.all([
        workerLine(first, "first journal worker"),
        workerLine(second, "second journal worker"),
      ]).then((lines) => lines.map((line) => JSON.parse(line) as {
        request: { idempotencyKey: string };
        startedNow: boolean;
      }));
      await Promise.all([
        expectCleanWorkerExit(first, "first journal worker"),
        expectCleanWorkerExit(second, "second journal worker"),
      ]);

      expect(firstResult.request.idempotencyKey).toBe(secondResult.request.idempotencyKey);
      expect([firstResult.startedNow, secondResult.startedNow].sort()).toEqual([false, true]);
      const state = JSON.parse(readFileSync(join(dataDir, "box-create-requests.json"), "utf8")) as {
        requests: Array<{ botId: string; requestBody: string; idempotencyKey: string }>;
      };
      expect(state.requests).toEqual([{
        botId: "multiprocess-bot",
        requestBody,
        idempotencyKey: firstResult.request.idempotencyKey,
        createdAt: expect.any(Number),
      }]);
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second.child.exitCode === null) second.child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("safely retires a complete lock left by an exited process", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-box-journal-stale-"));
    const exited = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    const exitedPid = exited.pid;
    expect(exitedPid).toBeTypeOf("number");
    await once(exited, "exit");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "box-create-requests.lock"), JSON.stringify({
      version: 1,
      pid: exitedPid,
      token: randomUUID(),
      createdAt: Date.now(),
    }));
    const source = `
      const journal = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
      process.stdout.write(JSON.stringify(journal.beginBoxCreate(
        "stale-lock-bot",
        JSON.stringify({ ttlSeconds: 7200, noEnv: true }),
      )) + "\\n");
    `;
    const worker = journalWorker(dataDir, source);
    try {
      const result = JSON.parse(await workerLine(worker, "stale-lock worker"));
      await expectCleanWorkerExit(worker, "stale-lock worker");
      expect(result).toMatchObject({ startedNow: true, request: { botId: "stale-lock-bot" } });
      expect(JSON.parse(readFileSync(join(dataDir, "box-create-requests.json"), "utf8")).requests).toHaveLength(1);
    } finally {
      if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers when an elected stale-lock reaper also exited", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-box-journal-dead-reaper-"));
    const exitedOwner = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    const exitedOwnerPid = exitedOwner.pid;
    expect(exitedOwnerPid).toBeTypeOf("number");
    await once(exitedOwner, "exit");
    const exitedReaper = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    const exitedReaperPid = exitedReaper.pid;
    expect(exitedReaperPid).toBeTypeOf("number");
    await once(exitedReaper, "exit");

    const lockToken = randomUUID();
    const lockPath = join(dataDir, "box-create-requests.lock");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      pid: exitedOwnerPid,
      token: lockToken,
      createdAt: Date.now(),
    }));
    // This is the marker format shipped before successor elections existed.
    writeFileSync(`${lockPath}.reap-${lockToken}`, `${exitedReaperPid}\n`);

    const source = `
      const journal = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
      process.stdout.write(JSON.stringify(journal.beginBoxCreate(
        "dead-reaper-bot",
        JSON.stringify({ ttlSeconds: 7200, noEnv: true }),
      )) + "\\n");
    `;
    const worker = journalWorker(dataDir, source);
    try {
      const result = JSON.parse(await workerLine(worker, "dead-reaper worker"));
      await expectCleanWorkerExit(worker, "dead-reaper worker");
      expect(result).toMatchObject({ startedNow: true, request: { botId: "dead-reaper-bot" } });
      expect(JSON.parse(readFileSync(join(dataDir, "box-create-requests.json"), "utf8")).requests).toHaveLength(1);
    } finally {
      if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("bounds retries when a lock disappears between EEXIST and owner read", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-box-journal-vanishing-lock-"));
    const lockPath = join(dataDir, "box-create-requests.lock");
    const source = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const lockPath = ${JSON.stringify(lockPath)};
      const originalLink = fs.linkSync.bind(fs);
      const originalRead = fs.readFileSync.bind(fs);
      fs.linkSync = (existingPath, newPath) => {
        if (String(newPath) === lockPath) {
          const error = new Error("fixture lock exists");
          error.code = "EEXIST";
          throw error;
        }
        return originalLink(existingPath, newPath);
      };
      fs.readFileSync = (path, ...args) => {
        if (String(path) === lockPath) {
          const error = new Error("fixture lock vanished");
          error.code = "ENOENT";
          throw error;
        }
        return originalRead(path, ...args);
      };
      syncBuiltinESMExports();
      let clock = 0;
      Object.defineProperty(performance, "now", { value: () => (clock += 1_001) });
      const started = performance.now();
      const journal = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
      try {
        journal.beginBoxCreate("vanishing-lock-bot", JSON.stringify({ ttlSeconds: 7200, noEnv: true }));
        process.stdout.write(JSON.stringify({ unexpected: true }) + "\\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({
          error: String(error?.message ?? error),
          elapsed: performance.now() - started,
        }) + "\\n");
      }
    `;
    const worker = journalWorker(dataDir, source);
    try {
      const result = JSON.parse(await workerLine(worker, "vanishing-lock worker")) as {
        error?: string;
        elapsed?: number;
      };
      await expectCleanWorkerExit(worker, "vanishing-lock worker");
      expect(result.error).toMatch(/locked by another OpenMausBot process/i);
      expect(result.elapsed).toBeGreaterThanOrEqual(1_500);
      expect(result.elapsed).toBeLessThan(5_000);
    } finally {
      if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("bounds retries when every successfully reaped lock is replaced", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-box-journal-replaced-lock-"));
    const exited = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    const exitedPid = exited.pid;
    expect(exitedPid).toBeTypeOf("number");
    await once(exited, "exit");
    const lockPath = join(dataDir, "box-create-requests.lock");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      pid: exitedPid,
      token: randomUUID(),
      createdAt: Date.now(),
    }));
    const source = `
      import fs from "node:fs";
      import { randomUUID } from "node:crypto";
      import { syncBuiltinESMExports } from "node:module";
      const lockPath = ${JSON.stringify(lockPath)};
      const deadPid = ${JSON.stringify(exitedPid)};
      const originalUnlink = fs.unlinkSync.bind(fs);
      fs.unlinkSync = (path) => {
        originalUnlink(path);
        if (String(path) === lockPath) {
          fs.writeFileSync(lockPath, JSON.stringify({
            version: 1,
            pid: deadPid,
            token: randomUUID(),
            createdAt: Date.now(),
          }));
        }
      };
      syncBuiltinESMExports();
      let clock = 0;
      Object.defineProperty(performance, "now", { value: () => (clock += 1_001) });
      const started = performance.now();
      const journal = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
      try {
        journal.beginBoxCreate("replaced-lock-bot", JSON.stringify({ ttlSeconds: 7200, noEnv: true }));
        process.stdout.write(JSON.stringify({ unexpected: true }) + "\\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({
          error: String(error?.message ?? error),
          elapsed: performance.now() - started,
        }) + "\\n");
      }
    `;
    const worker = journalWorker(dataDir, source);
    try {
      const result = JSON.parse(await workerLine(worker, "replaced-lock worker")) as {
        error?: string;
        elapsed?: number;
      };
      await expectCleanWorkerExit(worker, "replaced-lock worker");
      expect(result.error).toMatch(/locked by another OpenMausBot process/i);
      expect(result.elapsed).toBeGreaterThanOrEqual(1_500);
      expect(result.elapsed).toBeLessThan(5_000);
    } finally {
      if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("never bypasses a live elected reaper when contenders race", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-box-journal-live-reaper-"));
    const exitedOwner = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    const exitedOwnerPid = exitedOwner.pid;
    expect(exitedOwnerPid).toBeTypeOf("number");
    await once(exitedOwner, "exit");

    const lockToken = randomUUID();
    const reaperToken = randomUUID();
    const lockPath = join(dataDir, "box-create-requests.lock");
    const lockContents = JSON.stringify({
      version: 1,
      pid: exitedOwnerPid,
      token: lockToken,
      createdAt: Date.now(),
    });
    const reaperContents = JSON.stringify({
      version: 1,
      pid: process.pid,
      token: reaperToken,
      createdAt: Date.now(),
      targetToken: lockToken,
    });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(lockPath, lockContents);
    writeFileSync(`${lockPath}.reap-${lockToken}`, reaperContents);

    const source = `
      const journal = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
      try {
        journal.beginBoxCreate("live-reaper-bot", JSON.stringify({ ttlSeconds: 7200, noEnv: true }));
        process.stdout.write(JSON.stringify({ unexpected: true }) + "\\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }) + "\\n");
      }
    `;
    const first = journalWorker(dataDir, source);
    const second = journalWorker(dataDir, source);
    try {
      const [firstResult, secondResult] = await Promise.all([
        workerLine(first, "first live-reaper contender"),
        workerLine(second, "second live-reaper contender"),
      ]).then((lines) => lines.map((line) => JSON.parse(line) as { error?: string }));
      await Promise.all([
        expectCleanWorkerExit(first, "first live-reaper contender"),
        expectCleanWorkerExit(second, "second live-reaper contender"),
      ]);

      expect(firstResult.error).toMatch(/locked by another OpenMausBot process/i);
      expect(secondResult.error).toMatch(/locked by another OpenMausBot process/i);
      expect(readFileSync(lockPath, "utf8")).toBe(lockContents);
      expect(readFileSync(`${lockPath}.reap-${lockToken}`, "utf8")).toBe(reaperContents);
      expect(() => readFileSync(join(dataDir, "box-create-requests.json"), "utf8")).toThrow();
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second.child.exitCode === null) second.child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed instead of replacing an ownerless or corrupt lock", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-box-journal-corrupt-lock-"));
    writeFileSync(join(dataDir, "box-create-requests.lock"), "not-json\n");
    const source = `
      const journal = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
      try {
        journal.beginBoxCreate("corrupt-lock-bot", JSON.stringify({ ttlSeconds: 7200, noEnv: true }));
        process.stdout.write(JSON.stringify({ unexpected: true }) + "\\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }) + "\\n");
      }
    `;
    const worker = journalWorker(dataDir, source);
    try {
      const result = JSON.parse(await workerLine(worker, "corrupt-lock worker"));
      await expectCleanWorkerExit(worker, "corrupt-lock worker");
      expect(result.error).toMatch(/recovery state.*lock is invalid/i);
      expect(() => readFileSync(join(dataDir, "box-create-requests.json"), "utf8")).toThrow();
      expect(readFileSync(join(dataDir, "box-create-requests.lock"), "utf8")).toBe("not-json\n");
    } finally {
      if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
