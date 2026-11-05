// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, BotAnnouncement } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const botNamed = (id: string, extra: Partial<BotAnnouncement> = {}): BotAnnouncement => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" }, tasks: [{ threadId: `${id}-thread`, title: "Thread", createdAt: 1 }], messages: [], ...extra,
});
const REFUSED = { error: "You've reached the 5 bots Starter includes. To create more, upgrade this Cloud.", code: "bot_limit" };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

const { StoreProvider, useStore } = await import("./store");
const { api, ApiError } = await import("./api");
const { botLimitShown, closeBotLimit } = await import("@/lib/bot-limit");

let seen!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  return null;
}
let root: Root;
let container: HTMLElement;
let creates: number;
let created: () => Promise<Response>;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

async function mount(bots: BotAnnouncement[], config: Record<string, unknown>) {
  FixtureEventSource.opened = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) return json({ bots, groups: [] });
    if (path === "/api/config") return json(config);
    if (path === "/api/instances") return json({ instances: [] });
    if (path.startsWith("/api/routines")) return json({ routines: [], runs: [] });
    if (path.startsWith("/api/webhooks")) return json({ webhooks: [], attempts: [] });
    if (path === "/api/bot-defaults") return json({ defaults: { profile: {}, memory: {}, skills: [], routines: [] }, modelSelection: { instanceId: "fake", model: "m" }, suggestedName: "Scout" });
    if (path === "/api/bots" && init?.method === "POST") { creates += 1; return created(); }
    return json({});
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  expect(seen.bots).toHaveLength(bots.length);
  expect(seen.config).toMatchObject(config);
}
/** Sends it and waits for New bot or Duplicate to have finished asking, so nothing it sends lands in the next test. */
const send = async (action: Action) => {
  flushSync(() => dispatch(action));
  await settle();
  await vi.waitFor(() => expect(seen.botCreationPending).toBe(false));
  await settle();
};
const five = () => Array.from({ length: 5 }, (_, i) => botNamed(`b${i}`));
const STARTER = { cloudStarter: true, botLimit: 5 };

beforeEach(() => {
  creates = 0;
  created = () => json(REFUSED, 409);
  closeBotLimit();
});
afterEach(async () => {
  root?.unmount();
  container?.remove();
  vi.unstubAllGlobals();
});

describe("a create button with no room", () => {
  it.each<[string, Action]>([["New bot", { type: "newBot" }], ["Duplicate", { type: "duplicateBot", botId: "b0" }]])("%s opens the popup and asks the server nothing", async (_name, action) => {
    await mount(five(), STARTER);
    await send(action);
    expect(botLimitShown()).toBe(true);
    expect(creates).toBe(0);
    expect(seen.error).toBeNull();
  });

  it("leaves the MausBot out of the count, as the server does", async () => {
    await mount([botNamed("maus", { defaultBot: {} } as never), ...five().slice(1)], STARTER);
    created = () => json({ bot: botNamed("new") }, 201);
    await send({ type: "newBot" });
    await vi.waitFor(() => expect(creates).toBe(1));
    expect(botLimitShown()).toBe(false);
  });

  it("goes straight on the moment the plan is bigger, with nothing reloaded", async () => {
    await mount(five(), STARTER);
    FixtureEventSource.opened[0]!.send({ kind: "config", ...seen.config, cloudStarter: false, botLimit: undefined }, "run:1");
    await settle();
    created = () => json({ bot: botNamed("new") }, 201);
    await send({ type: "newBot" });
    await vi.waitFor(() => expect(creates).toBe(1));
    expect(botLimitShown()).toBe(false);
  });

  it("has no limit on a plan that doesn't say one", async () => {
    await mount(five(), { cloudStarter: false });
    created = () => json({ bot: botNamed("new") }, 201);
    await send({ type: "newBot" });
    await vi.waitFor(() => expect(creates).toBe(1));
    expect(botLimitShown()).toBe(false);
  });
});

describe("the server's refusal, when the page's count was stale", () => {
  it.each<[string, Action]>([["New bot", { type: "newBot" }], ["Duplicate", { type: "duplicateBot", botId: "b1" }]])("%s shows the popup and no error beside it", async (_name, action) => {
    await mount(five().slice(1), STARTER);
    await send(action);
    await vi.waitFor(() => expect(botLimitShown()).toBe(true));
    expect(creates).toBe(1);
    expect(seen.error).toBeNull();
  });

  it("any other refusal is still an error", async () => {
    await mount(five().slice(1), STARTER);
    created = () => json({ error: "this workspace is limited to 100 bots" }, 409);
    await send({ type: "duplicateBot", botId: "b1" });
    await vi.waitFor(() => expect(seen.error).toBe("this workspace is limited to 100 bots"));
    expect(botLimitShown()).toBe(false);
  });

  it("opens the popup from any request, and leaves the rest to whoever asked", async () => {
    await mount([], {});
    vi.stubGlobal("fetch", () => json(REFUSED, 409));
    await expect(api("/api/teams/import?mode=add", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(botLimitShown()).toBe(true);
  });

  it.each<[Record<string, unknown>, number]>([[{ error: "busy", code: "thread_busy" }, 409], [{ error: "no", code: "bot_limit" }, 500]])("leaves %j (%i) alone", async (body, status) => {
    await mount([], {});
    vi.stubGlobal("fetch", () => json(body, status));
    await expect(api("/api/bots", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(botLimitShown()).toBe(false);
  });
});
