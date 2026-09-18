// This is the one place in the app that executes something it just downloaded,
// so the guard rails are what the test is for: the hash gate, the refusals on
// unsupported targets, the download it must NOT start when Piper is already
// installed, and the staging directory it must never leave behind.
//
// Nothing here touches the network: the fetcher and the unpacker are injected,
// and the artifacts are served from memory with hashes computed at test time.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PIPER_ENGINES,
  PIPER_VOICE_FILES,
  installPiper,
  piperEngineArtifact,
  piperInstallState,
  piperInstallable,
  piperTarget,
  startPiperInstall,
  unpackCommand,
} from "./piper-install.ts";

const TEST_TARGET = "test-x64";
const TEST_VOICE = "test-voice";
const ARCHIVE = Buffer.from("engine archive bytes");
const VOICE_MODEL = Buffer.from("onnx voice bytes");
const VOICE_META = Buffer.from('{"audio":{"quality":"medium"}}');

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Registered as a real target/voice so the production code path runs
 * unmodified against in-memory artifacts. Restored after every test. */
function registerTestArtifacts(): void {
  PIPER_ENGINES[TEST_TARGET] = { url: "https://example.test/engine.tar.gz", sha256: sha256(ARCHIVE), archive: "tar.gz" };
  PIPER_VOICE_FILES[TEST_VOICE] = [
    { name: "test-voice.onnx", url: "https://example.test/voice.onnx", sha256: sha256(VOICE_MODEL) },
    { name: "test-voice.onnx.json", url: "https://example.test/voice.onnx.json", sha256: sha256(VOICE_META) },
  ];
}

const roots: string[] = [];
const temporaryRoot = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `astra-piper-install-${label}-`));
  roots.push(dir);
  return dir;
};

const serve = (bodies: Record<string, Buffer>) => {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const body = bodies[String(url)];
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } as unknown as Response;
  });
  return fetchImpl as unknown as typeof fetch;
};

/** Unpacker stand-in: materialises the archive layout (a wrapping piper/
 * directory) exactly as the published piper builds do. */
const unpackInto = (names: string[] = ["piper.exe", "espeak-ng.dll"]) =>
  vi.fn(async (_command: string, args: string[]) => {
    const destination = args[args.indexOf("-C") + 1]!;
    mkdirSync(join(destination, "piper"), { recursive: true });
    for (const name of names) writeFileSync(join(destination, "piper", name), "");
  });

