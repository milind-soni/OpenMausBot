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
