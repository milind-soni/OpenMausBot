// The monthly spend cap and sell prices through real turns: the isolated
// fake-engine fixture booted with a stand-in enterprise layer that grants
// `budgets` and `billing`, the shared control surface for sends and waits,
// and the cap read back from /api/usage. No real licence, engine, or
// provider is involved; the fixture's home is disposable.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("spend cap and prices through real turns", () => {
  let session: VerificationServer;
  let layerDir: string;

  beforeEach(async () => {
    // The folder shape core looks for: <dir>/server/index.js exporting register().
    layerDir = mkdtempSync(join(tmpdir(), "omb-fake-layer-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["budgets", "billing"], expiresAt: "2099-01-01" }; }\n');
    session = await launchVerificationServer(process.env, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
    await removeTempDir(layerDir);
  });

  const control = (args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const put = (body: unknown) => api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = (botId: string, text: string) => api(`/api/bots/${encodeURIComponent(botId)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });

  it("refuses the next turn once the month reaches the cap, prices turns, and lets a raised cap through", async () => {
    const edition = (await (await api("/api/edition")).json()) as { edition: string; features: string[] };
    expect(edition).toMatchObject({ edition: "enterprise", features: ["billing", "budgets"] });

    // The fake engine reports $0.01 per turn: a $0.015 cap allows two turns and refuses the third.
    expect((await put({ budgets: { monthlyUsd: 0.015, warnAtPercent: 50 }, billing: { currency: "USD", prices: { default: { inputPerMillion: 1000, outputPerMillion: 2000 } } } })).status).toBe(200);
    const created = await control(["new-bot", "--name", "Cap probe"]);
    const botId = created.bot.id as string;

    for (const text of ["first", "second"]) {
      expect((await send(botId, text)).status).toBeLessThan(300);
      expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
    }
    const refused = await send(botId, "third");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "spend_cap", error: expect.stringContaining("$0.015") });

    const usage = (await (await api("/api/usage?groupBy=bot")).json()) as any;
    expect(usage.budget).toMatchObject({ monthlyUsd: 0.015, exceeded: true, warn: true });
    expect(usage.budget.spentUsd).toBeCloseTo(0.02, 6);
    expect(usage.billing).toEqual({ currency: "USD" });
    expect(usage.groups).toHaveLength(1);
    expect(usage.groups[0].turns).toBe(2);
    // priced from the list: tokens × the default rates, twice
    const perTurn = (usage.total.input / 2) * 1000 / 1_000_000 + (usage.total.output / 2) * 2000 / 1_000_000;
    expect(usage.total.billableUsd).toBeCloseTo(perTurn * 2, 9);
    expect(usage.groups[0].billableUsd).toBeCloseTo(perTurn * 2, 9);
    const csv = await (await api("/api/usage.csv")).text();
    expect(csv.split("\n")[0]).toContain("billable_usd");

    // A chat-only device sees the same refusal, not a silent drop.
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    expect((await send(botId, "fourth")).status).toBeLessThan(300);
    expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
    const raised = (await (await api("/api/usage")).json()) as any;
    expect(raised.budget).toMatchObject({ monthlyUsd: 1, exceeded: false });
    expect(raised.total.turns).toBe(3);
  }, 150_000);

  it.each([1, 2])("blocks a goal after %i paid turn(s) without retrying or spending another turn", async (allowedTurns) => {
    await session.close();
    const replyState = join(layerDir, "reply-state");
    session = await launchVerificationServer({
      ...process.env,
      FAKE_CLAUDE_REPLIES: JSON.stringify([
        'Delegating the check.<openmaus-goal>{"status":"continue","next":"Worker","instruction":"Check the draft"}</openmaus-goal>',
        "The draft has been checked.",
      ]),
      FAKE_CLAUDE_REPLY_STATE: replyState,
    }, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
    expect((await put({ budgets: { monthlyUsd: allowedTurns * 0.01 } })).status).toBe(200);
    const lead = (await control(["new-bot", "--name", "Lead"])).bot;
    const worker = (await control(["new-bot", "--name", "Worker"])).bot;
    const created = await api("/api/groups", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Budgeted goal", memberIds: [lead.id, worker.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } }),
    });
    expect(created.status).toBe(201);
    const { group } = await created.json() as any;
    expect((await api(`/api/groups/${group.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Check the draft and report back", mode: "goal" }),
    })).status).toBe(202);
    await control(["wait", "--channel", group.id, "--timeout", "30"]);

    const page = await (await api(`/api/threads/${group.threadId}/messages?limit=50`)).json() as any;
    const goal = page.messages.find((message: any) => message.kind === "goal.run")?.goalRun;
    expect(goal).toMatchObject({ status: "blocked", turnCount: allowedTurns,
      detail: expect.stringMatching(/reached its monthly spend limit/i) });
    const capErrors = page.messages.filter((message: any) => message.kind === "activity" &&
      /reached its monthly spend limit/i.test(message.tool?.name ?? ""));
    expect(capErrors).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("retrying once");
    expect(Number(readFileSync(replyState, "utf8"))).toBe(allowedTurns);
    const usage = await (await api("/api/usage")).json() as any;
    expect(usage.total.turns).toBe(allowedTurns);
    expect(usage.budget.exceeded).toBe(true);
  }, 150_000);

  it("refuses the next room member at execution time once the cap is reached", async () => {
    const edition = (await (await api("/api/edition")).json()) as { edition: string; features: string[] };
    expect(edition).toMatchObject({ edition: "enterprise", features: ["billing", "budgets"] });

    // The fake engine reports $0.01 per turn. A $0.01 cap lets the first room
    // member complete its turn, then blocks the second member inside
    // runGroupMemberTurn before it can dispatch another provider turn.
    expect((await put({
      budgets: { monthlyUsd: 0.01, warnAtPercent: 50 },
      billing: { currency: "USD", prices: { default: { inputPerMillion: 1000, outputPerMillion: 2000 } } },
    })).status).toBe(200);

    const first = (await control(["new-bot", "--name", "Room A"])) as { bot: { id: string } };
    const second = (await control(["new-bot", "--name", "Room B"])) as { bot: { id: string } };

    const roomRes = await api("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Cap room",
        memberIds: [first.bot.id, second.bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      }),
    });
    expect(roomRes.status).toBe(201);
    const room = (await roomRes.json()) as { group: { id: string; threadId: string } };

    const sent = await api(`/api/groups/${encodeURIComponent(room.group.id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello team" }),
    });
    expect(sent.status).toBe(202);

    await control(["wait", "--channel", room.group.id, "--timeout", "30"]);

    const page = (await (await api(`/api/threads/${encodeURIComponent(room.group.threadId)}/messages?limit=20`)).json()) as any;
    const botTextReplies = page.messages.filter((m: any) => m.role === "bot" && m.kind === "text");
    expect(botTextReplies).toHaveLength(1);

    const capHit = page.messages.find(
      (m: any) => m.role === "bot" && m.kind === "activity" && /reached its monthly spend limit/i.test(m.tool?.name ?? ""),
    );
    expect(capHit).toBeTruthy();

    const usage = (await (await api("/api/usage")).json()) as any;
    expect(usage.budget).toMatchObject({ monthlyUsd: 0.01, exceeded: true, warn: true });
    expect(usage.total.turns).toBe(1);
  }, 150_000);
});
