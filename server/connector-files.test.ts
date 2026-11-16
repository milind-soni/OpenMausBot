import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectorCallsIn, outboundCallsIn } from "../shared/outbound.ts";
import {
  connectorFileScope, localFileReferences, openBotFile, prepareConnectorFiles, stageConnectorFiles, withMissingFileHint,
  type BotFileScope, type FileStagingDeps,
} from "./connector-files.ts";
import { outboundCard } from "./outbound-requests.ts";

const call = <A,>(name: string, args: A, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const multi = (...tools: Array<{ tool_slug: string; arguments: any }>) => call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools });
const report = new TextEncoder().encode("%PDF-1.4 quarterly report");

function deps(overrides: Partial<FileStagingDeps> = {}) {
  const opened: string[] = [];
  const requests: unknown[] = [];
  const puts: Array<{ url: string; bytes: number; mimetype: string }> = [];
  const value: FileStagingDeps = {
    open: async (path) => { opened.push(path); return { name: "report.pdf", mime: "application/pdf", bytes: report }; },
    requestUpload: async (request) => { requests.push(request); return { key: `staged/${requests.length}.pdf`, url: `https://storage.composio.dev/upload/${requests.length}` }; },
    put: async (url, bytes, mimetype) => { puts.push({ url, bytes: bytes.byteLength, mimetype }); },
    toolkitFor: (tool) => tool.split("_")[0]!.toLowerCase(),
    appFor: (tool) => (tool.startsWith("GOOGLEDRIVE_") ? "Google Drive" : "the app"),
    ...overrides,
  };
  return { value, opened, requests, puts };
}

afterEach(() => vi.unstubAllGlobals());

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
    expect(puts).toEqual([{ url: "https://storage.composio.dev/upload/1", bytes: report.byteLength, mimetype: "application/pdf" }]);
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

  it("leaves ids, real keys, text, multi-line values and non-call frames alone", async () => {
    const untouched = [
      multi({ tool_slug: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", arguments: { file_name: "notes.txt", text_content: "/etc/hosts is a file", mime_type: "text/plain" } }),
      multi({ tool_slug: "GOOGLEDRIVE_EDIT_FILE", arguments: { file_id: "1AbC", content: "C:\\ is a drive" } }),
      multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: { name: "a.pdf", mimetype: "application/pdf", s3key: "proj/ab12/a.pdf" } } }),
      multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FROM_URL", arguments: { file_url: "https://example.com/a.pdf" } }),
      multi({ tool_slug: "SLACK_UPLOAD_FILE", arguments: { file: "/tmp/a.pdf\nand then some text" } }),
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

  it("sends a path that is not one of the bot's files as it is, with no refusal and no upload", async () => {
    // Dropbox and Drive paths, a web path: only a file the bot may send is uploaded.
    const frame = multi(
      { tool_slug: "DROPBOX_UPLOAD_FILE", arguments: { file: "/Apps/report.pdf" } },
      { tool_slug: "WEBFLOW_UPLOAD_ASSET", arguments: { image: "/images/logo.png" } },
    );
    const { value, opened, requests } = deps({ open: async (path) => { opened.push(path); return null; } });
    const prepared = await prepareConnectorFiles(frame, value);
    expect("refusal" in prepared).toBe(false);
    expect(prepared).toMatchObject({ files: [] });
    expect((prepared as { upload?: unknown }).upload).toBeUndefined();
    expect((await stageConnectorFiles(frame, value) as { frame: unknown }).frame).toBe(frame);
    expect(opened).toEqual(["/Apps/report.pdf", "/images/logo.png", "/Apps/report.pdf", "/images/logo.png"]);
    expect(requests).toEqual([]);
  });

  it("reads files first and uploads nothing until upload runs, listing each file on its call's approval card", async () => {
    const frame = multi(
      { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com", body: "x".repeat(600), attachment: "/Users/sam/work/Q3 board deck.pdf" } },
      { tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "from:a" } },
    );
    const { value, requests, puts } = deps();
    const prepared = await prepareConnectorFiles(frame, value);
    if ("refusal" in prepared) throw new Error(prepared.refusal);
    expect(requests).toEqual([]);
    expect(puts).toEqual([]);
    const card = outboundCard(prepared.cardCalls(outboundCallsIn(frame.params.name, frame.params.arguments)));
    expect(card.summary).toContain(`Uploads report.pdf (/Users/sam/work/Q3 board deck.pdf, ${report.byteLength} B)`);
    expect(card.summary.indexOf("Q3 board deck.pdf")).toBeLessThan(card.summary.indexOf("[arguments truncated]"));
    expect(prepared.cardCalls(connectorCallsIn(frame.params.name, frame.params.arguments))[1]).not.toHaveProperty("files");
    const sent = await prepared.upload!() as ReturnType<typeof multi>;
    expect(requests).toHaveLength(1);
    expect(sent.params.arguments.tools[0]!.arguments.attachment).toMatchObject({ s3key: "staged/1.pdf" });
  });

  it("refuses with what to do when a file may not be sent, naming the app and writing nothing", async () => {
    const { value, requests } = deps({ open: async () => { throw new Error("it is in a hidden folder or in the app's own data, which is never sent to an app"); } });
    const staged = await stageConnectorFiles(multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: "C:\\Users\\sam\\.ssh\\id_ed25519" } }), value);
    expect("refusal" in staged && staged.refusal).toContain("could not send C:\\Users\\sam\\.ssh\\id_ed25519 to Google Drive (it is in a hidden folder");
    expect("refusal" in staged && staged.refusal).toContain("Nothing was written to Google Drive");
    expect(requests).toEqual([]);
  });

  it("refuses plainly when the upload itself fails", async () => {
    const { value } = deps({ requestUpload: async () => { throw new Error("connected-apps service answered HTTP 503"); } });
    const staged = await stageConnectorFiles(multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: "/tmp/report.pdf" } }), value);
    expect("refusal" in staged && staged.refusal).toContain("uploading report.pdf for Google Drive failed (connected-apps service answered HTTP 503)");
    expect("refusal" in staged && staged.refusal).toContain("do not keep retrying");
  });

  it("puts the bytes without following a redirect", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { seen.push(init); return new Response("{}"); });
    const { value } = deps();
    delete value.put;
    await stageConnectorFiles(multi({ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: "/tmp/report.pdf" } }), value);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "PUT", redirect: "error" });
  });

  it("caps the files one call uploads", async () => {
    const { value, requests } = deps();
    const attachments = Array.from({ length: 11 }, (_, index) => `/tmp/${index}.pdf`);
    const staged = await stageConnectorFiles(multi({ tool_slug: "GMAIL_SEND_EMAIL", arguments: { attachments } }), value);
    expect("refusal" in staged && staged.refusal).toContain("at most 10");
    expect(requests).toEqual([]);
  });
});

