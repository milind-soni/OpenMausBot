// Every reader of a bot's workspace files leaves its private secret files alone: backups, moves to a Cloud or a team,
// Cloud Files, chat links and folders, attach_file, publish_page and the extract helper, and browser uploads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { skipped } from "../electron/cloud-sync-rules.mjs";
import { uploadableFiles } from "./browser-upload.ts";
import { listBotFiles } from "./cloud-send-files.ts";
import { listMessageFolder, openMessageFile } from "./message-file.ts";
import { botFileSource, readPageBundle } from "./pages/bundle.ts";
import { SECRET_FILE_REFUSAL, SECRET_FOLDER } from "./secret-folder.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";
import { omittedFromWorkspaceBackup } from "./workspace-backup.ts";

let data = "";
let workspace = "";
let secret = "";

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "omb-secret-folder-"));
  workspace = join(data, "workspaces", "atlas");
  mkdirSync(join(workspace, SECRET_FOLDER, "thread-1"), { recursive: true });
  secret = join(workspace, SECRET_FOLDER, "thread-1", "card-1");
  writeFileSync(secret, "sk_canary_secret");
  writeFileSync(join(workspace, "notes.txt"), "plain notes");
  writeFileSync(join(workspace, "index.html"), "<p>page</p>");
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

describe("a bot's private secret files", () => {
  it("never go into a workspace backup, a move to a Cloud or into a team, or Cloud Files", async () => {
    for (const path of [`workspaces/atlas/${SECRET_FOLDER}`, `workspaces/atlas/${SECRET_FOLDER}/thread-1/card-1`,
      `workspaces/atlas--member-ab12/${SECRET_FOLDER}/t/c`, `vm-home/${SECRET_FOLDER}/t/c`, `vm-homes/0123456789abcdef/${SECRET_FOLDER}/t/c`]) {
      expect(excludedWorkspaceAuthPath(path), path).toBe(true);
      expect(omittedFromWorkspaceBackup(path), path).toBe(true);
    }
    expect(excludedWorkspaceAuthPath("workspaces/atlas/notes.txt")).toBe(false);
    const moved = (await listBotFiles(data, ["atlas"])).map((file) => file.path);
    expect(moved).toContain("workspaces/atlas/notes.txt");
    expect(moved.some((path) => path.includes(SECRET_FOLDER))).toBe(false);
    expect(skipped(SECRET_FOLDER, true)).toBe(true);
  });

  it("cannot be opened or listed through a chat link, which attach_file uses too", async () => {
    await expect(openMessageFile(pathToFileURL(secret).href, [workspace])).rejects.toMatchObject({ status: 403, message: SECRET_FILE_REFUSAL });
    await expect(openMessageFile(`${SECRET_FOLDER}/thread-1/card-1`, [workspace])).rejects.toMatchObject({ status: 403 });
    await expect(listMessageFolder(pathToFileURL(join(workspace, SECRET_FOLDER, "thread-1")).href, [workspace])).rejects.toMatchObject({ status: 403 });
    const opened = await openMessageFile(pathToFileURL(join(workspace, "notes.txt")).href, [workspace]);
    await opened.handle.close();
  });

  it("are never published, read by the extract helper, or uploaded to a page", async () => {
    await expect(readPageBundle(secret, [workspace])).rejects.toMatchObject({ status: 403, message: SECRET_FILE_REFUSAL });
    await expect(botFileSource(secret, async () => ({ roots: [workspace], vmWorkspace: null }))).rejects.toMatchObject({ status: 403 });
    expect(uploadableFiles([secret], [workspace])).toEqual({ error: SECRET_FILE_REFUSAL });
    expect(uploadableFiles([join(workspace, "notes.txt")], [workspace])).toMatchObject({ files: [expect.stringContaining("notes.txt")] });
  });
});
