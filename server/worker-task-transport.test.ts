import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "./schema.ts";
import {
  fakeTaskRoot,
  HOST_TASK_PLATFORM,
  parsedManifest,
  TASK_NOW,
  workerFixture,
} from "./testing/worker-task.ts";
import { workerCuaCapabilityDigest, workerCuaCapabilityManifest } from "./worker-cua-capability.ts";
import { encodeFrame, END_FRAME } from "./worker-task-frames.ts";
import { workerTaskManifestDigest, type WorkerTaskManifest } from "./worker-task-manifest.ts";
import {
  activateWorkerTask,
  fetchWorkerResults,
  isPlausibleTaskRoot,
  resetWorkerTask,
  runWorkerCommand,
  stageWorkerTask,
  validateWorkerTask,
  type WorkerTaskStreamOptions,
} from "./worker-task-transport.ts";

const worker = workerFixture();
const taskRoot = fakeTaskRoot(HOST_TASK_PLATFORM, "task-1");

/** Captures the argv and stdin every call would have sent, and replies with
 * whatever the test lines up. Nothing here reaches a network or a shell. */
function fakeCompanion(replies: JsonValue[]) {
  const calls: { args: string[]; stdin: string }[] = [];
  let next = 0;
  const runner = (args: string[], _timeoutMs?: number, stdin = "") => {
    calls.push({ args, stdin });
    const reply = replies[Math.min(next, replies.length - 1)];
    next += 1;
    return Promise.resolve({ stdout: `${JSON.stringify(reply)}\n`, stderr: "" });
  };
  return { runner, calls };
}

/** Collects the bytes a streaming call would have written to ssh's stdin. */
function fakeStream(reply: JsonValue | Buffer) {
  const captured: Buffer[] = [];
  const calls: string[][] = [];
  const runner = async (args: string[], options: WorkerTaskStreamOptions) => {
    calls.push(args);
    if (options.write) {
      const sink = new PassThrough();
      sink.on("data", (chunk: Buffer) => captured.push(chunk));
      await options.write(sink as unknown as Writable);
      sink.end();
    }
    return {
      stdout: Buffer.isBuffer(reply) ? reply : Buffer.from(`${JSON.stringify(reply)}\n`, "utf8"),
      stderr: "",
    };
  };
  return { runner, calls, bytes: () => Buffer.concat(captured) };
}

describe("isPlausibleTaskRoot", () => {
  it("accepts the shape each platform's companion actually derives", () => {
    expect(isPlausibleTaskRoot("macos", "task-1", fakeTaskRoot("macos", "task-1"))).toBe(true);
    expect(isPlausibleTaskRoot("windows", "task-1", fakeTaskRoot("windows", "task-1"))).toBe(true);
  });

  it.each([
    ["a root for another task", "/Users/worker/Library/Application Support/OpenMausBot/tasks/other"],
    ["a traversal", "/Users/worker/../../tasks/task-1"],
    ["a relative path", "tasks/task-1"],
    ["a Windows root on macOS", "C:\\tasks\\task-1"],
  ])("refuses %s", (_label, value) => {
    expect(isPlausibleTaskRoot("macos", "task-1", value)).toBe(false);
  });

  it("refuses a root that is not under a tasks directory", () => {
    expect(isPlausibleTaskRoot("macos", "task-1", "/task-1")).toBe(false);
    expect(isPlausibleTaskRoot("windows", "task-1", "C:\\task-1")).toBe(false);
  });
});

describe("staging", () => {
  let root = "";
  let manifest: WorkerTaskManifest;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-stage-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.txt"), "hello worker");
    const body = Buffer.from("hello worker");
    manifest = parsedManifest(HOST_TASK_PLATFORM, {
      files: [{
        path: "src/main.txt",
        size: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      }],
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sends the manifest first, then each file, then an end frame", async () => {
    const stream = fakeStream({ ok: true, version: 1, op: "stage", files: 1 });
    const result = await stageWorkerTask(worker, root, manifest, stream.runner);
    expect(result.files).toBe(1);
    expect(stream.calls[0].slice(-3)).toEqual(["openmausbot-worker-companion", "stage", "task-1"]);

    const bytes = stream.bytes();
    expect(bytes.subarray(bytes.length - END_FRAME.length).equals(END_FRAME)).toBe(true);
    expect(bytes.includes(Buffer.from("hello worker"))).toBe(true);
    // The manifest travels ahead of the files it describes, so the worker can
    // never write a byte it has not already been told the digest of.
    expect(bytes.indexOf(Buffer.from('"manifest"'))).toBeLessThan(bytes.indexOf(Buffer.from("hello worker")));
  });

  it("refuses to stage when a file changed after approval", async () => {
    writeFileSync(join(root, "src", "main.txt"), "tampered");
    const stream = fakeStream({ ok: true, version: 1, op: "stage", files: 1 });
    await expect(stageWorkerTask(worker, root, manifest, stream.runner)).rejects.toThrow(/size changed|hash changed/);
    expect(stream.calls).toHaveLength(0);
  });

  it("refuses to stage a symlinked file", async () => {
    rmSync(join(root, "src", "main.txt"));
    symlinkSync(join(root, "elsewhere.txt"), join(root, "src", "main.txt"));
    writeFileSync(join(root, "elsewhere.txt"), "hello worker");
    const stream = fakeStream({ ok: true, version: 1, op: "stage", files: 1 });
    await expect(stageWorkerTask(worker, root, manifest, stream.runner)).rejects.toThrow(/not a regular file/);
  });

  it("refuses a worker that confirms a different number of files", async () => {
    const stream = fakeStream({ ok: true, version: 1, op: "stage", files: 4 });
    await expect(stageWorkerTask(worker, root, manifest, stream.runner))
      .rejects.toThrow(/different number of files/);
  });

  it("surfaces the companion's own refusal verbatim", async () => {
    const stream = fakeStream({ ok: false, error: "unsafe staged path: ../escape" });
    await expect(stageWorkerTask(worker, root, manifest, stream.runner))
      .rejects.toThrow("unsafe staged path: ../escape");
  });
});

