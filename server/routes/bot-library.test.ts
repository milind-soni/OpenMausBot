import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEES_EVERYTHING, VisibleSet } from "../bot-visibility.ts";
import { createChatApps, type ChatApps } from "../chat-apps.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { closeMessageDb } from "../message-db.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import { Store } from "../store.ts";
import { createBotLibraryRoutes } from "./bot-library.ts";
import type { RouteContext } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const opened: ChatApps[] = [];

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const apps of opened.splice(0)) apps.close();
});

function fixture() {
  const store = new Store(() => sonnet);
  const scout = store.createBot({ name: "Scout" });
  const other = store.createBot({ name: "Other" });
  const firstChat = scout.threadId;
  const secondChat = store.createTask(scout.id, "Weekly numbers")!.threadId;
  const apps = createChatApps({ store, dataDir: DATA_DIR, sweeps: false });
  opened.push(apps);
  let clock = 1_000;
  const show = (bot: typeof scout, threadId: string, input: Record<string, unknown>) => {
    vi.setSystemTime(clock += 1_000);
    const result = apps.createAppCard({ bot, threadId, input });
    if (result instanceof Promise || !result.ok) throw new Error("not shown");
    return result.messageId;
  };
  return { store, scout, other, firstChat, secondChat, show };
}

async function library(deps: Parameters<typeof createBotLibraryRoutes>[0], botId: string) {
  let answer: { status: number; body: unknown } | undefined;
  const json = ((_res: unknown, status: number, body: unknown) => { answer = { status, body }; }) as unknown as RouteContext["json"];
  await createBotLibraryRoutes(deps)({ path: `/api/bots/${botId}/library`, method: "GET", auth: { kind: "loopback" }, json } as unknown as RouteContext);
  return answer!;
}

const record = (page: Partial<PublishedPageRecord>): PublishedPageRecord =>
  ({ pageId: "p1", url: "https://p1.mausbot.page/", title: "Launch", botId: "", source: "/tmp/launch", cards: [], createdAt: 1, updatedAt: 1, ...page });

describe("GET /api/bots/:id/library", () => {
  it("lists the bot's pages from every one of its conversations, newest first, each at its latest version, and no other bot's", async () => {
    const { store, scout, other, firstChat, secondChat, show } = fixture();
    const sales = show(scout, firstChat, { tool: "show_html", html: "<p>Sales</p>", title: "Sales" });
    show(other, other.threadId, { tool: "show_html", html: "<p>Theirs</p>", title: "Theirs" });
    const board = show(scout, secondChat, { tool: "show_html", html: "<p>v1</p>", title: "Board" });
    show(scout, secondChat, { tool: "update_html", app_id: board, html: "<p>v2</p>", title: "Board v2" });
    show(scout, secondChat, { tool: "update_html", app_id: board, html: "<p>v3</p>", title: "Board v3" });
    const notes = show(scout, firstChat, { tool: "show_html", html: "<p>Notes</p>", title: "Notes" });

    const answer = await library({ store, visibleFor: () => new VisibleSet(store.bots, [], SEES_EVERYTHING), pages: () => [] }, scout.id);

    expect(answer).toEqual({ status: 200, body: { pages: [], apps: [
      { threadId: firstChat, messageId: notes, title: "Notes" },
      { threadId: secondChat, messageId: board, title: "Board v3" },
      { threadId: firstChat, messageId: sales, title: "Sales" },
    ] } });
  });

  it("names only what the caller can read: their conversations' pages, and the bot's links shown in one of them", async () => {
    const { store, scout, other, firstChat, secondChat, show } = fixture();
    show(scout, firstChat, { tool: "show_html", html: "<p>Mine</p>", title: "Mine" });
    show(scout, secondChat, { tool: "show_html", html: "<p>Private</p>", title: "Private" });
    const pages = () => [
      record({ pageId: "a", url: "https://a.mausbot.page/", title: "Older", botId: scout.id, cards: [{ threadId: firstChat, messageId: "m" }], updatedAt: 5 }),
      record({ pageId: "b", url: "https://b.mausbot.page/", title: "Hidden", botId: scout.id, cards: [{ threadId: secondChat, messageId: "m" }], updatedAt: 9 }),
      record({ pageId: "c", url: "https://c.mausbot.page/", title: "Theirs", botId: other.id, cards: [{ threadId: firstChat, messageId: "m" }], updatedAt: 9 }),
      record({ pageId: "d", url: "https://d.mausbot.page/", title: "Newer", botId: scout.id, cards: [{ threadId: firstChat, messageId: "m" }], updatedAt: 7 }),
    ];
    const member = { bot: (id: string) => id === scout.id, thread: (threadId: string) => threadId !== secondChat } as unknown as VisibleSet;

    const answer = await library({ store, visibleFor: () => member, pages }, scout.id);

    expect(answer.body).toMatchObject({
      apps: [{ threadId: firstChat, title: "Mine" }],
      pages: [{ url: "https://d.mausbot.page/", title: "Newer" }, { url: "https://a.mausbot.page/", title: "Older" }],
    });
    expect(await library({ store, visibleFor: () => member, pages }, other.id)).toEqual({ status: 404, body: { error: "no such bot" } });
  });
});
