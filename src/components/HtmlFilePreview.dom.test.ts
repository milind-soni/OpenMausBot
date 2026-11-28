// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlFileButton } from "./HtmlFilePreview";

const message = { threadId: "t", messageId: "m" };
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function open(answer: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(answer));
  await act(async () => root.render(createElement(HtmlFileButton, { path: "C:\\Users\\Maus\\Downloads\\report.html", name: "report.html", message })));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
const alertText = () => document.body.querySelector("[role=alert]")?.textContent ?? "";

describe("HTML file preview errors", () => {
  it("shows the server's own reason instead of blaming the connection or the encoding", async () => {
    await open(async () => new Response(JSON.stringify({ error: "the linked file changed while it was being opened" }), { status: 409, headers: { "content-type": "application/json" } }));
    expect(alertText()).toContain("the linked file changed while it was being opened");
    expect(alertText()).not.toContain("Check your connection");
    expect(alertText()).not.toContain("UTF-8");
  });

  it("keeps the connection hint when the request itself fails", async () => {
    await open(async () => { throw new TypeError("Failed to fetch"); });
    expect(alertText()).toContain("Check your connection");
  });

  it("opens an HTML page larger than 2 MiB", async () => {
    await open(async () => new Response(" ".repeat(2 * 1024 * 1024) + "<h1>Report</h1>"));
    expect(alertText()).toBe("");
    expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>Report</h1>");
  });

  it("offers Open this file when outside_workspace includes canOpenOutside and opens on click", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "the linked file is outside this conversation's workspace", code: "outside_workspace", canOpenOutside: true }), { status: 403, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("<h1>Allowed outside HTML</h1>"));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(HtmlFileButton, { path: "/outside/report.html", name: "report.html", message })));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    const openOutside = await vi.waitFor(() => {
      const button = [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Open this file");
      expect(button).toBeDefined();
      return button!;
    });
    await act(async () => openOutside.click());
    await vi.waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>Allowed outside HTML</h1>"));
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ path: "/outside/report.html", allowOutsideWorkspace: true });
  });
});

describe("PDF file preview", () => {
  it("shows the PDF from a blob typed as PDF whatever the server said, with Download beside it", async () => {
    const made: Blob[] = [];
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { made.push(blob as Blob); return "blob:pdf-preview"; });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.4 report", { headers: { "content-type": "text/html" } })));
      await act(async () => root.render(createElement(HtmlFileButton, { path: "/workspace/report.pdf", name: "report.pdf", message })));
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      await vi.waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("src")).toBe("blob:pdf-preview"));
      expect(made).toHaveLength(1);
      expect(made[0]!.type).toBe("application/pdf");
      expect(await made[0]!.text()).toBe("%PDF-1.4 report");
      expect(document.body.querySelector('button[aria-label="Save a copy of report.pdf"]')).not.toBeNull();
      expect(alertText()).toBe("");
      await act(async () => root.render(null));
      expect(revoke).toHaveBeenCalledWith("blob:pdf-preview");
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it("says the PDF could not be opened, not the page, when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await act(async () => root.render(createElement(HtmlFileButton, { path: "/workspace/report.pdf", name: "report.pdf", message })));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expect(alertText()).toBe("Could not open this PDF. Check your connection and try again."));
  });
});
