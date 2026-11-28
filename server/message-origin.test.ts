import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import { DATA_DIR } from "./config.ts";
import { json, readBody } from "./harness/http.ts";
import { pageMessage } from "./host/message-pages.ts";
import { inputOrigin } from "./message-origin.ts";
import type { RequestAuth } from "./request-auth.ts";
import { Store } from "./store.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./routes/threads.ts";
import { dispatchRoutes } from "./routes/table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store): Promise<string> {
  const deps = {
    store,
    userName: () => "Milind",
    viewerFor: () => ({}),
    visibleTo: () => ({ bot: () => true, group: () => true }),
    workspaceAccess: () => null,
    desktopMutationToken: () => undefined,
    companionMutationToken: () => undefined,
    cliOwnerToken: () => undefined,
  } as unknown as ThreadRouteDeps;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
      const handled = await dispatchRoutes([createThreadRoutes(deps)], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("message origin", () => {
  it("assigns distinct origins to a client submission, a bot handoff, a routine line and an external integration", () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const client = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "typed here" });
    const handoff = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "from a teammate", peerAsk: { botId: "helper", name: "Helper" } });
    const routine = store.appendMessage(bot.threadId, {
      role: "user", kind: "text", text: "the daily brief", automated: true,
      origin: inputOrigin({ automationSource: "schedule", automated: true }),
    });
    const integration = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "relayed from another app", relayed: true });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answering" });

    expect({ client: client.origin, handoff: handoff.origin, routine: routine.origin, integration: integration.origin })
      .toEqual({ client: "client", handoff: "bot", routine: "routine", integration: "integration" });
    expect(reply.origin).toBeUndefined();
  });

  it("classifies each server-verified submission path", () => {
    expect(inputOrigin({ via: "api" })).toBe("api");
    expect(inputOrigin({ automationSource: "api" })).toBe("api");
    expect(inputOrigin({ automationSource: "webhook" })).toBe("integration");
    expect(inputOrigin({ fromApp: {} })).toBe("integration");
    expect(inputOrigin({ peerAsk: { botId: "b", name: "B" } })).toBe("bot");
    expect(inputOrigin({ commsDepth: 1 })).toBe("bot");
    expect(inputOrigin({ automationSource: "schedule" })).toBe("routine");
    expect(inputOrigin({ automationSource: "manual" })).toBe("routine");
    expect(inputOrigin({ via: "call" })).toBe("client");
    expect(inputOrigin({ automated: true })).toBe("unknown");
  });

  it("leaves a user line stored without an origin unset, which readers take as unknown", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    store.importTranscript(bot.threadId, [
      { id: "legacy-line", at: 1_000, parentId: null, role: "user", kind: "text", text: "an older record" },
    ], "legacy-line");

    expect(store.messagesFor(bot.threadId).find((message) => message.id === "legacy-line")?.origin).toBeUndefined();
    const base = await serve(store);
    const exported = await (await fetch(`${base}/api/threads/${bot.threadId}/export?format=json`)).json() as { messages: Array<{ id: string; origin?: string }> };
    expect(exported.messages.find((message) => message.id === "legacy-line")?.origin).toBeUndefined();
  });

  it("gives a message ID the same origin in the live event and the JSON export", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const live: Array<{ threadId: string; message: Record<string, any> }> = [];
    store.onChange((change) => { if (change.type === "message") live.push({ threadId: change.threadId, message: pageMessage(change.message) as Record<string, any> }); });
    const client = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "typed here" });
    const routine = store.appendMessage(bot.threadId, {
      role: "user", kind: "text", text: "the daily brief", automated: true,
      origin: inputOrigin({ automationSource: "schedule", automated: true }),
    });
    const base = await serve(store);
    const exported = await (await fetch(`${base}/api/threads/${bot.threadId}/export?format=json`)).json() as { messages: Array<{ id: string; origin?: string }> };

    for (const message of [client, routine]) {
      const event = live.find((frame) => frame.message.id === message.id);
      const transcript = exported.messages.find((line) => line.id === message.id);
      expect(event?.message.origin).toBe(message.origin);
      expect(transcript?.origin).toBe(event?.message.origin);
    }
    expect([client.origin, routine.origin]).toEqual(["client", "routine"]);
  });
});
