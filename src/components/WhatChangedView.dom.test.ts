// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compareTexts } from "../../shared/text-changes";
import { StoreContext } from "@/state/store-context";
import { AttachmentGallery } from "./AttachmentGallery";
import WhatChangedContent, { changeBlocks } from "./WhatChangedView";

const ORIGINAL = ["Mara walked into the bar at noon.", "Tom said nothing.", "One.", "Two.", "Three.", "Four.", "She left before dawn."].join("\n\n");
const EDITED = ORIGINAL.replace("walked", "ran").replace("She left before dawn.", "She left before dawn. A stranger watched.");
const STORE = "/data/attachments";
const SOURCE = `${STORE}/1f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.md`, RESULT = `${STORE}/2f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.md`;

class InlineWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(data: { original: string; edited: string }) {
    queueMicrotask(() => this.onmessage?.({ data: compareTexts(data.original, data.edited) } as MessageEvent));
  }
  terminate() {}
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", InlineWorker);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

/** Polls until the page shows what the test waits for, letting React and the fake worker run in between. */
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 5_000, interval: 5 });

describe("What changed view", () => {
  it("loads both files through their messages, counts the changes and marks them word by word", async () => {
    const asked: Array<{ url: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const { path } = JSON.parse(String(init.body)) as { path: string };
      asked.push({ url, path });
      return new Response(path === SOURCE ? ORIGINAL : EDITED, path === SOURCE ? { headers: { "x-openmausbot-kept-original": "1" } } : {});
    }));
    await act(async () => root.render(createElement(WhatChangedContent, {
      original: { path: SOURCE, name: "chapter.md", message: { threadId: "t", messageId: "u1" } },
      edited: { path: RESULT, name: "chapter-edited.md", message: { threadId: "t", messageId: "b1" } },
    })));
    await until(() => expect(host.querySelector("[role=status]")?.textContent).toBe("Changed 1 · Added 1"));
    expect(asked).toEqual([
      { url: "/api/threads/t/messages/u1/file", path: SOURCE },
      { url: "/api/threads/t/messages/b1/file", path: RESULT },
    ]);
    expect(host.textContent).toContain("Compared with chapter.md, as you sent it");
    expect([...host.querySelectorAll("del")].map((node) => node.textContent)).toEqual(["walked"]);
    expect([...host.querySelectorAll("ins")].map((node) => node.textContent)).toEqual(["ran", "A stranger watched."]);
    // The unchanged middle is folded away beyond one paragraph of context on each side.
    expect(host.textContent).toContain("3 unchanged paragraphs");
    expect(host.textContent).not.toContain("Two.");

    await act(async () => (host.querySelector("[aria-label='Next change']") as HTMLButtonElement).click());
    expect(host.textContent).toContain("1 of 2");
    await act(async () => (host.querySelector("[aria-label='Previous change']") as HTMLButtonElement).click());
    expect(host.textContent).toContain("2 of 2");
  });

  it("says so when nothing changed, and when a file is too large", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ORIGINAL)));
    await act(async () => root.render(createElement(WhatChangedContent, {
      original: { path: SOURCE, name: "a.md", message: { threadId: "t", messageId: "u1" } },
      edited: { path: RESULT, name: "b.md", message: { threadId: "t", messageId: "b1" } },
    })));
    await until(() => expect(host.textContent).toContain("No changes: the two versions say the same thing"));
    // Served from the store, not from a copy kept when it was sent: the view says so.
    expect(host.textContent).toContain("Your original a.md wasn't kept when you sent it");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": String(3 * 1024 * 1024) } })));
    await act(async () => root.render(createElement(WhatChangedContent, {
      key: "again",
      original: { path: SOURCE, name: "a.md", message: { threadId: "t", messageId: "u1" } },
      edited: { path: RESULT, name: "b.md", message: { threadId: "t", messageId: "b2" } },
    })));
    await until(() => expect(host.querySelector("[role=alert]")?.textContent).toBe("These files are too large to compare here (each up to 2 MB and 20,000 sentences)."));
  });
});

describe("the What changed control", () => {
  const state = (messages: unknown[]) => ({ state: { bots: [{ id: "bot", threadId: "t", messages }], groups: [], forkPanel: null } }) as never;
  const person = { id: "u1", role: "user", text: `Improve the dialogue\n\n<attached-file path="${SOURCE}" name="chapter.md" />`, parentId: null };
  const returned = { id: "b1", role: "bot", text: "", parentId: "u1", attachments: [{ kind: "file", path: RESULT, name: "chapter-edited.md", mime: "text/markdown" }] };
  const gallery = () => createElement(AttachmentGallery, { files: [{ path: RESULT, name: "chapter-edited.md", private: true }], message: { threadId: "t", messageId: "b1" } });
  const labels = () => [...host.querySelectorAll("button")].map((button) => button.textContent);

  it("sits beside a returned edit of the person's file, and nowhere else", async () => {
    await act(async () => root.render(createElement(StoreContext.Provider, { value: state([person, returned]) }, gallery())));
    expect(labels()).toContain("What changed");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.parse(String(init.body)).path === SOURCE ? ORIGINAL : EDITED)));
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "What changed")!.click());
    await until(() => expect(document.querySelector("dialog h2")?.textContent).toBe("What changed in chapter-edited.md"));
    await until(() => expect(document.querySelector("dialog [role=status]")?.textContent).toBe("Changed 1 · Added 1"));
    expect(document.querySelector("dialog [role=status]")?.textContent).toBe("Changed 1 · Added 1");
    await act(async () => root.render(createElement(StoreContext.Provider, { value: state([{ ...person, text: "Improve the dialogue" }, returned]) }, gallery())));
    expect(labels()).not.toContain("What changed");
    await act(async () => root.render(gallery()));
    expect(labels()).not.toContain("What changed");
  });
});

describe("changeBlocks", () => {
  it("numbers changes in reading order and keeps changed paragraphs whole", () => {
    const result = compareTexts(ORIGINAL, EDITED);
    if (!result.ok) throw new Error("compare");
    const { blocks, changes } = changeBlocks(result.segments);
    expect(changes).toBe(2);
    expect(blocks.map((block) => block.kind === "paragraph" ? block.paragraph.para : `folded ${block.paragraphs.length}`)).toEqual([1, 2, "folded 3", 6, 7]);
  });
});
