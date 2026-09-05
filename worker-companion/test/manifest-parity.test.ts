// The manifest is intentionally validated twice: once by the control plane
// and once by the standalone worker companion. This corpus makes the duplicated
// security rules fail together instead of silently drifting apart.
import { describe, expect, it } from "vitest";

import type { WorkerPlatform } from "../../server/computer-workers.ts";
import type { JsonValue } from "../../server/schema.ts";
import {
  HOST_TASK_PLATFORM,
  TASK_NOW,
  parsedManifest,
  workerFixture,
} from "../../server/testing/worker-task.ts";
import { parseWorkerTaskManifest } from "../../server/worker-task-manifest.ts";
import { parseStagedManifest, taskManifestDigest } from "../src/manifest.ts";

function document(platform: WorkerPlatform): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(parsedManifest(platform))) as Record<string, JsonValue>;
}

function expectBothToReject(platform: WorkerPlatform, value: Record<string, JsonValue>): void {
  const json = value as JsonValue;
  expect(() => parseWorkerTaskManifest(json, workerFixture(platform), TASK_NOW)).toThrow();
  expect(() => parseStagedManifest(json, taskManifestDigest(json))).toThrow();
}

describe.each(["windows", "macos"] as const)("%s manifest validator parity", (platform) => {
  it("accepts the same normalized document", () => {
    const value = document(platform) as JsonValue;
    const control = parseWorkerTaskManifest(value, workerFixture(platform), TASK_NOW);
    const companion = parseStagedManifest(value, taskManifestDigest(value));
    expect(companion).toEqual(control);
  });

  it("refuses duplicate file paths", () => {
    const value = document(platform);
    value.files = [
      { path: "src/main.ts", size: 1, sha256: "c".repeat(64) },
      { path: "SRC/main.ts", size: 1, sha256: "d".repeat(64) },
    ];
    expectBothToReject(platform, value);
  });

  it("refuses duplicate command ids", () => {
    const value = document(platform);
    const commands = value.commands as JsonValue[];
    value.commands = [commands[0]!, { ...(commands[0] as Record<string, JsonValue>) }];
    expectBothToReject(platform, value);
  });

  it("requires both fixed result artefacts and unique result paths", () => {
    const missing = document(platform);
    missing.resultPaths = ["result.json", "other.txt"];
    expectBothToReject(platform, missing);

    const duplicate = document(platform);
    duplicate.resultPaths = ["result.json", "changes.patch", "RESULT.JSON"];
    expectBothToReject(platform, duplicate);
  });

  it("refuses non-exact and duplicate browser origins", () => {
    const path = document(platform);
    path.surface = "browser";
    path.origins = ["https://example.com/private"];
    expectBothToReject(platform, path);

    const duplicate = document(platform);
    duplicate.surface = "browser";
    duplicate.origins = ["https://example.com", "https://example.com"];
    expectBothToReject(platform, duplicate);
  });

  it("refuses command arguments containing line controls", () => {
    const value = document(platform);
    const command = (value.commands as Record<string, JsonValue>[])[0]!;
    command.argv = ["safe\nsecond-command"];
    expectBothToReject(platform, value);
  });

  it("refuses a manifest lifetime beyond two hours", () => {
    const value = document(platform);
    value.expiresAt = TASK_NOW + 2 * 60 * 60_000 + 1;
    expectBothToReject(platform, value);
  });
});

it("the host fixture still targets the platform this test process can execute", () => {
  expect(HOST_TASK_PLATFORM).toBe(process.platform === "win32" ? "windows" : "macos");
});
