import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { localFileReferences, openBotFile, stageConnectorFiles, withMissingFileHint, type FileStagingDeps } from "./connector-files.ts";

const call = <A,>(name: string, args: A, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const multi = (...tools: Array<{ tool_slug: string; arguments: any }>) => call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools });
const report = new TextEncoder().encode("%PDF-1.4 quarterly report");

function deps(overrides: Partial<FileStagingDeps> = {}) {
  const opened: string[] = [];
  const requests: unknown[] = [];
  const puts: Array<{ url: string; bytes: number; mimetype: string }> = [];
  const value: FileStagingDeps = {
    open: async (path) => { opened.push(path); return { name: "report.pdf", mime: "application/pdf", bytes: report }; },
    requestUpload: async (request) => { requests.push(request); return { key: `staged/${requests.length}.pdf`, url: `https://storage.example/upload/${requests.length}` }; },
    put: async (url, bytes, mimetype) => { puts.push({ url, bytes: bytes.byteLength, mimetype }); },
    toolkitFor: (tool) => tool.split("_")[0]!.toLowerCase(),
    appFor: (tool) => (tool.startsWith("GOOGLEDRIVE_") ? "Google Drive" : "the app"),
    ...overrides,
  };
  return { value, opened, requests, puts };
}

describe("connected-app file arguments", () => {
  it("uploads a Windows path given as Google Drive's file_to_upload and names it by its staged key", async () => {
    const frame = multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: "C:\\Users\\sam\\Documents\\report.pdf", folder_to_upload_to: "1AbC" } });
    const { value, opened, requests, puts } = deps();
    const staged = await stageConnectorFiles(frame, value);
    expect("frame" in staged).toBe(true);
    const sent = (staged as { frame: ReturnType<typeof multi> }).frame;
    expect(sent.params.arguments.tools[0]!.arguments).toEqual({
      file_to_upload: { name: "report.pdf", mimetype: "application/pdf", s3key: "staged/1.pdf" },
      folder_to_upload_to: "1AbC",
    });
    expect(opened).toEqual(["C:\\Users\\sam\\Documents\\report.pdf"]);
    expect(requests).toEqual([{
      toolkit_slug: "googledrive", tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", filename: "report.pdf", mimetype: "application/pdf",
      md5: createHash("md5").update(report).digest("hex"),
    }]);
    expect(puts).toEqual([{ url: "https://storage.example/upload/1", bytes: report.byteLength, mimetype: "application/pdf" }]);
    // The bot's own frame is left as it was.
    expect(frame.params.arguments.tools[0]!.arguments.file_to_upload).toBe("C:\\Users\\sam\\Documents\\report.pdf");
  });

  it("reads a path written where Composio wants an s3key, keeping the name and type the bot gave", async () => {
    const frame = multi({ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com", attachment: { name: "Q3.pdf", mimetype: "application/pdf", s3key: "/Users/sam/work/out.pdf" } } });
    const { value, opened } = deps();
    const staged = await stageConnectorFiles(frame, value) as { frame: ReturnType<typeof multi> };
    expect(opened).toEqual(["/Users/sam/work/out.pdf"]);
    expect(staged.frame.params.arguments.tools[0]!.arguments.attachment).toEqual({ name: "Q3.pdf", mimetype: "application/pdf", s3key: "staged/1.pdf" });
  });

  it("uploads each path in a list of attachments, and a directly called tool's file", async () => {
    const { value, opened } = deps();
    const listed = await stageConnectorFiles(multi({ tool_slug: "GMAIL_SEND_EMAIL", arguments: { attachments: ["/tmp/a.pdf", "/tmp/b.pdf"] } }), value) as { frame: ReturnType<typeof multi> };
    expect((listed.frame.params.arguments.tools[0]!.arguments as { attachments: unknown[] }).attachments).toEqual([
      { name: "report.pdf", mimetype: "application/pdf", s3key: "staged/1.pdf" },
      { name: "report.pdf", mimetype: "application/pdf", s3key: "staged/2.pdf" },
    ]);
    const direct = await stageConnectorFiles(call("GOOGLEDRIVE_UPLOAD_FILE", { file_to_upload: "~/report.pdf" }), value) as { frame: ReturnType<typeof call> };
    expect((direct.frame.params.arguments as { file_to_upload: unknown }).file_to_upload).toMatchObject({ s3key: "staged/3.pdf" });
    expect(opened.at(-1)).not.toMatch(/^~/);
  });

  it("leaves ids, real keys, text and non-call frames alone", async () => {
    const untouched = [
      multi({ tool_slug: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", arguments: { file_name: "notes.txt", text_content: "/etc/hosts is a file", mime_type: "text/plain" } }),
      multi({ tool_slug: "GOOGLEDRIVE_EDIT_FILE", arguments: { file_id: "1AbC", content: "C:\\ is a drive" } }),
      multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: { name: "a.pdf", mimetype: "application/pdf", s3key: "proj/ab12/a.pdf" } } }),
      multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FROM_URL", arguments: { file_url: "https://example.com/a.pdf" } }),
      call("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "upload_local_file('/tmp/a.pdf')" }),
      call("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: "upload /tmp/a.pdf to drive" }] }),
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    const { value, opened } = deps();
    for (const frame of untouched) {
      expect(localFileReferences(frame).references).toEqual([]);
      expect((await stageConnectorFiles(frame, value) as { frame: unknown }).frame).toBe(frame);
    }
    expect(opened).toEqual([]);
  });

  it("refuses with what to do when the file cannot be read, naming the app and writing nothing", async () => {
    const { value, requests } = deps({ open: async () => { throw new Error("it is outside your working folder and this conversation's attachments"); } });
    const staged = await stageConnectorFiles(multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: "D:\\private\\tax.pdf" } }), value);
    expect("refusal" in staged && staged.refusal).toContain("could not read D:\\private\\tax.pdf to send it to Google Drive (it is outside your working folder");
    expect("refusal" in staged && staged.refusal).toContain("Nothing was written to Google Drive");
    expect("refusal" in staged && staged.refusal).toContain("GOOGLEDRIVE_CREATE_FILE_FROM_TEXT");
    expect(requests).toEqual([]);
  });

  it("refuses plainly when the upload itself fails", async () => {
    const { value } = deps({ requestUpload: async () => { throw new Error("connected-apps service answered HTTP 503"); } });
    const staged = await stageConnectorFiles(multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: "/tmp/report.pdf" } }), value);
    expect("refusal" in staged && staged.refusal).toContain("uploading report.pdf for Google Drive failed (connected-apps service answered HTTP 503)");
    expect("refusal" in staged && staged.refusal).toContain("do not keep retrying");
  });

  it("caps the files one call uploads", async () => {
    const { value, opened } = deps();
    const attachments = Array.from({ length: 11 }, (_, index) => `/tmp/${index}.pdf`);
    const staged = await stageConnectorFiles(multi({ tool_slug: "GMAIL_SEND_EMAIL", arguments: { attachments } }), value);
    expect("refusal" in staged && staged.refusal).toContain("at most 10");
    expect(opened).toEqual([]);
  });
});

