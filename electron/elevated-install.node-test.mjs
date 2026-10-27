// The root script runs through a real shell here, with a recording apt-get standing in for the package manager.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ELEVATED_INSTALL_SCRIPT,
  PKEXEC,
  canInstallElevated,
  installPackageElevated,
  sha512Hex,
} from "./elevated-install.mjs";

const hex = (text) => createHash("sha512").update(text).digest("hex");
const base64 = (text) => createHash("sha512").update(text).digest("base64");

test("a password prompt is only attempted where one can appear", () => {
  const ok = { platform: "linux", env: { DISPLAY: ":0" }, access: () => {} };
  assert.equal(canInstallElevated(ok), true);
  assert.equal(canInstallElevated({ ...ok, env: { WAYLAND_DISPLAY: "wayland-0" } }), true);
  assert.equal(canInstallElevated({ ...ok, platform: "darwin" }), false);
  assert.equal(canInstallElevated({ ...ok, env: {} }), false, "no graphical session: ssh, a service");
  assert.equal(canInstallElevated({ ...ok, env: { DISPLAY: ":0", OMB_UPDATE_INSTALL: "terminal" } }), false);
  assert.equal(canInstallElevated({ ...ok, access: () => { throw new Error("ENOENT"); } }), false);
});

test("pkexec is trusted only at its system location", () => {
  assert.equal(PKEXEC, "/usr/bin/pkexec");
});