describe("which files a bot may send", () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const dir = () => { const path = mkdtempSync(join(tmpdir(), "omb-connector-files-")); made.push(path); return path; };
  const put = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, report); return path; };
  const scope = (over: Partial<BotFileScope>): BotFileScope => ({ roots: [], attachments: [], refuse: [], ...over });

  it("reads a file in the bot's folder, and passes over one outside it or missing", async () => {
    const work = dir(), elsewhere = dir();
    put(join(work, "report.pdf"));
    put(join(elsewhere, "secret.pdf"));
    const file = await openBotFile(join(work, "report.pdf"), scope({ roots: [work], home: elsewhere }));
    expect(file).toMatchObject({ name: "report.pdf", mime: "application/pdf" });
    expect(Buffer.from(file!.bytes).equals(Buffer.from(report))).toBe(true);
    await expect(openBotFile(join(elsewhere, "secret.pdf"), scope({ roots: [work] }))).resolves.toBeNull();
    await expect(openBotFile(join(work, "missing.pdf"), scope({ roots: [work] }))).resolves.toBeNull();
    await expect(openBotFile(work, scope({ roots: [dirname(work)] }))).resolves.toBeNull();
  });

  it("reads only this conversation's own attachments from the attachment store", async () => {
    const data = dir();
    const store = join(data, "attachments");
    const mine = put(join(store, "mine.pdf"));
    const someoneElses = put(join(store, "someone-elses.pdf"));
    const turn = connectorFileScope({
      roots: [join(data, "workspaces", "bot"), store], attachmentStore: store,
      messages: [{ attachments: [{ path: mine }] }, {}], appData: [data, undefined], guestRoot: "/workspace",
    });
    expect(turn).toEqual({ roots: [join(data, "workspaces", "bot")], attachments: [mine], refuse: [data] });
    await expect(openBotFile(mine, { ...turn, home: dir() })).resolves.toMatchObject({ name: "mine.pdf" });
    await expect(openBotFile(someoneElses, { ...turn, home: dir() })).resolves.toBeNull();
  });

  it("never sends the home folder's hidden folders or the app's own data, even when the bot works in the home folder", async () => {
    const home = dir();
    const data = join(home, ".openmausbot"), desktop = join(home, "AppData", "Roaming", "MausBot");
    const inHome = scope({ roots: [home], refuse: [data, desktop], home });
    const sensitive = /hidden folder or in the app's own data/;
    await expect(openBotFile(put(join(home, ".ssh", "id_ed25519")), inHome)).rejects.toThrow(sensitive);
    await expect(openBotFile(put(join(home, ".aws", "credentials")), inHome)).rejects.toThrow(sensitive);
    await expect(openBotFile(put(join(home, ".config", "gh", "hosts.yml")), inHome)).rejects.toThrow(sensitive);
    await expect(openBotFile(put(join(home, ".netrc")), inHome)).rejects.toThrow(sensitive);
    await expect(openBotFile(put(join(data, "config.json")), inHome)).rejects.toThrow(sensitive);
    await expect(openBotFile(put(join(desktop, "Local State")), inHome)).rejects.toThrow(sensitive);
    await expect(openBotFile(put(join(home, "Documents", "report.pdf")), inHome)).resolves.toMatchObject({ name: "report.pdf" });
    // The bot's own workspace sits inside the app's data folder, and is its to send from, but not a hidden folder in it.
    const workspace = join(data, "workspaces", "bot");
    const own = scope({ roots: [workspace], refuse: [data, desktop], home });
    await expect(openBotFile(put(join(workspace, "out", "chart.pdf")), own)).resolves.toMatchObject({ name: "chart.pdf" });
    await expect(openBotFile(put(join(workspace, ".claude", "settings.json")), own)).rejects.toThrow(sensitive);
    await expect(openBotFile(put(join(data, "secrets.json")), own)).resolves.toBeNull();
  });

  it("reads a Local VM path from the VM's folder on this computer", async () => {
    const host = dir();
    put(join(host, "out", "chart.png"));
    const file = await openBotFile("/workspace/out/chart.png", scope({ guest: { root: "/workspace", host }, home: dir() }));
    expect(file?.name).toBe("chart.png");
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
