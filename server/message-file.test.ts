import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  MESSAGE_FILE_DOWNLOAD_MAX_BYTES,
  MESSAGE_FILE_MAX_BYTES,
  messageFileDisposition,
  messageFileDownloadName,
  messageAttachmentName,
  messageFileRoots,
  messageImageTargetAt,
  messageReferencesFile,
  listMessageFolder,
  messageFolderEntryName,
  mimeFor,
  openMessageFile,
  openMessageFolderEntry,
} from "./message-file.ts";

const referencesAttachment = (text: string, requested: string) => messageAttachmentName(text, requested) !== null;
const suite = mkdtempSync(join(tmpdir(), "omb-message-file-"));
const workspace = join(suite, "workspace");
const outside = join(suite, "outside");

beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => rmSync(suite, { recursive: true, force: true }));

describe("message-linked files", () => {
  it.skipIf(process.platform === "win32")("rejects a named pipe without waiting for a writer", async () => {
    const fifo = join(workspace, "waiting-pipe");
    execFileSync("mkfifo", [fifo]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const opened = openMessageFile(fifo, [workspace]).then(
      async (file) => { await file.handle.close(); return null; },
      (error: unknown) => error,
    );
    const result = await Promise.race([
      opened,
      new Promise<"blocked">((resolve) => { timer = setTimeout(() => resolve("blocked"), 1_000); }),
    ]);
    try {
      expect(result).toMatchObject({ status: 400, message: "the link does not point to a regular file" });
    } finally {
      clearTimeout(timer);
      if (result === "blocked") closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      await opened;
    }
  });

  it("resolves a Markdown image from an opaque source offset", () => {
    const markdown = [
      "See this:",
      "",
      "![Direct](./direct.png)",
      "",
      "![Referenced][preview]",
      "",
      "[preview]: ./referenced.png",
    ].join("\n");

    expect(messageImageTargetAt(markdown, markdown.indexOf("![Direct]"))).toBe("./direct.png");
    expect(messageImageTargetAt(markdown, markdown.indexOf("![Referenced]"))).toBe("./referenced.png");
    expect(messageImageTargetAt(markdown, 1)).toBeNull();
    expect(messageImageTargetAt(markdown, -1)).toBeNull();
  });

  it("never widens an explicitly null pinned cwd to the configured folder", () => {
    expect(messageFileRoots({
      senderWorkspace: "/app/workspace",
      attachments: "/app/attachments",
      pinnedCwd: null,
      configuredCwd: "/later/project",
    })).toEqual(["/app/workspace", "/app/attachments"]);
    expect(messageFileRoots({
      senderWorkspace: "/app/workspace",
      attachments: "/app/attachments",
      pinnedCwd: undefined,
      configuredCwd: "/current/project",
    })[0]).toBe("/current/project");
  });

  it("matches Unix, Windows, and UNC links independently of the server OS", () => {
    expect(messageReferencesFile(
      "[Open the notes](file:///Users/milind/Project/release%20notes.md)",
      "/Users/milind/Project/release notes.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "I created /Users/milind/Project/release notes.md for you.",
      "/Users/milind/Project/release notes.md",
    ))
      .toBe(false);
    expect(messageReferencesFile(
      "[Open it](C:\\Users\\Maus\\report.md)",
      "C:\\Users\\Maus\\report.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[Open it](file:///C:/Users/Maus/release%20notes.md)",
      "C:\\Users\\Maus\\release notes.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[Open it](file://server/share/phone%20report.md)",
      "\\\\server\\share\\phone report.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[This is a website](//server/share/phone%20report.md)",
      "\\\\server\\share\\phone report.md",
    )).toBe(false);
    expect(messageReferencesFile(
      "[Open A&amp;B](docs/A&amp;B.md \"download\")",
      "docs/A&B.md",
    )).toBe(true);
    expect(messageReferencesFile("<file:///Users/milind/report.md>", "/Users/milind/report.md"))
      .toBe(true);

    expect(messageReferencesFile(
      "[Open it](C:/Users/Maus/drafts/../report.md)",
      "C:\\Users\\Maus\\report.md",
    )).toBe(true);
    expect(messageReferencesFile("[Open it](/C:/Users/Maus/report.md)", "C:/Users/Maus/report.md"))
      .toBe(false);
    expect(messageReferencesFile("[Open it](C:/Users/Maus/report.md)", "c:/users/maus/report.md"))
      .toBe(false);
  });

  it("normalizes encoded Windows and UNC targets before authorization", () => {
    expect(messageReferencesFile(
      "[Open it](C:/Users/Maus/release%20notes.md?download=1#latest)",
      "C:\\Users\\Maus\\release notes.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[Web link](//server/share/team%20notes.md?download=1#latest)",
      "\\\\server\\share\\team notes.md",
    )).toBe(false);
    expect(messageReferencesFile(
      "[Open it](%5C%5Cserver%5Cshare%5Cteam%20notes.md?download=1)",
      "//server/share/team notes.md",
    )).toBe(true);

    expect(messageReferencesFile(
      "[Open it](C:/Users/Maus/release%2520notes.md?download=1)",
      "C:\\Users\\Maus\\release notes.md",
    )).toBe(false);
  });

  it("keeps a Windows path's backslash before punctuation, as in \\.openmausbot", () => {
    const report = "C:\\Users\\Maus\\.openmausbot\\workspaces\\bot\\_drafts\\report.md";
    const chart = "C:\\Users\\Maus\\.openmausbot\\workspaces\\bot\\chart.png";
    const notes = "C:\\Users\\Maus\\.openmausbot\\release notes.md";
    const markdown = `[Report](${report})\n\n![Chart](${chart})\n\n[Notes][notes]\n\n[notes]: <${notes}>`;

    expect(messageReferencesFile(markdown, report)).toBe(true);
    expect(messageReferencesFile(markdown, notes)).toBe(true);
    expect(messageImageTargetAt(markdown, markdown.indexOf("![Chart]"))).toBe(chart);
    expect(messageReferencesFile(markdown, "C:\\Users\\Maus.openmausbot\\workspaces\\bot_drafts\\report.md")).toBe(false);
  });

  it("resolves only definitions used by rendered reference links", () => {
    expect(messageReferencesFile(
      "[Open the report][Download]\n\n[download]: /Users/milind/report.md",
      "/Users/milind/report.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[unused]: /project/.env",
      "/project/.env",
    )).toBe(false);
  });

  it("does not grant file paths from Markdown that is not a rendered link", () => {
    const path = "/project/.env";
    for (const markdown of [
      "```markdown\n[x](/project/.env)\n```",
      "~~~\n[x](/project/.env)\n~~~",
      "    [x](/project/.env)",
      "\t[x](/project/.env)",
      "> ```\n> [x](/project/.env)\n> ```",
      "- ```markdown\n  [x](/project/.env)\n  ```",
      "`[x](/project/.env)`",
      "``look at `[x](/project/.env)` here``",
      "\\[x](/project/.env)",
      "<!-- [x](/project/.env) -->",
      "<attached-file path=\"/project/.env\" />",
      "I saved it at /project/.env.",
    ]) {
      expect(messageReferencesFile(markdown, path), markdown).toBe(false);
    }

    expect(messageReferencesFile(
      "`[sample](/project/.env)` but [open the real file](/project/.env)",
      path,
    )).toBe(true);
    expect(messageReferencesFile("\\![open](/project/.env)", path)).toBe(true);
    expect(messageReferencesFile("![preview](/project/.env)", path)).toBe(true);
    expect(messageReferencesFile("![preview][secret]\n\n[secret]: /project/.env", path)).toBe(true);
    expect(messageReferencesFile(
      "[not a valid destination](/project/foo\\ bar.md)",
      "/project/foo\\ bar.md",
    )).toBe(false);
  });

  it("matches only exact standalone attachment tags", () => {
    const path = "/app/attachments/report & notes.pdf";
    expect(referencesAttachment(
      '<attached-file path="/app/attachments/report &amp; notes.pdf" />',
      path,
    )).toBe(true);
    expect(referencesAttachment(
      'A note\n<attached-image path="/app/attachments/report &amp; notes.pdf" name="report.pdf" />\n',
      path,
    )).toBe(true);
    expect(referencesAttachment(`<attached-file path="${path}" />`, "/app/attachments/other.pdf"))
      .toBe(false);

    for (const text of [
      `Use <attached-file path="${path}" /> as an example`,
      `<attached-file path="${path}" /> as an example`,
      `\`<attached-file path="${path}" />\``,
      `\`\`\`\n<attached-file path="${path}" />\n\`\`\``,
      `    <attached-file path="${path}" />`,
      `> <attached-file path="${path}" />`,
      `<!-- example\n<attached-file path="${path}" />\n-->`,
      `<pre>\n<attached-file path="${path}" />\n</pre>`,
      `<div>\n<attached-file path="${path}" />\n</div>`,
      `<pasted-text>\n<attached-file path="${path}" />\n</pasted-text>`,
      `<attached-file name="report.pdf" path="${path}" />`,
      `<attached-file path="${path}" extra="yes" />`,
      `<attached-file path="${path}">`,
    ]) {
      expect(referencesAttachment(text, path), text).toBe(false);
    }
  });

  it("preserves the sanitized attachment display name", () => {
    const path = "/app/attachments/4e8d.pdf";
    expect(messageAttachmentName(
      `<attached-file path="${path}" name="Quarterly &amp; review.pdf" />`,
      path,
    )).toBe("Quarterly & review.pdf");
    expect(messageAttachmentName(`<attached-file path="${path}" name="../renamed.pdf" />`, path))
      .toBe("renamed.pdf");
    expect(messageAttachmentName("not an attachment", path)).toBeNull();
    expect(messageAttachmentName(`<attached-file path="${path}" />`, "\0")).toBeNull();
    const hostile = `folder\\sub/${"a".repeat(220)}\u202E\ud800.pdf`;
    const safe = messageAttachmentName(`<attached-file path="${path}" name="${hostile}" />`, path);
    expect(Buffer.byteLength(safe ?? "")).toBeLessThanOrEqual(180);
    expect(safe).not.toContain("/");
    expect(safe).not.toContain("\\");
    expect(() => messageFileDisposition(hostile)).not.toThrow();
  });

  it("bounds Unicode display names by UTF-8 bytes while preserving the extension", () => {
    const path = "/app/attachments/4e8d.pdf";
    const safe = messageAttachmentName(
      `<attached-file path="${path}" name="${"📄".repeat(100)}.pdf" />`,
      path,
    );

    expect(safe).toMatch(/\.pdf$/);
    expect(Buffer.byteLength(safe ?? "")).toBeLessThanOrEqual(180);
    expect(() => messageFileDisposition(safe ?? "")).not.toThrow();
  });

  it("opens encoded relative and file URL links through a stable handle", async () => {
    const path = join(workspace, "release notes.md");
    writeFileSync(path, "# unchanged bytes\n");

    const relative = await openMessageFile("release%20notes.md#today", [workspace]);
    expect(relative).toMatchObject({
      bytes: 18,
      name: "release notes.md",
      mime: "text/markdown; charset=utf-8",
    });
    expect(await relative.handle.readFile("utf8")).toBe("# unchanged bytes\n");
    await relative.handle.close();

    const absolute = await openMessageFile(pathToFileURL(path).href, [workspace]);
    expect(await absolute.handle.readFile("utf8")).toBe("# unchanged bytes\n");
    await absolute.handle.close();
  });

  it("normalizes an encoded Windows path before opening it", async () => {
    const path = process.platform === "win32"
      ? join(workspace, "release notes.md")
      : join(workspace, "C:\\Users\\Maus\\release notes.md");
    const href = process.platform === "win32"
      ? `${path.replace("release notes.md", "release%20notes.md")}?download=1#latest`
      : "C:\\Users\\Maus\\release%20notes.md?download=1#latest";
    writeFileSync(path, "windows path bytes");

    const opened = await openMessageFile(href, [workspace]);
    expect(await opened.handle.readFile("utf8")).toBe("windows path bytes");
    await opened.handle.close();
  });

  it("accepts an authored file URL without double-decoding percent or filename suffix characters", async () => {
    for (const name of ["demo#one.mp4", "r%20.pdf", "r .pdf"]) {
      const path = join(workspace, name);
      writeFileSync(path, name);
      const href = pathToFileURL(path).href;
      expect(messageReferencesFile(`[file](${href})`, href)).toBe(true);
      const opened = await openMessageFile(href, [workspace]);
      expect(opened.name).toBe(name);
      await opened.handle.close();
    }
  });

  it("serves OpenDocument formats with their standard MIME types", async () => {
    for (const [extension, mime] of [
      ["odt", "application/vnd.oasis.opendocument.text"],
      ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
      ["odp", "application/vnd.oasis.opendocument.presentation"],
    ] as const) {
      writeFileSync(join(workspace, `document.${extension}`), "open document");
      const file = await openMessageFile(`document.${extension}`, [workspace]);
      expect(file.mime).toBe(mime);
      await file.handle.close();
    }
  });

  it("serves message-authorized video formats without changing the file ceiling", async () => {
    for (const [extension, mime] of [
      ["mp4", "video/mp4"], ["m4v", "video/x-m4v"],
      ["webm", "video/webm"], ["mov", "video/quicktime"],
    ]) {
      writeFileSync(join(workspace, `clip.${extension}`), "video fixture");
      const file = await openMessageFile(`clip.${extension}`, [workspace]);
      expect(file.mime).toBe(mime);
      await file.handle.close();
    }
    const large = join(workspace, "large.mp4");
    writeFileSync(large, "x");
    truncateSync(large, MESSAGE_FILE_MAX_BYTES + 1);
    await expect(openMessageFile(large, [workspace])).rejects.toMatchObject({ status: 413 });
  });

  it("refuses traversal and a symlink that resolves outside the allowed root", async () => {
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "not for this conversation");
    symlinkSync(secret, join(workspace, "escape.md"));

    const refusal = { status: 403, code: "outside_workspace" };
    await expect(openMessageFile("../outside/secret.md", [workspace])).rejects.toMatchObject(refusal);
    await expect(openMessageFile(secret, [workspace])).rejects.toMatchObject(refusal);
    await expect(openMessageFile("escape.md", [workspace])).rejects.toMatchObject(refusal);
  });

  it("accepts only regular files no larger than the phone download ceiling", async () => {
    await expect(openMessageFile(".", [workspace]))
      .rejects.toMatchObject({ status: 400 });

    const large = join(workspace, "large.pdf");
    writeFileSync(large, "x");
    truncateSync(large, MESSAGE_FILE_MAX_BYTES + 1);
    await expect(openMessageFile("large.pdf", [workspace]))
      .rejects.toMatchObject({ status: 413 });
  });

  it("lets a saved download pass the preview ceiling and explains a file over the limit", async () => {
    const large = join(workspace, "reel.mp4");
    writeFileSync(large, "x");
    truncateSync(large, 26 * 1024 * 1024);

    await expect(openMessageFile("reel.mp4", [workspace])).rejects.toMatchObject({
      status: 413,
      code: "file_too_large",
      errorKey: "serverError.file.tooLarge",
      errorParams: { size: "26 MB", limit: "25 MB", name: "reel.mp4" },
    });
    const file = await openMessageFile("reel.mp4", [workspace], MESSAGE_FILE_DOWNLOAD_MAX_BYTES);
    expect(file.bytes).toBe(26 * 1024 * 1024);
    await file.handle.close();

    mkdirSync(join(workspace, "Reels"));
    writeFileSync(join(workspace, "Reels", "big.mp4"), "x");
    truncateSync(join(workspace, "Reels", "big.mp4"), 26 * 1024 * 1024);
    await expect(openMessageFolderEntry("Reels/", "big.mp4", [workspace])).rejects.toMatchObject({ status: 413 });
    const entry = await openMessageFolderEntry("Reels/", "big.mp4", [workspace], MESSAGE_FILE_DOWNLOAD_MAX_BYTES);
    await entry.handle.close();

    truncateSync(large, MESSAGE_FILE_DOWNLOAD_MAX_BYTES + 1);
    await expect(openMessageFile("reel.mp4", [workspace], MESSAGE_FILE_DOWNLOAD_MAX_BYTES))
      .rejects.toMatchObject({ status: 413, errorParams: { size: "500.1 MB", limit: "500 MB" } });
  });

  it("lists the regular files directly inside a linked folder", async () => {
    const folder = join(workspace, "Posts", "2026-10-07_News");
    mkdirSync(join(folder, "nested"), { recursive: true });
    writeFileSync(join(folder, "b.png"), "png");
    writeFileSync(join(folder, "a.md"), "# a");
    writeFileSync(join(folder, "nested", "deep.txt"), "not listed");

    await expect(openMessageFile("Posts/2026-10-07_News/", [workspace]))
      .rejects.toMatchObject({ status: 400, code: "directory" });
    await expect(listMessageFolder("Posts/2026-10-07_News/", [workspace])).resolves.toEqual({
      name: "2026-10-07_News",
      entries: [
        { name: "a.md", bytes: 3, mime: "text/markdown; charset=utf-8" },
        { name: "b.png", bytes: 3, mime: "image/png" },
      ],
      truncated: false,
    });

    const opened = await openMessageFolderEntry("Posts/2026-10-07_News/", "a.md", [workspace]);
    try {
      expect(opened).toMatchObject({ name: "a.md", bytes: 3 });
    } finally {
      await opened.handle.close();
    }
    await expect(openMessageFolderEntry("Posts/2026-10-07_News/", "nested", [workspace]))
      .rejects.toMatchObject({ status: 404 });
    expect(messageFolderEntryName("../secret.md")).toBeNull();
    expect(messageFolderEntryName("nested/deep.txt")).toBeNull();
    expect(messageFolderEntryName("..")).toBeNull();
    expect(messageFolderEntryName("a.md")).toBe("a.md");
  });

  it("refuses a folder outside the root and leaves out symlinks that escape it", async () => {
    writeFileSync(join(outside, "secret.md"), "not for this conversation");
    const refusal = { status: 403, code: "outside_workspace" };
    await expect(listMessageFolder(outside, [workspace])).rejects.toMatchObject(refusal);
    await expect(listMessageFolder("../outside", [workspace])).rejects.toMatchObject(refusal);
    symlinkSync(outside, join(workspace, "escape"));
    await expect(listMessageFolder("escape", [workspace])).rejects.toMatchObject(refusal);

    const folder = join(workspace, "posts");
    mkdirSync(folder);
    writeFileSync(join(folder, "kept.md"), "ok");
    symlinkSync(join(outside, "secret.md"), join(folder, "leak.md"));
    const listing = await listMessageFolder("posts", [workspace]);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["kept.md"]);
    await expect(openMessageFolderEntry("posts", "leak.md", [workspace]))
      .rejects.toMatchObject({ status: 404 });
  });

  it("matches a raw file URL with non-ASCII names, then refuses it only for its folder", async () => {
    // Bots on macOS write the URL unencoded; Windows needs a real file URL.
    const url = (path: string) => process.platform === "win32" ? pathToFileURL(path).href : `file://${path}`;
    const folder = join(outside, "Posts", "2026-10-08_News");
    mkdirSync(join(folder, "00_غلاف"), { recursive: true });
    writeFileSync(join(outside, "PREVIEW.jpg"), "jpg");
    const file = url(join(outside, "PREVIEW.jpg"));
    const linkedFolder = url(folder);
    const nested = url(join(folder, "00_غلاف"));
    const text = `- [PREVIEW.jpg](${file})\n- [2026-10-08_News](${linkedFolder})\n- [00_غلاف](${nested})`;
    for (const href of [file, linkedFolder, nested]) expect(messageReferencesFile(text, href)).toBe(true);

    const roots = [workspace];
    const refusal = { status: 403, code: "outside_workspace" };
    await expect(openMessageFile(file, roots)).rejects.toMatchObject(refusal);
    await expect(openMessageFile(linkedFolder, roots)).rejects.toMatchObject(refusal);
    await expect(listMessageFolder(nested, roots)).rejects.toMatchObject(refusal);

    const opened = await openMessageFile(file, [workspace, outside]);
    await opened.handle.close();
    await expect(listMessageFolder(linkedFolder, [workspace, outside])).resolves.toMatchObject({ name: "2026-10-08_News" });
  });

  it("emits a safe UTF-8 attachment filename", () => {
    const header = messageFileDisposition("résumé \"final\".md");
    expect(header).toContain('filename="re_sume_ _final_.md"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.md");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
  });

  it("types an archive by its extension alone and serves it as a download", async () => {
    for (const [name, mime] of [
      ["a.zip", "application/zip"], ["a.rar", "application/vnd.rar"], ["a.7z", "application/x-7z-compressed"],
      ["a.tar", "application/x-tar"], ["a.gz", "application/gzip"], ["a.tgz", "application/x-compressed-tar"],
      ["a.bz2", "application/x-bzip2"], ["a.xz", "application/x-xz"],
      ["build.tar.gz", "application/gzip"], ["BUILD.ZIP", "application/zip"], ["Site.Tar.Gz", "application/gzip"],
      ["a.cab", "application/octet-stream"], ["a.tar.zst", "application/octet-stream"], ["zip", "application/octet-stream"],
    ] as const) expect(mimeFor(name), name).toBe(mime);
    // Content never decides the type: zip bytes under a .txt name stay text, text under a .zip name stays an archive.
    writeFileSync(join(workspace, "really-zip.txt"), "PK\x03\x04");
    writeFileSync(join(workspace, "really-text.zip"), "hello");
    for (const [name, mime] of [["really-zip.txt", "text/plain; charset=utf-8"], ["really-text.zip", "application/zip"]] as const) {
      const opened = await openMessageFile(name, [workspace]);
      await opened.handle.close();
      expect(opened.mime).toBe(mime);
    }
    expect(messageFileDisposition("build.tar.gz")).toMatch(/^attachment; filename="build\.tar\.gz"/);
    expect(messageFileDownloadName("build.tar.gz", "4e8d.gz")).toBe("build.tar.gz");
    expect(messageFileDownloadName("BUILD.ZIP", "4e8d.zip")).toBe("BUILD.ZIP");
    expect(messageFileDownloadName("setup.exe", "4e8d.zip")).toBe("setup.zip");
  });

  it("never lets a display name disguise the canonical file extension", () => {
    expect(messageFileDownloadName("Quarterly report.pdf", "4e8d.pdf")).toBe("Quarterly report.pdf");
    expect(messageFileDownloadName("setup.exe", "4e8d.pdf")).toBe("setup.pdf");
    expect(messageFileDownloadName("preview.jpg", "4e8d.png")).toBe("preview.png");
  });
});
