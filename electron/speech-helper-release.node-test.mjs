import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CONTROL = 0x40000, OPTION = 0x80000, SHIFT = 0x20000, COMMAND = 0x100000;

const swiftc =
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).status === 0;

test("the helper finishes when any of the chosen modifiers is let go", { skip: !swiftc && "needs macOS with swiftc" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "speech-helper-release-"));
  try {
    const bin = join(dir, "speech-helper");
    execFileSync(
      "xcrun",
      ["swiftc", "-Onone", fileURLToPath(new URL("./resources/speech-helper.swift", import.meta.url)), "-o", bin],
      { timeout: 180_000 },
    );
    const check = (mods, flags) =>
      JSON.parse(execFileSync(bin, ["--release-check", mods, String(flags)], { encoding: "utf8", timeout: 10_000 }));
    assert.deepEqual(check("control,option", CONTROL | OPTION), { released: false });
    assert.deepEqual(check("control,option", CONTROL | OPTION | SHIFT), { released: false });
    assert.deepEqual(check("control,option", CONTROL), { released: true });
    assert.deepEqual(check("control,option", 0), { released: true });
    assert.deepEqual(check("option,shift", OPTION | SHIFT), { released: false });
    assert.deepEqual(check("option,shift", SHIFT | COMMAND), { released: true });
    const bad = spawnSync(bin, ["--release-check", "control,hyper", "0"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout), { error: "bad-modifiers" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
