import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePreviewFile, writePreviewTextFile } from "./previewFiles.ts";

const dirs: string[] = [];
function project() {
  const dir = mkdtempSync(join(tmpdir(), "gbs-preview-write-"));
  dirs.push(dir);
  return { dir, projects: [{ id: "p", name: "P", path: dir }] };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("writePreviewTextFile", () => {
  it("saves Markdown and text files and reports the new mtime", () => {
    const { dir, projects } = project();
    writeFileSync(join(dir, "notes.md"), "# Old");
    writeFileSync(join(dir, "todo.txt"), "a");
    const md = resolvePreviewFile(projects, "p", "notes.md");
    expect(writePreviewTextFile(md, "# New", md.mtimeMs)).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("# New");
    const txt = resolvePreviewFile(projects, "p", "todo.txt");
    expect(txt.kind).toBe("text");
    writePreviewTextFile(txt, "b", null);
    expect(readFileSync(join(dir, "todo.txt"), "utf8")).toBe("b");
  });
  it("refuses a save when the file changed on disk since it was loaded", () => {
    const { dir, projects } = project();
    writeFileSync(join(dir, "notes.md"), "v1");
    const loaded = resolvePreviewFile(projects, "p", "notes.md");
    writeFileSync(join(dir, "notes.md"), "agent edit");
    utimesSync(join(dir, "notes.md"), new Date(), new Date(Date.now() + 5000));
    expect(() => writePreviewTextFile(loaded, "mine", loaded.mtimeMs)).toThrow(expect.objectContaining({ status: 409 }));
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("agent edit");
  });
  it("never writes HTML, images or files outside the project", () => {
    const { dir, projects } = project();
    writeFileSync(join(dir, "index.html"), "<p>x</p>");
    const html = resolvePreviewFile(projects, "p", "index.html");
    expect(() => writePreviewTextFile(html, "<script>", null)).toThrow(expect.objectContaining({ status: 415 }));
    expect(() => resolvePreviewFile(projects, "p", "../escape.md")).toThrow(expect.objectContaining({ status: 403 }));
  });
});

import { mkdirSync, symlinkSync } from "node:fs";
import { resolveChatFileReference } from "./previewFiles.ts";

describe("resolveChatFileReference", () => {
  it("maps absolute, file://, ~ and relative paths into a registered project", () => {
    const { dir, projects } = project();
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "plan.md"), "# Plan");
    for (const ref of [join(dir, "docs/plan.md"), `file://${join(dir, "docs/plan.md")}`, "docs/plan.md", "./docs/plan.md"]) {
      const hit = resolveChatFileReference(projects, ref, "/nowhere");
      expect([hit.project.id, hit.relativePath, hit.kind]).toEqual(["p", "docs/plan.md", "markdown"]);
    }
    expect(resolveChatFileReference(projects, "~/docs/plan.md", dir).relativePath).toBe("docs/plan.md");
  });
  it("refuses paths outside projects, escapes and unsupported files", () => {
    const { dir, projects } = project();
    const outside = mkdtempSync(join(tmpdir(), "gbs-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "x");
    symlinkSync(join(outside, "secret.md"), join(dir, "link.md"));
    writeFileSync(join(dir, "key.pem"), "x");
    expect(() => resolveChatFileReference(projects, join(outside, "secret.md"), "/")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => resolveChatFileReference(projects, join(dir, "link.md"), "/")).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => resolveChatFileReference(projects, "../secret.md", "/")).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => resolveChatFileReference(projects, join(dir, "key.pem"), "/")).toThrow(expect.objectContaining({ status: 415 }));
  });
});
