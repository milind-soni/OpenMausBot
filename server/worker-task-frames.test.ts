import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import * as companion from "../worker-companion/src/frames.ts";
import { PLATFORM_PROFILES, taskCapabilityManifest, parseStagedManifest } from "../worker-companion/src/manifest.ts";
import { HOST_TASK_PLATFORM, fakeTaskRoot, manifestFixture, parsedManifest } from "./testing/worker-task.ts";
import { workerCuaCapabilityDigest, workerCuaCapabilityManifest } from "./worker-cua-capability.ts";
import * as server from "./worker-task-frames.ts";
import { workerTaskManifestDigest, workerTaskManifestJson } from "./worker-task-manifest.ts";
import type { JsonValue } from "./schema.ts";

/** Collect a frame stream into whole frames, for the tests below. */
function decode(module: typeof server | typeof companion, bytes: Buffer) {
  const frames: { header: server.FrameHeader; payload: Buffer }[] = [];
  let parts: Buffer[] = [];
  const reader = new module.FrameReader({
    onHeader: () => { parts = []; },
    onPayload: (chunk) => { parts.push(chunk); },
    onFrameEnd: (header) => {
      if (header.kind !== "end") frames.push({ header, payload: Buffer.concat(parts) });
    },
  });
  reader.push(bytes);
  reader.end();
  return frames;
}

// The two framing modules are duplicated because the companion ships to the
// worker as a standalone package. Duplication only stays safe while each end
// can read what the other writes, which is what these drive.
describe("frame parity between the control plane and the companion", () => {
  const manifest = Buffer.from('{"hello":"world"}', "utf8");
  const payload = Buffer.from([0, 1, 2, 253, 254, 255]);

  it("the companion reads what the control plane writes", () => {
    const stream = Buffer.concat([
      server.encodeFrame({ kind: "manifest", bytes: manifest.length }, manifest),
      server.encodeFrame({ kind: "file", bytes: payload.length, path: "a/b.bin", sha256: "b".repeat(64) }, payload),
      server.END_FRAME,
    ]);
    const frames = decode(companion, stream);
    expect(frames.map((frame) => frame.header.kind)).toEqual(["manifest", "file"]);
    expect(frames[1].payload.equals(payload)).toBe(true);
  });

  it("the control plane reads what the companion writes", () => {
    const stream = Buffer.concat([
      companion.encodeFrame({ kind: "file", bytes: payload.length, path: "result.json", sha256: "c".repeat(64) }, payload),
      companion.END_FRAME,
    ]);
    const frames = decode(server, stream);
    expect(frames[0].header.path).toBe("result.json");
    expect(frames[0].payload.equals(payload)).toBe(true);
  });

  it("the two end frames are byte-identical", () => {
    expect(server.END_FRAME.equals(companion.END_FRAME)).toBe(true);
  });
});

describe("frame reader", () => {
  const body = Buffer.from("0123456789", "utf8");
  const stream = Buffer.concat([
    server.encodeFrame({ kind: "manifest", bytes: body.length }, body),
    server.END_FRAME,
  ]);

  it("reassembles a frame split across arbitrary chunk boundaries", () => {
    for (let split = 1; split < stream.length; split += 1) {
      const frames: Buffer[] = [];
      let parts: Buffer[] = [];
      const reader = new server.FrameReader({
        onHeader: () => { parts = []; },
        onPayload: (chunk) => { parts.push(chunk); },
        onFrameEnd: (header) => { if (header.kind !== "end") frames.push(Buffer.concat(parts)); },
      });
      reader.push(stream.subarray(0, split));
      reader.push(stream.subarray(split));
      reader.end();
      expect(frames[0].toString("utf8")).toBe("0123456789");
    }
  });

  it("refuses a stream that ends mid-frame", () => {
    const reader = new server.FrameReader({ onHeader: () => {}, onPayload: () => {}, onFrameEnd: () => {} });
    reader.push(stream.subarray(0, stream.length - 4));
    expect(() => reader.end()).toThrow(/before its end frame/);
  });

  it("refuses bytes after the end frame", () => {
    const reader = new server.FrameReader({ onHeader: () => {}, onPayload: () => {}, onFrameEnd: () => {} });
    expect(() => reader.push(Buffer.concat([stream, Buffer.from("extra")]))).toThrow(/past its end frame/);
  });

  it("refuses an oversized header length before allocating anything", () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(server.MAX_FRAME_HEADER_BYTES + 1, 0);
    const reader = new server.FrameReader({ onHeader: () => {}, onPayload: () => {}, onFrameEnd: () => {} });
    expect(() => reader.push(prefix)).toThrow(/header length is out of range/);
  });

  it("refuses a file frame with no digest", () => {
    expect(() => server.encodeFrame({ kind: "file", bytes: 0, path: "a" })).toThrow(/path and a digest/);
  });
});

