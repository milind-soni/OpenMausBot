import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, Message } from "@/state/store";
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
const { initialState, reducer } = await import("@/state/store");

const history = (count: number): Message[] => Array.from({ length: count }, (_, i) => ({
  id: `m-${i}`, parentId: i ? `m-${i - 1}` : null, at: 1_790_000_000_000 + i,
  role: i % 2 ? "bot" : "user", kind: "text", text: `Conversation message ${i.toString().padStart(3, "0")}`,
}));

function owners(messages: Message[], hasMore: boolean, identity?: { threadId: string; name: string }) {
  const bot: Bot = { id: "bot", threadId: identity?.threadId ?? "shown-thread", name: identity?.name ?? "Export bot", title: "", description: "", color: "blue",
    notifications: true, unread: false, busy: false, modelSelection: { instanceId: "fixture", model: "fixture" },
    messages, hasMore, activeLeafId: fixture.leaf };
  const room: Group = { id: "room", threadId: identity?.threadId ?? "shown-thread", name: identity?.name ?? "Export room", memberIds: [],
    defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages, hasMore };
  return { bot, room };
}

function actionForState(kind: "bot" | "room", key: "copy" | "download", state: AppState) {
  renderToStaticMarkup(kind === "bot" ? createElement(ChatMoreMenu, { bot: state.bots[0]! }) : createElement(RoomMoreMenu, { group: state.groups[0]! }));
  return fixture.items.find((item) => item.key === key)!;
}

function heldState(kind: "bot" | "room", messages = fixture.messages.slice(-80), hasMore = true, identity?: { threadId: string; name: string }): AppState {
  const { bot, room } = owners(messages, hasMore, identity);
  return { ...initialState, bots: kind === "bot" ? [bot] : [], groups: kind === "room" ? [room] : [], selectedId: kind };
}

function action(kind: "bot" | "room", key: "copy" | "download", messages: Message[], hasMore: boolean, identity?: { threadId: string; name: string }) {
  return actionForState(kind, key, heldState(kind, messages, hasMore, identity));
}

function send(state: AppState, kind: "bot" | "room", text: string, sendId: string): AppState {
  return reducer(state, kind === "bot" ? { type: "send", botId: "bot", text, sendId }
    : { type: "sendGroup", groupId: "room", text, sendId });
}

