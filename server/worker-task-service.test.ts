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
import type { ResolvedWorker } from "./computer-workers.ts";
import type { ModelSelection } from "./contracts.ts";
import type { JsonValue } from "./schema.ts";
import { Store, type BotRecord } from "./store.ts";
import {
  fakeTaskRoot,
  parsedManifest,
  taskProposalFixture,
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
import { workerComputerContent, workerResultsText, WorkerTaskService } from "./worker-task-service.ts";
import { WORKER_TASK_MAX_REPLY_CONTENT_BLOCKS, WORKER_TASK_MAX_REPLY_TEXT_CHARS } from "./worker-task-client.ts";
import type { WorkerTaskStreamOptions } from "./worker-task-transport.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
// The successful desktop protocol is macOS on every CI host. These workers
// are fake; Windows desktop admission has its own negative acceptance below.
const worker = workerFixture("macos");
const taskRoot = fakeTaskRoot("macos", "task-1");

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
  const runner = (args: string[], _timeoutMs?: number, stdin = "") => {
    if (args.includes("describe")) {
      ops.push("describe");
      return Promise.resolve({ stdout: '{"type":"object","properties":{}}\n', stderr: "" });
    }
    const request = JSON.parse(stdin || "{}");
    ops.push(String(request.op));
    const canned: Record<string, JsonValue> = {
      validate: { ok: true, version: 1, op: "validate", taskRoot, files: 0, commandIds: ["build"] },
      activate: { ok: true, version: 1, op: "activate", capabilitySha256: capability },
      reset: { ok: true, version: 1, op: "reset", capabilitySha256: worker.expectedParkedCapabilitySha256! },
      run: { ok: true, version: 1, op: "run", commandId: "build", code: 0, stdout: "built", stderr: "" },
      ...overrides,
    };
    return Promise.resolve({ stdout: `${JSON.stringify(canned[String(request.op)])}\n`, stderr: "" });
  };
  const streamRunner = async (args: string[], options: WorkerTaskStreamOptions) => {
    const operation = args.includes("fetch") ? "fetch" : args.includes("call") ? "computer" : "stage";
    ops.push(operation);
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
    if (args.includes("call")) {
      return {
        stdout: Buffer.from('{"content":[{"type":"text","text":"clicked"}]}\n', "utf8"),
        stderr: "",
      };
    }
    return { stdout: Buffer.from('{"ok":true,"version":1,"op":"stage","files":0}\n', "utf8"), stderr: "" };
  };
  return { runner, streamRunner };
}

