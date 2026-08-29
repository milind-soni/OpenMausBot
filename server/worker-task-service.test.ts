// The authority chain end to end, against a fake worker: propose → approve →
// stage → validate → activate, then run and read back. No SSH, no daemon —
// #508 acceptance item 8's fake-worker protocol, which is what CI can actually
// prove on all three platforms.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import type { JsonValue } from "./schema.ts";
import { Store, type BotRecord } from "./store.ts";
import {
  fakeTaskRoot,
  HOST_TASK_PLATFORM,
  manifestFixture,
  parsedManifest,
  TASK_NOW,
  workerFixture,
} from "./testing/worker-task.ts";
import { workerCuaCapabilityDigest, workerCuaCapabilityManifest } from "./worker-cua-capability.ts";
import {
  cancelWorkerTaskApprovalsForWorker,
  resolveWorkerTaskApproval,
} from "./worker-task-approval.ts";
import { encodeFrame, END_FRAME } from "./worker-task-frames.ts";
import { workerTaskManifestDigest, WorkerTaskRegistry } from "./worker-task-manifest.ts";
import { WorkerTaskService } from "./worker-task-service.ts";
import type { WorkerTaskStreamOptions } from "./worker-task-transport.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
const worker = workerFixture();
const taskRoot = fakeTaskRoot(HOST_TASK_PLATFORM, "task-1");

// A manifest is bound to one conversation, and a test bot's thread id is
// generated, so these are rebuilt per test rather than at module scope.
let digest = "";
let capability = "";

let store: Store;
let bot: BotRecord;
let registry: WorkerTaskRegistry;
let cwd = "";
/** Every companion op the fake worker was asked to perform, in order. */
let ops: string[] = [];

/** A worker that behaves. Individual tests override one reply to misbehave. */
function fakeWorker(overrides: Record<string, JsonValue> = {}) {
  const runner = (_args: string[], _timeoutMs?: number, stdin = "") => {
    const request = JSON.parse(stdin || "{}");
    ops.push(String(request.op));
    const canned: Record<string, JsonValue> = {
      validate: { ok: true, version: 1, op: "validate", taskRoot, files: 0, commandIds: ["build"] },
      activate: { ok: true, version: 1, op: "activate", capabilitySha256: capability },
      reset: { ok: true, version: 1, op: "reset", capabilitySha256: "d".repeat(64) },
      run: { ok: true, version: 1, op: "run", commandId: "build", code: 0, stdout: "built", stderr: "" },
      ...overrides,
    };
    return Promise.resolve({ stdout: `${JSON.stringify(canned[String(request.op)])}\n`, stderr: "" });
  };
  const streamRunner = async (args: string[], options: WorkerTaskStreamOptions) => {
    ops.push(args.includes("fetch") ? "fetch" : "stage");
    if (options.write) {
      // A sink that swallows the staged bytes: what is staged is the transport
      // test's subject, not this one's.
      const sink = new PassThrough();
      sink.resume();
      await options.write(sink);
      sink.end();
    }
    if (args.includes("fetch")) {
      const body = Buffer.from('{"ok":true}', "utf8");
      const sha256 = createHash("sha256").update(body).digest("hex");
      return {
        stdout: Buffer.concat([
          encodeFrame({ kind: "file", bytes: body.length, path: "result.json", sha256 }, body),
          END_FRAME,
        ]),
        stderr: "",
      };
    }
    return { stdout: Buffer.from('{"ok":true,"version":1,"op":"stage","files":0}\n', "utf8"), stderr: "" };
  };
  return { runner, streamRunner };
}

function makeService(overrides: Record<string, JsonValue> = {}): WorkerTaskService {
  const fake = fakeWorker(overrides);
  return new WorkerTaskService({
    bus: { store, broadcast: () => {} },
    registry,
    workerFor: () => worker,
    runner: fake.runner,
    streamRunner: fake.streamRunner,
    now: () => TASK_NOW,
  });
}

/** Answer the approval card as soon as it appears. */
async function answer(behavior: "allow" | "deny"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const card = store.messagesFor(bot.threadId).find((message) => message.card?.tool?.startsWith("worker_task:"));
    const requestId = card?.card?.requestId;
    if (requestId && !card?.card?.answered && resolveWorkerTaskApproval(requestId, behavior)) return;
    await new Promise((wait) => setTimeout(wait, 5));
  }
  throw new Error("no approval card appeared");
}

const propose = (document?: JsonValue) =>
  ({ op: "propose", manifest: document ?? manifestFixture(HOST_TASK_PLATFORM, { threadId: bot.threadId }) }) as JsonValue;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(selection);
  registry = new WorkerTaskRegistry();
  ops = [];
  cwd = mkdtempSync(join(tmpdir(), "omb-task-"));
  bot = store.createBot();
  store.patchBot(bot.id, { cwd, workerId: worker.id });
  bot = store.bot(bot.id)!;

  const manifest = parsedManifest(HOST_TASK_PLATFORM, { threadId: bot.threadId });
  digest = workerTaskManifestDigest(manifest);
  capability = workerCuaCapabilityDigest(workerCuaCapabilityManifest(manifest, taskRoot, TASK_NOW));
});

afterEach(() => {
  cancelWorkerTaskApprovalsForWorker(worker.id);
  rmSync(cwd, { recursive: true, force: true });
});

