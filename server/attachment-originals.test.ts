import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetKeptOriginalsForTests, dropKeptOriginals, KEEP_MAX_BYTES, keepAttachedOriginals, keptOriginal, keptOriginalsDir } from "./attachment-originals.ts";
import { attachmentsForBox } from "./box-attachments.ts";

const NAME = "6f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.md";
const tag = (path: string) => `Edit this\n<attached-file path="${path}" name="chapter.md" />`;

describe("kept originals", () => {
  let root: string, dataDir: string, store: string, kept: string;
  beforeEach(() => {
    __resetKeptOriginalsForTests();
    root = mkdtempSync(join(tmpdir(), "kept-originals-"));
    dataDir = join(root, "data");
    store = join(dataDir, "attachments");
    kept = keptOriginalsDir(dataDir);
    mkdirSync(store, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps what the person sent when an unboxed turn names it, through an in-place write and a rename over it", () => {
    const upload = join(store, NAME);
    writeFileSync(upload, "as sent");
    const text = tag(upload);
    expect(attachmentsForBox(text, join(dataDir, "task-workspaces", "bot", "thread"), false, dataDir, store)).toBe(text);
    expect(keptOriginal(upload, store, kept)).toBe(join(kept, NAME));

    writeFileSync(upload, "edited in place");
    expect(readFileSync(keptOriginal(upload, store, kept)!, "utf8")).toBe("as sent");
    writeFileSync(`${upload}.tmp`, "saved by rename");
    renameSync(`${upload}.tmp`, upload);
    expect(readFileSync(keptOriginal(upload, store, kept)!, "utf8")).toBe("as sent");

    // A later turn naming the same upload never replaces the kept copy with the edit.
    keepAttachedOriginals(text, store, kept);
    expect(readFileSync(join(kept, NAME), "utf8")).toBe("as sent");
  });

  it("keeps nothing when the box shows the upload read-only, and keeps it when the box leaves the store's path", () => {
    const upload = join(store, NAME);
    writeFileSync(upload, "as sent");
    attachmentsForBox(tag(upload), join(dataDir, "task-workspaces", "bot", "thread"), true, dataDir, store);
    expect(existsSync(join(kept, NAME))).toBe(false);
    expect(attachmentsForBox(tag(upload), join(root, "own-project"), true, dataDir, store)).toBe(tag(upload));
    expect(readFileSync(join(kept, NAME), "utf8")).toBe("as sent");
  });

  it("keeps only documents from the store, within the size limit", () => {
    const image = join(store, "6f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.mp4");
    const outside = join(root, NAME);
    const big = join(store, "7f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.txt");
    writeFileSync(image, "video");
    writeFileSync(outside, "someone's own file");
    writeFileSync(big, Buffer.alloc(KEEP_MAX_BYTES + 1));
    keepAttachedOriginals([tag(image), tag(outside), tag(big)].join("\n"), store, kept);
    expect(existsSync(kept) ? readdirSync(kept) : []).toEqual([]);
  });

  it("goes when its upload is removed, and never names a file outside the folder", () => {
    const upload = join(store, NAME);
    writeFileSync(upload, "as sent");
    keepAttachedOriginals(tag(upload), store, kept);
    dropKeptOriginals([NAME, "../escape.md"], kept);
    expect(keptOriginal(upload, store, kept)).toBeNull();
  });

  it("never stops the turn when the copy cannot be made", () => {
    const upload = join(store, NAME);
    writeFileSync(upload, "as sent");
    mkdirSync(kept, { recursive: true });
    chmodSync(kept, 0o500);
    try {
      expect(() => keepAttachedOriginals(tag(upload), store, kept)).not.toThrow();
    } finally {
      chmodSync(kept, 0o700);
    }
  });
});