function makeService(
  overrides: Record<string, JsonValue> = {},
  options: { controlHeld?: (botId: string) => boolean; worker?: ResolvedWorker } = {},
): WorkerTaskService {
  const fake = fakeWorker(overrides);
  return new WorkerTaskService({
    bus: { store, broadcast: () => {} },
    registry,
    workerFor: () => options.worker ?? worker,
    channelFor: () => worker.platform === "windows"
      ? "\\\\.\\pipe\\cua-driver"
      : "/Users/worker/.openmausbot/run/cua.sock",
    controlHeld: options.controlHeld,
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
  ({ op: "propose", manifest: document ?? taskProposalFixture("macos") }) as JsonValue;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(selection);
  registry = new WorkerTaskRegistry();
  ops = [];
  cwd = mkdtempSync(join(tmpdir(), "omb-task-"));
  bot = store.createBot();
  store.patchBot(bot.id, { cwd, workerId: worker.id });
  bot = store.bot(bot.id)!;

  const manifest = parsedManifest("macos", { threadId: bot.threadId });
  digest = workerTaskManifestDigest(manifest);
  capability = workerCuaCapabilityDigest(workerCuaCapabilityManifest(manifest, taskRoot, TASK_NOW));
});

afterEach(() => {
  cancelWorkerTaskApprovalsForWorker(worker.id);
  rmSync(cwd, { recursive: true, force: true });
});

describe("propose", () => {
  it("holds Windows desktop tasks before approval, registration or SSH", async () => {
    const service = makeService({}, { worker: workerFixture("windows") });
    const outcome = await service.handle(bot, propose(taskProposalFixture("windows")));
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/Windows desktop tasks.*application-boundary acceptance/);
    expect(registry.forThread(bot.threadId)).toBeNull();
    expect(store.messagesFor(bot.threadId).some((message) => message.card?.tool?.startsWith("worker_task:"))).toBe(false);
    expect(ops).toEqual([]);
  });

  it("also holds an existing Windows desktop record before any remote operation", async () => {
    const manifest = parsedManifest("windows", { threadId: bot.threadId });
    registry.register(manifest);
    registry.approve(manifest.taskId, workerTaskManifestDigest(manifest), TASK_NOW);
    const service = makeService({}, { worker: workerFixture("windows") });
    const outcome = await service.handle(bot, { op: "run", commandId: "build" });
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/Windows desktop tasks.*application-boundary acceptance/);
    expect(ops).toEqual([]);
  });

  it("still requests normal approval for the separate Windows browser surface", async () => {
    const service = makeService({}, { worker: workerFixture("windows") });
    const pending = service.handle(bot, propose(taskProposalFixture("windows", {
      origins: ["https://example.com"],
    })));
    await answer("deny");
    expect((await pending).text).toContain("denied");
    expect(ops).toEqual([]);
  });

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

  it("refuses control-plane-owned fields in a model proposal", async () => {
    const service = makeService();
    const attemptedBinding = taskProposalFixture("macos", { threadId: "another-thread" });
    const outcome = await service.handle(bot, propose(attemptedBinding));
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/Invalid worker task proposal/);
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

  it("surfaces an invalid proposal as a refusal, not a crash", async () => {
    const service = makeService();
    const outcome = await service.handle(bot, propose({ version: 1 } as JsonValue));
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/Invalid worker task proposal/);
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
    expect(ops).toEqual(["stage", "validate", "activate", "reset"]);
    expect(service.activeCapabilityDigest(worker.id)).toBeNull();
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

  it("enforces the human control hold in the server even after activation", async () => {
    let held = false;
    const service = makeService({}, { controlHeld: () => held });
    const pending = service.handle(bot, propose());
    await answer("allow");
    await pending;
    ops = [];
    held = true;

    const outcome = await service.handle(bot, { op: "run", commandId: "build" } as JsonValue);
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/control of this computer/);
    expect(ops).toEqual([]);
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

  it("describes and calls an approved desktop tool through the one-shot path", async () => {
    const service = await approved();
    const described = await service.handle(bot, { op: "describe", tool: "click" } as JsonValue);
    const called = await service.handle(
      bot,
      { op: "computer", tool: "click", arguments: { x: 12, y: 30 } } as JsonValue,
    );
    expect(described.text).toContain("properties");
    expect(called.content).toEqual([{ type: "text", text: "clicked" }]);
    expect(ops).toEqual(["describe", "computer"]);
  });

  it("refuses a CUA tool outside the approved task surface before SSH", async () => {
    const service = await approved();
    const outcome = await service.handle(
      bot,
      { op: "computer", tool: "browser_navigate", arguments: { url: "https://example.com" } } as JsonValue,
    );
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/does not allow/);
    expect(ops).toEqual([]);
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

  it("binds an approval to the worker that received it", async () => {
    const fake = fakeWorker();
    let assigned = worker;
    const service = new WorkerTaskService({
      bus: { store, broadcast: () => {} },
      registry,
      workerFor: () => assigned,
      runner: fake.runner,
      streamRunner: fake.streamRunner,
      now: () => TASK_NOW,
    });
    const pending = service.handle(bot, propose());
    await answer("allow");
    await pending;
    assigned = { ...worker, id: "other-worker", sshAlias: "other-worker" };

    const outcome = await service.handle(bot, { op: "run", commandId: "build" } as JsonValue);
    expect(outcome.status).toBe(409);
    expect(outcome.error).toMatch(/different worker/);
  });
});

describe("worker reply bounds", () => {
  it("caps accepted computer content at the client wire limit", () => {
    const stdout = Buffer.from(JSON.stringify({
      content: Array.from({ length: WORKER_TASK_MAX_REPLY_CONTENT_BLOCKS + 4 }, (_, index) => ({
        type: "text",
        text: `block-${index}`,
      })),
    }));
    const parsed = workerComputerContent(stdout);
    expect(parsed.content).toHaveLength(WORKER_TASK_MAX_REPLY_CONTENT_BLOCKS);
  });

  it("caps an individual computer text block at the client wire limit", () => {
    const stdout = Buffer.from(JSON.stringify({
      content: [{ type: "text", text: "x".repeat(WORKER_TASK_MAX_REPLY_TEXT_CHARS + 1) }],
    }));
    const parsed = workerComputerContent(stdout);
    expect(parsed.content[0]).toMatchObject({ type: "text" });
    expect(parsed.content[0]?.type === "text" ? parsed.content[0].text.length : 0)
      .toBe(WORKER_TASK_MAX_REPLY_TEXT_CHARS);
  });

  it("caps the combined result text at the client wire limit", () => {
    const content = Buffer.from("x".repeat(64 * 1024));
    const text = workerResultsText(Array.from({ length: 32 }, (_, index) => ({
      path: `result-${index}.txt`,
      sha256: "a".repeat(64),
      bytes: content.length,
      content,
      truncated: false,
    })));
    expect(text.length).toBe(WORKER_TASK_MAX_REPLY_TEXT_CHARS);
    expect(text).toContain("request fewer result paths");
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
    expect(service.activeCapabilityDigest(worker.id)).toBe(capability);
  });

  it("says so once the approval has been revoked", async () => {
    const service = makeService();
    const pending = service.handle(bot, propose());
    await answer("allow");
    await pending;
    service.forgetWorker(worker.id);

    const outcome = await service.handle(bot, { op: "status" } as JsonValue);
    expect(outcome.text).toMatch(/no longer approved/);
    expect(service.activeCapabilityDigest(worker.id)).toBeNull();
  });
});
