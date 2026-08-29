// The companion half of the task layer, driven with real bytes against a real
// task root under a temporary home. Nothing here talks to a CUA daemon: the
// operations that need one are exercised up to the point where they would.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeFrame, END_FRAME, type FrameHeader } from "../src/frames.ts";
import { taskManifestDigest } from "../src/manifest.ts";
import { taskRoot, type WorkerPlatform } from "../src/platform.ts";
import {
  fetchResults,
  isSafeStagedPath,
  MANIFEST_FILE,
  resolveInRoot,
  runTaskCommand,
  stageTask,
  validateTask,
} from "../src/task.ts";
import { asDigest } from "../src/wire.ts";
import { HOST_TASK_PLATFORM, parsedManifest } from "../../server/testing/worker-task.ts";
import { workerTaskManifestJson } from "../../server/worker-task-manifest.ts";
import type { JsonValue } from "../../server/schema.ts";

/** The companion's own spelling of the platform this host can lay out paths
 * for; the server fixture's `HOST_TASK_PLATFORM` is the same choice in the
 * manifest's vocabulary. */
const PLATFORM: WorkerPlatform = process.platform === "win32" ? "win32" : "darwin";

const TASK_ID = "task-1";
const body = Buffer.from("hello worker", "utf8");
const bodyDigest = createHash("sha256").update(body).digest("hex");

let home = "";
let saved: Record<string, string | undefined> = {};

function manifestDocument(overrides: Record<string, JsonValue> = {}): JsonValue {
  const manifest = parsedManifest(HOST_TASK_PLATFORM, {
    files: [{ path: "src/main.txt", size: body.length, sha256: bodyDigest }],
    ...overrides,
  });
  return JSON.parse(workerTaskManifestJson(manifest)) as JsonValue;
}

/** The exact byte stream `stageWorkerTask` would have written. */
function stagingStream(document: JsonValue, files: { header: FrameHeader; payload: Buffer }[]): Buffer {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  return Buffer.concat([
    encodeFrame({ kind: "manifest", bytes: json.length }, json),
    ...files.map((file) => encodeFrame(file.header, file.payload)),
    END_FRAME,
  ]);
}

async function stage(bytes: Buffer, taskId = TASK_ID) {
  const input = new PassThrough();
  const staged = stageTask(taskId, input, PLATFORM);
  input.end(bytes);
  return staged;
}

const goodFile = { header: { kind: "file", bytes: body.length, path: "src/main.txt", sha256: bodyDigest } as FrameHeader, payload: body };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omb-worker-"));
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; the Windows
  // layout reads LOCALAPPDATA directly. Set all three so either layout lands
  // under the temporary directory whatever host this runs on.
  saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = home;
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("staged path rules", () => {
  it.each(["src/main.txt", "a/b/c.json", "Makefile"])("accepts %s", (path) => {
    expect(isSafeStagedPath(path)).toBe(true);
  });

  it.each([
    "../escape.txt",
    "a/../../b",
    "/absolute",
    "a//b",
    "trailing/",
    ".env",
    "config/.env.local",
    "deploy/id_rsa",
    "certs/server.pem",
    "app/credentials.json",
  ])("refuses %s", (path) => {
    expect(isSafeStagedPath(path)).toBe(false);
  });

  it("refuses a path that would escape the root even if it passed the grammar", () => {
    expect(() => resolveInRoot("/tmp/root", "..")).toThrow(/escapes the task root/);
  });
});

