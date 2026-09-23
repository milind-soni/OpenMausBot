// Temporary, source-level backport for the embedded Windows daemon launcher.
// Do not edit the signed vendor EXE or replace the SDK's lifecycle with a wrapper.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseBytes } from "./prepare-browser.mjs";

export const CUA_SDK_SOURCE = {
  asset: "cua-fc188250b4ca8549b8e61f937fdb1fb560770e86.tar.gz",
  url: "https://codeload.github.com/trycua/cua/tar.gz/fc188250b4ca8549b8e61f937fdb1fb560770e86",
  bytes: 218684699,
  sha256: "c85b75962da72f97f8f9d2f632ddd88ebca29bac30baf7c8954257cb808b0aa1",
};
export const CUA_SDK_PATCH_SHA256 = "6dcfd0337e708682d3dca101aadebce09a1972b4575c2b9b81730bac45eebe50";
export const CUA_SDK_VERSION = "0.28.2";
export const CUA_SDK_RUST = "1.97.1";
const patchPath = fileURLToPath(new URL("../third_party/cua/windows-embedded-console.patch", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function verifyCuaSdkPatch(bytes) {
  assert.equal(digest(bytes), CUA_SDK_PATCH_SHA256, "CUA Windows patch SHA-256 mismatch");
}

export async function buildWindowsCuaSdk(destination, expectedVersion) {
  assert.equal(process.platform, "win32", "CUA Windows SDK must be built on Windows");
  assert.equal(process.arch, "x64");
  assert.equal(expectedVersion, CUA_SDK_VERSION, "Update the Windows SDK source backport with the CUA version");
  const patch = readFileSync(patchPath);
  verifyCuaSdkPatch(patch);
  const scratch = mkdtempSync(join(tmpdir(), "omb-cua-sdk-"));
  const command = (file, args, input) => {
    const result = spawnSync(file, args, { cwd: scratch, input, windowsHide: true,
      stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", timeout: 30 * 60_000 });
    assert(!result.error && result.status === 0, `${file} failed: ${result.error?.message ?? result.status}`);
  };
  try {
    const archive = join(scratch, CUA_SDK_SOURCE.asset);
    writeFileSync(archive, await releaseBytes(CUA_SDK_SOURCE));
    command(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "--strip-components=1", "-C", scratch]);
    command("git", ["apply", "--check", "-"], patch);
    command("git", ["apply", "--whitespace=error-all", "-"], patch);
    command("rustup", ["toolchain", "install", CUA_SDK_RUST, "--profile", "minimal", "--target", "x86_64-pc-windows-msvc"]);
    command("rustup", ["run", CUA_SDK_RUST, "cargo", "build", "--locked", "--release", "--manifest-path",
      "libs/cua-driver/rust/Cargo.toml", "--package", "cua-driver-sdk", "--lib", "--target", "x86_64-pc-windows-msvc"]);
    const binary = join(scratch, "libs/cua-driver/rust/target/x86_64-pc-windows-msvc/release/cua_driver_sdk.dll");
    mkdirSync(destination, { recursive: true });
    copyFileSync(binary, join(destination, "cua_driver_sdk.dll"));
    copyFileSync(patchPath, join(destination, "windows-embedded-console.patch"));
    copyFileSync(join(scratch, "LICENSE.md"), join(destination, "CUA-LICENSE.txt"));
    writeFileSync(join(destination, "cua-sdk-provenance.json"), JSON.stringify({
      version: CUA_SDK_VERSION, source: CUA_SDK_SOURCE, patchSha256: CUA_SDK_PATCH_SHA256,
      rust: CUA_SDK_RUST, cargoLockSha256: digest(readFileSync(join(scratch, "libs/cua-driver/rust/Cargo.lock"))),
      dllSha256: digest(readFileSync(binary)),
    }, null, 2));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
