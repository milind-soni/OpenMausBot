// @vitest-environment happy-dom
// One archive path for the sidebar and the Simple bot panel: both end with the sidebar's "Archived · Undo" notice.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), state: {} as AppState }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/thread-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => true,
}));

const { initialState } = await import("@/state/store");
const { announceArchiveNotice, archiveBotWithNotice, onArchiveNotice } = await import("./bot-archive");
const { useBotActions } = await import("./bot-panel/bot-actions");

const make = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id[0]!.toUpperCase() + id.slice(1), title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, ...extra,
});
const scout = make("scout");
const nova = make("nova");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.state = { ...initialState, bots: [scout, nova], selectedId: "scout" };
});

describe("archiving a bot", () => {
  it("hides it, opens the next bot when it was on screen, and offers Undo", async () => {
    fixture.api.mockResolvedValue({ bot: { ...scout, hidden: true } });
    const notify = vi.fn();
    await archiveBotWithNotice(scout, { bots: [scout, nova], selectedId: "scout", dispatch: fixture.dispatch, showThreads: true, notify });
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ hidden: true }) });
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "botPatched", bot: { ...scout, hidden: true } }],
      [{ type: "select", id: "nova" }],
    ]);
    expect(notify.mock.calls).toEqual([
      [null],
      [{ error: false, text: "Scout archived", restoreBot: { id: "scout", name: "Scout" } }],
    ]);
  });

  it("stays on the open bot when another one is archived, and says why a failure failed", async () => {
    fixture.api.mockResolvedValueOnce({ bot: { ...nova, hidden: true } }).mockRejectedValueOnce(new Error("Server is offline"));
    const notify = vi.fn();
    await archiveBotWithNotice(nova, { bots: [scout, nova], selectedId: "scout", dispatch: fixture.dispatch, showThreads: true, notify });
    expect(fixture.dispatch.mock.calls.map(([action]) => action.type)).toEqual(["botPatched"]);
    await archiveBotWithNotice(nova, { bots: [scout, nova], selectedId: "scout", dispatch: fixture.dispatch, showThreads: true, notify });
    expect(notify).toHaveBeenLastCalledWith({ error: true, text: "Server is offline" });
  });

  it("reaches the sidebar from anywhere, and says when no sidebar is there to hear", () => {
    const shown = vi.fn();
    expect(announceArchiveNotice(null)).toBe(false);
    const stop = onArchiveNotice(shown);
    expect(announceArchiveNotice({ error: false, text: "Scout archived" })).toBe(true);
    expect(shown).toHaveBeenCalledWith({ error: false, text: "Scout archived" });
    stop();
    expect(announceArchiveNotice(null)).toBe(false);
  });
});

describe("archiving from the bot panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let actions: ReturnType<typeof useBotActions> | null = null;
  function Probe({ of }: { of: Bot }) {
    actions = useBotActions(of);
    return null;
  }
  const render = () => flushSync(() => root.render(createElement(Probe, { of: scout })));
  const confirmArchive = async () => {
    flushSync(() => actions!.requestArchive());
    render();
    flushSync(() => actions!.confirmed());
    await settle();
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    render();
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });

  it("ends with the sidebar's Archived notice and its Undo, as the sidebar's own archive does", async () => {
    fixture.api.mockResolvedValue({ bot: { ...scout, hidden: true } });
    const sidebar = vi.fn();
    const stop = onArchiveNotice(sidebar);
    await confirmArchive();
    stop();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: false });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "select", id: "nova" });
    expect(sidebar).toHaveBeenLastCalledWith({ error: false, text: "Scout archived", restoreBot: { id: "scout", name: "Scout" } });
  });

  it("still reports a failure in the chat when no sidebar is on screen", async () => {
    fixture.api.mockRejectedValue(new Error("Server is offline"));
    await confirmArchive();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "error", message: "Server is offline" });
  });
});
