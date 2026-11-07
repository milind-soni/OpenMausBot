import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { folderToFollow, inMyFolderCwd, sharedProjectFolder, validateBotCwd } from "./bot-cwd.ts";

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
  const privateWorkspace = join(data, "task-workspaces", "bot", "thread");
  mkdirSync(join(data, "task-workspaces", "bot", "thread"), { recursive: true });
  mkdirSync(project);
  const linkKind = process.platform === "win32" ? "junction" : "dir";
  const intoData = join(dir, "site-link-into-data");
  const outside = join(dir, "omb-outside-site");
  const anotherOutside = join(dir, "omb-another-outside");
  mkdirSync(outside);
  mkdirSync(anotherOutside);
  try { symlinkSync(privateWorkspace, intoData, linkKind); } catch {}
  const outLink = join(dir, "site-link-outside");
  try { symlinkSync(outside, outLink, linkKind); } catch {}
  const linked = existsSync(intoData) && existsSync(outLink);

  it("shares an existing folder outside the data folder, even one whose name starts the same", () => {
    expect(sharedProjectFolder(project, data)).toBe(project);
  });

  it("never shares the data folder, a private workspace in it, a missing folder or no folder", () => {
    expect(sharedProjectFolder(data, data)).toBeUndefined();
    expect(sharedProjectFolder(privateWorkspace, data)).toBeUndefined();
    expect(sharedProjectFolder(join(dir, "gone"), data)).toBeUndefined();
    expect(sharedProjectFolder(null, data)).toBeUndefined();
    expect(sharedProjectFolder(undefined, data)).toBeUndefined();
  });

  it.runIf(linked)("never shares a folder whose link resolves into the data folder, while a link out stays shareable", () => {
    expect(sharedProjectFolder(intoData, data)).toBeUndefined();
    expect(sharedProjectFolder(outLink, data)).toBe(realpathSync(outside));
  });

  it.runIf(linked)("returns the folder a link resolved to at check time, so retargeting it cannot move a shared task", () => {
    expect(sharedProjectFolder(outLink, data)).toBe(realpathSync(outside));
    rmSync(outLink);
    symlinkSync(join(dir, "omb-another-outside"), outLink, linkKind);
    expect(realpathSync(outLink)).not.toBe(realpathSync(outside));
    expect(sharedProjectFolder(outLink, data)).toBe(realpathSync(join(dir, "omb-another-outside")));
  });

  it.runIf(linked)("checks the data root as it really resolves, so a linked data folder is still a boundary", () => {
    const linkedData = join(dir, "omb-data-link");
    try { symlinkSync(data, linkedData, linkKind); } catch {}
    if (!existsSync(linkedData)) return;
    expect(sharedProjectFolder(privateWorkspace, linkedData)).toBeUndefined();
    expect(sharedProjectFolder(project, linkedData)).toBe(project);
  });

  it.runIf(linked)("still validates a linked folder as a plain working folder", () => {
    expect(validateBotCwd(intoData)).toEqual({ ok: true, cwd: intoData });
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

describe("folderToFollow", () => {
  const own = join(dir, "omb-data", "task-workspaces", "bot", "thread");
  const bot = { id: "bot", cwd: join(dir, "omb-data-site") };
  const folders = { worksInFolders: true, keepsPrivateFolder: false };

  it("moves a thread from its own folder to the working folder its bot has been given", () => {
    expect(folderToFollow(bot, "thread", own, folders)).toBe(bot.cwd);
  });

  it("leaves a thread where it is when the bot has no working folder or the thread is not in its own folder", () => {
    expect(folderToFollow({ id: "bot" }, "thread", own, folders)).toBeUndefined();
    expect(folderToFollow(bot, "thread", join(dir, "chosen"), folders)).toBeUndefined();
    expect(folderToFollow(bot, "thread", bot.cwd, folders)).toBeUndefined();
    expect(folderToFollow(bot, "thread", join(dir, "omb-data", "task-workspaces", "bot", "other-thread"), folders)).toBeUndefined();
    expect(folderToFollow(bot, "thread", null, folders)).toBeUndefined();
    expect(folderToFollow(bot, "thread", undefined, folders)).toBeUndefined();
  });

  it("never moves a conversation that keeps a private folder, or one on an engine that works in no folder", () => {
    expect(folderToFollow(bot, "thread", own, { ...folders, keepsPrivateFolder: true })).toBeUndefined();
    expect(folderToFollow(bot, "thread", own, { ...folders, worksInFolders: false })).toBeUndefined();
  });
});
