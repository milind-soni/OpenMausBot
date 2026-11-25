import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { bindSafetyFloor } from "../safety-floor-gate.ts";

import { acpAnswersAlone, acpCarriesCommand, acpFileEditWithin, acpPermissionCommand, acpShellRequest, answersAlone, permissionCommand } from "./permission-command.ts";

const CWD = "/home/user/work";

describe("acpPermissionCommand", () => {
  it("reads Antigravity's CommandLine/Cwd", () => {
    expect(acpPermissionCommand({
      CommandLine: "ls -la /home/user/workspace/notes/",
      Cwd: "/home/user/.openmausbot/task-workspaces/fc432790/4b7437fe",
      WaitMsBeforeAsync: 5000,
    }, undefined)).toEqual({
      command: "ls -la /home/user/workspace/notes/",
      cwd: "/home/user/.openmausbot/task-workspaces/fc432790/4b7437fe",
    });
  });

  it("still reads the lower-case spelling every other agent sends", () => {
    expect(acpPermissionCommand({ command: "npm test", cwd: CWD }, undefined))
      .toEqual({ command: "npm test", cwd: CWD });
  });

  it("falls back to the launch directory when the frame names none", () => {
    expect(acpPermissionCommand({ CommandLine: "ls" }, CWD)).toEqual({ command: "ls", cwd: CWD });
    expect(acpPermissionCommand({ CommandLine: "ls" }, undefined)).toBeUndefined();
  });

  it("refuses two different spellings of the same field", () => {
    expect(acpPermissionCommand({ command: "ls", CommandLine: "rm -rf /", cwd: CWD }, undefined)).toBeUndefined();
    expect(acpPermissionCommand({ CommandLine: "ls", cwd: CWD, Cwd: "/elsewhere" }, undefined)).toBeUndefined();
    expect(acpPermissionCommand({ command: "ls", CommandLine: "ls", cwd: CWD }, undefined))
      .toEqual({ command: "ls", cwd: CWD });
  });

  it("refuses a relative or unusable directory rather than guessing", () => {
    expect(acpPermissionCommand({ CommandLine: "ls", Cwd: "relative/path" }, CWD)).toBeUndefined();
    expect(acpPermissionCommand({ CommandLine: "ls", Cwd: 42 }, CWD)).toBeUndefined();
    expect(acpPermissionCommand({ CommandLine: "", Cwd: CWD }, undefined)).toBeUndefined();
    expect(acpPermissionCommand(null, CWD)).toBeUndefined();
    expect(acpPermissionCommand(["ls"], CWD)).toBeUndefined();
  });
});

describe("permissionCommand", () => {
  it("keeps every byte of the command, including whitespace", () => {
    expect(permissionCommand("  ls   -la  \n", CWD)).toEqual({ command: "  ls   -la  \n", cwd: CWD });
  });

  it("refuses anything that is not a command and an absolute directory", () => {
    expect(permissionCommand("ls", "relative")).toBeUndefined();
    expect(permissionCommand("", CWD)).toBeUndefined();
    expect(permissionCommand("   ", CWD)).toBeUndefined();
    expect(permissionCommand("ls\0", CWD)).toBeUndefined();
    expect(permissionCommand("ls", `${CWD}\0`)).toBeUndefined();
    expect(permissionCommand(undefined, CWD)).toBeUndefined();
  });
});

