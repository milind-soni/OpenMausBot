import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { SecretCards } from "../host/secret-cards.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createSecretCardRoutes, secretAnswerRefusal, type SecretAnswerContext } from "./secret-cards.ts";
import type { RouteContext } from "./table.ts";

const session = (scopes: Array<"admin" | "client">): RequestAuth => ({
  kind: "session", via: "bearer", scopes, session: { id: "s1", email: "ada@example.test" } as SessionRecord,
});
const ADMIN = session(["admin", "client"]);
const MEMBER = session(["client"]);
const team = (owner: string | null, person: string | null): SecretAnswerContext => ({ personalCloud: false, shared: true, owner, person });

describe("who may type a secret into a card", () => {
  it("is this computer's own app, never a local service", () => {
    const desktop = { personalCloud: false, shared: false, owner: null, person: null };
    expect(secretAnswerRefusal({ kind: "loopback", scopes: ["admin", "client"] }, desktop)).toBeNull();
    expect(secretAnswerRefusal({ kind: "loopback", scopes: ["admin"], trust: "service" }, desktop)).toMatch(/local service cannot/u);
  });

  it("is a Cloud's owner, never a guest", () => {
    const cloud = { personalCloud: true, shared: false, owner: null, person: "p:ada" };
    expect(secretAnswerRefusal(ADMIN, cloud)).toBeNull();
    expect(secretAnswerRefusal(MEMBER, cloud)).toBe("Only the owner of this Cloud can enter this secret.");
  });

  // An admin who answers an ordinary card for a member never types a member's secret.
  it("on a team, is only the person the conversation belongs to, or an admin when it names no one", () => {
    expect(secretAnswerRefusal(MEMBER, team("p:ada", "p:ada"))).toBeNull();
    expect(secretAnswerRefusal(MEMBER, team("p:ada", "p:bob"))).toBe("Only the person this conversation belongs to can enter this secret.");
    expect(secretAnswerRefusal(ADMIN, team("p:ada", "p:boss"))).toBe("Only the person this conversation belongs to can enter this secret.");
    expect(secretAnswerRefusal(ADMIN, team(null, "p:boss"))).toBeNull();
    expect(secretAnswerRefusal(MEMBER, team(null, "p:bob"))).toBe("Only a workspace admin can enter this secret.");
  });
});

describe("POST /api/bots/<bot>/secret-cards/<card>/save", () => {
  const PATH = "/api/bots/atlas/secret-cards/card-1/save";
  function route(over: Partial<{ visible: boolean; context: SecretAnswerContext }> = {}) {
    const saveCustomSecret = vi.fn(() => ({ status: 200, body: { provided: true, resumed: true } }));
    const cards = { secretMessage: vi.fn(() => ({ id: "card-1" })), saveCustomSecret } as unknown as SecretCards;
    const handler = createSecretCardRoutes({
      cards, phoneSecretSubmissions: { has: () => false },
      threadVisible: () => over.visible ?? true,
      answerContext: () => over.context ?? team("p:ada", "p:ada"),
    });
    return { handler, saveCustomSecret };
  }
  const context = (body: unknown, contentType = "application/json", auth: RequestAuth = MEMBER): RouteContext => ({
    req: { headers: { "content-type": contentType } } as unknown as IncomingMessage, res: {} as ServerResponse,
    path: PATH, method: "POST", url: new URL(PATH, "http://fixture.invalid"), auth,
    readBody: vi.fn(async () => body), json: vi.fn(),
  });

  it("hands the value to the card's own save, and answers without it", async () => {
    const { handler, saveCustomSecret } = route();
    const ctx = context({ threadId: "thread-1", value: "sk_live_canary" });
    await handler(ctx);
    expect(saveCustomSecret).toHaveBeenCalledExactlyOnceWith("atlas", "thread-1", "card-1", "sk_live_canary");
    expect(ctx.json).toHaveBeenCalledExactlyOnceWith(ctx.res, 200, { provided: true, resumed: true });
  });

  it("keeps the unowned conversation refusal as uncoded English", async () => {
    const { handler, saveCustomSecret } = route({ context: team(null, "p:bob") });
    const ctx = context({ threadId: "thread-1", value: "sk_live_canary" });
    await handler(ctx);
    expect(saveCustomSecret).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledExactlyOnceWith(ctx.res, 403, { error: "Only a workspace admin can enter this secret." });
  });

  it.each([
    ["a form post", { contentType: "text/plain" }, 415],
    ["a conversation the session cannot see", { visible: false }, 404],
    ["someone else's conversation", { context: team("p:ada", "p:bob") }, 403],
  ] as const)("refuses %s before anything is kept", async (_name, over, status) => {
    const { handler, saveCustomSecret } = route("visible" in over || "context" in over ? over as never : {});
    const ctx = context({ threadId: "thread-1", value: "sk_live_canary" }, "contentType" in over ? over.contentType : "application/json");
    await handler(ctx);
    expect(saveCustomSecret).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.json).mock.calls[0]?.[1]).toBe(status);
    expect(JSON.stringify(vi.mocked(ctx.json).mock.calls)).not.toContain("sk_live_canary");
  });
});

