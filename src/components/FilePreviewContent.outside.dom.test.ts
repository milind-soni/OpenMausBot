// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { FilePreviewContent } from "./HtmlFilePreview";

const message = { threadId: "t", messageId: "m" };
const linked = "/Users/maus/.openmausbot/workspaces/finance-head/Q3%20report";
const onDisk = "/Users/maus/.openmausbot/workspaces/finance-head/Q3 report";
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "ogb");
  setLocale("en");
});

const outside = () => new Response(JSON.stringify({ error: "the linked file is outside this conversation's workspace", code: "outside_workspace" }), { status: 403, headers: { "content-type": "application/json" } });
const files = [
  { kind: "markdown", extension: ".md" },
  { kind: "html", extension: ".html" },
  { kind: "table", extension: ".csv" },
] as const;

async function show(kind: (typeof files)[number]["kind"], extension: string, answer: () => Response) {
  const fetch = vi.fn(async () => answer());
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(createElement(FilePreviewContent, { kind, path: `${linked}${extension}`, shownPath: `${onDisk}${extension}`, name: `Q3 report${extension}`, message })));
  await vi.waitFor(() => expect(host.querySelector("[role=alert]")).not.toBeNull(), { timeout: 5_000 });
  return fetch;
}
const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent?.trim() || button.getAttribute("aria-label"));

describe("a previewed file outside the chat's folders", () => {
  for (const { kind, extension } of files) {
    it(`${kind}: says why it can't open and offers no Save or Retry that would fail the same way`, async () => {
      const fetch = await show(kind, extension, outside);
      expect(host.querySelector("[role=alert]")!.textContent).toBe("This file is outside this chat's working folder, so it can't be opened here");
      expect(buttons()).toEqual([]);
      expect(host.querySelector("code")?.textContent).toBe(`${onDisk}${extension}`);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${kind}: shows the file in its folder on the desktop`, async () => {
      const revealInFolder = vi.fn(async () => "shown");
      Object.assign(window, { ogb: { revealInFolder } });
      await show(kind, extension, outside);
      expect(buttons()).toEqual(["Show in folder"]);
      await act(async () => host.querySelector("button")!.click());
      expect(revealInFolder).toHaveBeenCalledWith(`${onDisk}${extension}`);
    });
  }

  it("keeps Retry for a refusal that may pass next time", async () => {
    await show("markdown", ".md", () => new Response(JSON.stringify({ error: "the linked file changed while it was being opened" }), { status: 409, headers: { "content-type": "application/json" } }));
    expect(host.querySelector("[role=alert]")!.textContent).toContain("the linked file changed while it was being opened");
    expect(buttons()).toContain("Retry");
  });

  it("speaks the person's language", async () => {
    setLocale("de");
    await show("markdown", ".md", outside);
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Diese Datei liegt außerhalb des Arbeitsordners dieses Chats und kann hier nicht geöffnet werden");
  });
});
