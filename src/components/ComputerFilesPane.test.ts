// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: vi.fn() }),
}));

import { ComputerFilesPane, recentChangedFiles, sharedFileReferences } from "./ComputerFilesPane";

const reply = (id: string, text: string, patch: Partial<Message> = {}) =>
  ({ id, role: "bot", kind: "text", at: 1, text, ...patch }) as Message;
const digest = (added: string[], deleted: string[] = []) => ({
  id: "digest", role: "bot", kind: "digest", at: 2,
  digest: { files: { added, changed: [], deleted } },
}) as unknown as Message;
const bot = (messages: Message[], patch: Partial<Bot> = {}) => ({
  id: "scout", threadId: "thread-1", name: "Scout", cwd: "/workspace", messages, ...patch,
}) as Bot;

describe("file grants in the visible conversation", () => {
  it("keeps the newest shared message and its authored encoded URL", () => {
    const path = "/workspace/release notes#1.md";
    const href = "file:///workspace/release%20notes%231.md";
    const references = sharedFileReferences(bot([
      reply("old", `[report](${href})`),
      reply("new", `[report](${href})`),
      digest([path]),
    ]));
    expect(references.get(path)).toMatchObject({
      file: { path: href, linked: true }, message: { threadId: "thread-1", messageId: "new" },
    });
  });

  it("does not turn user prose, digest paths, code examples or web links into grants", () => {
    const references = sharedFileReferences(bot([
      reply("user", "[local](/workspace/user.txt)", { role: "user" }),
      reply("text", "`[example](/workspace/example.txt)`\n\n/workspace/plain.txt\n\n[remote](https://example.test/web.txt)"),
      digest(["/workspace/unshared.txt"]),
    ]));
    expect(references.size).toBe(0);
  });

  it("uses only the visible branch", () => {
    const references = sharedFileReferences(bot([
      reply("root", "Start"),
      reply("other", "[hidden](/workspace/report.md)", { parentId: "root" }),
      reply("visible", "[report](report.md)", { parentId: "root" }),
    ], { activeLeafId: "visible" }));
    expect(references.has("/workspace/report.md")).toBe(false);
    expect(references.get("report.md")?.message.messageId).toBe("visible");
  });

  it("keeps a stored attachment path literal, including percent characters", () => {
    const path = "/attachments/release%20notes.txt";
    const references = sharedFileReferences(bot([reply("attached", "", {
      attachments: [{ kind: "file", path, name: "release notes.txt", mime: "text/plain" }],
    })]));
    expect(references.get(path)).toMatchObject({
      file: { path, private: true }, message: { messageId: "attached" },
    });
    expect(references.has("/attachments/release notes.txt")).toBe(false);
  });

  it("matches relative digest paths against the pinned folder instead of changed bot defaults", () => {
    const references = sharedFileReferences(bot([
      reply("old-folder", "[report](/workspace/original/report.md)"),
      reply("other-folder", "[other](/workspace/changed/report.md)"),
      reply("relative", "[notes](./notes.md)"),
    ], {
      cwd: "/workspace/changed",
      tasks: [{ threadId: "thread-1", title: "", createdAt: 1, cwd: "/workspace/original" }],
    }));
    expect(references.get("report.md")?.message.messageId).toBe("old-folder");
    expect(references.get("notes.md")?.message.messageId).toBe("relative");
  });

  it("does not guess a relative path from another folder or an explicit null pin", () => {
    const messages = [reply("sibling", "[report](/workspace-other/report.md)")];
    expect(sharedFileReferences(bot(messages)).has("report.md")).toBe(false);
    expect(sharedFileReferences(bot([reply("report", "[report](/workspace/report.md)")], {
      tasks: [{ threadId: "thread-1", title: "", createdAt: 1, cwd: null }],
    })).has("report.md")).toBe(false);
  });

  it("matches Windows file URLs to Git's forward-slash relative paths", () => {
    const references = sharedFileReferences(bot([
      reply("windows", "[report](file:///C:/work/notes/report%20one.md)"),
    ], { cwd: "C:\\work" }));
    expect(references.get("notes/report one.md")?.file.path).toBe("file:///C:/work/notes/report%20one.md");
  });

  it.each([
    ["drive path", "C:\\Work", "c:/work/Notes/Report%20one.md"],
    ["drive URL", "C:\\Work", "file:///c:/work/Notes/Report%20one.md"],
    ["UNC URL", "\\\\Server\\Share\\Work", "file://server/share/work/Notes/Report%20one.md"],
  ])("matches a differently cased Windows %s prefix without changing the shared reference", (_kind, cwd, href) => {
    const references = sharedFileReferences(bot([reply("shared", `[report](${href})`)], { cwd }));
    expect(references.get("Notes/Report one.md")).toMatchObject({
      file: { path: href, linked: true }, message: { threadId: "thread-1", messageId: "shared" },
    });
    expect(references.has("notes/report one.md")).toBe(false);
  });

  it.each([
    ["C:\\Work", "file:///c:/work-other/report.md"],
    ["\\\\Server\\Share\\Work", "file://server/share/work-other/report.md"],
    ["\\\\Server\\Share\\Work", "file://other/share/work/report.md"],
    ["/Work", "file:///work/report.md"],
    ["/Work", "/work/report.md"],
  ])("does not match a file outside the same folder: %s and %s", (cwd, href) => {
    const references = sharedFileReferences(bot([reply("shared", `[report](${href})`)], { cwd }));
    expect(references.has("report.md")).toBe(false);
  });

  it("still suppresses files whose latest digest deleted them", () => {
    expect(recentChangedFiles(bot([
      digest(["/workspace/removed.md", "/workspace/kept.md"]),
      { ...digest([], ["/workspace/removed.md"]), id: "later" },
    ]))).toEqual(["/workspace/kept.md"]);
  });
});