describe("validate", () => {
  const manifest = parsedManifest();
  const digest = workerTaskManifestDigest(manifest);

  it("names only the task id and the digest on the wire", async () => {
    const fake = fakeCompanion([{ ok: true, version: 1, op: "validate", taskRoot, files: 0, commandIds: ["build"] }]);
    const result = await validateWorkerTask(worker, manifest, digest, fake.runner);
    expect(result.commandIds).toEqual(["build"]);
    expect(JSON.parse(fake.calls[0].stdin)).toEqual({ op: "validate", taskId: "task-1", manifestSha256: digest });
    expect(fake.calls[0].stdin).not.toContain(worker.sshAlias);
  });

  it("refuses an implausible task root before anything is built from it", async () => {
    const fake = fakeCompanion([
      { ok: true, version: 1, op: "validate", taskRoot: "/etc", files: 0, commandIds: [] },
    ]);
    await expect(validateWorkerTask(worker, manifest, digest, fake.runner))
      .rejects.toThrow(/implausible task root/);
  });

  it("refuses a worker holding a different set of files", async () => {
    const fake = fakeCompanion([
      { ok: true, version: 1, op: "validate", taskRoot, files: 3, commandIds: ["build"] },
    ]);
    await expect(validateWorkerTask(worker, manifest, digest, fake.runner))
      .rejects.toThrow(/different set of task files/);
  });

  it("treats a non-JSON reply as a transport failure", async () => {
    const runner = () => Promise.resolve({ stdout: "Welcome to Ubuntu 24.04\n", stderr: "" });
    await expect(validateWorkerTask(worker, manifest, digest, runner)).rejects.toThrow(/unreadable reply/);
  });

  it("reads the last line, so a login banner ahead of the reply is tolerated", async () => {
    const reply = { ok: true, version: 1, op: "validate", taskRoot, files: 0, commandIds: ["build"] };
    const runner = () => Promise.resolve({ stdout: `motd line\n${JSON.stringify(reply)}\n`, stderr: "" });
    await expect(validateWorkerTask(worker, manifest, digest, runner)).resolves.toMatchObject({ files: 0 });
  });
});

