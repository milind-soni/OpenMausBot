import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentsForBox, BOX_ATTACHMENTS_FOLDER } from "./box-attachments.ts";

describe("attachmentsForBox", () => {
  let root: string, uploads: string, cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "box-attachments-"));
    uploads = join(root, "data", "attachments");
    cwd = join(root, "data", "task-workspaces", "bot", "thread");
    mkdirSync(uploads, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies each upload into the working folder and points the engine at the copy", () => {
    const upload = join(uploads, "1f0c2a.md");
    writeFileSync(upload, "# notes\n");
    writeFileSync(join(uploads, "9b7e.png"), "png");
    const text = `Read this\n<attached-file path="${upload}" name="notes.md" />\n<attached-image path="${join(uploads, "9b7e.png")}" name="shot.png" />`;

    const out = attachmentsForBox(text, cwd, true, uploads);

    const staged = join(cwd, BOX_ATTACHMENTS_FOLDER, "1f0c2a.md");
    expect(out).toBe(`Read this\n<attached-file path="${staged}" name="notes.md" />\n<attached-image path="${join(cwd, BOX_ATTACHMENTS_FOLDER, "9b7e.png")}" name="shot.png" />`);
    expect(readFileSync(staged, "utf8")).toBe("# notes\n");
    // A copy, not a link: editing it leaves the upload alone, and a later turn keeps the edited copy.
    writeFileSync(staged, "changed");
    expect(readFileSync(upload, "utf8")).toBe("# notes\n");
    expect(attachmentsForBox(text, cwd, true, uploads)).toBe(out);
    expect(readFileSync(staged, "utf8")).toBe("changed");
  });

  it("changes nothing with the box off or without a working folder", () => {
    const upload = join(uploads, "a.md");
    writeFileSync(upload, "x");
    const text = `<attached-file path="${upload}" name="a.md" />`;
    expect(attachmentsForBox(text, cwd, false, uploads)).toBe(text);
    expect(attachmentsForBox(text, undefined, true, uploads)).toBe(text);
  });

  it("leaves paths outside the uploads folder, odd names and missing files as they are", () => {
    writeFileSync(join(root, "elsewhere.md"), "x");
    writeFileSync(join(root, "data", "secret.md"), "x");
    const text = [
      `<attached-file path="${join(root, "elsewhere.md")}" name="e.md" />`,
      `<attached-file path="${uploads}/../secret.md" name="s.md" />`,
      `<attached-file path="${join(uploads, "missing.md")}" name="m.md" />`,
      `<attached-file path="${join(uploads, ".openmaus-upload-x.partial")}" name="p" />`,
    ].join("\n");
    expect(attachmentsForBox(text, cwd, true, uploads)).toBe(text);
  });
});
