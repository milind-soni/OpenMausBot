import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { openMessageFile } from "./message-file.ts";
import { DOCUMENT_PREVIEW_MAX_BYTES, readDocumentPreview } from "./document-preview.ts";

const root = mkdtempSync(join(tmpdir(), "omb-documents-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** Read a temporary file through its authorized handle and always close it. */
async function preview(name: string, bytes: string | Buffer) {
  writeFileSync(join(root, name), bytes);
  const file = await openMessageFile(name, [root]);
  try { return await readDocumentPreview(file); } finally { await file.handle.close(); }
}

describe("document preview", () => {
  it("reads Unicode text and Markdown through an authorised handle", async () => {
    expect(await preview("Report with spaces.md", "# Отчёт\n\nПривет"))
      .toMatchObject({ kind: "markdown", text: "# Отчёт\n\nПривет", truncated: false });
    expect(await preview("notes.txt", "Plain text"))
      .toMatchObject({ kind: "text", text: "Plain text", truncated: false });
    expect(await preview("empty.md", "")).toMatchObject({ text: "", bytes: 0 });
  });

  it("bounds a long document and does not corrupt a final multibyte character", async () => {
    const result = await preview("long.md", "a".repeat(DOCUMENT_PREVIEW_MAX_BYTES - 1) + "界end");
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a".repeat(DOCUMENT_PREVIEW_MAX_BYTES - 1));
  });

  it("leaves office, PDF, HTML, binary and non-UTF8 files download-only", async () => {
    for (const name of ["report.pdf", "report.docx", "page.html", "page.svg"]) {
      expect(await preview(name, "<script>untrusted()</script>")).toMatchObject({ kind: "download" });
      expect(await preview(name, "data")).not.toHaveProperty("text");
    }
    expect(await preview("binary.txt", Buffer.from([1, 0, 3]))).toMatchObject({ kind: "download" });
    expect(await preview("legacy.txt", Buffer.from([0xff, 0xfe, 65, 0]))).toMatchObject({ kind: "download" });
  });

  it("keeps a pinned worktree bounded and handles relative paths with spaces", async () => {
    const worktree = join(root, "task worktree");
    const other = join(root, "other task");
    mkdirSync(worktree); mkdirSync(other);
    writeFileSync(join(worktree, "Final report.md"), "# Worktree");
    writeFileSync(join(other, "private.md"), "Private");
    const file = await openMessageFile("Final%20report.md", [worktree]);
    try { expect((await readDocumentPreview(file)).text).toBe("# Worktree"); }
    finally { await file.handle.close(); }
    await expect(openMessageFile("../other%20task/private.md", [worktree])).rejects.toMatchObject({ status: 403 });
    await expect(openMessageFile("missing.md", [worktree])).rejects.toMatchObject({ status: 404 });
  });
});
