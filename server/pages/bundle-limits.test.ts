import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { readPageBundle } from "./bundle.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, open: vi.fn(real.open) };
});

const scratch: string[] = [];
function folder() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "omb-page-limits-")));
  scratch.push(path);
  return path;
}
function beforeOpen(change: () => void) {
  const opener = vi.mocked(open), actual = opener.getMockImplementation()!;
  opener.mockImplementationOnce((async (...args: Parameters<typeof actual>) => {
    change();
    return actual(...args);
  }) as typeof actual);
}
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("refuses a single page that grows after its size check", async () => {
  const root = folder(), file = join(root, "index.html");
  writeFileSync(file, "small");
  beforeOpen(() => writeFileSync(file, "x".repeat(128 * 1024)));
  await expect(readPageBundle(file, [root], { bytes: 16, files: 1 })).rejects.toMatchObject({ status: 413 });
});

it("checks growing folder files against the remaining byte budget", async () => {
  const root = folder(), file = join(root, "a.css");
  writeFileSync(file, "a");
  writeFileSync(join(root, "index.html"), "index");
  beforeOpen(() => writeFileSync(file, "a".repeat(12)));
  await expect(readPageBundle(root, [root], { bytes: 16, files: 2 })).rejects.toMatchObject({ status: 413 });
});

it("reports the bytes actually read when a folder file shrinks", async () => {
  const root = folder(), file = join(root, "a.css");
  writeFileSync(file, "a".repeat(12));
  writeFileSync(join(root, "index.html"), "index");
  beforeOpen(() => writeFileSync(file, "a"));
  const bundle = await readPageBundle(root, [root], { bytes: 32, files: 2 });
  expect(bundle.bytes).toBe(6);
  expect(bundle.bytes).toBe(bundle.files.reduce((sum, entry) => sum + entry.data.byteLength, 0));
});

it.each(["a.mp4", "z.mp4"])("counts videos and ordinary files together regardless of order (%s)", async (video) => {
  const root = folder();
  writeFileSync(join(root, video), "video");
  writeFileSync(join(root, "index.html"), "index");
  await expect(readPageBundle(root, [root], { bytes: 16, files: 1 }, { videos: true })).rejects.toMatchObject({ status: 413 });
});

it("accepts exactly the byte and file limits, with video bytes kept on disk", async () => {
  const root = folder();
  writeFileSync(join(root, "a.mp4"), "a".repeat(100));
  writeFileSync(join(root, "index.html"), "index");
  const bundle = await readPageBundle(root, [root], { bytes: 5, files: 2 }, { videos: true });
  expect(bundle.bytes).toBe(5);
  expect(bundle.files[0]!.data.toString()).toBe("index");
  expect(bundle.videos?.["a.mp4"]?.bytes).toBe(100);
});

it("accepts an empty HTML file with a zero-byte budget", async () => {
  const root = folder(), file = join(root, "index.html");
  writeFileSync(file, "");
  expect((await readPageBundle(file, [root], { bytes: 0, files: 1 })).bytes).toBe(0);
});
