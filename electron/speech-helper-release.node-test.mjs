import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("the helper removes an orphan session before requesting speech authorization", { skip: !swiftc && "needs macOS with swiftc" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "speech-helper-owner-"));
  try {
    const bin = join(dir, "speech-helper");
    execFileSync(
      "xcrun",
      ["swiftc", "-Onone", fileURLToPath(new URL("./resources/speech-helper.swift", import.meta.url)), "-o", bin],
      { timeout: 180_000 },
    );
    const session = join(dir, "session");
    mkdirSync(session, { mode: 0o700 });
    for (const name of ["stdout.ndjson", "stderr.log", "finish"]) writeFileSync(join(session, name), "fixture");
    const lifeline = join(session, "owner.pipe");
    execFileSync("/usr/bin/mkfifo", ["-m", "600", lifeline]);
    const result = spawnSync(bin, ["--lifeline-file", lifeline], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(session), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