afterEach(() => {
  delete PIPER_ENGINES[TEST_TARGET];
  delete PIPER_VOICE_FILES[TEST_VOICE];
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("targets", () => {
  it("names the platform it will fetch for", () => {
    expect(piperTarget("win32", "x64")).toBe("win32-x64");
    expect(piperEngineArtifact("darwin-arm64")?.archive).toBe("tar.gz");
  });

  it("refuses a platform piper publishes nothing for", () => {
    expect(piperInstallable("win32-arm64")).toBe(false);
    expect(piperInstallable("win32-x64")).toBe(true);
  });

  it("uses the platform's own tar, by absolute path on Windows", () => {
    const zip = piperEngineArtifact("win32-x64")!;
    expect(unpackCommand("a.zip", zip, "dest", "win32", { SystemRoot: "C:\\Windows" })).toEqual({
      command: join("C:\\Windows", "System32", "tar.exe"),
      args: ["-xf", "a.zip", "-C", "dest"],
    });
    const tarball = piperEngineArtifact("linux-x64")!;
    expect(unpackCommand("a.tar.gz", tarball, "dest", "linux", {})).toEqual({
      command: "tar",
      args: ["-xzf", "a.tar.gz", "-C", "dest"],
    });
  });
});

describe("installPiper", () => {
  it("installs the engine and the voice, and leaves no staging directory", async () => {
    registerTestArtifacts();
    const root = temporaryRoot("happy");
    const fetchImpl = serve({
      "https://example.test/engine.tar.gz": ARCHIVE,
      "https://example.test/voice.onnx": VOICE_MODEL,
      "https://example.test/voice.onnx.json": VOICE_META,
    });
    const unpack = unpackInto();
    await installPiper({ root, target: TEST_TARGET, voiceId: TEST_VOICE, fetchImpl, unpack });

    expect(existsSync(join(root, process.platform === "win32" ? "piper.exe" : "piper"))).toBe(true);
    expect(existsSync(join(root, "espeak-ng.dll"))).toBe(true);
    expect(readFileSync(join(root, "voices", "test-voice.onnx"))).toEqual(VOICE_MODEL);
    expect(readFileSync(join(root, "voices", "test-voice.onnx.json"))).toEqual(VOICE_META);
    expect(readdirSync(root).filter((entry) => entry.startsWith(".install-"))).toEqual([]);
    // The tarball flag, not the zip one: the archive shape decides.
    expect(unpack.mock.calls[0]![1]).toContain("-xzf");
  });

  it("refuses a download whose bytes do not match the pinned hash", async () => {
    registerTestArtifacts();
    const root = temporaryRoot("tampered");
    const fetchImpl = serve({ "https://example.test/engine.tar.gz": Buffer.from("swapped payload") });
    const unpack = unpackInto();
    await expect(
      installPiper({ root, target: TEST_TARGET, voiceId: TEST_VOICE, fetchImpl, unpack }),
    ).rejects.toThrow(/Checksum mismatch/);
    // Nothing unpacked, nothing executed, nothing left behind.
    expect(unpack).not.toHaveBeenCalled();
    expect(readdirSync(root).filter((entry) => entry.startsWith(".install-"))).toEqual([]);
  });

  it("cleans up when the unpacker fails", async () => {
    registerTestArtifacts();
    const root = temporaryRoot("unpack-fails");
    const fetchImpl = serve({
      "https://example.test/engine.tar.gz": ARCHIVE,
      "https://example.test/voice.onnx": VOICE_MODEL,
      "https://example.test/voice.onnx.json": VOICE_META,
    });
    const unpack = vi.fn(async () => {
      throw new Error("tar exited 1: not an archive");
    });
    await expect(installPiper({ root, target: TEST_TARGET, voiceId: TEST_VOICE, fetchImpl, unpack })).rejects.toThrow(
      /not an archive/,
    );
    expect(readdirSync(root).filter((entry) => entry.startsWith(".install-"))).toEqual([]);
  });

  it("leaves no engine behind when the voice download fails", async () => {
    // Availability keys on the engine binary, so a half-install must not look
    // installed: the voice is fetched before the engine is moved into place.
    registerTestArtifacts();
    const root = temporaryRoot("voice-fails");
    const fetchImpl = serve({ "https://example.test/engine.tar.gz": ARCHIVE, "https://example.test/voice.onnx": VOICE_MODEL });
    await expect(
      installPiper({ root, target: TEST_TARGET, voiceId: TEST_VOICE, fetchImpl, unpack: unpackInto() }),
    ).rejects.toThrow(/Download failed \(404\)/);
    expect(existsSync(join(root, process.platform === "win32" ? "piper.exe" : "piper"))).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.startsWith(".install-"))).toEqual([]);
  });

  it("refuses an unsupported target without fetching anything", async () => {
    const fetchImpl = serve({});
    await expect(
      installPiper({ root: temporaryRoot("unsupported"), target: "win32-arm64", fetchImpl }),
    ).rejects.toThrow(/no engine for win32-arm64/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not download again when the engine and voice are already there", async () => {
    registerTestArtifacts();
    const root = temporaryRoot("already");
    mkdirSync(join(root, "voices"), { recursive: true });
    writeFileSync(join(root, process.platform === "win32" ? "piper.exe" : "piper"), "");
    for (const file of PIPER_VOICE_FILES[TEST_VOICE]!) writeFileSync(join(root, "voices", file.name), "");
    const fetchImpl = serve({});
    await installPiper({ root, target: TEST_TARGET, voiceId: TEST_VOICE, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("startPiperInstall", () => {
  it("runs one install at a time and reports the outcome as state", async () => {
    registerTestArtifacts();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;
    const root = temporaryRoot("state");

    expect(startPiperInstall({ root, target: TEST_TARGET, voiceId: TEST_VOICE, fetchImpl }).started).toBe(true);
    expect(piperInstallState().installing).toBe(true);
    // A second click while the first is in flight joins it instead of racing it.
    expect(startPiperInstall({ root, target: TEST_TARGET, voiceId: TEST_VOICE, fetchImpl }).started).toBe(false);

    release();
    await vi.waitFor(() => expect(piperInstallState().installing).toBe(false));
    expect(piperInstallState().error).toMatch(/Download failed \(500\)/);
  });
});
