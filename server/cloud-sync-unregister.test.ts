import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createCloudSync, type CloudSync } from "./cloud-sync.ts";

const scratch: string[] = [];
const opened: CloudSync[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), "omb-sync-unregister-"));
  scratch.push(home);
  const dataDir = join(home, "data");
  const sync = createCloudSync({ dataDir });
  opened.push(sync);
  const folder = sync.register({ computerId: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", computerName: "PC", pcPath: "/notes", name: "Notes" });
  writeFileSync(join(folder.cloudPath, "a.txt"), "first");
  writeFileSync(join(folder.cloudPath, "b.txt"), "second");
  return { sync, folder, dataDir };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const sync of opened.splice(0)) sync.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each([1, 2])("keeps the registration retryable if trashing file %s fails", async (failAt) => {
  const { sync, folder } = setup();
  await sync.files(folder.id);
  const original = sync.store.toTrash.bind(sync.store);
  const failure = Object.assign(new Error("temporary trash failure"), { code: "EIO" });
  let calls = 0;
  const trash = vi.spyOn(sync.store, "toTrash").mockImplementation((...args) => {
    if (++calls === failAt) throw failure;
    return original(...args);
  });

  await expect(sync.unregister(folder.id, false)).rejects.toBe(failure);
  expect(sync.store.pcFolders()).toEqual([folder]);
  expect((await sync.files(folder.id))).toHaveLength(3 - failAt);
  expect(sync.trash().entries).toHaveLength(failAt - 1);

  trash.mockRestore();
  await sync.unregister(folder.id, false);
  expect(sync.store.pcFolders()).toEqual([]);
  expect(existsSync(folder.cloudPath)).toBe(false);
  expect(sync.trash().entries.map(entry => entry.path).sort()).toEqual(["a.txt", "b.txt"]);
});

it("can unlink a folder while keeping its Cloud copy without touching trash", async () => {
  const { sync, folder } = setup();
  const trash = vi.spyOn(sync.store, "toTrash");
  await sync.unregister(folder.id, true);
  expect(sync.store.pcFolders()).toEqual([]);
  expect(readFileSync(join(folder.cloudPath, "a.txt"), "utf8")).toBe("first");
  expect(trash).not.toHaveBeenCalled();
});

it("does not unregister or trash an automatically discovered bot folder", async () => {
  const { sync, dataDir } = setup();
  const botFolder = join(dataDir, "task-workspaces", "owl", "t1");
  mkdirSync(botFolder, { recursive: true });
  writeFileSync(join(botFolder, "report.txt"), "keep");
  await expect(sync.unregister("bot-owl-t1", false)).rejects.toMatchObject({ status: 404 });
  expect(readFileSync(join(botFolder, "report.txt"), "utf8")).toBe("keep");
});