describe("stage", () => {
  it("writes the manifest and every declared file", async () => {
    const result = await stage(stagingStream(manifestDocument(), [goodFile]));
    expect(result.files).toBe(1);
    const root = taskRoot(TASK_ID, PLATFORM);
    expect(readFileSync(join(root, "src", "main.txt"), "utf8")).toBe("hello worker");
    expect(JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8")).taskId).toBe(TASK_ID);
  });

  it("refuses a file whose bytes do not hash to what the frame declared", async () => {
    const tampered = { header: { ...goodFile.header, sha256: "f".repeat(64) } as FrameHeader, payload: body };
    await expect(stage(stagingStream(manifestDocument(), [tampered]))).rejects.toThrow(/hash does not match/);
  });

  it("refuses a path that escapes the task root", async () => {
    const escape = {
      header: { kind: "file", bytes: body.length, path: "../escape.txt", sha256: bodyDigest } as FrameHeader,
      payload: body,
    };
    await expect(stage(stagingStream(manifestDocument(), [escape]))).rejects.toThrow(/unsafe staged path/);
  });

  it("refuses a staged file that would shadow the manifest", async () => {
    const shadow = {
      header: { kind: "file", bytes: body.length, path: MANIFEST_FILE, sha256: bodyDigest } as FrameHeader,
      payload: body,
    };
    await expect(stage(stagingStream(manifestDocument(), [shadow]))).rejects.toThrow(/shadow the manifest/);
  });

  it("refuses a stream with no manifest at all", async () => {
    await expect(stage(Buffer.concat([encodeFrame(goodFile.header, goodFile.payload), END_FRAME])))
      .rejects.toThrow(/carried no manifest/);
  });

  it("leaves nothing behind when a stage fails part way", async () => {
    const tampered = { header: { ...goodFile.header, sha256: "f".repeat(64) } as FrameHeader, payload: body };
    await expect(stage(stagingStream(manifestDocument(), [tampered]))).rejects.toThrow();
    expect(() => readFileSync(join(taskRoot(TASK_ID, PLATFORM), MANIFEST_FILE))).toThrow();
  });

  it("replaces an earlier stage rather than merging into it", async () => {
    await stage(stagingStream(manifestDocument(), [goodFile]));
    const document = manifestDocument({ files: [] });
    await stage(stagingStream(document, []));
    expect(() => readFileSync(join(taskRoot(TASK_ID, PLATFORM), "src", "main.txt"))).toThrow();
  });
});

describe("validate", () => {
  it("accepts a stage that matches the approved digest exactly", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    const validated = validateTask(TASK_ID, taskManifestDigest(document), PLATFORM);
    expect(validated.manifest.commands[0].id).toBe("build");
  });

  it("refuses a digest that is not the one approved", async () => {
    await stage(stagingStream(manifestDocument(), [goodFile]));
    expect(() => validateTask(TASK_ID, "f".repeat(64), PLATFORM))
      .toThrow(/does not match the approved digest/);
  });

  it("refuses a file changed after staging", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    writeFileSync(join(taskRoot(TASK_ID, PLATFORM), "src", "main.txt"), "tampered after approval");
    expect(() => validateTask(TASK_ID, taskManifestDigest(document), PLATFORM))
      .toThrow(/size changed|hash changed/);
  });

  it("refuses a declared input that disappeared", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    rmSync(join(taskRoot(TASK_ID, PLATFORM), "src", "main.txt"));
    expect(() => validateTask(TASK_ID, taskManifestDigest(document), PLATFORM))
      .toThrow(/is missing/);
  });

  it("allows files the task wrote itself, which is what build output and results are", async () => {
    // An exact-file-set rule would make a task's own success read as tampering:
    // result.json and changes.patch are written into this same root by the very
    // commands the manifest approved.
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    writeFileSync(join(taskRoot(TASK_ID, PLATFORM), "result.json"), '{"ok":true}');
    writeFileSync(join(taskRoot(TASK_ID, PLATFORM), "src", "main.o"), "object code");
    expect(validateTask(TASK_ID, taskManifestDigest(document), PLATFORM).manifest.files).toHaveLength(1);
  });

  it("refuses when nothing is staged under that id", () => {
    expect(() => validateTask("never-staged", "a".repeat(64), PLATFORM)).toThrow(/no task is staged/);
  });
});

describe("run", () => {
  it("runs the approved command by id, inside the task root", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    const result = await runTaskCommand(TASK_ID, taskManifestDigest(document), "build", PLATFORM);
    expect(result.commandId).toBe("build");
    expect(result.code).toBe(0);
  });

  it("refuses a command id the approved manifest does not name", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    await expect(runTaskCommand(TASK_ID, taskManifestDigest(document), "deploy", PLATFORM))
      .rejects.toThrow(/no command with that id/);
  });

  it("re-validates before running, so a file changed after approval stops the command", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    writeFileSync(join(taskRoot(TASK_ID, PLATFORM), "src", "main.txt"), "swapped");
    await expect(runTaskCommand(TASK_ID, taskManifestDigest(document), "build", PLATFORM))
      .rejects.toThrow(/size changed|hash changed/);
  });
});

describe("fetch results", () => {
  it("returns only the artefacts the approved manifest declares", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    const root = taskRoot(TASK_ID, PLATFORM);
    writeFileSync(join(root, "result.json"), '{"ok":true}');
    writeFileSync(join(root, "changes.patch"), "diff --git a b\n");
    writeFileSync(join(root, "notes.txt"), "not declared as a result");

    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    fetchResults(TASK_ID, asDigest(taskManifestDigest(document)), sink, PLATFORM);
    sink.end();

    const stream = Buffer.concat(chunks);
    expect(stream.includes(Buffer.from("result.json"))).toBe(true);
    expect(stream.includes(Buffer.from("changes.patch"))).toBe(true);
    expect(stream.includes(Buffer.from("notes.txt"))).toBe(false);
    expect(stream.subarray(stream.length - END_FRAME.length).equals(END_FRAME)).toBe(true);
  });

  it("emits only an end frame when the task produced nothing", async () => {
    const document = manifestDocument();
    await stage(stagingStream(document, [goodFile]));
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    fetchResults(TASK_ID, asDigest(taskManifestDigest(document)), sink, PLATFORM);
    sink.end();
    expect(Buffer.concat(chunks).equals(END_FRAME)).toBe(true);
  });
});