// The companion also duplicates the manifest rules and the capability builder.
// Same contract, same reason: a control plane that has been tampered with must
// not be able to hand the worker a boundary the worker would not derive itself.
describe("manifest and capability parity", () => {
  const document: JsonValue = JSON.parse(workerTaskManifestJson(parsedManifest()));
  const digest = workerTaskManifestDigest(parsedManifest());

  it("both ends compute the same manifest digest", () => {
    const staged = parseStagedManifest(document, digest);
    expect(staged.taskId).toBe("task-1");
  });

  it("the companion refuses a staged manifest that does not match the approved digest", () => {
    expect(() => parseStagedManifest(document, "f".repeat(64))).toThrow(/does not match the approved digest/);
  });

  it("both ends derive a byte-identical capability", () => {
    const manifest = parsedManifest();
    const root = fakeTaskRoot(HOST_TASK_PLATFORM, manifest.taskId);
    const staged = parseStagedManifest(document, digest);
    expect(taskCapabilityManifest(staged, root, TASK_ISSUED))
      .toBe(workerCuaCapabilityManifest(manifest, root, TASK_ISSUED));
  });

  it("a browser task derives the same capability on both ends too", () => {
    const overrides = { surface: "browser", origins: ["https://example.com"] };
    const manifest = parsedManifest(HOST_TASK_PLATFORM, overrides);
    const browserDocument: JsonValue = JSON.parse(workerTaskManifestJson(manifest));
    const staged = parseStagedManifest(browserDocument, workerTaskManifestDigest(manifest));
    const root = fakeTaskRoot(HOST_TASK_PLATFORM, manifest.taskId);
    expect(workerCuaCapabilityDigest(taskCapabilityManifest(staged, root, TASK_ISSUED)))
      .toBe(workerCuaCapabilityDigest(workerCuaCapabilityManifest(manifest, root, TASK_ISSUED)));
  });

  it.each([
    ["macos", "/bin/sh"],
    ["macos", "/usr/bin/osascript"],
    ["macos", "/usr/bin/open"],
    ["windows", "C:\\Windows\\System32\\cmd.exe"],
    ["windows", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  ] as const)("both ends reject %s executable %s", (platform, executable) => {
    // The server's own refusal is covered in worker-task-manifest.test.ts; this
    // asserts the companion's copy of the rule agrees, which is the half that
    // would silently drift.
    expect(PLATFORM_PROFILES[platform].blockedExecutable.test(executable)).toBe(true);
  });

  it("both ends still allow an ordinary build binary", () => {
    expect(PLATFORM_PROFILES.macos.blockedExecutable.test("/opt/homebrew/bin/just")).toBe(false);
    expect(PLATFORM_PROFILES.windows.blockedExecutable.test("C:\\tools\\build.exe")).toBe(false);
  });
});

const TASK_ISSUED = 1_800_000_000_000;

// Manifest documents are staged as bytes and re-parsed on the worker, so the
// document the control plane sends has to survive that round trip unchanged.
describe("staged manifest round trip", () => {
  it("survives serialisation with its digest intact", () => {
    const manifest = parsedManifest();
    const bytes = Buffer.from(workerTaskManifestJson(manifest), "utf8");
    const reparsed: JsonValue = JSON.parse(bytes.toString("utf8"));
    expect(parseStagedManifest(reparsed, workerTaskManifestDigest(manifest)).commands[0].id).toBe("build");
  });

  it("a manifest fixture is a plain JSON document", () => {
    expect(() => JSON.parse(JSON.stringify(manifestFixture()))).not.toThrow();
  });
});