describe("propose", () => {
  it("stages, validates and activates only after a person allows", async () => {
    const service = makeService();
    const pending = service.handle(bot, propose());
    await answer("allow");
    const outcome = await pending;

    expect(outcome.status).toBe(200);
    expect(outcome.text).toContain("Approved and active");
    expect(outcome.text).toContain(capability.slice(0, 12));
    // Order matters: nothing reaches the worker before the person answers, and
    // the capability is activated only after the worker has re-validated.
    expect(ops).toEqual(["stage", "validate", "activate"]);
  });

  it("touches the worker not at all when the person denies", async () => {
    const service = makeService();
    const pending = service.handle(bot, propose());
    await answer("deny");
    const outcome = await pending;

    expect(outcome.text).toContain("denied");
    expect(ops).toEqual([]);
  });

  it("refuses a manifest bound to another conversation", async () => {
    const service = makeService();
    const elsewhere = manifestFixture(HOST_TASK_PLATFORM, { threadId: "another-thread" });
    const outcome = await service.handle(bot, propose(elsewhere));
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/different conversation/);
    expect(ops).toEqual([]);
  });

  it("refuses a bot with no working folder rather than staging from the home directory", async () => {
    store.patchBot(bot.id, { cwd: undefined });
    const service = makeService();
    const outcome = await service.handle(store.bot(bot.id)!, propose());
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/no working folder/);
  });

  it("refuses a bot with no worker assigned", async () => {
    const service = new WorkerTaskService({
      bus: { store, broadcast: () => {} },
      registry,
      workerFor: () => null,
      now: () => TASK_NOW,
    });
    const outcome = await service.handle(bot, propose());
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/not assigned/);
  });

  it("surfaces an invalid manifest as a refusal, not a crash", async () => {
    const service = makeService();
    const outcome = await service.handle(bot, propose({ version: 1 } as JsonValue));
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/Invalid worker task manifest/);
  });

  it("refuses when the worker activates a capability the control plane did not derive", async () => {
    const service = makeService({
      activate: { ok: true, version: 1, op: "activate", capabilitySha256: "e".repeat(64) },
    });
    const pending = service.handle(bot, propose());
    await answer("allow");
    const outcome = await pending;
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/different capability/);
  });
});

describe("run and results", () => {
  async function approved(overrides: Record<string, JsonValue> = {}): Promise<WorkerTaskService> {
    const service = makeService(overrides);
    const pending = service.handle(bot, propose());
    await answer("allow");
    await pending;
    ops = [];
    return service;
  }

  it("runs an approved command by id", async () => {
    const service = await approved();
    const outcome = await service.handle(bot, { op: "run", commandId: "build" } as JsonValue);
    expect(outcome.text).toContain("build exited 0");
    expect(outcome.text).toContain("built");
    expect(ops).toEqual(["run"]);
  });

  it("refuses a command id the approved manifest does not contain", async () => {
    const service = await approved();
    const outcome = await service.handle(bot, { op: "run", commandId: "deploy" } as JsonValue);
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/no command with that id/);
  });

  it("reads back the declared artefacts", async () => {
    const service = await approved();
    const outcome = await service.handle(bot, { op: "results" } as JsonValue);
    expect(outcome.text).toContain("result.json");
    expect(outcome.text).toContain('{"ok":true}');
  });

  it("refuses to run once the worker's approvals are revoked", async () => {
    const service = await approved();
    // What happens when a worker drops off: #508 item 6.
    service.forgetWorker(worker.id);
    const outcome = await service.handle(bot, { op: "run", commandId: "build" } as JsonValue);
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/no longer approved/);
    expect(ops).toEqual([]);
  });

  it("leaves another worker's approval alone when one worker is forgotten", async () => {
    const service = await approved();
    service.forgetWorker("some-other-worker");
    const outcome = await service.handle(bot, { op: "run", commandId: "build" } as JsonValue);
    expect(outcome.status).toBe(200);
  });

  it("refuses to run a task that was never proposed", async () => {
    const service = makeService();
    const outcome = await service.handle(bot, { op: "run", commandId: "build" } as JsonValue);
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/no worker task has been proposed/);
  });

  it("refuses an unknown operation", async () => {
    const service = makeService();
    const outcome = await service.handle(bot, { op: "sudo" } as JsonValue);
    expect(outcome.status).toBe(400);
  });
});

describe("status", () => {
  it("reports nothing before anything is proposed", async () => {
    const outcome = await makeService().handle(bot, { op: "status" } as JsonValue);
    expect(outcome.text).toContain("No worker task");
  });

  it("reports the live approval and never mints one", async () => {
    const service = makeService();
    const pending = service.handle(bot, propose());
    await answer("allow");
    await pending;
    ops = [];

    const outcome = await service.handle(bot, { op: "status" } as JsonValue);
    expect(outcome.text).toContain(digest.slice(0, 12));
    expect(outcome.text).toContain("build");
    expect(ops).toEqual([]);
  });

  it("says so once the approval has been revoked", async () => {
    const service = makeService();
    const pending = service.handle(bot, propose());
    await answer("allow");
    await pending;
    service.forgetWorker(worker.id);

    const outcome = await service.handle(bot, { op: "status" } as JsonValue);
    expect(outcome.text).toMatch(/no longer approved/);
  });
});
