import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { namedUploadPaths, uploadableFiles } from "./browser-upload.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

function folders() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-upload-")));
  dirs.push(base);
  const attachments = join(base, "attachments"), workspace = join(base, "workspace"), outside = join(base, "outside");
  for (const dir of [attachments, workspace, outside]) mkdirSync(dir);
  writeFileSync(join(attachments, "cv.pdf"), "%PDF");
  writeFileSync(join(workspace, "report.csv"), "a,b");
  writeFileSync(join(outside, "secret.txt"), "no");
  return { base, attachments, workspace, outside, roots: [attachments, workspace] };
}

describe("files a page may receive", () => {
  it("takes the person's attachments and the bot's own folders", () => {
    const { attachments, workspace, roots } = folders();
    expect(uploadableFiles([join(attachments, "cv.pdf"), join(workspace, "report.csv")], roots))
      .toEqual({ files: [join(attachments, "cv.pdf"), join(workspace, "report.csv")] });
  });

  it("refuses any other file, including one reached through a symlink or a ..", () => {
    const { attachments, outside, roots } = folders();
    symlinkSync(join(outside, "secret.txt"), join(attachments, "looks-attached.txt"));
    for (const file of [join(outside, "secret.txt"), join(attachments, "looks-attached.txt"), join(attachments, "..", "outside", "secret.txt"), process.execPath]) {
      expect(uploadableFiles([file], roots)).toEqual({ error: expect.stringMatching(/cannot be uploaded/) });
    }
  });

  it("refuses relative, missing and folder paths, and more than ten files", () => {
    const { attachments, roots } = folders();
    expect(uploadableFiles(["cv.pdf"], roots)).toEqual({ error: expect.stringMatching(/not an absolute path/) });
    expect(uploadableFiles([join(attachments, "gone.pdf")], roots)).toEqual({ error: expect.stringMatching(/does not exist/) });
    mkdirSync(join(attachments, "folder"));
    expect(uploadableFiles([join(attachments, "folder")], roots)).toEqual({ error: expect.stringMatching(/not a file/) });
    expect(uploadableFiles(Array(11).fill(join(attachments, "cv.pdf")), roots)).toEqual({ error: expect.stringMatching(/1 to 10/) });
    expect(uploadableFiles([], roots)).toEqual({ error: expect.stringMatching(/1 to 10/) });
    expect(uploadableFiles("cv.pdf", roots)).toEqual({ error: expect.stringMatching(/1 to 10/) });
  });
});

describe("the name a page sees", () => {
  it("gives an attachment the person's own name, and leaves every other file as it is", async () => {
    const { base, attachments, workspace } = folders();
    const stored = join(attachments, "cv.pdf"), report = join(workspace, "report.csv");
    const [named, same, unnamed, unsafe] = await namedUploadPaths([
      { file: stored, name: "Jane Doe CV.pdf" }, { file: report, name: "report.csv" }, { file: report, name: null }, { file: stored, name: "../escape.pdf" },
    ], join(base, "uploads"));
    expect(basename(named!)).toBe("Jane Doe CV.pdf");
    expect(dirname(dirname(named!))).toBe(join(base, "uploads"));
    expect(readFileSync(named!, "utf8")).toBe("%PDF");
    expect([same, unnamed, unsafe]).toEqual([report, report, stored]);
  });

  it("removes named copies a day old", async () => {
    const { base, attachments } = folders();
    const folder = join(base, "uploads");
    const [old] = await namedUploadPaths([{ file: join(attachments, "cv.pdf"), name: "old.pdf" }], folder);
    const day = 24 * 60 * 60 * 1000;
    utimesSync(dirname(old!), new Date(Date.now() - day - 1000), new Date(Date.now() - day - 1000));
    const [fresh] = await namedUploadPaths([{ file: join(attachments, "cv.pdf"), name: "new.pdf" }], folder);
    expect(existsSync(old!)).toBe(false);
    expect(existsSync(fresh!)).toBe(true);
  });

  it.each([0, 3, 1024 * 1024 + 7])("keeps %i copied bytes independent of later writes to the source", async (size) => {
    const { base, workspace } = folders();
    const file = join(workspace, "report.csv");
    writeFileSync(file, Buffer.alloc(size, 0x61));
    const [staged] = await namedUploadPaths([{ file, name: "Report.csv" }], join(base, "uploads"));
    writeFileSync(file, "changed");
    expect(readFileSync(staged!).equals(Buffer.alloc(size, 0x61))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a file replaced by a symlink after the allowlist check", async () => {
    const { base, workspace, outside, roots } = folders();
    const file = join(workspace, "report.csv");
    const checked = uploadableFiles([file], roots);
    expect(checked).toEqual({ files: [file] });
    if ("error" in checked) throw new Error(checked.error);
    rmSync(file);
    symlinkSync(join(outside, "secret.txt"), file);
    await expect(namedUploadPaths(checked.files.map((file) => ({ file, name: null })), join(base, "uploads"), Date.now(), { everyFile: true })).rejects.toThrow();
  });
});

describe("the files a boxed browser is given", () => {
  it("copies every file into the one folder the box shows Chrome, under the person's name or its own", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-boxed-upload-")));
    const source = join(root, "work", "report.txt"), stored = join(root, "attachments", "a1b2.pdf");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(stored), { recursive: true });
    writeFileSync(source, "report");
    writeFileSync(stored, "pdf");
    const folder = join(root, "profile", "omb-uploads");
    const linked = await namedUploadPaths([{ file: source, name: null }, { file: stored, name: "Invoice.pdf" }], folder, Date.now(), { everyFile: true });
    expect(linked.every((path) => path.startsWith(folder + sep))).toBe(true);
    expect(linked.map((path) => basename(path))).toEqual(["report.txt", "Invoice.pdf"]);
    expect(readFileSync(linked[0]!, "utf8")).toBe("report");
    // Unboxed, a file already under its own name is given as it is.
    expect(await namedUploadPaths([{ file: source, name: null }], folder)).toEqual([source]);
    rmSync(root, { recursive: true, force: true });
  });
});
