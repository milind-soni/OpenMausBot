// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarkdownFileContent from "./MarkdownFilePreview";

const message = { threadId: "t", messageId: "m" };
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function open(answer: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(answer));
  await act(async () => root.render(createElement(MarkdownFileContent, { path: "/workspace/copy-v3.md", name: "copy-v3.md", message })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return host;
}
const alertText = () => host.querySelector("[role=alert]")?.textContent ?? "";

describe("Markdown file preview errors and encodings (#5618)", () => {
  it("opens a file saved as Windows-1252 instead of failing", async () => {
    // "# Relatório\n\nAção concluída" in Windows-1252: ó=F3, ç=E7, ã=E3, í=ED.
    const bytes = new Uint8Array([0x23, 0x20, 0x52, 0x65, 0x6c, 0x61, 0x74, 0xf3, 0x72, 0x69, 0x6f, 0x0a, 0x0a, 0x41, 0xe7, 0xe3, 0x6f, 0x20, 0x63, 0x6f, 0x6e, 0x63, 0x6c, 0x75, 0xed, 0x64, 0x61]);
    await open(async () => new Response(bytes));
    expect(alertText()).toBe("");
    expect(host.textContent).toContain("Relatório");
    expect(host.textContent).toContain("Ação concluída");
  });

  it("still opens UTF-8 files as UTF-8", async () => {
    await open(async () => new Response(new TextEncoder().encode("# Relatório\n\nAção")));
    expect(host.textContent).toContain("Relatório");
    expect(host.textContent).toContain("Ação");
  });

  it("does not show a UTF-16 file as garbage", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x41, 0x00, 0xe7, 0x00]);
    await open(async () => new Response(bytes));
    expect(alertText()).toContain("Could not open this file");
  });

  it("shows the server's own reason instead of blaming the connection", async () => {
    await open(async () => new Response(JSON.stringify({ error: "That file is no longer in the bot's folder." }), { status: 404, headers: { "content-type": "application/json" } }));
    expect(alertText()).toContain("That file is no longer in the bot's folder.");
    expect(alertText()).not.toContain("Check your connection");
  });

  it("keeps the connection hint when the request itself fails", async () => {
    await open(async () => { throw new TypeError("Failed to fetch"); });
    expect(alertText()).toContain("Check your connection");
  });
});