describe("recent file actions", () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = (value: Bot) => flushSync(() => root.render(createElement(ComputerFilesPane, { bot: value })));
  const saveButton = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="Save a copy of ${name}"]`);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers the existing CSV preview and save controls, with no eager file request", () => {
    render(bot([
      reply("shared", "[data](/workspace/data.csv)"),
      digest(["/workspace/data.csv", "/workspace/unshared.txt"]),
    ]));
    expect(saveButton("data.csv")).not.toBeNull();
    expect(container.querySelector('button[aria-label="Preview table: data.csv"]')).not.toBeNull();
    expect(saveButton("unshared.txt")).toBeNull();
    expect(container.textContent).toContain("Not shared");
    expect(container.querySelector('[title="Ask the bot to share a file link in this chat to save a copy."]')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads through the exact shared message and preserves the original URL", async () => {
    const href = "file:///workspace/release%20notes%231.md";
    vi.mocked(fetch).mockResolvedValue(new Response("Sample report", {
      headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="release.md"' },
    }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(bot([reply("message / 1", `[report](${href})`), digest(["/workspace/release notes#1.md"])], { threadId: "thread / 1" }));
    saveButton("release notes#1.md")!.click();
    await vi.waitFor(() => expect(container.textContent).toContain("Downloaded"));
    expect(fetch).toHaveBeenCalledWith("/api/threads/thread%20%2F%201/messages/message%20%2F%201/file", expect.objectContaining({
      method: "POST", body: JSON.stringify({ path: href, listFolder: true }),
    }));
    expect(download).toHaveBeenCalledOnce();
  });

  it("shows the existing workspace refusal and clears it when switching conversations", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: "outside", code: "outside_workspace",
    }), { status: 403, headers: { "content-type": "application/json" } }));
    const messages = [reply("shared", "[report](/workspace/report.md)"), digest(["/workspace/report.md"])];
    render(bot(messages));
    saveButton("report.md")!.click();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("outside this chat's working folder"));
    render(bot(messages, { threadId: "thread-2" }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(saveButton("report.md")).not.toBeNull();
  });
});
