// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { collectMessageFiles } from "./AttachmentGallery";
import { AttachedFileChip } from "./AttachmentPreview";
import { ChatMarkdown } from "./ChatMarkdown";
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
      expect(host.querySelector("[role=alert]")!.textContent).toBe("This file is outside this chat's working folder, so it can't be opened here. Ask the bot that saved it to attach a copy.");
      expect(buttons()).toEqual([]);
      expect(host.textContent).toContain("Find this file at this path on the computer running");
      expect(host.querySelector("code")?.textContent).toBe(`${onDisk}${extension}`);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${kind}: shows the file in its folder on the desktop`, async () => {
      const revealInFolder = vi.fn(async () => "shown");
      Object.assign(window, { ogb: { revealInFolder } });
      await show(kind, extension, outside);
      expect(buttons()).toEqual(["Show in folder"]);
      expect(host.textContent).not.toContain("Find this file at this path");
      expect(host.querySelector("code")?.textContent).toBe(`${onDisk}${extension}`);
      await act(async () => host.querySelector("button")!.click());
      expect(revealInFolder).toHaveBeenCalledWith(`${onDisk}${extension}`);
    });
  }

  it("shows no path for a relative link, which names no folder to start from", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => outside()));
    await act(async () => root.render(createElement(FilePreviewContent, { kind: "markdown", path: "../finance-head/report.md", shownPath: "../finance-head/report.md", name: "report.md", message })));
    await vi.waitFor(() => expect(host.textContent).toContain("Ask the bot that saved it to attach a copy."), { timeout: 5_000 });
    expect(host.textContent).not.toContain("Find this file at this path");
    expect(host.querySelector("[title]")).toBeNull();
    expect(host.textContent).not.toContain("../finance-head/report.md");
    expect(buttons()).toEqual([]);
  });

  it("keeps the find-it hint for a network share path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => outside()));
    await act(async () => root.render(createElement(FilePreviewContent, { kind: "markdown", path: "file://server/share/report.md", shownPath: "//server/share/report.md", name: "report.md", message })));
    await vi.waitFor(() => expect(host.textContent).toContain("Find this file at this path on the computer running"), { timeout: 5_000 });
    expect(host.querySelector("code")?.textContent).toBe("//server/share/report.md");
  });

  it("keeps Retry for a refusal that may pass next time", async () => {
    await show("markdown", ".md", () => new Response(JSON.stringify({ error: "the linked file changed while it was being opened" }), { status: 409, headers: { "content-type": "application/json" } }));
    expect(host.querySelector("[role=alert]")!.textContent).toContain("the linked file changed while it was being opened");
    expect(buttons()).toContain("Retry");
  });

  it("speaks the person's language", async () => {
    setLocale("de");
    await show("markdown", ".md", outside);
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Diese Datei liegt außerhalb des Arbeitsordners dieses Chats und kann hier nicht geöffnet werden. Bitte den Bot, der sie gespeichert hat, eine Kopie anzuhängen.");
  });
});

describe("a linked file outside the chat's folders, opened from the chat", () => {
  async function openFrom(element: ReturnType<typeof createElement>, label: string) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => outside());
    const revealInFolder = vi.fn(async () => "shown");
    vi.stubGlobal("fetch", fetch);
    Object.assign(window, { ogb: { revealInFolder } });
    await act(async () => root.render(element));
    await act(async () => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    const show = await vi.waitFor(() => {
      const button = [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === "Show in folder");
      expect(button).toBeDefined();
      return button!;
    }, { timeout: 5_000 });
    await act(async () => show.click());
    const asked = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as { path: string };
    return { asked: asked.path, revealed: revealInFolder.mock.calls[0] };
  }

  it("asks for a table by the link as written and shows it in its folder by its real path", async () => {
    const opened = await openFrom(createElement(ChatMarkdown, { text: `Report: [Q3 report.csv](${linked}.csv)`, message }), "Preview table: Q3 report.csv");
    expect(opened.asked).toBe(`${linked}.csv`);
    expect(opened.revealed).toEqual([`${onDisk}.csv`]);
  });

  it("shows a file:// link listed as a file chip, as the Library lists a message's links, in its folder by its real path", async () => {
    const [file] = collectMessageFiles(`Report: [Q3](file://${linked}.md)`);
    const opened = await openFrom(createElement(AttachedFileChip, { file: file!, linked: true, message }), "Preview: Q3 report.md");
    expect(opened.asked).toBe(`file://${linked}.md`);
    expect(opened.revealed).toEqual([`${onDisk}.md`]);
  });
});
