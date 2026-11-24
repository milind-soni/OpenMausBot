// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  state: { computerOpen: false, settingsOpen: false, inspectorOpen: false, activityOpen: false, activeView: "chat" },
  dispatched: [] as unknown[],
  wide: true,
}));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: fixture.state, dispatch: () => {} }) }));
vi.mock("@/state/store-ref", () => ({ useOptionalStoreRef: () => ({ dispatch: (action: unknown) => fixture.dispatched.push(action), state: () => fixture.state }) }));

const { closeFilePreview } = await import("@/lib/file-preview");
const { openAppPreview, closeAppPreview } = await import("@/lib/app-preview");
const { AttachedFileChip } = await import("./AttachmentPreview");
const { FilePreviewPanel } = await import("./FilePreviewPanel");
const { ChatMarkdown } = await import("./ChatMarkdown");
// The preview loads this lazily; loaded once here, the tests wait only on the file.
await import("./MarkdownFilePreview");

const PLAN = { path: "/workspace/observing-plan.md", name: "observing-plan.md", private: true };
const message = { threadId: "t1", messageId: "m1" };
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: fixture.wide && query === "(min-width: 1280px)", addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# Observing plan\n\nBring a red flashlight.")));
  fixture.state = { computerOpen: false, settingsOpen: false, inspectorOpen: false, activityOpen: false, activeView: "chat" };
  fixture.dispatched.length = 0;
  fixture.wide = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { closeFilePreview(); closeAppPreview(); root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "ogb");
});

/** A conversation with one Markdown file in a reply, and the shell's pane beside it; `inPanel` draws the chip in a
 * side panel instead. */
async function render({ threadId = "t1", inPanel = false } = {}) {
  const chip = createElement(AttachedFileChip, { file: PLAN, message });
  await act(async () => root.render(createElement(Fragment, null,
    createElement("main", { "data-look": "chat" }, inPanel ? createElement("aside", null, chip) : chip, createElement("textarea", { "aria-label": "Message" })),
    createElement(FilePreviewPanel, { threadId }),
  )));
}
const nameButton = () => host.querySelector<HTMLButtonElement>("main button[aria-label='Preview: observing-plan.md']")!;
async function openFile() {
  await act(async () => nameButton().click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Bring a red flashlight."));
}
const pane = () => host.querySelector<HTMLElement>("aside[data-file-preview]");
const dialog = () => document.body.querySelector("dialog");

describe("a file opened from the chat on a wide window", () => {
  it("opens beside the conversation, which stays on screen and usable", async () => {
    await render();
    await openFile();
    expect(pane()?.getAttribute("data-file-preview")).toBe(PLAN.path);
    expect(pane()?.querySelector("h2")?.textContent).toBe("observing-plan.md");
    expect(pane()?.textContent).toContain("Bring a red flashlight.");
    expect(dialog()).toBeNull();
    expect(host.querySelector("main textarea")).not.toBeNull();
    expect(nameButton()).not.toBeNull();
    expect(fixture.dispatched).toContainEqual({ type: "toggleComputer", open: false });
  });

  it("keeps Save as its own button next to the name, and in the pane", async () => {
    await render();
    await openFile();
    expect(host.querySelector("main button[aria-label='Save a copy of observing-plan.md']")).not.toBeNull();
    expect(pane()?.querySelector("button[aria-label='Save a copy of observing-plan.md']")).not.toBeNull();
  });

  it("closes from its button and gives focus back to the file without scrolling the chat", async () => {
    await render();
    await openFile();
    const focus = vi.spyOn(nameButton(), "focus");
    await act(async () => pane()!.querySelector<HTMLButtonElement>("button[aria-label='Close preview']")!.click());
    expect(pane()).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("closes on Escape", async () => {
    await render();
    await openFile();
    await act(async () => { pane()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(pane()).toBeNull();
  });

  it("closes when the chat moves to another conversation", async () => {
    await render();
    await openFile();
    await render({ threadId: "t2" });
    expect(pane()).toBeNull();
  });

  it("shows a linked file outside the chat in its folder by its real path, asking for it by the link as written", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ error: "the linked file is outside this conversation's workspace", code: "outside_workspace" }), { status: 403, headers: { "content-type": "application/json" } }));
    const revealInFolder = vi.fn(async () => "shown");
    vi.stubGlobal("fetch", fetch);
    Object.assign(window, { ogb: { revealInFolder } });
    await act(async () => root.render(createElement(Fragment, null,
      createElement("main", { "data-look": "chat" }, createElement(ChatMarkdown, { text: "Report: [Q3 report.md](/workspace/finance/Q3%20report.md)", message })),
      createElement(FilePreviewPanel, { threadId: "t1" }),
    )));
    await act(async () => host.querySelector<HTMLButtonElement>("main button[title='Preview: Q3 report.md']")!.click());
    const show = await vi.waitFor(() => {
      const button = [...(pane()?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Show in folder");
      expect(button).toBeDefined();
      return button!;
    });
    await act(async () => show.click());
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ path: "/workspace/finance/Q3%20report.md" });
    expect(revealInFolder).toHaveBeenCalledWith("/workspace/finance/Q3 report.md");
  });

  it("gives way to another panel on that side", async () => {
    await render();
    await openFile();
    await act(async () => openAppPreview({ url: "https://bright-bakery.netlify.app/", title: "Bright Bakery" }));
    expect(pane()).toBeNull();
    await act(async () => closeAppPreview());
    expect(pane()).toBeNull();
  });
});

describe("a file that keeps the dialog", () => {
  it("opens in the dialog on a narrow window", async () => {
    fixture.wide = false;
    await render();
    await openFile();
    expect(pane()).toBeNull();
    expect(dialog()?.textContent).toContain("Bring a red flashlight.");
  });

  it("opens in the dialog from a side panel", async () => {
    await render({ inPanel: true });
    await openFile();
    expect(pane()).toBeNull();
    expect(dialog()?.textContent).toContain("Bring a red flashlight.");
    expect(fixture.dispatched).toEqual([]);
  });
});
