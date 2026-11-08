// @vitest-environment node
import { createHash, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { executionRunnerPublicKey, executionRunnerResource, type ExecutionRunnerRelease } from "./execution-bundle";
import { VERSION } from "../runner/security.mjs";

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "origin-release-")); vi.stubEnv("ORIGIN_LOCAL_DATA_DIR", directory); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

test("published signed manifest authenticates the exact downloadable runner bytes", async () => {
  const publicKey = executionRunnerPublicKey();
  const response = await executionRunnerResource(["latest.json"]);
  expect(response.status).toBe(200);
  const release = await response.json() as ExecutionRunnerRelease;
  const signature = Buffer.from(release.signature, "base64");
  expect(verify(null, Buffer.from(JSON.stringify(release.manifest)), publicKey, signature)).toBe(true);
  expect(verify(null, Buffer.from(JSON.stringify({ ...release.manifest, version: "999.0.0" })), publicKey, signature)).toBe(false);
  expect((await (await executionRunnerResource([release.manifest.version, "manifest.json"])).json())).toEqual(release);
  for (const file of release.manifest.files) {
    const resource = await executionRunnerResource([release.manifest.version, ...file.path.split("/")]);
    expect(resource.status).toBe(200);
    const bytes = Buffer.from(await resource.arrayBuffer());
    expect(bytes.byteLength).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
});

test("enrollment trust survives publisher module restarts without replacing the private key", async () => {
  const publicKey = executionRunnerPublicKey(), keyPath = path.join(directory, "runner-signing.key"), original = readFileSync(keyPath);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  vi.resetModules();
  const restarted = await import("./execution-bundle");
  expect(restarted.executionRunnerPublicKey()).toBe(publicKey);
  expect(readFileSync(keyPath)).toEqual(original);
  const release = await restarted.executionRunnerRelease();
  expect(verify(null, Buffer.from(JSON.stringify(release.manifest)), publicKey, Buffer.from(release.signature, "base64"))).toBe(true);
});

test("unsafe signing-key permissions and links are rejected without silent trust rotation", () => {
  const publicKey = executionRunnerPublicKey(), keyPath = path.join(directory, "runner-signing.key"), original = readFileSync(keyPath);
  chmodSync(keyPath, 0o644);
  expect(() => executionRunnerPublicKey()).toThrow();
  expect(readFileSync(keyPath)).toEqual(original);
  chmodSync(keyPath, 0o600);
  const other = path.join(directory, "preserved.key");
  renameSync(keyPath, other); symlinkSync(other, keyPath);
  expect(() => executionRunnerPublicKey()).toThrow();
  expect(readFileSync(other)).toEqual(original);
  unlinkSync(keyPath); renameSync(other, keyPath);
  expect(executionRunnerPublicKey()).toBe(publicKey);
});

test.each([["unknown", "manifest.json"], ["latest.json", "extra"], [VERSION, "runner", "../runner-signing.key"], [VERSION, "runner", "runner-signing.key"], [VERSION, "runner", "test", "security.test.mjs"]])("release resources never expose unknown versions or private paths: %j", async (...resource) => {
  expect((await executionRunnerResource(resource)).status).toBe(404);
});
