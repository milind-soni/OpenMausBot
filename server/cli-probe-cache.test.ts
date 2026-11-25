import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const windows = process.platform === "win32";

import { createCliProbeCache, probeCacheFile, probedProgram } from "./cli-probe-cache.ts";
import { noteProbeUnsettled } from "./cli-program.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function place() {
  const root = mkdtempSync(join(tmpdir(), "omb-probe-cache-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // The interpreter the test programs' `#!/usr/bin/env node` names, found on the same PATH.
  writeFileSync(join(bin, windows ? "node.exe" : "node"), "\u007fELF node");
  return { root, bin, file: join(root, "user-data", "engine-probes.json") };
}

function program(bin: string, name: string, body = "#!/usr/bin/env node\nconsole.log('1.0.0');\n"): string {
  const path = join(bin, windows ? `${name}.exe` : name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** A stand-in for execCli that counts its runs and answers what `answer` says. */
function runner(answer: (args: string[]) => { err?: Error; stdout: string; stderr?: string } = () => ({ stdout: "1.0.0\n" })) {
  const calls: string[][] = [];
  const run = ((_cli: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr?: string) => void) => {
    calls.push(args);
    const { err, stdout, stderr } = answer(args);
    queueMicrotask(() => cb(err ?? null, stdout, stderr ?? ""));
  }) as Parameters<typeof createCliProbeCache>[0]["run"];
  return { run, calls };
}

/** On Windows a program on a PATH needs its extension, and execCli resolves a bare name on the app's own PATH: these
 * tests name the program by its full path there. */
const cliFor = (bin: string, name: string) => (windows ? join(bin, `${name}.exe`) : name);
const ask = (exec: ReturnType<typeof createCliProbeCache>["exec"], cli: string, args: string[], path: string) =>
  new Promise<{ err: Error | null; stdout: string; stderr?: string }>((resolve) => exec(cli, args, { env: { PATH: path } }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));

describe("engine probe answers kept between desktop starts", () => {
  it("is kept only under the desktop app, in its own folder", () => {
    expect(probeCacheFile({})).toBeNull();
    expect(probeCacheFile({ OMB_USER_DATA: "/tmp/u" })).toBeNull();
    expect(probeCacheFile({ OMB_DESKTOP_PARENT: "1" })).toBeNull();
    expect(probeCacheFile({ OMB_DESKTOP_PARENT: "1", OMB_USER_DATA: "relative" })).toBeNull();
    expect(probeCacheFile({ OMB_DESKTOP_PARENT: "1", OMB_USER_DATA: join(tmpdir(), "u") })).toBe(join(tmpdir(), "u", "engine-probes.json"));
  });

  it("answers an unchanged program's --version and --help from the kept copy, also in the next start", async () => {
    const { bin, file } = place();
    program(bin, "engine");
    const first = runner((args) => ({ stdout: args[0] === "--help" ? "usage: engine --autocompact\n" : "1.0.0\n" }));
    const cache = createCliProbeCache({ file, appVersion: "0.1.180", run: first.run });
    expect(await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin)).toEqual({ err: null, stdout: "1.0.0\n", stderr: "" });
    expect(await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin)).toEqual({ err: null, stdout: "1.0.0\n", stderr: "" });
    expect(await ask(cache.exec, cliFor(bin, "engine"), ["--help"], bin)).toMatchObject({ stdout: "usage: engine --autocompact\n" });
    expect(await ask(cache.exec, cliFor(bin, "engine"), ["--help"], bin)).toMatchObject({ stdout: "usage: engine --autocompact\n" });
    expect(first.calls).toEqual([["--version"], ["--help"]]);

    const next = runner();
    const restarted = createCliProbeCache({ file, appVersion: "0.1.180", run: next.run });
    expect(await ask(restarted.exec, cliFor(bin, "engine"), ["--version"], bin)).toMatchObject({ stdout: "1.0.0\n" });
    expect(next.calls).toEqual([]);
  });

  it("asks again once the program file changes, or the app is another version", async () => {
    const { bin, file } = place();
    const npmTime = new Date("1985-10-26T08:15:00Z");
    const path = program(bin, "engine");
    utimesSync(path, npmTime, npmTime);
    const counted = runner();
    const cache = createCliProbeCache({ file, appVersion: "0.1.180", run: counted.run });
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    // Same size and modification time npm gives every file, but a new file: still asked again.
    rmSync(path);
    utimesSync(program(bin, "engine"), npmTime, npmTime);
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(2);
    program(bin, "engine", "#!/usr/bin/env node\nconsole.log('2.0.0');\n");
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(3);
    const upgraded = createCliProbeCache({ file, appVersion: "0.1.181", run: counted.run });
    await ask(upgraded.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(4);
  });

  it("never keeps a failure, an empty answer, a sign-in check, or a program that is not on the PATH", async () => {
    const { bin, file } = place();
    program(bin, "engine");
    let answer: { err?: Error; stdout: string } = { err: new Error("exit 1"), stdout: "" };
    const counted = runner(() => answer);
    const cache = createCliProbeCache({ file, appVersion: "1", run: counted.run });
    expect((await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin)).err?.message).toBe("exit 1");
    answer = { stdout: "  \n" };
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    answer = { stdout: "Logged in\n" };
    await ask(cache.exec, cliFor(bin, "engine"), ["auth", "status"], bin);
    await ask(cache.exec, cliFor(bin, "engine"), ["auth", "status"], bin);
    await ask(cache.exec, cliFor(bin, "missing"), ["--version"], bin);
    await ask(cache.exec, cliFor(bin, "missing"), ["--version"], bin);
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(7);
  });

  it.skipIf(windows)("does not keep a shell script or a version manager's shim, whose file stays while the version it runs changes", () => {
    const { root, bin } = place();
    program(bin, "viaShell", "#!/bin/bash\nexec real-engine \"$@\"\n");
    program(bin, "viaEnvShell", "#!/usr/bin/env -S bash -e\nexec real-engine \"$@\"\n");
    const manager = program(join(root), "mise", "\u007fELF");
    symlinkSync(manager, join(bin, "engine"));
    const shims = join(root, "shims");
    mkdirSync(shims);
    program(shims, "other");
    program(bin, "native", "\u007fELF binary");
    program(bin, "node-cli");
    expect(probedProgram("viaShell", { env: { PATH: bin } })).toBeNull();
    expect(probedProgram("viaEnvShell", { env: { PATH: bin } })).toBeNull();
    expect(probedProgram("engine", { env: { PATH: bin } })).toBeNull();
    expect(probedProgram("other", { env: { PATH: shims } })).toBeNull();
    expect(probedProgram("engine --flag", { env: { PATH: bin } })).toBeNull();
    expect(probedProgram("native", { env: { PATH: bin } })).toEqual({ program: expect.stringMatching(/native$/), interpreter: null });
    expect(probedProgram("node-cli", { env: { PATH: bin } })).toEqual({ program: expect.stringMatching(/node-cli$/), interpreter: expect.stringMatching(/node$/) });
  });

  it("runs every probe where nothing may be kept", async () => {
    const { bin } = place();
    program(bin, "engine");
    const counted = runner();
    const cache = createCliProbeCache({ file: null, appVersion: "1", run: counted.run });
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(2);
  });

  it.runIf(windows)("keeps an npm .cmd shim's answer under the script it runs, not the shim", () => {
    const { bin } = place();
    const script = join(bin, "node_modules", "engine", "bin", "engine.js");
    mkdirSync(join(bin, "node_modules", "engine", "bin"), { recursive: true });
    writeFileSync(script, "console.log('1.0.0');\n");
    writeFileSync(join(bin, "engine.cmd"), '@ECHO off\r\n"%~dp0\\node_modules\\engine\\bin\\engine.js" %*\r\n');
    expect(probedProgram(join(bin, "engine.cmd"), {})?.program.toLowerCase()).toBe(realpathSync(script).toLowerCase());
  });

  it("keys a script on the interpreter its #! line names too, and keeps nothing when that interpreter is gone", async () => {
    const { bin, file } = place();
    program(bin, "engine");
    const counted = runner();
    const cache = createCliProbeCache({ file, appVersion: "1", run: counted.run });
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(1);
    // Another Node on the same PATH: asked again.
    const node = join(bin, windows ? "node.exe" : "node");
    rmSync(node);
    writeFileSync(node, "\u007fELF another node build");
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(2);
    // No Node at all: the program cannot run, so no kept answer may say it is installed.
    rmSync(node);
    expect(probedProgram(cliFor(bin, "engine"), { env: { PATH: bin } })).toBeNull();
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(3);
  });

  it("runs the program again after a status check of that CLI could not finish", async () => {
    const { bin, file } = place();
    program(bin, "engine");
    const counted = runner();
    let unsettled = false;
    const cache = createCliProbeCache({ file, appVersion: "1", run: counted.run, unsettled: () => unsettled });
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    unsettled = true;
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(2);
    unsettled = false;
    await ask(cache.exec, cliFor(bin, "engine"), ["--version"], bin);
    expect(counted.calls).toHaveLength(2);
  });

  it("runs the program again while the status check could not finish, also when the probe names the CLI by another path", async () => {
    const { bin, file } = place();
    program(bin, "engine");
    const counted = runner();
    const cache = createCliProbeCache({ file, appVersion: "1", run: counted.run });
    // The probe names the copy by its full path (as on Windows); the engine status check knows the CLI by its set name.
    const byPath = join(bin, windows ? "engine.exe" : "engine");
    await ask(cache.exec, byPath, ["--version"], bin);
    try {
      noteProbeUnsettled("engine", true);
      await ask(cache.exec, byPath, ["--version"], bin);
      expect(counted.calls).toHaveLength(2);
    } finally {
      noteProbeUnsettled("engine", false);
    }
    await ask(cache.exec, byPath, ["--version"], bin);
    expect(counted.calls).toHaveLength(2);
  });
});