describe("Use a saved one: GET .../saved and POST .../use", () => {
  const BASE = "/api/bots/atlas/secret-cards/card-1";
  function route(over: Partial<{ visible: boolean; context: SecretAnswerContext }> = {}) {
    const savedChoices = vi.fn(() => [{ id: "s1", name: "Stripe secret key" }]);
    const useSavedSecret = vi.fn(async () => ({ status: 200, body: { provided: true, resumed: true } }));
    const cards = { secretMessage: vi.fn(() => ({ id: "card-1" })), savedChoices, useSavedSecret } as unknown as SecretCards;
    const handler = createSecretCardRoutes({
      cards, phoneSecretSubmissions: { has: () => false }, threadVisible: () => over.visible ?? true, answerContext: () => over.context ?? team(null, "p:boss"),
    });
    return { handler, savedChoices, useSavedSecret };
  }
  const context = (method: "GET" | "POST", end: string, body: unknown = {}, contentType = "application/json"): RouteContext => ({
    req: { headers: { "content-type": contentType } } as unknown as IncomingMessage, res: { setHeader: vi.fn() } as unknown as ServerResponse,
    path: `${BASE}/${end}`, method, url: new URL(`${BASE}/${end}?threadId=thread-1`, "http://fixture.invalid"), auth: ADMIN,
    readBody: vi.fn(async () => body), json: vi.fn(),
  });

  it("names the choices and uses the one picked", async () => {
    const { handler, useSavedSecret } = route();
    const list = context("GET", "saved");
    await handler(list);
    expect(list.json).toHaveBeenCalledExactlyOnceWith(list.res, 200, { choices: [{ id: "s1", name: "Stripe secret key" }] });
    const use = context("POST", "use", { threadId: "thread-1", itemId: "s1" });
    await handler(use);
    expect(useSavedSecret).toHaveBeenCalledExactlyOnceWith("atlas", "thread-1", "card-1", "s1");
    expect(use.json).toHaveBeenCalledExactlyOnceWith(use.res, 200, { provided: true, resumed: true });
  });

  it("refuses a form post, a hidden conversation and someone else's card before anything is used", async () => {
    for (const [over, contentType, status] of [[{}, "text/plain", 415], [{ visible: false }, "application/json", 404], [{ context: team("p:ada", "p:bob") }, "application/json", 403]] as const) {
      const { handler, useSavedSecret } = route(over);
      const use = context("POST", "use", { threadId: "thread-1", itemId: "s1" }, contentType);
      await handler(use);
      expect(useSavedSecret).not.toHaveBeenCalled();
      expect(vi.mocked(use.json).mock.calls[0]?.[1]).toBe(status);
    }
  });
});
