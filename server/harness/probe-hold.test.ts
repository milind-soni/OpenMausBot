import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { cliPresent, heldSnapshot, inconclusiveFailure, inconclusiveMark } from "./probe-hold.ts";

const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await removeTempDir(dir); });

describe("a check that could not finish", () => {
  it("is a timeout, a SIGKILL or a refused spawn; never a crash, a missing file, a permission or an exit status", () => {
    // execCli's own cut-off and Node's timeout kill.
    expect(inconclusiveFailure(Object.assign(new Error("opencode timed out after 8000 ms"), { killed: true, code: null, signal: null }))).toBe(true);
    expect(inconclusiveFailure(Object.assign(new Error("Command failed"), { killed: true, code: null, signal: "SIGTERM" }))).toBe(true);
    // The OOM killer's SIGKILL, with no timeout.
    expect(inconclusiveFailure(Object.assign(new Error("Command failed"), { killed: false, code: null, signal: "SIGKILL" }))).toBe(true);
    for (const code of ["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"]) expect(inconclusiveFailure(Object.assign(new Error(`spawn ${code}`), { code }))).toBe(true);

    for (const code of ["ENOENT", "EACCES", "EPERM"]) expect(inconclusiveFailure(Object.assign(new Error(`spawn ${code}`), { code }))).toBe(false);
    // A program that crashes answers: it is broken.
    for (const signal of ["SIGSEGV", "SIGABRT", "SIGBUS", "SIGTERM"]) expect(inconclusiveFailure(Object.assign(new Error("Command failed"), { killed: false, code: null, signal }))).toBe(false);
    expect(inconclusiveFailure(Object.assign(new Error("Command failed"), { killed: false, code: 1, signal: null }))).toBe(false);
    expect(inconclusiveFailure(null)).toBe(false);
    expect(inconclusiveMark(Object.assign(new Error("x"), { code: "EAGAIN" }))).toEqual({ busy: true });
    expect(inconclusiveMark(Object.assign(new Error("x"), { code: "ENOENT" }))).toEqual({});
  });

  it("keeps the last status that found the engine; else the program file decides", () => {
    const busy = { state: "unavailable", reason: "timed out", busy: true } as const;
    const known = { state: "available", version: "1.19.3", authenticated: true } as const;
    expect(heldSnapshot(known, busy, () => true)).toBe(known);
    expect(heldSnapshot(known, busy, () => null)).toBe(known);
    // The program is gone: the last status no longer stands, after a restart from the saved file either.
    expect(heldSnapshot(known, busy, () => false)).toEqual({ state: "unavailable", reason: "timed out" });
    expect(heldSnapshot(undefined, busy, () => true)).toEqual({ state: "available", unverified: true });
    expect(heldSnapshot({ state: "unavailable", reason: "old", version: "1.0.0" }, busy, () => true)).toEqual({ state: "available", unverified: true, version: "1.0.0" });
    expect(heldSnapshot(undefined, busy, () => false)).toEqual({ state: "unavailable", reason: "timed out" });
    // No program to look at (an engine without a CLI): unknown, and still never "missing".
    expect(heldSnapshot(undefined, busy, () => null)).toEqual(busy);
  });
});

describe("cliPresent", () => {
  const dir = () => { const made = mkdtempSync(join(tmpdir(), "omb-cli-present-")); scratch.push(made); return made; };

  it("finds an executable file without starting it", () => {
    const bin = dir(), file = join(bin, "opencode");
    writeFileSync(file, "#!/bin/sh\nexit 1\n");
    chmodSync(file, 0o755);
    expect(cliPresent("opencode", process.platform, () => file)).toBe(true);
    expect(cliPresent(`"${file}" acp`)).toBe(true);
  });

  it("a missing file, a folder, or (off Windows) a file that cannot run is not there", () => {
    const bin = dir(), file = join(bin, "opencode"), folder = join(bin, "folder");
    mkdirSync(folder);
    expect(cliPresent("opencode", "linux", () => null)).toBe(false);
    expect(cliPresent(join(bin, "gone"), "linux")).toBe(false);
    expect(cliPresent(folder, "linux")).toBe(false);
    expect(cliPresent("", "linux")).toBe(false);
    writeFileSync(file, "not executable");
    chmodSync(file, 0o644);
    if (process.platform !== "win32" && process.getuid?.() !== 0) expect(cliPresent("opencode", "linux", () => file)).toBe(false);
    // Windows has no execute bit: a file that is there is there (a .cmd shim, a D:\ path).
    expect(cliPresent("opencode", "win32", () => file)).toBe(true);
  });
});
