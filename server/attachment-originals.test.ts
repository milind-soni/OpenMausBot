import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dropKeptOriginals, dropOrphanKeptOriginals, KEEP_MAX_BYTES, keepUploadedOriginal, keptOriginal, keptOriginalsBytes, keptOriginalsDir } from "./attachment-originals.ts";

const name = (n: number, ext = "md") => `${n.toString(16).padStart(8, "0")}-1a2b-4c3d-8e4f-0a1b2c3d4e5f.${ext}`;

describe("kept originals", () => {
  let root: string, store: string, kept: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kept-originals-"));
    store = join(root, "data", "attachments");
    kept = keptOriginalsDir(join(root, "data"));
    mkdirSync(store, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps what the person sent as it arrives, through an in-place write and a rename over it", async () => {
    const upload = join(store, name(1));
    writeFileSync(upload, "as sent");
    await keepUploadedOriginal(upload, kept);
    expect(keptOriginal(upload, store, kept)).toBe(join(kept, name(1)));

    writeFileSync(upload, "edited in place");
    expect(readFileSync(keptOriginal(upload, store, kept)!, "utf8")).toBe("as sent");
    writeFileSync(`${upload}.tmp`, "saved by rename");
    renameSync(`${upload}.tmp`, upload);
    expect(readFileSync(keptOriginal(upload, store, kept)!, "utf8")).toBe("as sent");

    // Sending the same upload again never replaces the kept copy with an edit.
    await keepUploadedOriginal(upload, kept);
    expect(readFileSync(join(kept, name(1)), "utf8")).toBe("as sent");
  });

  it("keeps only documents from the store, within the size limit", async () => {
    const video = join(store, name(2, "mp4")), big = join(store, name(3, "txt"));
    writeFileSync(video, "video");
    writeFileSync(big, Buffer.alloc(KEEP_MAX_BYTES + 1));
    await keepUploadedOriginal(video, kept);
    await keepUploadedOriginal(big, kept);
    await keepUploadedOriginal(join(root, "someone's own.md"), kept);
    expect(existsSync(kept) ? readdirSync(kept) : []).toEqual([]);
    expect(keptOriginal(join(root, name(1)), store, kept)).toBeNull();
  });

  it("makes room by dropping the oldest copies when the folder is full, never by keeping nothing", async () => {
    mkdirSync(kept, { recursive: true });
    const old = join(kept, name(4)), newer = join(kept, name(5));
    writeFileSync(old, Buffer.alloc(50));
    writeFileSync(newer, Buffer.alloc(40));
    utimesSync(old, new Date(1_000_000), new Date(1_000_000));
    const upload = join(store, name(6));
    writeFileSync(upload, "the newest upload");
    await keepUploadedOriginal(upload, kept, 100);
    expect(readdirSync(kept).sort()).toEqual([name(5), name(6)].sort());
  });

  it("is counted in the storage figure and goes with its upload, or at a clear once its upload is gone", async () => {
    const upload = join(store, name(7)), orphan = join(store, name(8));
    writeFileSync(upload, "as sent");
    writeFileSync(orphan, "removed outside the app");
    await keepUploadedOriginal(upload, kept);
    await keepUploadedOriginal(orphan, kept);
    expect(keptOriginalsBytes(kept)).toBe("as sent".length + "removed outside the app".length);
    rmSync(orphan);
    expect(dropOrphanKeptOriginals(store, kept)).toBe(1);
    dropKeptOriginals([name(7), "../escape.md"], kept);
    expect(keptOriginal(upload, store, kept)).toBeNull();
    expect(keptOriginalsBytes(kept)).toBe(0);
  });

  it("keeps concurrent uploads within the shared folder's total limit", async () => {
    const uploads = Array.from({ length: 20 }, (_, index) => join(store, name(index + 20)));
    for (const [index, upload] of uploads.entries()) writeFileSync(upload, Buffer.alloc(32, index));
    await Promise.all(uploads.map((upload, index) => keepUploadedOriginal(upload, index % 2 ? `${kept}/.` : kept, 128)));
    expect(keptOriginalsBytes(kept)).toBe(128);
    expect(readdirSync(kept)).toHaveLength(4);
    expect(keptOriginal(uploads.at(-1)!, store, kept)).toBe(join(kept, name(39)));
    for (const copy of readdirSync(kept)) expect(readFileSync(join(kept, copy))).toEqual(readFileSync(join(store, copy)));
  });

  it("lets queued uploads keep their originals after a copy fails", async () => {
    mkdirSync(kept, { recursive: true });
    const first = join(store, name(40)), second = join(store, name(41));
    writeFileSync(first, "first upload");
    writeFileSync(second, "second upload");
    const partial = `${join(kept, name(40))}.${process.pid}.partial`;
    writeFileSync(partial, "unfinished copy");
    await Promise.all([keepUploadedOriginal(first, kept), keepUploadedOriginal(second, kept)]);
    expect(existsSync(partial)).toBe(false);
    expect(keptOriginal(first, store, kept)).toBeNull();
    expect(readFileSync(keptOriginal(second, store, kept)!, "utf8")).toBe("second upload");
  });

  it("never fails the upload when the copy cannot be made", async () => {
    writeFileSync(join(root, "not-a-folder"), "");
    await expect(keepUploadedOriginal(join(store, name(9)), join(root, "not-a-folder", "kept"))).resolves.toBeUndefined();
  });
});
