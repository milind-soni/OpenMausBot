import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return {
    items: [] as SidebarMenuItem[],
    messages: [] as Message[],
    leaf: "",
    api: vi.fn(),
    writeText: vi.fn(async (_text: string) => {}),
    download: vi.fn(),
    dispatch: vi.fn(),
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }) };
});
vi.mock("@/state/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/api")>(), api: fixture.api,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("@/lib/chat-find", () => ({ requestChatFind: vi.fn(), useChatFindOpen: () => false }));
vi.mock("./ContextWarning", () => ({ useContextAction: () => ({ pending: false, run: vi.fn() }) }));
vi.mock("@/lib/export-transcript", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/export-transcript")>(), downloadMarkdownTranscript: fixture.download,
}));
vi.mock("./SidebarPopoverMenu", () => ({ SidebarPopoverMenu: ({ items }: { items: SidebarMenuItem[] }) => {
  fixture.items = items;
  return null;
} }));

const { ChatMoreMenu } = await import("./ChatMoreMenu");
const { RoomMoreMenu } = await import("./RoomMoreMenu");

const history = (count: number): Message[] => Array.from({ length: count }, (_, i) => ({
  id: `m-${i}`, parentId: i ? `m-${i - 1}` : null, at: 1_790_000_000_000 + i,
  role: i % 2 ? "bot" : "user", kind: "text", text: `Conversation message ${i.toString().padStart(3, "0")}`,
}));

function action(kind: "bot" | "room", key: "copy" | "download", messages: Message[], hasMore: boolean, identity?: { threadId: string; name: string }) {
  const bot: Bot = { id: "bot", threadId: identity?.threadId ?? "shown-thread", name: identity?.name ?? "Export bot", title: "", description: "", color: "blue",
    notifications: true, unread: false, busy: false, modelSelection: { instanceId: "fixture", model: "fixture" },
    messages, hasMore, activeLeafId: fixture.leaf };
  const room: Group = { id: "room", threadId: identity?.threadId ?? "shown-thread", name: identity?.name ?? "Export room", memberIds: [],
    defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages, hasMore };
  renderToStaticMarkup(kind === "bot" ? createElement(ChatMoreMenu, { bot }) : createElement(RoomMoreMenu, { group: room }));
  return fixture.items.find((item) => item.key === key)!;
}

beforeEach(() => {
  fixture.messages = history(270);
  fixture.leaf = "m-269";
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://fixture");
    expect(url.pathname).toBe("/api/threads/shown-thread/messages");
    const before = url.searchParams.get("before");
    const end = before ? fixture.messages.findIndex((message) => message.id === before) : fixture.messages.length;
    expect(end).toBeGreaterThan(0);
    const start = Math.max(0, end - Number(url.searchParams.get("limit")));
    return { messages: fixture.messages.slice(start, end), hasMore: start > 0, activeLeafId: fixture.leaf };
  });
  fixture.writeText.mockClear();
  fixture.download.mockClear();
  fixture.dispatch.mockClear();
  vi.stubGlobal("navigator", { clipboard: { writeText: fixture.writeText } });
});
afterEach(() => vi.unstubAllGlobals());

async function exported(kind: "bot" | "room", operation: "copy" | "download", messages: Message[], hasMore: boolean) {
  vi.stubGlobal("window", {});
  const item = action(kind, operation, messages, hasMore);
  expect(item.disabled).toBeFalsy();
  item.onSelect();
  const output = operation === "copy" ? fixture.writeText : fixture.download;
  await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
  return output.mock.calls[0]![operation === "copy" ? 0 : 1] as string;
}

describe("copying and downloading a paged conversation", () => {
  for (const kind of ["bot", "room"] as const) {
    for (const operation of ["copy", "download"] as const) {
      it(`${operation} includes the earlier pages of a ${kind} conversation`, async () => {
        const held = fixture.messages.slice(-80);
        const markdown = await exported(kind, operation, held, true);
        expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(270);
        expect(markdown.indexOf("Conversation message 000")).toBeLessThan(markdown.indexOf("Conversation message 269"));
        expect(fixture.api).toHaveBeenCalledTimes(2);
        expect(held).toHaveLength(80);
      });

      it(`${operation} uses the held ${kind} conversation when no earlier page exists`, async () => {
        const held = fixture.messages.slice(-2);
        const markdown = await exported(kind, operation, held, false);
        expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(2);
        expect(fixture.api).not.toHaveBeenCalled();
      });

      it(`${operation} keeps the selected ${kind} metadata when another conversation opens during the read`, async () => {
        const page = Promise.withResolvers<{ messages: Message[]; hasMore: boolean; activeLeafId: string }>();
        fixture.api.mockReturnValueOnce(page.promise);
        vi.stubGlobal("window", {});
        action(kind, operation, fixture.messages.slice(-80), true).onSelect();
        action(kind, operation, [], false, { threadId: "other-thread", name: "Other conversation" });
        page.resolve({ messages: fixture.messages.slice(-200), hasMore: true, activeLeafId: fixture.leaf });
        const output = operation === "copy" ? fixture.writeText : fixture.download;
        await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
        const markdown = output.mock.calls[0]![operation === "copy" ? 0 : 1] as string;
        expect(markdown).toContain(kind === "bot" ? "# Thread with Export bot" : "# Group: Export room");
        expect(markdown).not.toContain("Other conversation");
        expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(270);
        expect(fixture.api.mock.calls.every(([path]) => path.startsWith("/api/threads/shown-thread/messages?"))).toBe(true);
        if (operation === "download") expect(output.mock.calls[0]![0]).toMatch(new RegExp(`^export-${kind}-transcript-\\d{4}-\\d{2}-\\d{2}\\.md$`));
      });
    }

    it(`exports only the selected branch after loading all ${kind} pages`, async () => {
      fixture.messages.push({ id: "other-branch", parentId: "m-100", role: "bot", kind: "text", text: "Unselected branch", at: 1_790_000_000_999 });
      const markdown = await exported(kind, "copy", fixture.messages.slice(-80), true);
      expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(270);
      expect(markdown).not.toContain("Unselected branch");
    });

    it(`keeps screen-capture placeholders in earlier ${kind} pages`, async () => {
      fixture.messages[10] = { ...fixture.messages[10]!, kind: "screen", text: undefined, hasImage: true };
      const markdown = await exported(kind, "copy", fixture.messages.slice(-80), true);
      expect(markdown).toContain("Screen capture (image not included in Markdown export).");
      expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(269);
    });

    it(`does not download a partial ${kind} conversation after an earlier page fails`, async () => {
      fixture.api.mockResolvedValueOnce({ messages: fixture.messages.slice(-200), hasMore: true, activeLeafId: fixture.leaf });
      fixture.api.mockRejectedValueOnce(new Error("History is unavailable"));
      vi.stubGlobal("window", {});
      action(kind, "download", fixture.messages.slice(-80), true).onSelect();
      await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: "History is unavailable" }));
      expect(fixture.download).not.toHaveBeenCalled();
      expect(fixture.writeText).not.toHaveBeenCalled();
    });
  }
});
