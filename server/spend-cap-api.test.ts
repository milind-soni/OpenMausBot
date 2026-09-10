// The monthly spend cap and sell prices through real turns: the isolated
// fake-engine fixture booted with a stand-in enterprise layer that grants
// `budgets` and `billing`, the shared control surface for sends and waits,
// and the cap read back from /api/usage. No real licence, engine, or
// provider is involved; the fixture's home is disposable.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    session = await launchVerificationServer(
      { ...process.env, FAKE_CLAUDE_MODE: "slow" },
      undefined,
      undefined,
      undefined,
      { dir: layerDir, licenseKey: "fixture-key" },
    );
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
    await removeTempDir(layerDir);
  });

  const control = (args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const put = (body: unknown) => api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const post = (path: string, body: unknown, token?: string) => api(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const send = (botId: string, text: string) => api(`/api/bots/${encodeURIComponent(botId)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const pair = async (label: string) => {
    const opened = (await (await post("/api/auth/pairing", {})).json()) as { code: string };
    const paired = (await (await post("/api/auth/pair", { code: opened.code, label })).json()) as { token: string };
    expect(paired.token).toBeTypeOf("string");
    return paired.token;
  };

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

  it("books each room member and checks the cap again before the next member dispatch", async () => {
    expect((await put({ budgets: { monthlyUsd: 0.005 } })).status).toBe(200);
    const first = await control(["new-bot", "--name", "Room first"]);
    const second = await control(["new-bot", "--name", "Room second"]);
    const firstId = first.bot.id as string;
    const secondId = second.bot.id as string;
    const created = await post("/api/groups", {
      name: "Budget room",
      memberIds: [firstId, secondId],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
    expect(created.status).toBe(201);
    const groupId = ((await created.json()) as any).group.id as string;

    expect((await post(`/api/groups/${groupId}/messages`, { text: "First bounded round" })).status).toBe(202);
    await expect.poll(async () => {
      const [usage, fleet] = await Promise.all([
        api("/api/usage").then((response) => response.json()) as Promise<any>,
        api("/api/bots?messages=50").then((response) => response.json()) as Promise<any>,
      ]);
      const room = fleet.groups.find((candidate: { id: string }) => candidate.id === groupId);
      const speakers = [...new Set(room?.messages
        .filter((message: any) => message.role === "bot" && message.kind === "text" && message.from?.botId)
        .map((message: any) => message.from.botId) ?? [])];
      const capErrors = room?.messages.filter((message: any) =>
        message.kind === "activity" && /monthly spend limit/i.test(message.tool?.name ?? "")
      ).length ?? 0;
      return {
        working: room?.working,
        turns: usage.total?.turns,
        spentUsd: usage.budget?.spentUsd,
        speakers,
        capErrors,
      };
    }, { timeout: 30_000 }).toEqual({
      working: false,
      turns: 1,
      spentUsd: 0.01,
      speakers: [firstId],
      capErrors: 1,
    });

    // A detached scheduled goal reaches the same dispatch guard. The cap is
    // a blocked business condition, not a transient provider failure to retry.
    const routine = await post("/api/routines", {
      name: "Capped room goal",
      prompt: "Coordinate work without exceeding the cap",
      target: "room-goal",
      groupId,
      botId: firstId,
      runOn: "maus",
      schedule: { type: "once", at: Date.now() + 60_000 },
      durationMinutes: 30,
    });
    expect(routine.status).toBe(201);
    const routineId = ((await routine.json()) as any).routine.id as string;
    const started = await post(`/api/routines/${routineId}/run`, {});
    expect(started.status).toBe(201);
    const runId = ((await started.json()) as any).run.id as string;
    await expect.poll(async () => {
      const calendar = (await (await api("/api/routines")).json()) as any;
      const run = calendar.runs.find((candidate: { id: string }) => candidate.id === runId);
      return { status: run?.status, goalStatus: run?.goalStatus, error: run?.error };
    }, { timeout: 10_000 }).toEqual({
      status: "failed",
      goalStatus: "blocked",
      error: expect.stringMatching(/monthly spend limit/i),
    });

    // Raising the cap preserves normal room fan-out; both settled members are
    // durable ledger rows attributed to their own bot.
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    expect((await post(`/api/groups/${groupId}/messages`, { text: "Second complete round" })).status).toBe(202);
    await expect.poll(async () => {
      const usage = (await (await api("/api/usage?groupBy=bot")).json()) as any;
      return {
        turns: usage.total?.turns,
        costUsd: usage.total?.costUsd,
        byBot: usage.groups.map((entry: any) => [entry.key, entry.turns]),
      };
    }, { timeout: 30_000 }).toEqual({
      turns: 3,
      costUsd: 0.03,
      byBot: expect.arrayContaining([
        [`bot:${firstId}`, 2],
        [`bot:${secondId}`, 1],
      ]),
    });
  }, 150_000);

  it("attributes a room-goal member turn to its routine", async () => {
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    const lead = await control(["new-bot", "--name", "Routine lead"]);
    const leadId = lead.bot.id as string;
    const created = await post("/api/groups", {
      name: "Routine accounting room",
      memberIds: [leadId],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
    expect(created.status).toBe(201);
    const groupId = ((await created.json()) as any).group.id as string;

    const routine = await post("/api/routines", {
      name: "Routine ledger attribution",
      prompt: "Coordinate this bounded fixture goal",
      target: "room-goal",
      groupId,
      botId: leadId,
      runOn: "maus",
      schedule: { type: "once", at: Date.now() + 60_000 },
      durationMinutes: 30,
    });
    expect(routine.status).toBe(201);
    const routineId = ((await routine.json()) as any).routine.id as string;
    const started = await post(`/api/routines/${routineId}/run`, {});
    expect(started.status).toBe(201);
    const runId = ((await started.json()) as any).run.id as string;

    // The generic fake reply is not a valid goal decision, so the run fails
    // after one real coordinator turn. That settled turn still belongs to
    // the routine even though its intermediate event is not a routine result.
    await expect.poll(async () => {
      const calendar = (await (await api("/api/routines")).json()) as any;
      return calendar.runs.find((candidate: { id: string }) => candidate.id === runId)?.status;
    }, { timeout: 30_000 }).toBe("failed");
    await expect.poll(async () => {
      const usage = (await (await api("/api/usage?groupBy=user")).json()) as any;
      return { turns: usage.total?.turns, groups: usage.groups };
    }, { timeout: 10_000 }).toEqual({
      turns: 1,
      groups: [expect.objectContaining({
        key: `routine:${routineId}`,
        label: "Routine: Routine ledger attribution",
        turns: 1,
      })],
    });
  }, 150_000);

  it("keeps each user's attribution across two queued room turns", async () => {
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    const alice = await pair("Alice device");
    const bob = await pair("Bob device");
    const carol = await pair("Carol device");
    const createdBot = await control(["new-bot", "--name", "Queue accountant"]);
    const botId = createdBot.bot.id as string;
    const created = await post("/api/groups", {
      name: "Queued accounting room",
      memberIds: [botId],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
    expect(created.status).toBe(201);
    const groupId = ((await created.json()) as any).group.id as string;

    expect((await post(`/api/groups/${groupId}/messages`, { text: "Alice's turn" }, alice)).status).toBe(202);
    // Slow mode emits an assistant item before its gated completion. Seeing
    // it proves the first provider dispatch (and its usage snapshot) exists.
    await expect.poll(async () => {
      const fleet = (await (await api("/api/bots?messages=50")).json()) as any;
      const room = fleet.groups.find((candidate: { id: string }) => candidate.id === groupId);
      return {
        working: room?.working,
        hasInFlightReply: room?.messages.some((message: any) => message.role === "bot" && message.kind === "text"),
      };
    }, { timeout: 30_000 }).toEqual({ working: true, hasInFlightReply: true });

    const queued = await post(`/api/groups/${groupId}/messages`, { text: "Bob's queued turn" }, bob);
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ queued: true });
    const queuedSecond = await post(`/api/groups/${groupId}/messages`, { text: "Carol's queued turn" }, carol);
    expect(queuedSecond.status).toBe(202);
    expect(await queuedSecond.json()).toMatchObject({ queued: true });

    await expect.poll(async () => {
      const [usage, fleet] = await Promise.all([
        api("/api/usage?groupBy=user").then((response) => response.json()) as Promise<any>,
        api("/api/bots?messages=50").then((response) => response.json()) as Promise<any>,
      ]);
      const room = fleet.groups.find((candidate: { id: string }) => candidate.id === groupId);
      return {
        working: room?.working,
        turns: usage.total?.turns,
        byUser: usage.groups.map((entry: any) => [entry.key, entry.turns]),
      };
    }, { timeout: 30_000 }).toEqual({
      working: false,
      turns: 3,
      byUser: expect.arrayContaining([
        ["user:alice device", 1],
        ["user:bob device", 1],
        ["user:carol device", 1],
      ]),
    });
  }, 150_000);

  it("keeps calendar turns owner-attributed when a paired user queues behind them", async () => {
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    const user = await pair("Dana device");
    const first = await control(["new-bot", "--name", "Calendar queue first"]);
    const second = await control(["new-bot", "--name", "Calendar queue second"]);
    const firstId = first.bot.id as string;
    const secondId = second.bot.id as string;

    const call = await post("/api/calendar-calls", {
      name: "Calendar queue attribution",
      description: "Keep this occurrence attributed to its owner",
      botIds: [firstId, secondId],
      schedule: { type: "once", at: Date.now() - 100 },
      durationMinutes: 5,
    });
    expect(call.status).toBe(201);
    const callId = ((await call.json()) as any).call.id as string;
    let roomId: string | undefined;
    // The first calendar member has dispatched but not completed. Queueing a
    // paired send now must not retag the calendar operation's second member.
    await expect.poll(async () => {
      const fleet = (await (await api("/api/bots?messages=50")).json()) as any;
      const room = fleet.groups.find((candidate: any) => candidate.messages?.some(
        (message: any) => message.sendId?.startsWith(`calendar_${callId}_`),
      ));
      if (room) roomId = room.id;
      return Boolean(
        room?.working &&
        room.messages.some((message: any) => message.role === "bot" && message.kind === "text"),
      );
    }, { timeout: 30_000 }).toBe(true);
    expect(roomId).toBeTypeOf("string");

    const queued = await post(`/api/groups/${roomId}/messages`, { text: "Dana's queued follow-up" }, user);
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ queued: true });

    await expect.poll(async () => {
      const [usage, fleet] = await Promise.all([
        api("/api/usage?groupBy=user").then((response) => response.json()) as Promise<any>,
        api("/api/bots?messages=50").then((response) => response.json()) as Promise<any>,
      ]);
      const room = fleet.groups.find((candidate: { id: string }) => candidate.id === roomId);
      return {
        working: room?.working,
        turns: usage.total?.turns,
        byUser: usage.groups.map((entry: any) => [entry.key, entry.turns]),
      };
    }, { timeout: 30_000 }).toEqual({
      working: false,
      turns: 4,
      byUser: expect.arrayContaining([
        ["owner", 2],
        ["user:dana device", 2],
      ]),
    });
  }, 150_000);

  it("does not let a due calendar call dispatch above the cap and books it normally after the cap is raised", async () => {
    expect((await put({ budgets: { monthlyUsd: 0.005 } })).status).toBe(200);
    const first = await control(["new-bot", "--name", "Calendar first"]);
    const second = await control(["new-bot", "--name", "Calendar second"]);
    const firstId = first.bot.id as string;
    const secondId = second.bot.id as string;

    expect((await send(firstId, "Consume the initial allowance")).status).toBe(202);
    expect(JSON.stringify(await control(["wait", "--bot", firstId, "--timeout", "30"]))).toContain("settled");
    await expect.poll(async () => ((await (await api("/api/usage")).json()) as any).total?.turns, {
      timeout: 10_000,
    }).toBe(1);

    const blockedCall = await post("/api/calendar-calls", {
      name: "Blocked calendar call",
      description: "Must not dispatch above the cap",
      botIds: [firstId, secondId],
      schedule: { type: "once", at: Date.now() - 100 },
      durationMinutes: 5,
    });
    expect(blockedCall.status).toBe(201);
    const blockedCallId = ((await blockedCall.json()) as any).call.id as string;
    await expect.poll(async () => {
      const [usage, fleet] = await Promise.all([
        api("/api/usage").then((response) => response.json()) as Promise<any>,
        api("/api/bots?messages=50").then((response) => response.json()) as Promise<any>,
      ]);
      const room = fleet.groups.find((candidate: any) => candidate.messages?.some(
        (message: any) => message.sendId?.startsWith(`calendar_${blockedCallId}_`),
      ));
      return {
        roomCreated: Boolean(room),
        working: room?.working,
        turns: usage.total?.turns,
        replies: room?.messages.filter((message: any) => message.role === "bot" && message.kind === "text").length ?? 0,
        capErrors: room?.messages.filter((message: any) =>
          message.kind === "activity" && /monthly spend limit/i.test(message.tool?.name ?? "")
        ).length ?? 0,
      };
    }, { timeout: 30_000 }).toEqual({
      roomCreated: true,
      working: false,
      turns: 1,
      replies: 0,
      capErrors: 1,
    });

    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    const allowedCall = await post("/api/calendar-calls", {
      name: "Allowed calendar call",
      description: "Both members should answer and be booked",
      botIds: [firstId, secondId],
      schedule: { type: "once", at: Date.now() - 100 },
      durationMinutes: 5,
    });
    expect(allowedCall.status).toBe(201);
    const allowedCallId = ((await allowedCall.json()) as any).call.id as string;
    await expect.poll(async () => {
      const [usage, fleet] = await Promise.all([
        api("/api/usage?groupBy=bot").then((response) => response.json()) as Promise<any>,
        api("/api/bots?messages=50").then((response) => response.json()) as Promise<any>,
      ]);
      const room = fleet.groups.find((candidate: any) => candidate.messages?.some(
        (message: any) => message.sendId?.startsWith(`calendar_${allowedCallId}_`),
      ));
      const speakers = [...new Set(room?.messages
        .filter((message: any) => message.role === "bot" && message.kind === "text" && message.from?.botId)
        .map((message: any) => message.from.botId) ?? [])].sort();
      return { turns: usage.total?.turns, costUsd: usage.total?.costUsd, working: room?.working, speakers };
    }, { timeout: 30_000 }).toEqual({
      turns: 3,
      costUsd: 0.03,
      working: false,
      speakers: [firstId, secondId].sort(),
    });
  }, 150_000);
});
