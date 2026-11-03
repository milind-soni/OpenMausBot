import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { arrivedRoute, automationsOffRoute, homeRoute, movedFrom, webhookHomeLine, webhookMovedLine } from "./cloud-send-arrived.ts";
import "./server-line-packs.ts";
import type { MoveAutomations } from "./move-freeze.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cloud(owner = true, language?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-arrived-")); dirs.push(dataDir);
  const lines: Array<{ threadId: string; text?: string }> = [];
  const deps = {
    dataDir,
    store: { bot: (id: string) => (id === "scout" ? { threadId: "t-scout" } : undefined), appendMessage: (threadId: string, message: { text?: string }) => { lines.push({ threadId, text: message.text }); return message; } } as never,
    webhooks: () => ({ list: () => [{ id: "w1", name: "Orders", botId: "scout" }, { id: "w2", name: "Gone", botId: "nobody" }] }) as never,
    lineLanguage: (person?: string) => person === "p_owner" ? language : "en",
    owner: () => (owner ? { person: "p_owner", name: "Owner" } : null),
  };
  const ask = async (body: unknown) => {
    let answered: { status: number; body: any } | undefined;
    await arrivedRoute(deps, { path: "/api/cloud-send/arrived", method: "POST", req: {} as never, res: {} as never, auth: {} as never, url: new URL("http://x/"),
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    return answered!;
  };
  return { dataDir, lines, ask };
}

describe("POST /api/cloud-send/arrived", () => {
  it("keeps the computer the bots came from, and each webhook's bot says its new address is on its card, once", async () => {
    const { dataDir, lines, ask } = cloud();
    expect(await ask({ v: 1, computer: "MacBook Air", webhooks: ["w1", "w2", "w9"] })).toEqual({ status: 200, body: { v: 1, told: 1 } });
    expect(lines).toEqual([{ threadId: "t-scout", text: webhookMovedLine("Orders") }]);
    expect(lines[0]!.text).not.toMatch(/https?:/u);
    expect(movedFrom(dataDir)).toMatchObject({ computer: "MacBook Air", told: ["w1"] });
    expect(await ask({ v: 1, computer: "MacBook Air", webhooks: ["w1"] }), "a move resumed after a crash says nothing twice").toEqual({ status: 200, body: { v: 1, told: 0 } });
    expect(lines).toHaveLength(1);
  });

  it.each([
    [undefined, 'Now that I live on Garage server, my webhook "Orders" has a new address. Open Automations, choose Copy address on "Orders", and paste it into the app that sends to it.'],
    ["de", 'Jetzt, wo ich auf Garage server lebe, hat mein Webhook „Orders“ eine neue Adresse. Öffne Automatisierungen, wähle bei „Orders“ die Option „Adresse kopieren“ und füge sie in die App ein, die Daten dorthin sendet.'],
  ])("writes the move notice in the owner's language (%s), keeping the server and webhook names", async (language, text) => {
    const { lines, ask } = cloud(true, language);
    expect((await ask({ v: 1, computer: "MacBook Air", webhooks: ["w1"], place: "Garage server" })).status).toBe(200);
    expect(lines).toEqual([{ threadId: "t-scout", text }]);
  });

  it("only from My Cloud's owner", async () => {
    const { dataDir, lines, ask } = cloud(false);
    expect((await ask({ v: 1, computer: "MacBook Air", webhooks: ["w1"] })).status).toBe(403);
    expect([lines, movedFrom(dataDir)]).toEqual([[], null]);
  });
});

describe("POST /api/cloud-send/home", () => {
  it("once the bots came home, each bot that said its webhook had a new address on My Cloud says it has one here again, once", async () => {
    const { dataDir, lines, ask } = cloud();
    await ask({ v: 1, computer: "MacBook Air", webhooks: ["w1", "w2"] });
    lines.length = 0;
    const deps = { dataDir, store: { bot: (id: string) => (id === "scout" ? { threadId: "t-scout" } : undefined), appendMessage: (threadId: string, message: { text?: string }) => { lines.push({ threadId, text: message.text }); return message; } } as never,
      webhooks: () => ({ list: () => [{ id: "w1", name: "Orders", botId: "scout" }, { id: "w3", name: "Never moved", botId: "scout" }] }) as never };
    const home = async (body: unknown, method = "POST") => {
      let answered: { status: number; body: any } | undefined;
      const handled = await homeRoute(deps, { path: "/api/cloud-send/home", method, req: { resume() {} } as never, res: {} as never, auth: {} as never, url: new URL("http://x/"),
        json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
      return { handled, ...answered! };
    };
    expect((await home({ v: 2 })).status).toBe(400);
    expect(lines).toEqual([]);
    expect(await home({ v: 1 })).toEqual({ handled: true, status: 200, body: { v: 1, told: 1 } });
    expect(lines).toEqual([{ threadId: "t-scout", text: webhookHomeLine("Orders") }]);
    expect(lines[0]!.text).toContain("back on this computer");
    expect(lines[0]!.text).not.toMatch(/https?:/u);
    expect(movedFrom(dataDir), "where the bots came from no longer applies").toBeNull();
    expect((await home({ v: 1 })).body, "asked again: nothing twice").toEqual({ v: 1, told: 0 });
    expect(lines).toHaveLength(1);
    expect((await home({}, "GET")).status).toBe(405);
  });

  it("with `webhooks`, only the bots of those webhooks say it: the ones this computer brought, while My Cloud keeps other computers' bots", async () => {
    const { dataDir, lines, ask } = cloud();
    await ask({ v: 1, computer: "Studio iMac", webhooks: ["w1"] });
    lines.length = 0;
    const deps = { dataDir, store: { bot: () => ({ threadId: "t-scout" }), appendMessage: (threadId: string, message: { text?: string }) => { lines.push({ threadId, text: message.text }); return message; } } as never,
      webhooks: () => ({ list: () => [{ id: "w1", name: "Orders", botId: "scout" }] }) as never };
    let answered: { status: number; body: any } | undefined;
    await homeRoute(deps, { path: "/api/cloud-send/home", method: "POST", req: { resume() {} } as never, res: {} as never, auth: {} as never, url: new URL("http://x/"),
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => ({ v: 1, webhooks: ["w7"] }) } as never);
    expect(answered).toEqual({ status: 200, body: { v: 1, told: 0 } });
    expect(lines, "another computer's webhook stays on My Cloud: its bot says nothing here").toEqual([]);
  });
});

describe("POST /api/cloud-send/automations-off", () => {
  /** My Cloud's automations, all on: two computers' and one made there. */
  function automations() {
    const on = new Map([["routine:a1", true], ["routine:b1", true], ["call:a2", true], ["webhook:a3", true], ["app-event:a4", true], ["routine:c1", true], ["routine:a5", false]]);
    const id = (key: string) => key.slice(key.indexOf(":") + 1);
    const of = (kind: string) => [...on].filter(([key]) => key.startsWith(`${kind}:`)).map(([key, value]) => ({ id: id(key), value }));
    const turnOff = (kind: string) => async (target: string) => { on.set(`${kind}:${target}`, false); return null; };
    const deps = {
      routines: () => ({ listRoutines: () => of("routine").map(({ id: routine, value }) => ({ id: routine, enabled: value })), update: turnOff("routine") }),
      calls: () => ({ list: () => of("call").map(({ id: call, value }) => ({ id: call, nextRunAt: value ? 1 : null })), switchOff: (call: string) => { on.set(`call:${call}`, false); return true; } }),
      webhooks: () => ({ list: () => of("webhook").map(({ id: hook, value }) => ({ id: hook, enabled: value })), update: turnOff("webhook") }),
      appEvents: () => ({ list: () => of("app-event").map(({ id: trigger, value }) => ({ id: trigger, enabled: value })), update: turnOff("app-event") }),
      waits: () => null,
    } as unknown as MoveAutomations;
    return { on, deps };
  }
  const ask = async (deps: MoveAutomations, body: unknown, { owner = true, method = "POST" } = {}) => {
    let answered: { status: number; body: any } | undefined;
    const handled = await automationsOffRoute({ automations: deps, owner: () => (owner ? { person: "p_owner", name: "Owner" } : null) }, { path: "/api/cloud-send/automations-off", method,
      req: { resume() {} } as never, res: {} as never, auth: {} as never, url: new URL("http://x/"),
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    return { handled, ...answered! };
  };

  it("stops exactly the automations a computer brought, of every kind, and says which were on; the rest of My Cloud goes on", async () => {
    const { on, deps } = automations();
    expect(await ask(deps, { v: 1, keys: ["routine:a1", "call:a2", "webhook:a3", "app-event:a4", "routine:a5", "routine:gone"] }))
      .toEqual({ handled: true, status: 200, body: { v: 1, off: ["routine:a1", "call:a2", "webhook:a3", "app-event:a4"] } });
    expect(Object.fromEntries(on)).toEqual({ "routine:a1": false, "routine:b1": true, "call:a2": false, "webhook:a3": false, "app-event:a4": false, "routine:c1": true, "routine:a5": false });
    expect((await ask(deps, { v: 1, keys: ["routine:a1"] })).body, "asked again after a crash: nothing else changes").toEqual({ v: 1, off: [] });
  });

  it("only from My Cloud's owner, only by key, only POST", async () => {
    const { on, deps } = automations();
    expect((await ask(deps, { v: 1, keys: ["routine:b1"] }, { owner: false })).status).toBe(403);
    expect((await ask(deps, { v: 1, keys: ["bot:b1"] })).status).toBe(400);
    expect((await ask(deps, { v: 1, keys: ["routine:b1"] }, { method: "GET" })).status).toBe(405);
    expect([...on.values()].filter(Boolean)).toHaveLength(6);
  });
});
