import { describe, expect, it } from "vitest";

import { WORKER_DEFAULTS, type ResolvedWorker, type WorkerPlatform } from "./computer-workers.ts";
import type { JsonValue } from "./schema.ts";
import {
  WORKER_TASK_IDLE_TIMEOUT_MS,
  WORKER_TASK_MANIFEST_VERSION,
  WORKER_TASK_MAX_LIFETIME_MS,
  WorkerTaskRegistry,
  parseWorkerTaskManifest,
  workerTaskManifestDigest,
} from "./worker-task-manifest.ts";

const POLICY = "a".repeat(64);
const NOW = 1_800_000_000_000;

function worker(platform: WorkerPlatform, overrides: Partial<ResolvedWorker> = {}): ResolvedWorker {
  const defaults = WORKER_DEFAULTS[platform];
  return {
    id: platform === "windows" ? "win-box" : "mac-guest",
    platform,
    displayName: platform === "windows" ? "Windows box" : "macOS guest",
    sshAlias: platform === "windows" ? "omb-win" : "omb-mac",
    expectedDriverVersion: "0.20.0",
    expectedBasePolicySha256: POLICY,
    browserExecutable: defaults.browserExecutable,
    browserProfile: defaults.browserProfile,
    ideExecutable: defaults.ideExecutable,
    paused: false,
    configured: true,
    ...overrides,
  };
}

/** A minimal manifest that parses, so each test can change exactly one thing. */
function manifest(platform: WorkerPlatform, overrides: Record<string, JsonValue> = {}): JsonValue {
  const w = worker(platform);
  // SAFETY: every value below is a JSON primitive, array, or plain object, and
  // `overrides` is already typed as JsonValue, so the literal is JSON by
  // construction.
  return {
    version: WORKER_TASK_MANIFEST_VERSION,
    platform,
    workerId: w.id,
    taskId: "task-1",
    threadId: "thread-1",
    createdAt: NOW,
    expiresAt: NOW + 60 * 60_000,
    idleTimeoutMs: WORKER_TASK_IDLE_TIMEOUT_MS,
    target: { sshAlias: w.sshAlias, basePolicySha256: POLICY },
    files: [],
    commands: [{
      id: "build",
      executable: platform === "windows" ? "C:\\tools\\build.exe" : "/opt/homebrew/bin/just",
      argv: ["build"],
      cwd: "src",
      timeoutMs: 60_000,
    }],
    origins: [],
    resultPaths: ["result.json", "changes.patch"],
    ...overrides,
  } as JsonValue;
}

const parse = (platform: WorkerPlatform, overrides: Record<string, JsonValue> = {}, w = worker(platform)) =>
  parseWorkerTaskManifest(manifest(platform, overrides), w, NOW);

