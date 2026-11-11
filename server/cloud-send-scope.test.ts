import { describe, expect, it } from "vitest";

import { cloudSendSummary, type CloudSendSources } from "./cloud-send.ts";
import { createMoveScopes, moveScopeRoute, roomGoes } from "./cloud-send-scope.ts";
import type { BotRecord } from "./store.ts";

const bot = (id: string, extra: Partial<BotRecord> = {}) => ({ id, name: id, soul: "Be brief.", threadId: `t-${id}`, ...extra }) as unknown as BotRecord;

function sources(bots: BotRecord[]): CloudSendSources {
  return { appVersion: "1", bots: () => bots, greetingOnly: () => false, skills: () => [{ name: "notes", sha256: "a".repeat(64), enabled: true }], picture: () => null, logins: () => [], onePassword: () => null, settings: () => ({}),
    move: { botParts: () => ({}), items: (carried) => [...carried].flatMap((id) => [{ key: `routine:r-${id}`, kind: "routine" as const, label: "r", id: `r-${id}`, bot: id, parts: {} }, { key: `call:c-${id}`, kind: "call" as const, label: "c", id: `c-${id}`, bot: id, parts: {} }]) } };
}

describe("a move of some bots", () => {
  it("carries only the chosen bots, their skills and routines, what is the person's own, and no calendar call", () => {
    const summary = cloudSendSummary(sources([bot("a"), bot("b")]), { move: true, bots: new Set(["a"]) });
    expect(summary.items.map((item) => item.key)).toEqual(["bot:a", "skill:a:notes", "setting:profile", "setting:language", "routine:r-a"]);
  });

  it("never carries again a bot that lives elsewhere now, from the server it left", () => {
    const moved = bot("a", { movedTo: { team: { id: "my-cloud", name: "My Cloud" }, state: "moved", at: 1 }, hidden: true });
    const held = bot("b", { movedTo: { team: { id: "my-cloud", name: "My Cloud" }, state: "moving", at: 1 } });
    const keys = (options: Parameters<typeof cloudSendSummary>[1]) => cloudSendSummary(sources([moved, held]), options).items.filter((item) => item.kind === "bot").map((item) => item.id);
    expect(keys({ move: true, leaving: true }), "one on its way still goes").toEqual(["b"]);
    expect(keys({ move: true }), "the Cloud a bot left for a team still lists it").toEqual(["a", "b"]);
  });

  it("takes a room only when every bot in it goes, the helper every place has aside", () => {
    const helper = (id: string) => (id === "maus" ? { defaultBot: { v: 1 } } : {});
    expect(roomGoes({ memberIds: ["a", "b"] }, new Set(["a", "b"]), helper)).toBe(true);
    expect(roomGoes({ memberIds: ["a", "maus"] }, new Set(["a"]), helper)).toBe(true);
    expect(roomGoes({ memberIds: ["a", "b"] }, new Set(["a"]), helper), "b stays, and works in it here").toBe(false);
    expect(roomGoes({ memberIds: ["maus"] }, new Set(["a"]), helper), "none of its bots go").toBe(false);
  });

  it("names any number of bots once, and an answer that names no known choice is never read as all of them", async () => {
    const scopes = createMoveScopes();
    const ask = async (body: unknown, method = "POST") => {
      let answered: { status: number; body: any } | undefined;
      await moveScopeRoute(scopes, { path: "/api/cloud-send/scope", method, req: { resume() {} } as never, res: { setHeader() {} } as never, json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
      return answered!;
    };
    const many = Array.from({ length: 5_000 }, (_, i) => `bot-${i}`);
    const first = await ask({ v: 1, bots: many });
    expect(first.status).toBe(200);
    expect(scopes.get(first.body.scope)?.size).toBe(5_000);
    expect(scopes.get("nobody")).toBeNull();
    expect((await ask({ v: 1, bots: ["bad id"] })).status).toBe(400);
    for (let i = 0; i < 8; i++) await ask({ v: 1, bots: ["a"] });
    expect(scopes.get(first.body.scope), "only the latest few are kept").toBeNull();
  });
});
