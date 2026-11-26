import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { acpMediaUri, findMediaPaths, readAcpMediaLinks } from "./media-links.ts";

const scratch = mkdtempSync(join(tmpdir(), "omb-media-links-"));
const folder = join(scratch, "a folder");
mkdirSync(folder);
const clip = join(folder, "clip one.mp4");
const photo = join(scratch, "photo.png");
const big = join(scratch, "big.mov");
writeFileSync(clip, Buffer.alloc(300));
writeFileSync(photo, Buffer.alloc(200));
writeFileSync(big, Buffer.alloc(900));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("acpMediaUri", () => {
  it("keeps the drive letter out of the path on Windows and percent-encodes the rest", () => {
    expect(acpMediaUri("D:\\a b\\c.mp4", "win32")).toBe("file:D:/a%20b/c.mp4");
    expect(acpMediaUri("/Users/k/a b.png", "darwin")).toBe("file:///Users/k/a%20b.png");
  });
});

describe("findMediaPaths", () => {
  it("finds existing files named in text, with spaces in the path, quoted or at a sentence end, once each", async () => {
    const text = `Watch ${clip} and summarize.\nAlso "${photo}", https://example.com/x.mp4, ${join(scratch, "missing.mp4")}.\nAgain ${clip}`;
    expect((await findMediaPaths(text)).map((file) => file.path)).toEqual([clip, photo]);
  });

  it("treats two spellings of the same file as one", async () => {
    const other = process.platform === "win32" ? photo.replaceAll("\\", "/") : photo.replace(scratch, `${scratch}/.`);
    expect((await findMediaPaths(`${photo} and ${other}`)).map((file) => file.path)).toEqual([photo]);
  });

  it("reads a handed-on inbox/... path from the turn's own folder, and only when that folder is given", async () => {
    const handed = join(scratch, "inbox", "bot-a", "task one", "handed clip.mp4");
    mkdirSync(dirname(handed), { recursive: true });
    writeFileSync(handed, Buffer.alloc(100));
    const text = `1 file, listed below as copies in your own folder.\n- ${join("inbox", "bot-a", "task one", "handed clip.mp4")} (video/mp4, 1 KB)`;
    expect((await findMediaPaths(text, scratch)).map((file) => file.path)).toEqual([handed]);
    expect(await findMediaPaths(text)).toEqual([]);
    expect(await findMediaPaths(`- not${join("inbox", "bot-a", "task one", "handed clip.mp4")}`, scratch)).toEqual([]);
  });

  it("prefers a named absolute path over an inbox/... file inside it, and never reads outside the inbox", async () => {
    const turn = join(scratch, "turn");
    const absolute = join(scratch, "archive", "a inbox", "bot-b", "clip.mp4");
    const local = join(turn, "inbox", "bot-b", "clip.mp4");
    for (const file of [absolute, local]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.alloc(100));
    }
    expect((await findMediaPaths(`see ${absolute}`, turn)).map((file) => file.path)).toEqual([absolute]);
    writeFileSync(join(scratch, "secret.pdf"), Buffer.alloc(100));
    expect(await findMediaPaths("- inbox/../../secret.pdf", turn)).toEqual([]);
  });

  it("ignores text without media", async () => {
    expect(await findMediaPaths("see notes.md and https://example.com/a.png")).toEqual([]);
  });
});

describe("readAcpMediaLinks", () => {
  it("links files within the budget and names the ones left out", async () => {
    const { blocks, note } = await readAcpMediaLinks(`${clip}\n${big}\n${photo}`, 0, 600);
    expect(blocks).toEqual([
      { type: "resource_link", uri: acpMediaUri(clip), name: "clip one.mp4" },
      { type: "resource_link", uri: acpMediaUri(photo), name: "photo.png" },
    ]);
    expect(note).toContain(`attached these files to this message so you can see and hear them directly; do not open them with a file tool: ${clip} | ${photo}`);
    expect(note).toContain(`Not attached: ${big} (0.0 MB)`);
  });

  it("counts media the prompt already carries against the same budget", async () => {
    const { blocks, note } = await readAcpMediaLinks(`${clip}\n${photo}`, 350, 600);
    expect(blocks).toEqual([{ type: "resource_link", uri: acpMediaUri(photo), name: "photo.png" }]);
    expect(note).toContain(`Not attached: ${clip} (0.0 MB)`);
    expect(note).toContain("images attached to it included");
  });

  it("keeps looking past many files that do not fit for one that does", async () => {
    const many = Array.from({ length: 20 }, (_, index) => {
      const file = join(scratch, `huge ${index}.mp4`);
      writeFileSync(file, Buffer.alloc(900));
      return file;
    });
    const { blocks, note } = await readAcpMediaLinks([...many, photo].join("\n"), 0, 600);
    expect(blocks).toEqual([{ type: "resource_link", uri: acpMediaUri(photo), name: "photo.png" }]);
    expect(note).toContain(many[19]);
  });

  it("adds nothing when the text names no media", async () => {
    expect(await readAcpMediaLinks("no media here")).toEqual({ blocks: [], note: "" });
  });
});
