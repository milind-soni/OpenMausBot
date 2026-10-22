import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PagePublisher } from "../pages/publisher.ts";
import { createPagesInternalRoutes, createPublishedPageRoutes, type PagesInternalContext } from "./published-pages.ts";
import { PASS, type RouteContext } from "./table.ts";

function fakePublisher() {
  return {
    publish: vi.fn(async () => ({ status: 200, text: "Published “Bake sale” at https://abcdefghijklmnopqrstuvwxyz.mausbot.page/" })),
    unpublish: vi.fn(async () => ({ status: 200, text: "Unpublished.", card: { state: "unpublished" as const, title: "Bake sale" } })),
  } satisfies PagePublisher;
}

function sink() {
  const sent: { status?: number; body?: any } = {};
  const json = ((_res: unknown, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as PagesInternalContext["json"];
  return { sent, json, res: {} as PagesInternalContext["res"] };
}

async function internal(handler: ReturnType<typeof createPagesInternalRoutes>, input: { path?: string; method?: string; body?: unknown; vmWorkspace?: string | null } = {}) {
  const { sent, json, res } = sink();
  const post = vi.fn(() => "message-1");
  const out = await handler({ method: input.method ?? "POST", path: input.path ?? "/api/internal/pages/publish", res, json, botId: "bot-1", threadId: "thread-1",
    readBody: async () => input.body ?? {}, folders: async () => ({ roots: ["/work/bot-1"], vmWorkspace: input.vmWorkspace ?? null }), post });
  return { out, post, ...sent };
}

describe("the page tools' internal routes", () => {
  it("passes requests that are not its own", async () => {
    const handler = createPagesInternalRoutes(fakePublisher());
    expect((await internal(handler, { path: "/api/internal/attach-file" })).out).toBe(PASS);
    expect((await internal(handler, { method: "GET" })).out).toBe(PASS);
  });

  it("publishes as the capability's own bot and conversation, from its own folders, whatever the body says", async () => {
    const publisher = fakePublisher(), handler = createPagesInternalRoutes(publisher);
    const answer = await internal(handler, { body: { path: "site", title: "Bake sale", page_id: "abcdefghijklmnopqrstuvwxyz", botId: "someone-else" } });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, text: expect.stringContaining("Published") } });
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-1", threadId: "thread-1", path: "site", title: "Bake sale",
      pageId: "abcdefghijklmnopqrstuvwxyz", roots: ["/work/bot-1"] }));
  });

  it("reads a path inside the bot's private desktop as the same file on this computer", async () => {
    const publisher = fakePublisher(), handler = createPagesInternalRoutes(publisher);
    await internal(handler, { body: { path: "/home/cua/workspace/site", title: "Site" }, vmWorkspace: "/vm/bot-1" });
    // The guest path becomes this computer's own path under the private desktop's folder (Windows joins with "\\").
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ path: join("/vm/bot-1", "site"), roots: ["/vm/bot-1", "/work/bot-1"] }));
  });

  it("refuses a body that isn't the tool's, and passes on a publisher's refusal as an error", async () => {
    const publisher = fakePublisher(), handler = createPagesInternalRoutes(publisher);
    expect(await internal(handler, { body: { path: 3, title: "x" } })).toMatchObject({ status: 400 });
    expect(publisher.publish).not.toHaveBeenCalled();
    publisher.publish.mockResolvedValueOnce({ status: 403, text: "Publishing a page needs a MausBot account." });
    expect(await internal(handler, { body: { path: "site", title: "x" } })).toMatchObject({ status: 403, body: { error: "Publishing a page needs a MausBot account." } });
  });

  it("unpublishes by page id or path, as the capability's bot", async () => {
    const publisher = fakePublisher(), handler = createPagesInternalRoutes(publisher);
    const answer = await internal(handler, { path: "/api/internal/pages/unpublish", body: { path: "site" } });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, text: "Unpublished." } });
    expect(publisher.unpublish).toHaveBeenCalledWith({ path: "site", botId: "bot-1", roots: ["/work/bot-1"] });
  });
});

describe("the card's Unpublish", () => {
  const call = async (handler: ReturnType<typeof createPublishedPageRoutes>, path: string, method = "POST") => {
    const sent: { status?: number; body?: any } = {};
    const out = await handler({ path, method, res: {}, json: (_res: unknown, status: number, body: unknown) => { sent.status = status; sent.body = body; } } as unknown as RouteContext);
    return { out, ...sent };
  };

  it("unpublishes the page the path names and answers with its card", async () => {
    const publisher = fakePublisher(), handler = createPublishedPageRoutes(publisher);
    expect(await call(handler, "/api/published-pages/abcdefghijklmnopqrstuvwxyz/unpublish")).toMatchObject({ status: 200, body: { ok: true, card: { state: "unpublished" } } });
    expect(publisher.unpublish).toHaveBeenCalledWith({ pageId: "abcdefghijklmnopqrstuvwxyz" });
    expect((await call(handler, "/api/published-pages/abcdefghijklmnopqrstuvwxyz/unpublish", "GET")).out).toBe(PASS);
    expect((await call(handler, "/api/published-pages/short/unpublish")).out).toBe(PASS);
  });
});