async function selectedOutput(operation: "copy" | "download"): Promise<string> {
  const output = operation === "copy" ? fixture.writeText : fixture.download;
  await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
  return output.mock.calls[0]![operation === "copy" ? 0 : 1] as string;
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

    it(`keeps the ${kind} branch-selection contract after loading all pages`, async () => {
      fixture.messages.push({ id: "other-branch", parentId: "m-100", role: "bot", kind: "text", text: "Unselected branch", at: 1_790_000_000_999 });
      const markdown = await exported(kind, "copy", fixture.messages.slice(-80), true);
      expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(270);
      if (kind === "bot") expect(markdown).not.toContain("Unselected branch");
      else expect(markdown).toContain("Unselected branch");
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

describe("exporting the conversation state visible when the menu was clicked", () => {
  for (const { kind, leaf } of [{ kind: "room", leaf: undefined }, { kind: "bot", leaf: null }, { kind: "bot", leaf: undefined }] as const) {
    for (const operation of ["copy", "download"] as const) {
      it(`${operation} excludes a new ${kind} row with ${String(leaf)} leaf while history loads`, async () => {
        const page = Promise.withResolvers<{ messages: Message[]; hasMore: boolean; activeLeafId: string }>();
        fixture.api.mockReturnValueOnce(page.promise);
        const clicked = heldState(kind);
        if (kind === "bot") clicked.bots[0] = { ...clicked.bots[0]!, activeLeafId: leaf };
        vi.stubGlobal("window", {});
        actionForState(kind, operation, clicked).onSelect();
        // Storage order, rather than a sender's clock, determines which rows arrived later.
        fixture.messages.push({ id: "late-row", role: "user", kind: "text", text: "Arrived after export click", at: 1 });
        page.resolve({ messages: fixture.messages.slice(-200), hasMore: true, activeLeafId: "late-row" });
        const markdown = await selectedOutput(operation);
        expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(270);
        expect(markdown).not.toContain("Arrived after export click");
      });
    }
  }

  it("does not extend a room's history boundary when its optimistic send is confirmed later", async () => {
    const page = Promise.withResolvers<{ messages: Message[]; hasMore: boolean; activeLeafId: string }>();
    fixture.api.mockReturnValueOnce(page.promise);
    const clicked = send(heldState("room"), "room", "Pending at click", "pending-room-send");
    vi.stubGlobal("window", {});
    actionForState("room", "copy", clicked).onSelect();
    fixture.messages.push({ id: "unrelated-late-row", role: "user", kind: "text", text: "Unrelated later message", at: 1 },
      { id: "confirmed-room-row", sendId: "pending-room-send", role: "user", kind: "text", text: "Pending at click", at: 2 });
    page.resolve({ messages: fixture.messages.slice(-200), hasMore: true, activeLeafId: "confirmed-room-row" });
    const markdown = await selectedOutput("copy");
    expect(markdown.match(/Pending at click/g)).toHaveLength(1);
    expect(markdown).toContain("Conversation message 000");
    expect(markdown).not.toContain("Unrelated later message");
  });

  it("uses an optimistic bot row's already-persisted parent as its history boundary", async () => {
    const clicked = send(heldState("bot"), "bot", "Pending child", "child-send");
    clicked.bots[0] = { ...clicked.bots[0]!, messages: clicked.bots[0]!.messages.slice(-1) };
    vi.stubGlobal("window", {});
    actionForState("bot", "copy", clicked).onSelect();
    const markdown = await selectedOutput("copy");
    expect(markdown).toContain("Conversation message 000");
    expect(markdown).toContain("Conversation message 269");
    expect(markdown).toContain("Pending child");
  });

  it("does not export an unbounded room history when no clicked row or parent survives", async () => {
    const clicked = send(heldState("room"), "room", "Only pending row", "unanchored-send");
    clicked.groups[0] = { ...clicked.groups[0]!, messages: clicked.groups[0]!.messages.slice(-1) };
    vi.stubGlobal("window", {});
    actionForState("room", "download", clicked).onSelect();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "error", message: "The conversation history at export time is no longer available",
    }));
    expect(fixture.download).not.toHaveBeenCalled();
  });

  for (const kind of ["bot", "room"] as const) {
    it(`keeps an unconfirmed optimistic ${kind} send while filling earlier pages`, async () => {
      const state = send(heldState(kind), kind, "Visible pending question", "pending-send");
      vi.stubGlobal("window", {});
      actionForState(kind, "copy", state).onSelect();
      const markdown = await selectedOutput("copy");
      expect(markdown).toContain("Conversation message 000");
      expect(markdown.match(/Visible pending question/g)).toHaveLength(1);
    });

    it(`keeps the held ${kind} streamed text over an older history-page copy`, async () => {
      const state = reducer(heldState(kind), { type: "messagePatched", threadId: "shown-thread",
        message: { ...fixture.messages.at(-1)!, text: "Visible streamed answer" } });
      vi.stubGlobal("window", {});
      actionForState(kind, "download", state).onSelect();
      const markdown = await selectedOutput("download");
      expect(markdown).toContain("Visible streamed answer");
      expect(markdown).not.toContain("Conversation message 269");
      expect(markdown).toContain("Conversation message 000");
    });

    it(`reconciles a confirmed ${kind} send by its optimistic identity without duplicating it`, async () => {
      const state = send(heldState(kind), kind, "Confirmed question", "confirmed-send");
      fixture.messages.push({ id: "server-send", sendId: "confirmed-send", parentId: kind === "bot" ? "m-269" : null,
        role: "user", kind: "text", text: "Confirmed question", at: 1_790_000_001_000 });
      fixture.leaf = "server-send";
      vi.stubGlobal("window", {});
      actionForState(kind, "copy", state).onSelect();
      const markdown = await selectedOutput("copy");
      expect(markdown.match(/Confirmed question/g)).toHaveLength(1);
      expect(markdown).toContain("Conversation message 000");
      expect(markdown).toContain("Conversation message 269");
    });

    it(`retains the clicked ${kind} snapshot when the stream advances during the read`, async () => {
      const page = Promise.withResolvers<{ messages: Message[]; hasMore: boolean; activeLeafId: string }>();
      fixture.api.mockReturnValueOnce(page.promise);
      const clicked = reducer(heldState(kind), { type: "messagePatched", threadId: "shown-thread",
        message: { ...fixture.messages.at(-1)!, text: "Text visible at click" } });
      vi.stubGlobal("window", {});
      actionForState(kind, "copy", clicked).onSelect();
      const laterMessage = { ...fixture.messages.at(-1)!, text: "Text that arrived later" };
      const later = reducer(clicked, { type: "messagePatched", threadId: "shown-thread", message: laterMessage });
      actionForState(kind, "copy", later);
      fixture.messages[269] = laterMessage;
      page.resolve({ messages: fixture.messages.slice(-200), hasMore: true, activeLeafId: fixture.leaf });
      const markdown = await selectedOutput("copy");
      expect(markdown).toContain("Text visible at click");
      expect(markdown).not.toContain("Text that arrived later");
    });
  }

  it("keeps the locally selected bot branch while its separate POST is still outstanding", async () => {
    fixture.messages.push({ id: "alternate", parentId: "m-200", role: "user", kind: "text", text: "Selected alternate question", at: 1_790_000_001_000 },
      { id: "alternate-answer", parentId: "alternate", role: "bot", kind: "text", text: "Selected alternate answer", at: 1_790_000_001_001 });
    const state = reducer(heldState("bot"), { type: "switchBranch", botId: "bot", threadId: "shown-thread", messageId: "alternate" });
    expect(state.bots[0]!.activeLeafId).toBe("alternate-answer");
    vi.stubGlobal("window", {});
    actionForState("bot", "download", state).onSelect();
    const markdown = await selectedOutput("download");
    expect(markdown).toContain("Conversation message 000");
    expect(markdown).toContain("Selected alternate question");
    expect(markdown).toContain("Selected alternate answer");
    expect(markdown).not.toContain("Conversation message 269");
  });

  it("remaps the selected optimistic leaf without admitting a later server reply", async () => {
    const state = send(heldState("bot"), "bot", "Question at click", "clicked-send");
    fixture.messages.push({ id: "server-send", sendId: "clicked-send", parentId: "m-269", role: "user", kind: "text", text: "Question at click", at: 1_790_000_001_000 },
      { id: "later-answer", parentId: "server-send", role: "bot", kind: "text", text: "Reply not yet visible at click", at: 1_790_000_001_001 });
    fixture.leaf = "later-answer";
    vi.stubGlobal("window", {});
    actionForState("bot", "copy", state).onSelect();
    const markdown = await selectedOutput("copy");
    expect(markdown.match(/Question at click/g)).toHaveLength(1);
    expect(markdown).toContain("Conversation message 000");
    expect(markdown).not.toContain("Reply not yet visible at click");
  });

  it("reconnects a held parent chain when an earlier optimistic send was confirmed", async () => {
    const first = send(heldState("bot"), "bot", "Unconfirmed first message", "first-send");
    const state = send(first, "bot", "Pending second message", "second-send");
    fixture.messages.push({ id: "server-first", sendId: "first-send", parentId: "m-269", role: "user", kind: "text",
      text: "Canonical first message", at: 1_790_000_001_000 });
    fixture.leaf = "server-first";
    vi.stubGlobal("window", {});
    actionForState("bot", "copy", state).onSelect();
    const markdown = await selectedOutput("copy");
    expect(markdown).toContain("Conversation message 000");
    expect(markdown).toContain("Canonical first message");
    expect(markdown).toContain("Pending second message");
    expect(markdown).not.toContain("Unconfirmed first message");
    expect(state.bots[0]!.messages.at(-1)!.parentId).toBe("optimistic-first-send");
  });

  it("does not merge distinct persisted room rows merely because their sendIds match", async () => {
    const state = reducer(heldState("room"), { type: "messageAdded", threadId: "shown-thread", message: {
      id: "held-record", sendId: "shared-send-id", role: "user", kind: "text", text: "Visible persisted row", at: 1_790_000_001_000,
    } });
    fixture.messages.splice(100, 0, { id: "other-record", sendId: "shared-send-id", role: "user", kind: "text", text: "Another persisted row", at: 1_790_000_000_099 });
    vi.stubGlobal("window", {});
    actionForState("room", "copy", state).onSelect();
    const markdown = await selectedOutput("copy");
    expect(markdown).toContain("Visible persisted row");
    expect(markdown).toContain("Another persisted row");
    expect(markdown).toContain("Conversation message 000");
  });

  for (const leaf of [null, undefined]) {
    it(`preserves an explicit ${String(leaf)} bot leaf instead of adopting the server selection`, async () => {
      fixture.messages.push({ id: "other-branch", parentId: "m-100", role: "bot", kind: "text", text: "Also visible without a selected leaf", at: 1_790_000_001_000 });
      const state = heldState("bot");
      state.bots[0] = { ...state.bots[0]!, activeLeafId: leaf };
      vi.stubGlobal("window", {});
      actionForState("bot", "copy", state).onSelect();
      const markdown = await selectedOutput("copy");
      expect(markdown).toContain("Also visible without a selected leaf");
      expect(markdown.match(/Conversation message \d{3}/g)).toHaveLength(270);
    });
  }

  it("fails a missing selected leaf instead of exporting every server branch", async () => {
    const state = heldState("bot");
    state.bots[0] = { ...state.bots[0]!, activeLeafId: "unavailable-selected-leaf" };
    vi.stubGlobal("window", {});
    actionForState("bot", "download", state).onSelect();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: "The selected conversation branch is no longer available" }));
    expect(fixture.download).not.toHaveBeenCalled();
  });
});
