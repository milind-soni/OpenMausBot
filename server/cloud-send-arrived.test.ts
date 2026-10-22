import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { arrivedRoute, homeRoute, movedFrom, webhookHomeLine, webhookMovedLine } from "./cloud-send-arrived.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cloud(owner = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-arrived-")); dirs.push(dataDir);
  const lines: Array<{ threadId: string; text?: string }> = [];
  const deps = {
    dataDir,
    store: { bot: (id: string) => (id === "scout" ? { threadId: "t-scout" } : undefined), appendMessage: (threadId: string, message: { text?: string }) => { lines.push({ threadId, text: message.text }); return message; } } as never,
    webhooks: () => ({ list: () => [{ id: "w1", name: "Orders", botId: "scout" }, { id: "w2", name: "Gone", botId: "nobody" }] }) as never,
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
});