describe.each(["windows", "macos"] as const)("%s task manifest", (platform) => {
  it("parses a well-formed manifest and defaults the surface to desktop", () => {
    const parsed = parse(platform);
    expect(parsed.surface).toBe("desktop");
    expect(parsed.platform).toBe(platform);
    expect(parsed.target.browserExecutable).toBe(WORKER_DEFAULTS[platform].browserExecutable);
  });

  it("refuses a manifest bound to the other platform", () => {
    const other = platform === "windows" ? "macos" : "windows";
    expect(() => parseWorkerTaskManifest(manifest(platform), worker(other), NOW)).toThrow();
  });

  it("refuses a manifest naming a different worker id", () => {
    expect(() => parse(platform, { workerId: "someone-else" })).toThrow(/different worker/);
  });

  it("refuses a mismatched SSH alias", () => {
    const w = worker(platform);
    expect(() => parse(platform, { target: { sshAlias: "other-host", basePolicySha256: POLICY } }, w))
      .toThrow(/SSH alias/);
  });

  it("refuses a mismatched base-policy digest", () => {
    const w = worker(platform);
    expect(() => parse(platform, { target: { sshAlias: w.sshAlias, basePolicySha256: "b".repeat(64) } }, w))
      .toThrow(/policy digest/);
  });

  it("refuses a worker with no pinned base policy", () => {
    const unpinned = worker(platform, { configured: false, expectedBasePolicySha256: null });
    expect(() => parseWorkerTaskManifest(manifest(platform), unpinned, NOW)).toThrow(/pinned base policy/);
  });

  it("refuses an expired manifest and one that outlives the two-hour ceiling", () => {
    expect(() => parse(platform, { expiresAt: NOW - 1 })).toThrow(/not currently valid/);
    expect(() => parse(platform, { expiresAt: NOW + WORKER_TASK_MAX_LIFETIME_MS + 1_000 })).toThrow(/lifetime/);
  });

  it("requires both result artefacts", () => {
    expect(() => parse(platform, { resultPaths: ["result.json", "other.txt"] })).toThrow(/result\.json/);
  });

  it("keeps browser and desktop surfaces disjoint", () => {
    expect(() => parse(platform, { surface: "browser", origins: [] })).toThrow(/exact origin/);
    expect(() => parse(platform, { surface: "desktop", origins: ["https://example.com"] }))
      .toThrow(/cannot declare browser origins/);
  });

  it.each([
    ["a wildcard", "https://*.example.com"],
    ["a path", "https://example.com/app"],
    ["a query", "https://example.com/?a=1"],
    ["embedded credentials", "https://user:pw@example.com"],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("refuses an origin with %s", (_label, origin) => {
    expect(() => parse(platform, { surface: "browser", origins: [origin] })).toThrow(/origin must be exact/);
  });

  it("refuses a GUI application as a structured command — that surface belongs to CUA", () => {
    const w = worker(platform);
    expect(() => parse(platform, {
      commands: [{ id: "c", executable: w.ideExecutable, argv: [], cwd: "src", timeoutMs: 1_000 }],
    })).toThrow(/driven through CUA/);
  });

  it("refuses a relative executable", () => {
    expect(() => parse(platform, {
      commands: [{ id: "c", executable: "build.exe", argv: [], cwd: "src", timeoutMs: 1_000 }],
    })).toThrow(/absolute path/);
  });

  it("refuses a staged file on a credential-shaped path", () => {
    expect(() => parse(platform, {
      files: [{ path: "config/id_rsa", size: 1, sha256: "c".repeat(64) }],
    })).toThrow();
  });

  it("digests canonically, so key order cannot change what was approved", () => {
    const a = parse(platform);
    // The same document with every top-level key emitted in reverse order.
    // SAFETY: manifest() returns a plain JSON object literal, so reading its
    // own keys back as a record is sound.
    const base = manifest(platform) as Record<string, JsonValue>;
    const entries = Object.entries(base).reverse();
    expect(entries.map(([key]) => key)).not.toEqual(Object.keys(base));
    // SAFETY: re-assembling that object's own entries cannot make it non-JSON.
    const reversed = Object.fromEntries(entries) as JsonValue;
    const reordered = parseWorkerTaskManifest(reversed, worker(platform), NOW);
    expect(workerTaskManifestDigest(reordered)).toBe(workerTaskManifestDigest(a));
  });
});

// The blocklists differ per platform and each one is the difference between a
// bounded command and arbitrary execution, so they are asserted separately.
describe("forbidden executables", () => {
  it.each([
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\reg.exe",
    "C:\\Windows\\System32\\wscript.exe",
  ])("refuses %s on Windows", (executable) => {
    expect(() => parse("windows", {
      commands: [{ id: "c", executable, argv: [], cwd: "src", timeoutMs: 1_000 }],
    })).toThrow(/forbidden/);
  });

  it.each([
    "/bin/sh",
    "/bin/bash",
    "/bin/zsh",
    "/usr/bin/osascript",
    "/usr/bin/open",
    "/usr/bin/sudo",
    "/usr/bin/env",
    "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
  ])("refuses %s on macOS", (executable) => {
    expect(() => parse("macos", {
      commands: [{ id: "c", executable, argv: [], cwd: "src", timeoutMs: 1_000 }],
    })).toThrow(/forbidden/);
  });

  it("still allows an ordinary build binary on each platform", () => {
    expect(() => parse("windows", {
      commands: [{ id: "c", executable: "C:\\tools\\msbuild.exe", argv: [], cwd: "src", timeoutMs: 1_000 }],
    })).not.toThrow();
    expect(() => parse("macos", {
      commands: [{ id: "c", executable: "/opt/homebrew/bin/cargo", argv: [], cwd: "src", timeoutMs: 1_000 }],
    })).not.toThrow();
  });

  it("requires a .exe on Windows only", () => {
    expect(() => parse("windows", {
      commands: [{ id: "c", executable: "C:\\tools\\build", argv: [], cwd: "src", timeoutMs: 1_000 }],
    })).toThrow(/\.exe/);
  });
});

describe("WorkerTaskRegistry", () => {
  const record = () => parse("macos");

  it("does not treat registration as approval", () => {
    const registry = new WorkerTaskRegistry();
    const entry = registry.register(record());
    expect(entry.approvedAt).toBeNull();
    expect(registry.approved(entry.manifest.taskId, entry.digest, NOW)).toBeNull();
  });

  it("approves against the exact digest and refuses any other", () => {
    const registry = new WorkerTaskRegistry();
    const entry = registry.register(record());
    expect(registry.approve(entry.manifest.taskId, "d".repeat(64), NOW)).toBe(false);
    expect(registry.approve(entry.manifest.taskId, entry.digest, NOW)).toBe(true);
    expect(registry.approved(entry.manifest.taskId, entry.digest, NOW)).not.toBeNull();
  });

  it("drops approval when the document changes under the same task id", () => {
    const registry = new WorkerTaskRegistry();
    const first = registry.register(record());
    registry.approve(first.manifest.taskId, first.digest, NOW);
    const changed = parse("macos", { threadId: "thread-2" });
    const second = registry.register(changed);
    expect(second.digest).not.toBe(first.digest);
    expect(second.approvedAt).toBeNull();
    expect(registry.approved(second.manifest.taskId, second.digest, NOW)).toBeNull();
  });

  it("expires approval on idle timeout", () => {
    const registry = new WorkerTaskRegistry();
    const entry = registry.register(record());
    registry.approve(entry.manifest.taskId, entry.digest, NOW);
    const idle = NOW + WORKER_TASK_IDLE_TIMEOUT_MS;
    expect(registry.approved(entry.manifest.taskId, entry.digest, idle)).toBeNull();
  });

  it("revoking one worker leaves the other worker's approvals intact", () => {
    const registry = new WorkerTaskRegistry();
    const mac = registry.register(parse("macos"));
    const win = registry.register(parseWorkerTaskManifest(
      manifest("windows", { taskId: "task-2" }),
      worker("windows"),
      NOW,
    ));
    registry.approve(mac.manifest.taskId, mac.digest, NOW);
    registry.approve(win.manifest.taskId, win.digest, NOW);

    registry.revokeWorker("mac-guest");

    expect(registry.approved(mac.manifest.taskId, mac.digest, NOW)).toBeNull();
    expect(registry.approved(win.manifest.taskId, win.digest, NOW)).not.toBeNull();
  });
});
