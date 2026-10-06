import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { cuaSpaceOwnership, forgetCuaSpaceOwnership, recordCuaSpaceOwnership } from "./cua-space-ownership.ts";

it("persists a private ownership receipt, binds the creation identity and removes it explicitly", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-cua-receipt-"));
  const name = "openmausbot-test-linux";
  const records = join(dir, "cua-space-ownership");
  const path = join(records, `${createHash("sha256").update(name).digest("hex")}.json`);
  try {
    expect(cuaSpaceOwnership(name, dir)).toBeNull();
    recordCuaSpaceOwnership(name, dir);
    expect(cuaSpaceOwnership(name, dir)).toEqual({ name });
    expect(cuaSpaceOwnership("another-space", dir)).toBeNull();
    if (process.platform !== "win32") {
      expect(statSync(records).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    recordCuaSpaceOwnership(name, dir, "2026-10-03T21:33:54Z");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ name, addedAt: "2026-10-03T21:33:54Z" });
    forgetCuaSpaceOwnership(name, dir);
    expect(cuaSpaceOwnership(name, dir)).toBeNull();
    forgetCuaSpaceOwnership(name, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("fails closed for malformed or wrong-name ownership receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-cua-receipt-invalid-"));
  const name = "openmausbot-test-linux";
  const path = join(dir, "cua-space-ownership", `${createHash("sha256").update(name).digest("hex")}.json`);
  try {
    recordCuaSpaceOwnership(name, dir);
    for (const contents of ["{", JSON.stringify({ name: "another-space" }), JSON.stringify({ name, addedAt: 123 })]) {
      writeFileSync(path, contents);
      expect(cuaSpaceOwnership(name, dir)).toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