test("the feed's checksum becomes the hex the script compares", () => {
  assert.equal(sha512Hex(base64("deb bytes")), hex("deb bytes"));
  assert.equal(sha512Hex(hex("deb bytes").toUpperCase()), hex("deb bytes"));
  for (const bad of [undefined, null, "", "abc", "x".repeat(88), `${base64("a")}!`, 42]) {
    assert.equal(sha512Hex(bad), null, String(bad));
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-elevated-"));
  const cache = join(dir, "cache dir", "o'brien", "pending");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, "OpenMausBot-2.0.0-amd64.deb");
  writeFileSync(file, "deb bytes");
  return { dir, file, cache, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the arguments are the system pkexec, a fixed script, and two values", async () => {
  const f = fixture();
  try {
    const calls = [];
    const result = await installPackageElevated({
      file: f.file,
      sha512: base64("deb bytes"),
      run: (program, args, options, callback) => {
        calls.push({ program, args, options });
        callback(null, "", "");
        return { stdin: { end() {} } };
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].program, "/usr/bin/pkexec");
    assert.deepEqual(calls[0].args, ["/bin/sh", "-c", ELEVATED_INSTALL_SCRIPT, "sh", f.file, hex("deb bytes")]);
    assert.ok(calls[0].options.timeout > 60_000);
  } finally {
    f.cleanup();
  }
});

test("each way the install can end maps to a reason the card can act on", async () => {
  const f = fixture();
  try {
    const outcome = (error, stderr = "") =>
      installPackageElevated({
        file: f.file,
        sha512: hex("deb bytes"),
        run: (_p, _a, _o, callback) => {
          callback(error, "", stderr);
          return null;
        },
      });
    const coded = (code, extra = {}) => Object.assign(new Error(`exit ${code}`), { code, ...extra });

    assert.equal((await outcome(coded(126))).reason, "declined");
    assert.equal((await outcome(coded(127))).reason, "refused");
    assert.equal((await outcome(coded(65))).reason, "checksum");
    assert.equal((await outcome(coded("ENOENT"))).reason, "unavailable");

    const failed = await outcome(coded(100), "W: noise\nE: Unable to acquire the dpkg frontend lock\n");
    assert.equal(failed.reason, "failed");
    assert.match(failed.detail, /Unable to acquire the dpkg frontend lock/);

    const slow = await outcome(coded(null, { killed: true }));
    assert.equal(slow.reason, "failed");
    assert.match(slow.detail, /too long/);

    const thrown = await installPackageElevated({
      file: f.file,
      sha512: hex("deb bytes"),
      run: () => {
        throw new Error("spawn failed");
      },
    });
    assert.equal(thrown.reason, "unavailable");
  } finally {
    f.cleanup();
  }
});

test("nothing is run for a file or checksum that cannot be trusted", async () => {
  const f = fixture();
  try {
    const run = () => assert.fail("pkexec must not be started");
    const link = join(f.dir, "link.deb");
    symlinkSync(f.file, link);
    writeFileSync(join(f.dir, "not-a-deb.txt"), "x");

    for (const file of [undefined, "", "relative.deb", join(f.dir, "gone.deb"), join(f.dir, "not-a-deb.txt"), f.cache, link]) {
      const result = await installPackageElevated({ file, sha512: hex("deb bytes"), run });
      assert.equal(result.ok, false, String(file));
      assert.equal(result.reason, "unverifiable", String(file));
    }
    const noSum = await installPackageElevated({ file: f.file, sha512: undefined, run });
    assert.equal(noSum.reason, "unverifiable");
    assert.match(noSum.detail, /checksum/);
  } finally {
    f.cleanup();
  }
});

// ---- the script itself, in a real shell --------------------------------

// The root script only ever runs on Linux, and the stand-in apt-get uses GNU coreutils (stat -c, find, sha512sum).
const linuxOnly = { skip: process.platform !== "linux" && "the root script runs only on Linux" };

function runScript(file, expected, { aptBody } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-script-"));
  const bin = join(dir, "bin");
  const log = join(dir, "apt.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "apt-get"),
    aptBody ?? [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${log}'`,
      'for last; do :; done',
      `printf 'dir=%s\\nmode=%s\\ndirmode=%s\\nbytes=%s\\nfront=%s\\n' "$(dirname "$last")" "$(stat -c %a "$last")" "$(stat -c %a "$(dirname "$last")")" "$(cat "$last")" "$DEBIAN_FRONTEND" >> '${log}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "apt-get"), 0o755);
  const result = spawnSync("/bin/sh", ["-c", ELEVATED_INSTALL_SCRIPT, "sh", file, expected], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir },
  });
  return {
    result,
    log: existsSync(log) ? readFileSync(log, "utf8") : null,
    leftovers: execFileSync("find", [dir, "-maxdepth", "1", "-name", "tmp.*"], { encoding: "utf8" }).trim(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("root installs its own verified copy, not the file in the user's cache", linuxOnly, () => {
  const f = fixture();
  const run = runScript(f.file, hex("deb bytes"));
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const lines = run.log.trim().split("\n");
    assert.deepEqual(lines.slice(0, 4), ["install", "-y", "-o", "Dpkg::Options::=--force-confold"]);
    const installed = lines[4];
    assert.match(installed, /\/tmp\.[^/]+\/update\.deb$/);
    assert.ok(!installed.startsWith(f.cache), "must not install straight from the user-writable cache");
    assert.ok(run.log.includes("mode=644") && run.log.includes("dirmode=755"));
    assert.ok(run.log.includes("bytes=deb bytes") && run.log.includes("front=noninteractive"));
    assert.equal(run.leftovers, "");
  } finally {
    run.cleanup();
    f.cleanup();
  }
});

test("a file swapped after the download is refused before apt-get runs", linuxOnly, () => {
  const f = fixture();
  writeFileSync(f.file, "swapped for something else");
  const run = runScript(f.file, hex("deb bytes"));
  try {
    assert.equal(run.result.status, 65);
    assert.match(run.result.stderr, /checksum/);
    assert.equal(run.log, null, "apt-get must never see an unverified package");
    assert.equal(run.leftovers, "");
  } finally {
    run.cleanup();
    f.cleanup();
  }
});

test("a failing apt-get fails the script and still cleans up", linuxOnly, () => {
  const f = fixture();
  const run = runScript(f.file, hex("deb bytes"), { aptBody: "#!/bin/sh\necho 'E: broken dependencies' >&2\nexit 100\n" });
  try {
    assert.equal(run.result.status, 100);
    assert.match(run.result.stderr, /broken dependencies/);
    assert.equal(run.leftovers, "");
  } finally {
    run.cleanup();
    f.cleanup();
  }
});