describe("activate", () => {
  const manifest = parsedManifest();
  const digest = workerTaskManifestDigest(manifest);
  const expected = workerCuaCapabilityDigest(workerCuaCapabilityManifest(manifest, taskRoot, TASK_NOW));

  it("sends the issuing instant and the digest, never the capability itself", async () => {
    const fake = fakeCompanion([{ ok: true, version: 1, op: "activate", capabilitySha256: expected }]);
    const result = await activateWorkerTask(worker, manifest, digest, taskRoot, fake.runner, TASK_NOW);
    expect(result.capabilitySha256).toBe(expected);
    const sent = JSON.parse(fake.calls[0].stdin);
    expect(sent).toEqual({
      op: "activate",
      taskId: "task-1",
      manifestSha256: digest,
      issuedAt: TASK_NOW,
      expectedCapabilitySha256: expected,
    });
    // The capability document is derived at both ends and never travels.
    expect(fake.calls[0].stdin).not.toContain("allow:");
    expect(fake.calls[0].stdin).not.toContain("expires_after");
  });

  it("refuses when the worker activates a different capability", async () => {
    const fake = fakeCompanion([{ ok: true, version: 1, op: "activate", capabilitySha256: "e".repeat(64) }]);
    await expect(activateWorkerTask(worker, manifest, digest, taskRoot, fake.runner, TASK_NOW))
      .rejects.toThrow(/activated a different capability/);
  });

  it("will not derive a capability for an implausible root", async () => {
    const fake = fakeCompanion([{ ok: true, version: 1, op: "activate", capabilitySha256: expected }]);
    await expect(activateWorkerTask(worker, manifest, digest, "/etc", fake.runner, TASK_NOW))
      .rejects.toThrow(/implausible task root/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("run", () => {
  const manifest = parsedManifest();
  const digest = workerTaskManifestDigest(manifest);

  it("selects a command by id and never describes one", async () => {
    const fake = fakeCompanion([
      { ok: true, version: 1, op: "run", commandId: "build", code: 0, stdout: "ok", stderr: "" },
    ]);
    const result = await runWorkerCommand(worker, manifest, digest, "build", fake.runner);
    expect(result.code).toBe(0);
    const sent = JSON.parse(fake.calls[0].stdin);
    expect(sent).toEqual({ op: "run", taskId: "task-1", manifestSha256: digest, commandId: "build" });
    expect(fake.calls[0].stdin).not.toContain(manifest.commands[0].executable);
  });

  it("refuses a command id the approved manifest does not contain", async () => {
    const fake = fakeCompanion([{ ok: false, error: "unreachable" }]);
    await expect(runWorkerCommand(worker, manifest, digest, "deploy", fake.runner))
      .rejects.toThrow(/no command with that id/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a reply that names a different command", async () => {
    const fake = fakeCompanion([
      { ok: true, version: 1, op: "run", commandId: "other", code: 0, stdout: "", stderr: "" },
    ]);
    await expect(runWorkerCommand(worker, manifest, digest, "build", fake.runner))
      .rejects.toThrow(/ran a different command/);
  });

  it("passes a non-zero exit through as a result, not an error", async () => {
    const fake = fakeCompanion([
      { ok: true, version: 1, op: "run", commandId: "build", code: 2, stdout: "", stderr: "boom" },
    ]);
    await expect(runWorkerCommand(worker, manifest, digest, "build", fake.runner))
      .resolves.toMatchObject({ code: 2, stderr: "boom" });
  });
});

describe("reset", () => {
  it("names the pinned base policy so the worker proves what it parked on", async () => {
    const fake = fakeCompanion([{ ok: true, version: 1, op: "reset", capabilitySha256: "d".repeat(64) }]);
    await resetWorkerTask(worker, "task-1", fake.runner);
    expect(JSON.parse(fake.calls[0].stdin)).toEqual({
      op: "reset",
      taskId: "task-1",
      expectedBasePolicySha256: worker.expectedBasePolicySha256,
    });
  });

  it("refuses a worker with no pinned base policy", async () => {
    const unpinned = workerFixture(HOST_TASK_PLATFORM, { expectedBasePolicySha256: null, configured: false });
    const fake = fakeCompanion([{ ok: true, version: 1, op: "reset", capabilitySha256: "d".repeat(64) }]);
    await expect(resetWorkerTask(unpinned, "task-1", fake.runner)).rejects.toThrow(/no pinned base policy/);
  });
});

describe("fetch results", () => {
  const manifest = parsedManifest();
  const digest = workerTaskManifestDigest(manifest);
  const body = Buffer.from('{"ok":true}', "utf8");
  const sha256 = createHash("sha256").update(body).digest("hex");

  it("returns the declared artefacts", async () => {
    const stream = fakeStream(Buffer.concat([
      encodeFrame({ kind: "file", bytes: body.length, path: "result.json", sha256 }, body),
      END_FRAME,
    ]));
    const artefacts = await fetchWorkerResults(worker, manifest, digest, stream.runner);
    expect(artefacts).toHaveLength(1);
    expect(artefacts[0].content.toString("utf8")).toBe('{"ok":true}');
    expect(stream.calls[0].slice(-3)).toEqual(["fetch", "task-1", digest]);
  });

  it("refuses an artefact the manifest never declared", async () => {
    const stream = fakeStream(Buffer.concat([
      encodeFrame({ kind: "file", bytes: body.length, path: "etc/passwd", sha256 }, body),
      END_FRAME,
    ]));
    await expect(fetchWorkerResults(worker, manifest, digest, stream.runner))
      .rejects.toThrow(/never declared/);
  });

  it("refuses an artefact whose bytes do not match its digest", async () => {
    const stream = fakeStream(Buffer.concat([
      encodeFrame({ kind: "file", bytes: body.length, path: "result.json", sha256: "f".repeat(64) }, body),
      END_FRAME,
    ]));
    await expect(fetchWorkerResults(worker, manifest, digest, stream.runner))
      .rejects.toThrow(/hash does not match/);
  });

  it("refuses a result stream that tries to smuggle a manifest", async () => {
    const stream = fakeStream(Buffer.concat([
      encodeFrame({ kind: "manifest", bytes: body.length }, body),
      END_FRAME,
    ]));
    await expect(fetchWorkerResults(worker, manifest, digest, stream.runner))
      .rejects.toThrow(/cannot carry a manifest/);
  });

  it("refuses the same artefact twice", async () => {
    const frame = encodeFrame({ kind: "file", bytes: body.length, path: "result.json", sha256 }, body);
    const stream = fakeStream(Buffer.concat([frame, frame, END_FRAME]));
    await expect(fetchWorkerResults(worker, manifest, digest, stream.runner))
      .rejects.toThrow(/twice/);
  });
});
