import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_URL = pathToFileURL(join(process.cwd(), "server", "box-delete-journal.ts")).href;
const OPERATION_ID = "bdop_0123456789abcdef0123456789abcdef";

function operation(
  targetId = "bx_23456789",
  status: "pending" | "processing" | "blocked" | "completed" = "pending",
) {
  return { id: OPERATION_ID, kind: "box" as const, targetId, status };
}

function worker(dataDir: string, source: string) {
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
  return { child, lines, exited: once(child, "exit"), stderr: () => stderr };
}

async function nextLine(subject: ReturnType<typeof worker>, label: string): Promise<string> {
  const line = await subject.lines.next();
  if (line.done) throw new Error(`${label} exited before replying: ${subject.stderr()}`);
  return line.value;
}

async function expectCleanExit(subject: ReturnType<typeof worker>, label: string): Promise<void> {
  const [code, signal] = await subject.exited;
  expect({ code, signal, stderr: subject.stderr() }, label).toEqual({ code: 0, signal: null, stderr: "" });
}

describe("Box deletion journal", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-box-delete-journal-"));
    vi.stubEnv("OMB_DATA_DIR", dataDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists a prepared target across a module restart without credentials", async () => {
    let journal = await import("./box-delete-journal.ts");
    const prepared = journal.prepareBoxDeletion({
      boxId: "bx_23456789",
      name: "ogb-0123456789ab-owner-abcdef",
      ownerBotId: "owner-bot",
    });
    expect(prepared).toMatchObject({
      boxId: "bx_23456789",
      ownerBotId: "owner-bot",
      phase: "prepared",
    });

    vi.resetModules();
    journal = await import("./box-delete-journal.ts");
    expect(journal.getBoxDeletion("bx_23456789")).toEqual(prepared);
    expect(journal.isBoxDeletionPending("bx_23456789")).toBe(true);
    expect(journal.hasPendingBoxDeletionForBot("owner-bot")).toBe(true);

    const path = join(dataDir, "box-delete-requests.json");
    const stored = readFileSync(path, "utf8");
    expect(JSON.parse(stored)).toEqual({ version: 1, records: [prepared] });
    expect(stored).not.toMatch(/token|authorization|secret/i);
    // Windows reports 0666 for a 0600 file: the mode is a POSIX guarantee.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("advances a target-bound operation monotonically and retires idempotently", async () => {
    const journal = await import("./box-delete-journal.ts");
    journal.prepareBoxDeletion({ boxId: "bx_23456789", name: "owned-box", ownerBotId: "owner-bot" });

    const pending = journal.markBoxDeletionAccepted("bx_23456789", operation());
    expect(pending).toMatchObject({ phase: "accepted", operationId: OPERATION_ID, status: "pending" });
    const processing = journal.markBoxDeletionAccepted("bx_23456789", operation("bx_23456789", "processing"));
    expect(processing.status).toBe("processing");

    // An eventually-consistent provider response must not move the fence back.
    expect(journal.markBoxDeletionAccepted("bx_23456789", operation()).status).toBe("processing");
    const completed = journal.markBoxDeletionAccepted("bx_23456789", operation("bx_23456789", "completed"));
    expect(completed.status).toBe("completed");
    expect(journal.listBoxDeletions()).toEqual([completed]);

    const snapshot = journal.boxDeletionSnapshot();
    snapshot[0]!.name = "mutated outside";
    expect(journal.getBoxDeletion("bx_23456789")?.name).toBe("owned-box");

    journal.retireBoxDeletion("bx_23456789");
    journal.retireBoxDeletion("bx_23456789");
    expect(journal.boxDeletionSnapshot()).toEqual([]);
  });

  it("records a block, keeps the target fenced, and supports an explicit deletion retry", async () => {
    const journal = await import("./box-delete-journal.ts");
    const identity = { boxId: "bx_23456789", name: "orphan-box", ownerBotId: null };
    journal.prepareBoxDeletion(identity);
    journal.markBoxDeletionAccepted("bx_23456789", operation());
    const blocked = journal.markBoxDeletionBlocked(
      "bx_23456789",
      operation("bx_23456789", "blocked"),
    );
    expect(blocked).toMatchObject({ phase: "blocked", operationId: OPERATION_ID, status: "blocked" });
    expect(journal.isBoxDeletionPending("bx_23456789")).toBe(true);

    const retried = journal.prepareBoxDeletion(identity);
    expect(retried).toMatchObject({ ...identity, phase: "prepared" });
    expect(retried).not.toHaveProperty("operationId");
    expect(retried).not.toHaveProperty("status");
    expect(journal.isBoxDeletionPending("bx_23456789")).toBe(true);
  });

  it("refuses identity conflicts and non-target-bound provider receipts", async () => {
    const journal = await import("./box-delete-journal.ts");
    journal.prepareBoxDeletion({ boxId: "bx_23456789", name: "owned-box", ownerBotId: "owner-bot" });

    expect(() => journal.prepareBoxDeletion({
      boxId: "bx_23456789",
      name: "renamed-box",
      ownerBotId: "owner-bot",
    })).toThrow(/conflicted/i);
    expect(() => journal.markBoxDeletionAccepted(
      "bx_23456789",
      operation("bx_3456789a"),
    )).toThrow(/mismatched/i);
    expect(() => journal.markBoxDeletionAccepted("bx_23456789", {
      ...operation(),
      kind: "workspace",
    })).toThrow(/mismatched/i);
    expect(() => journal.markBoxDeletionAccepted("bx_23456789", {
      ...operation(),
      id: "operation-not-provider-shaped",
    })).toThrow(/mismatched/i);

    journal.markBoxDeletionAccepted("bx_23456789", operation());
    expect(() => journal.markBoxDeletionAccepted("bx_23456789", {
      ...operation(),
      id: "bdop_ffffffffffffffffffffffffffffffff",
    })).toThrow(/another deletion operation/i);

    journal.prepareBoxDeletion({ boxId: "bx_3456789a", name: "second-box", ownerBotId: null });
    expect(() => journal.markBoxDeletionAccepted("bx_3456789a", operation("bx_3456789a")))
      .toThrow(/another deletion operation/i);
  });

  it("rejects invalid targets before writing state", async () => {
    const journal = await import("./box-delete-journal.ts");
    expect(() => journal.prepareBoxDeletion({
      boxId: "../../config.json",
      name: "box",
      ownerBotId: null,
    })).toThrow(/invalid cloud computer id/i);
    expect(() => journal.prepareBoxDeletion({
      boxId: "bx_23456789",
      name: "bad\nname",
      ownerBotId: null,
    })).toThrow(/invalid cloud computer name/i);
    expect(() => journal.prepareBoxDeletion({
      boxId: "bx_23456789",
      name: "box",
      ownerBotId: "bad owner",
    })).toThrow(/invalid cloud computer owner/i);
    expect(() => readFileSync(join(dataDir, "box-delete-requests.json"), "utf8")).toThrow();
  });

  it("fails closed on malformed or duplicate persisted authority", async () => {
    const journal = await import("./box-delete-journal.ts");
    journal.prepareBoxDeletion({ boxId: "bx_23456789", name: "owned-box", ownerBotId: "owner-bot" });
    const path = join(dataDir, "box-delete-requests.json");
    writeFileSync(path, "{ truncated\n");
    expect(() => journal.boxDeletionSnapshot()).toThrow(/recovery state is unreadable/i);
    expect(readFileSync(path, "utf8")).toBe("{ truncated\n");

    const now = Date.now();
    const duplicate = {
      boxId: "bx_3456789a",
      name: "second-box",
      ownerBotId: null,
      phase: "accepted",
      operationId: OPERATION_ID,
      status: "pending",
      requestedAt: now,
      updatedAt: now,
    };
    writeFileSync(path, `${JSON.stringify({ version: 1, records: [
      { ...duplicate, boxId: "bx_23456789" },
      duplicate,
    ] })}\n`);
    expect(() => journal.boxDeletionSnapshot()).toThrow(/recovery state is invalid/i);
  });

  it("serializes independent processes without losing either prepared deletion", async () => {
    const concurrentDir = mkdtempSync(join(tmpdir(), "omb-box-delete-processes-"));
    const source = (boxId: string, name: string) => `
      const journal = await import(${JSON.stringify(MODULE_URL)});
      journal.boxDeletionSnapshot();
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => {
        const result = journal.prepareBoxDeletion({
          boxId: ${JSON.stringify(boxId)},
          name: ${JSON.stringify(name)},
          ownerBotId: null,
        });
        process.stdout.write(JSON.stringify(result) + "\\n");
      });
    `;
    const first = worker(concurrentDir, source("bx_23456789", "first-box"));
    const second = worker(concurrentDir, source("bx_3456789a", "second-box"));
    try {
      expect(await nextLine(first, "first worker")).toBe("ready");
      expect(await nextLine(second, "second worker")).toBe("ready");
      first.child.stdin.end("prepare\n");
      second.child.stdin.end("prepare\n");
      await Promise.all([nextLine(first, "first worker"), nextLine(second, "second worker")]);
      await Promise.all([expectCleanExit(first, "first worker"), expectCleanExit(second, "second worker")]);

      const saved = JSON.parse(readFileSync(join(concurrentDir, "box-delete-requests.json"), "utf8"));
      expect(saved.records).toHaveLength(2);
      expect(saved.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ boxId: "bx_23456789", phase: "prepared" }),
        expect.objectContaining({ boxId: "bx_3456789a", phase: "prepared" }),
      ]));
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second.child.exitCode === null) second.child.kill("SIGKILL");
      rmSync(concurrentDir, { recursive: true, force: true });
    }
  });

  it("recovers a complete lock left by an exited process", async () => {
    const staleDir = mkdtempSync(join(tmpdir(), "omb-box-delete-stale-lock-"));
    const exited = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
    const exitedPid = exited.pid;
    expect(exitedPid).toBeTypeOf("number");
    await once(exited, "exit");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "box-delete-requests.lock"), JSON.stringify({
      version: 1,
      pid: exitedPid,
      token: randomUUID(),
      createdAt: Date.now(),
    }));
    const source = `
      const journal = await import(${JSON.stringify(MODULE_URL)});
      const result = journal.prepareBoxDeletion({
        boxId: "bx_23456789",
        name: "stale-lock-box",
        ownerBotId: null,
      });
      process.stdout.write(JSON.stringify(result) + "\\n");
    `;
    const subject = worker(staleDir, source);
    try {
      expect(JSON.parse(await nextLine(subject, "stale-lock worker"))).toMatchObject({ phase: "prepared" });
      await expectCleanExit(subject, "stale-lock worker");
      expect(JSON.parse(readFileSync(join(staleDir, "box-delete-requests.json"), "utf8")).records).toHaveLength(1);
    } finally {
      if (subject.child.exitCode === null) subject.child.kill("SIGKILL");
      rmSync(staleDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a corrupt lock", async () => {
    const lockPath = join(dataDir, "box-delete-requests.lock");
    writeFileSync(lockPath, "not-json\n");
    const journal = await import("./box-delete-journal.ts");
    expect(() => journal.boxDeletionSnapshot()).toThrow(/recovery state is lock is invalid/i);
    expect(readFileSync(lockPath, "utf8")).toBe("not-json\n");
  });
});