describe("the never-list on an ACP request", () => {
  beforeEach(() => bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }) as never, undefined, "linux"));
  afterEach(() => bindSafetyFloor(() => ({})));

  it("reads a command under either spelling, whatever the request's kind", () => {
    expect(answersAlone("rm -rf ~")).toBe(false);
    expect(acpAnswersAlone({ command: "rm -rf ~" })).toBe(false);
    expect(acpAnswersAlone({ CommandLine: "rm -rf ~" })).toBe(false);
    expect(acpAnswersAlone({ command: "ls", CommandLine: "rm -rf ~" })).toBe(false);
    expect(acpAnswersAlone({ CommandLine: 42 })).toBe(false);
    expect(acpAnswersAlone({ CommandLine: "ls" })).toBe(true);
    expect(acpAnswersAlone({ command: "ls", CommandLine: "ls" })).toBe(true);
    for (const none of [undefined, null, {}, { path: "/tmp/a" }, ["rm -rf ~"]]) expect(acpAnswersAlone(none)).toBe(true);
    expect(acpCarriesCommand({ CommandLine: "ls" })).toBe(true);
    expect(acpCarriesCommand({ command: "" })).toBe(true);
    expect(acpCarriesCommand({ path: "/tmp/a" })).toBe(false);
  });

  it("carries the command line of a request that is not a shell call, and both lines when two spellings differ", () => {
    expect(acpShellRequest(false, { CommandLine: "rm -rf ~" }, CWD)).toEqual({ command: undefined, commandLine: "rm -rf ~" });
    expect(acpShellRequest(false, { command: "ls" }, CWD)).toEqual({ command: undefined, commandLine: "ls" });
    expect(acpShellRequest(true, { CommandLine: "ls" }, CWD)).toEqual({ command: { command: "ls", cwd: CWD }, commandLine: "ls" });
    expect(acpShellRequest(true, { command: "ls", CommandLine: "rm -rf ~" }, CWD)).toEqual({ command: undefined, commandLine: "ls\nrm -rf ~" });
    expect(acpShellRequest(false, { path: "/tmp/a" }, CWD)).toEqual({ command: undefined, commandLine: undefined });
    expect(acpShellRequest(false, undefined, CWD)).toEqual({ command: undefined, commandLine: undefined });
  });

  it("takes a request for a file edit only when it is one, inside the folder", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-edit-within-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const inside = { kind: "edit", locations: [{ path: `${root}/notes.md` }] };
    expect(acpFileEditWithin(inside, root)).toBe(true);
    expect(acpFileEditWithin(inside, undefined)).toBe(false);
    expect(acpFileEditWithin({ ...inside, kind: "execute" }, root)).toBe(false);
    expect(acpFileEditWithin({ ...inside, rawInput: { CommandLine: "ls" } }, root)).toBe(false);
    expect(acpFileEditWithin({ kind: "edit", locations: [{ path: root }] }, root)).toBe(false);
    expect(acpFileEditWithin({ kind: "edit", locations: [] }, root)).toBe(false);
    expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/../x` }] }, root)).toBe(false);
    expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/a\0b` }] }, root)).toBe(false);
    expect(acpFileEditWithin({ kind: "edit", locations: [{}] }, root)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("asks for a folder, and for a path that goes through any link, one that climbs out of the folder or one it cannot follow", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-edit-root-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "omb-edit-outside-")));
    try {
      mkdirSync(join(outside, "deep"));
      symlinkSync(join(outside, "deep"), join(root, "link"));
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/link/../x` }] }, root)).toBe(false);
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/x` }] }, root)).toBe(true);
      symlinkSync(join(outside, "not-yet"), join(root, "dangling"));
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/dangling` }] }, root)).toBe(false);
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/dangling/x` }] }, root)).toBe(false);
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/new-folder/x` }] }, root)).toBe(true);
      writeFileSync(join(root, "file.txt"), "");
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/file.txt/x` }] }, root)).toBe(false);
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/file.txt` }] }, root)).toBe(true);
      mkdirSync(join(root, "sub"));
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/sub` }] }, root)).toBe(false);
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: "/dev/null" }] }, "/dev")).toBe(false);
      symlinkSync(join(root, "file.txt"), join(root, "alias"));
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/alias` }] }, root)).toBe(false);
      symlinkSync(join(root, "sub"), join(root, "inner"));
      expect(acpFileEditWithin({ kind: "edit", locations: [{ path: `${root}/inner/x` }] }, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
