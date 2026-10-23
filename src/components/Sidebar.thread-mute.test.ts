// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type AppState, type BotAnnouncement } from "@/state/store";
import { BotThreadList, botRowProps } from "./Sidebar";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

/** The server's copy of the thread: what a PATCH writes, unless the server refuses it. */
const server = { muted: false, refuse: false };
const patches: unknown[] = [];
const serverBot = (): BotAnnouncement => ({
  id: "pepper", threadId: "current", name: "Pepper", title: "", description: "", color: "green", unread: false,
  notifications: true, modelSelection: { instanceId: "claude", model: "fixture" },
  tasks: [
    { threadId: "current", title: "Current thread", createdAt: 2, approvalMode: "ask" },
    { threadId: "release", title: "Release notes", createdAt: 1, approvalMode: "ask", notificationsMuted: server.muted },
  ],
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

let seen!: AppState;
function Harness() {
  const { state, dispatch } = useStore();
  seen = state;
  const bot = state.bots.find((candidate) => candidate.id === "pepper");
  return bot ? createElement(BotThreadList, {
    ...botRowProps(state, dispatch, bot, { density: "comfortable", quiet: false, query: "", onMenu: () => undefined }),
    selected: true,
  }) : null;
}

let root: Root;
const row = () => document.querySelector<HTMLButtonElement>('[data-sidebar-thread-row="release"]');
const storedMute = () => seen.bots.find((bot) => bot.id === "pepper")?.tasks?.find((task) => task.threadId === "release")?.notificationsMuted;
const mutedMark = () => row()!.parentElement!.querySelector('[aria-label="Notifications muted"]');
/** Opens the row's menu and returns its mute item once the menu shows it. */
const muteItem = async (label: "Mute notifications" | "Unmute notifications") => {
  const more = await vi.waitFor(() => row()!.parentElement!.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
  if (more.getAttribute("aria-expanded") === "true") more.click();
  await vi.waitFor(() => expect(more.getAttribute("aria-expanded")).toBe("false"));
  more.click();
  return vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLButtonElement>("[data-thread-overlay] button")].findLast((button) => button.textContent === label);
    expect(item).toBeDefined();
    return item!;
  });
};

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [serverBot()], groups: [] });
    if (path === "/api/bots/pepper/tasks/release" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { notificationsMuted?: boolean };
      patches.push(body);
      if (server.refuse) return json({ error: "That thread is no longer yours to change" }, 403);
      if (typeof body.notificationsMuted === "boolean") server.muted = body.notificationsMuted;
      return json({ bot: serverBot() });
    }
    if (path === "/api/instances") return json({ instances: [] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    return json({});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Harness))));
  await vi.waitFor(() => expect(FixtureEventSource.opened).toHaveLength(1));
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" }, "run:0");
  await vi.waitFor(() => expect(row()).not.toBeNull());
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("Mute notifications in a thread's menu", () => {
  it("mutes, then unmutes, the thread on the server and shows it on the row", async () => {
    const mute = await muteItem("Mute notifications");
    const help = document.getElementById(mute.getAttribute("aria-describedby") ?? "");
    expect(mute.title).toBe("");
    expect(help?.closest("[data-thread-overlay]")).not.toBeNull();
    expect(help?.textContent).toMatch(/still notifies you of anything waiting on you/);
    expect(mutedMark()).toBeNull();
    mute.click();
    await vi.waitFor(() => expect(mutedMark()).not.toBeNull());
    expect(patches.at(-1)).toEqual({ notificationsMuted: true });
    expect(storedMute()).toBe(true);

    (await muteItem("Unmute notifications")).click();
    await vi.waitFor(() => expect(mutedMark()).toBeNull());
    expect(patches.at(-1)).toEqual({ notificationsMuted: false });
    expect(storedMute()).toBe(false);
  });

  it("rolls back to the server's state when the server refuses", async () => {
    server.refuse = true;
    try {
      const sent = patches.length;
      (await muteItem("Mute notifications")).click();
      await vi.waitFor(() => expect(seen.error).toBe("That thread is no longer yours to change"));
      expect(patches.slice(sent)).toEqual([{ notificationsMuted: true }]);
      await vi.waitFor(() => expect(storedMute()).toBe(false));
      expect(mutedMark()).toBeNull();
      await muteItem("Mute notifications");
    } finally {
      server.refuse = false;
    }
  });

  it("shows a mute someone else set once the refreshed thread arrives", async () => {
    server.muted = true;
    FixtureEventSource.opened[0]!.send({ kind: "bot", bot: serverBot() }, "run:1");
    await vi.waitFor(() => expect(mutedMark()).not.toBeNull());
    expect(storedMute()).toBe(true);
    await muteItem("Unmute notifications");
  });
});
