import { describe, expect, it } from "vitest";

import { WORKER_DEFAULTS, type ResolvedWorker, type WorkerPlatform } from "./computer-workers.ts";
import type { JsonValue } from "./schema.ts";
import { workerCuaCapabilityDigest, workerCuaCapabilityManifest } from "./worker-cua-capability.ts";
import {
  WORKER_TASK_IDLE_TIMEOUT_MS,
  WORKER_TASK_MANIFEST_VERSION,
  parseWorkerTaskManifest,
} from "./worker-task-manifest.ts";

const POLICY = "a".repeat(64);
const NOW = 1_800_000_000_000;
const ROOT = { windows: "C:\\omb\\tasks\\task-1", macos: "/Users/worker/.openmausbot/tasks/task-1" } as const;

function worker(platform: WorkerPlatform): ResolvedWorker {
  const defaults = WORKER_DEFAULTS[platform];
  return {
    id: platform === "windows" ? "win-box" : "mac-guest",
    platform,
    displayName: "w",
    sshAlias: platform === "windows" ? "omb-win" : "omb-mac",
    expectedDriverVersion: "0.20.0",
    expectedBasePolicySha256: POLICY,
    browserExecutable: defaults.browserExecutable,
    browserProfile: defaults.browserProfile,
    ideExecutable: defaults.ideExecutable,
    paused: false,
    configured: true,
  };
}

function capability(platform: WorkerPlatform, overrides: Record<string, JsonValue> = {}, root: string = ROOT[platform]) {
  const w = worker(platform);
  // SAFETY: the literal below is composed only of JSON primitives, arrays and
  // plain objects, and `overrides` is already typed as JsonValue.
  const manifest = parseWorkerTaskManifest({
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
      argv: [],
      cwd: "src",
      timeoutMs: 60_000,
    }],
    origins: [],
    resultPaths: ["result.json", "changes.patch"],
    ...overrides,
  } as JsonValue, w, NOW);
  return workerCuaCapabilityManifest(manifest, root, NOW);
}

describe.each(["windows", "macos"] as const)("%s CUA capability", (platform) => {
  it("is a version 3 manifest with a bounded lifetime", () => {
    const yaml = capability(platform);
    expect(yaml).toContain("version: 3");
    expect(yaml).toMatch(/expires_after: \d+s/);
    expect(yaml).toMatch(/idle_timeout: \d+s/);
  });

  it("never enables the display", () => {
    expect(capability(platform)).toContain("display: false");
  });

  // This is the property the whole split exists to protect: a generic click can
  // reach anything on screen, so an origin-scoped browser capability that also
  // exposed generic input would make the origin list decorative.
  it("gives a browser task origins and no generic input", () => {
    const yaml = capability(platform, { surface: "browser", origins: ["https://example.com"] });
    expect(yaml).toContain('- "https://example.com"');
    expect(yaml).toContain("- browser_navigate");
    for (const generic of ["- click", "- type_text", "- press_key", "- hotkey", "- launch_app"]) {
      expect(yaml).not.toContain(generic);
    }
  });

  it("gives a desktop task generic input, the file manager, and no origins", () => {
    const yaml = capability(platform);
    expect(yaml).toContain("- click");
    expect(yaml).toContain("- type_text");
    expect(yaml).not.toContain("origins:");
    expect(yaml).not.toContain("- browser_navigate");
    const fileManager = platform === "windows"
      ? "C:\\\\Windows\\\\explorer.exe"
      : "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";
    expect(yaml).toContain(fileManager);
  });

  it("scopes desktop file access to the task root only", () => {
    const yaml = capability(platform);
    const root = ROOT[platform];
    const encoded = JSON.stringify(root);
    expect(yaml).toContain(`read:`);
    expect(yaml).toContain(`write:`);
    expect(yaml.split(encoded).length - 1).toBe(2);
  });

  it("refuses an expired manifest", () => {
    expect(() => capability(platform, { expiresAt: NOW + 500 })).toThrow(/expired/);
  });

  it("refuses a task root that is not absolute for the platform", () => {
    const wrong = platform === "windows" ? "/tmp/task" : "C:\\tmp\\task";
    expect(() => capability(platform, {}, wrong)).toThrow(/absolute/);
  });

  it("digests deterministically", () => {
    expect(workerCuaCapabilityDigest(capability(platform)))
      .toBe(workerCuaCapabilityDigest(capability(platform)));
    expect(workerCuaCapabilityDigest(capability(platform)))
      .not.toBe(workerCuaCapabilityDigest(capability(platform, { surface: "browser", origins: ["https://a.example"] })));
  });
});
