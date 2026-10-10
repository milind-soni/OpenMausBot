// The usage ledger through real settled turns: the isolated fake-engine
// fixture, the shared control surface for sends and waits, and the ledger
// file plus /api/usage read back as the owner and as a paired device. It
// never touches a live instance; the fixture's home is disposable.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

describe("usage ledger through real turns", () => {
  let session: VerificationServer;

  beforeEach(async () => {
    session = await launchVerificationServer();
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
  });

  const control = (args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const jsonRequest = (body: unknown, token?: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const pair = async (label: string, scopes?: string[]) => {
    const opened = (await (await api("/api/auth/pairing", jsonRequest(scopes ? { scopes } : {}))).json()) as { code: string };
    const paired = (await (await api("/api/auth/pair", jsonRequest({ code: opened.code, label }))).json()) as { token: string };
    expect(paired.token).toBeTypeOf("string");
    return paired.token;
  };

  it("writes one row per settled turn naming who asked, and reports it by person, bot and model", async () => {
    const created = await control(["new-bot", "--name", "Ledger probe"]);
    const botId = created.bot.id as string;

    // Turn 1: this computer, through the control surface (loopback = owner).
    await control(["send", "--bot", botId, "--text", "hello from the owner"]);
    expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");

    // Turn 2: a paired device. Without an email sign-in the ledger names it
    // by its device label, which is still a person, not the machine.
    const phone = await pair("Ada's phone");
    const sent = await api(`/api/bots/${encodeURIComponent(botId)}/messages`, jsonRequest({ text: "hello from a phone" }, phone));
    expect([200, 201, 202]).toContain(sent.status);
    expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");

    const file = join(session.info.dataDir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    await expect.poll(() => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0), { timeout: 10_000 }).toBe(2);
    const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({
      botId, botName: "Ledger probe", instanceId: "claude", driverKind: "claudeAgent", costUsd: 0.01, trigger: { kind: "owner" },
    });
    expect(rows[0].input).toBeGreaterThanOrEqual(10);
    expect(rows[0].output).toBeGreaterThanOrEqual(1);
    expect(rows[0].model).toBeTypeOf("string");
    expect(rows[1]).toMatchObject({ botId, costUsd: 0.01, trigger: { kind: "user", label: "Ada's phone" } });
    // Bookkeeping, never transcript: no message text reaches the ledger.
    expect(readFileSync(file, "utf8")).not.toContain("hello from");

    const byUser = (await (await api("/api/usage?groupBy=user")).json()) as any;
    expect(byUser.groups.map((g: any) => [g.key, g.turns, g.costUsd])).toEqual(
      expect.arrayContaining([["owner", 1, 0.01], ["user:ada's phone", 1, 0.01]]),
    );
    expect(byUser.total).toMatchObject({ turns: 2, unpriced: 0 });
    expect(byUser.total.costUsd).toBeCloseTo(0.02, 6);
    const byBot = (await (await api("/api/usage?groupBy=bot")).json()) as any;
    expect(byBot.groups).toEqual([expect.objectContaining({ key: `bot:${botId}`, label: "Ledger probe", turns: 2 })]);

    const csv = await api("/api/usage.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).trim().split("\n")).toHaveLength(3);

    // A chat-only device may spend but not audit.
    const client = await pair("Client phone", ["client"]);
    expect((await api("/api/usage", { headers: { authorization: `Bearer ${client}` } })).status).toBe(403);
    expect((await api("/api/usage.csv", { headers: { authorization: `Bearer ${client}` } })).status).toBe(403);
  }, 120_000);
});