describe("openBotFile", () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const dir = () => { const path = mkdtempSync(join(tmpdir(), "omb-connector-files-")); made.push(path); return path; };

  it("reads a file inside the roots and says why it cannot read one outside them or missing", async () => {
    const work = dir(), elsewhere = dir();
    writeFileSync(join(work, "report.pdf"), report);
    writeFileSync(join(elsewhere, "secret.pdf"), report);
    const file = await openBotFile(join(work, "report.pdf"), [work]);
    expect(file).toMatchObject({ name: "report.pdf", mime: "application/pdf" });
    expect(Buffer.from(file.bytes).equals(Buffer.from(report))).toBe(true);
    await expect(openBotFile(join(elsewhere, "secret.pdf"), [work])).rejects.toThrow("outside your working folder");
    await expect(openBotFile(join(work, "missing.pdf"), [work])).rejects.toThrow("there is no such file");
  });

  it("reads a Local VM path from the VM's folder on this computer", async () => {
    const host = dir();
    mkdirSync(join(host, "out"));
    writeFileSync(join(host, "out", "chart.png"), report);
    const file = await openBotFile("/workspace/out/chart.png", [], { root: "/workspace", host });
    expect(file.name).toBe("chart.png");
  });
});

describe("missing staged file note", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const failed = (text: string) => ({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: JSON.stringify({ successful: false, error: text, data: {} }) }], isError: true } });

  it("tells the bot to give a local path when Composio could not fetch the file", () => {
    const out = JSON.parse(new TextDecoder().decode(withMissingFileHint(
      encode(failed("Failed to download file with s3key C:\\Users\\sam\\report.pdf: storage returned HTTP 404")), "application/json", ["GOOGLEDRIVE_UPLOAD_FILE"],
    )));
    expect(out.result.content).toHaveLength(2);
    expect(out.result.content[1].text).toContain("never reads this computer's disk");
    expect(out.result.content[1].text).toContain("full path of a file in your working folder");
  });

  it("leaves other failures and successes byte for byte", () => {
    const other = encode(failed("404 File not found: 1AbC"));
    expect(withMissingFileHint(other, "application/json", ["GOOGLEDRIVE_EDIT_FILE"])).toBe(other);
    const ok = encode({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Failed to download file is a phrase" }] } });
    expect(withMissingFileHint(ok, "application/json", [])).toBe(ok);
  });
});
