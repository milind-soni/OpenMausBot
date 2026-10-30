import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { inMyFolderCwd, sharedProjectFolder, validateBotCwd } from "./bot-cwd.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-cwd-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("validateBotCwd", () => {
  it("accepts an existing absolute directory", () => {
    expect(validateBotCwd(dir)).toEqual({ ok: true, cwd: dir });
  });

  it("treats null and empty as clearing the folder", () => {
    expect(validateBotCwd(null)).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("")).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("   ")).toEqual({ ok: true, cwd: null });
  });

  it("expands a leading ~ to the home folder", () => {
    // compare against homedir() itself: a Windows home like C:\Users\RUNNER~1
    // legitimately contains "~", so "no ~ in the output" is not a valid check
    expect(validateBotCwd("~")).toEqual({ ok: true, cwd: resolve(homedir()) });
  });

  it("rejects relative paths, files, and missing folders with a reason", () => {
    expect(validateBotCwd("relative/path")).toEqual({ ok: false, error: expect.stringMatching(/absolute/) });
    const file = join(dir, "a-file.txt");
    writeFileSync(file, "x");
    expect(validateBotCwd(file)).toEqual({ ok: false, error: expect.stringMatching(/not a folder/) });
    expect(validateBotCwd(join(dir, "nope"))).toEqual({ ok: false, error: expect.stringMatching(/doesn't exist/) });
    expect(validateBotCwd(42)).toEqual({ ok: false, error: expect.stringMatching(/path/) });
  });
});

describe("sharedProjectFolder", () => {
  const data = join(dir, "omb-data");
  const project = join(dir, "omb-data-site");
  mkdirSync(join(data, "task-workspaces", "bot", "thread"), { recursive: true });
  mkdirSync(project);

  it("shares an existing folder outside the data folder, even one whose name starts the same", () => {
    expect(sharedProjectFolder(project, data)).toBe(project);
  });

  it("never shares the data folder, a private workspace in it, a missing folder or no folder", () => {
    expect(sharedProjectFolder(data, data)).toBeUndefined();
    expect(sharedProjectFolder(join(data, "task-workspaces", "bot", "thread"), data)).toBeUndefined();
    expect(sharedProjectFolder(join(dir, "gone"), data)).toBeUndefined();
    expect(sharedProjectFolder(null, data)).toBeUndefined();
    expect(sharedProjectFolder(undefined, data)).toBeUndefined();
  });
});

describe("inMyFolderCwd", () => {
  const data = join(dir, "omb-data");
  const project = join(dir, "omb-data-site");
  const privateFolder = join(data, "task-workspaces", "bot", "thread");

  it("shares the sender's project folder outside a room unless asked not to", () => {
    expect(inMyFolderCwd(undefined, true, project, data)).toEqual({ cwd: project });
    expect(inMyFolderCwd(true, true, project, data)).toEqual({ cwd: project });
    expect(inMyFolderCwd(false, true, project, data)).toEqual({});
  });

  it("stays silent when left out, and refuses an explicit true, where there is nothing to share", () => {
    expect(inMyFolderCwd(undefined, false, project, data)).toEqual({});
    expect(inMyFolderCwd(undefined, true, privateFolder, data)).toEqual({});
    expect(inMyFolderCwd(true, false, project, data)).toEqual({ error: expect.stringMatching(/room/) });
    expect(inMyFolderCwd(true, true, privateFolder, data)).toEqual({ error: expect.stringMatching(/no project folder/) });
  });
});
