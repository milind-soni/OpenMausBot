// Exact command identity, as reported by an ACP agent.
//
// Everything keyed on "which command was this" depends on these: the saved
// command allowlist most of all, whose rules can only ever match a request
// that carried a command in the first place.
import { describe, expect, it } from "vitest";

import { acpPermissionCommand, permissionCommand } from "./permission-command.ts";

const CWD = "/home/user/work";

describe("acpPermissionCommand", () => {
  it("reads Antigravity's CommandLine/Cwd", () => {
    // The field names and the shape are from a real request.opened event
    // observed on 2026-10-10; only the paths are generalised. Until this
    // spelling was handled the function returned undefined for every
    // Antigravity shell request, so those bots reported no command at all
    // and no saved-command rule could ever match one.
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
    // A frame that says two things is a contradiction, not a choice, and a
    // grant keyed on the wrong one would be a grant for a different command.
    expect(acpPermissionCommand({ command: "ls", CommandLine: "rm -rf /", cwd: CWD }, undefined)).toBeUndefined();
    expect(acpPermissionCommand({ CommandLine: "ls", cwd: CWD, Cwd: "/elsewhere" }, undefined)).toBeUndefined();
    // Agreeing on both spellings is not a contradiction.
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
