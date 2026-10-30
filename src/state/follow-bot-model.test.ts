// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, BotAnnouncement } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const opus = { instanceId: "claude", model: "claude-opus-5" };
const codex = { instanceId: "codex", model: "gpt-5-codex" };
const before: BotAnnouncement = {
  id: "bot", threadId: "first", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green", modelSelection: opus,
  tasks: [
    { threadId: "first", title: "First", createdAt: 1, modelSelection: opus, followsBotModel: true },
    { threadId: "busy", title: "Busy", createdAt: 2, modelSelection: codex, followsBotModel: false },
  ],
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const followed: string[] = [];

const { StoreProvider, useStore } = await import("./store");

let seen!: AppState;
let dispatch!: ReturnType<typeof useStore>["dispatch"];
function Probe() {
  const store = useStore();
  seen = store.state;
  dispatch = store.dispatch;
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [before], groups: [] });
    if (path === "/api/bots/bot/threads/follow-model") {
      followed.push(path);
      return json({ switched: 0, busy: 1, bot: before });
    }
    if (path === "/api/instances") return json({ instances: [] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    return json({});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" }, "run:0");
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("Switch them too in the store", () => {
  it("hands the server's busy count back to the caller after the bot is patched", async () => {
    const settled = vi.fn();
    dispatch({ type: "followBotModel", botId: "bot", onSettled: settled });
    await settle();
    expect(followed).toEqual(["/api/bots/bot/threads/follow-model"]);
    expect(settled).toHaveBeenCalledWith({ busy: 1 });
    expect(seen.bots.find((bot) => bot.id === "bot")?.tasks?.find((task) => task.threadId === "busy")?.followsBotModel).toBe(false);
  });
});
