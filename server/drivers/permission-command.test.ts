import { describe, expect, it } from "vitest";

import { acpPermissionCommand, permissionCommand } from "./permission-command.ts";

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
