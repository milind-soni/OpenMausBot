import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCloudSync, type CloudSync } from "./cloud-sync.ts";

const writes = vi.hoisted(() => ({ limit: Infinity }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    fs.writeSync(fd, buffer, offset, Math.min(length, writes.limit), position) };
});
const scratch: string[] = [];
const opened: CloudSync[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function setup() {
  const home = mkdtempSync(join(tmpdir(), "omb-sync-short-write-"));
  scratch.push(home);
  const sync = createCloudSync({ dataDir: join(home, "data"), statfs: () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 }) });
  opened.push(sync);
  const folder = sync.register({ computerId: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", computerName: "PC", pcPath: "/notes", name: "notes" });
  return { sync, folder };
}
async function* chunks(...texts: string[]) { for (const text of texts) yield Buffer.from(text); }
afterEach(() => {
  writes.limit = Infinity;
  for (const sync of opened.splice(0)) sync.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("writes every byte of each upload chunk when the filesystem stops short", async () => {
  const { sync, folder } = setup();
  const text = "first 世界 last";
  const { uploadId } = sync.beginUpload(folder.id, { path: "a.txt", size: Buffer.byteLength(text), sha256: sha(text), baseSha256: null });
  writes.limit = 2;
  expect(await sync.writePart(uploadId, 0, chunks("first "))).toEqual({ received: 6 });
  expect(await sync.writePart(uploadId, 6, chunks("世界", " last"))).toEqual({ received: Buffer.byteLength(text) });
  expect(await sync.commit(uploadId)).toEqual({ sha256: sha(text) });
  expect(readFileSync(join(folder.cloudPath, "a.txt"), "utf8")).toBe(text);
});

it("does not acknowledge a zero-progress write and allows retrying the same offset", async () => {
  const { sync, folder } = setup();
  const text = "retry me";
  const input = { path: "a.txt", size: text.length, sha256: sha(text), baseSha256: null };
  const { uploadId } = sync.beginUpload(folder.id, input);
  writes.limit = 0;
  await expect(sync.writePart(uploadId, 0, chunks(text))).rejects.toThrow(/upload.*written/i);
  expect(sync.beginUpload(folder.id, input)).toEqual({ uploadId, received: 0 });
  writes.limit = 3;
  expect(await sync.writePart(uploadId, 0, chunks(text))).toEqual({ received: text.length });
  expect(await sync.commit(uploadId)).toEqual({ sha256: sha(text) });
});
