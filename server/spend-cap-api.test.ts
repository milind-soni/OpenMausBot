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
import { openSse } from "./testing/sse.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";
import { ORGANIZE_MARKER } from "./memory-organize.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";
import { readUsage } from "./usage-ledger.ts";

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

  it("books memory helper usage and checks the cap before every background call", async () => {
    await session.close();
    const routes = join(layerDir, "memory-replies.json");
    const dump = join(layerDir, "memory-call.json");
    writeFileSync(routes, JSON.stringify({
      [CAPTURE_MARKER]: '[{"text":"Project codename is Bluebird","kind":"fact","confidence":0.9}]',
      [ORGANIZE_MARKER]: '{"moves":[]}',
      [TIDY_MARKER]: '{"pairs":[]}',
    }));
    session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_TEXT_DUMP: dump },
      undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
    const created = await api("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Budgeted memory" }) });
    expect(created.status).toBe(201);
    const { bot } = await created.json() as any;
    const memory = `/api/bots/${bot.id}/memory`;
    const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const rows = () => readUsage(session.info.dataDir, { from: new Date(Date.now() - 86_400_000), to: new Date() }).filter((row) => row.botId === bot.id);
    const tidy = async () => {
      const response = await api(`${memory}/tidy`, json("POST"));
      expect(response.status).toBe(200);
      return (await response.json() as any).report;
    };
    const text = async () => (await (await api(`${memory}/file?path=MEMORY.md`)).json() as any).text as string;
    expect((await api(`${memory}/file`, json("PUT", { path: "MEMORY.md", text:
      Array.from({ length: 5 }, (_, i) => `- 2026-01-01 · Project note ${i}\n`).join("") +
      "- 2026-01-01 · Expired appointment · until 2026-01-02\n" }))).status).toBe(200);
    expect((await put({ budgets: { monthlyUsd: 0.01 }, memory: { captureQuietMs: 1_000 } })).status).toBe(200);

    // Organize spends the cap; the contradiction call in the same pass must
    // never reach the provider. Free deterministic cleanup still runs.
    const notices = await openSse(`${session.info.url}/api/events`);
    try {
      expect(await tidy()).toMatchObject({ expired: 1, contradictionsChecked: false });
      await notices.until((frame) => frame.kind === "notify" && frame.notification?.kind === "spend", 5_000);
      const notice = notices.frames.find((frame) => frame.kind === "notify" && frame.notification?.kind === "spend");
      // Notification navigation needs a real chat, not the ledger-only ID.
      expect(notice.notification).toMatchObject({ botId: bot.id, threadId: bot.threadId });
    } finally {
      notices.close();
    }
    await expect.poll(rows).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      botId: bot.id, botName: bot.name, driverKind: "claudeAgent", model: "claude-haiku-4-5",
      input: 15, output: 5, cachedInput: 2, costUsd: 0.01, costSource: "reported",
      trigger: { kind: "bot", botId: bot.id }, threadId: expect.stringMatching(/^memory-/),
    });
    const atCap = readFileSync(dump, "utf8");
    expect(JSON.parse(atCap).prompt).toContain(ORGANIZE_MARKER);
    expect(await text()).not.toContain("Expired appointment");
    expect(await tidy()).toMatchObject({ contradictionsChecked: false });
    expect(readFileSync(dump, "utf8")).toBe(atCap);
    expect(rows()).toHaveLength(1);

    // Raising the cap permits the remaining model step and records a unique
    // background call, without changing the bot's main thread/model.
    expect((await put({ budgets: { monthlyUsd: 0.03 } })).status).toBe(200);
    expect(await tidy()).toMatchObject({ contradictionsChecked: true });
    await expect.poll(rows).toHaveLength(2);
    expect(new Set(rows().map((row) => row.threadId)).size).toBe(2);
    const lastTidyCall = readFileSync(dump, "utf8");
    expect(JSON.parse(lastTidyCall).prompt).toContain(TIDY_MARKER);

    // A foreground turn reaches the cap; its automatic capture is blocked.
    expect((await send(bot.id, "Project codename is Bluebird.")).status).toBeLessThan(300);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);
    await expect.poll(async () => (await (await api(`${memory}/upkeep`)).json() as any).lastCapture,
      { timeout: 15_000 }).toMatchObject({ added: 0 });
    expect(readFileSync(dump, "utf8")).toBe(lastTidyCall);
    expect(await text()).not.toContain("Bluebird");

    // Another turn after raising the cap allows capture, which itself
    // crosses the cap. The following organization call must be skipped.
    expect((await put({ budgets: { monthlyUsd: 0.045 } })).status).toBe(200);
    expect((await send(bot.id, "Remember the project codename is Bluebird.")).status).toBeLessThan(300);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);
    await expect.poll(text, { timeout: 15_000 }).toContain("Bluebird");
    await expect.poll(rows).toHaveLength(5);
    expect(JSON.parse(readFileSync(dump, "utf8")).prompt).toContain(CAPTURE_MARKER);
    const usage = await (await api("/api/usage")).json() as any;
    expect(usage.budget).toMatchObject({ exceeded: true });
    expect(usage.budget.spentUsd).toBeCloseTo(0.05);
    expect(rows().filter((row) => row.threadId.startsWith("memory-"))).toHaveLength(3);
  }, 120_000);

  it.each([
    { name: "missing usage stays unpriced", metadata: {}, costUsd: null, costSource: undefined },
    { name: "reported zero stays reported", metadata: { total_cost_usd: 0 }, costUsd: 0, costSource: "reported" },
    { name: "tokens without cost are estimated", metadata: { usage: { input_tokens: 10, output_tokens: 5 } }, costUsd: 0.000035, costSource: "estimated" },
  ])("memory helper accounting: $name", async ({ metadata, costUsd, costSource }) => {
    await session.close();
    session = await launchVerificationServer({ ...process.env,
      FAKE_CLAUDE_TEXT_RESULT: JSON.stringify({ type: "result", result: '{"moves":[]}', ...metadata }),
    }, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
    const { bot } = await control(["new-bot", "--name", "Helper usage"]);
    expect((await api(`/api/bots/${bot.id}/memory/file`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "MEMORY.md", text: "- 2026-01-01 · Prefers concise replies\n" }),
    })).status).toBe(200);
    expect((await api(`/api/bots/${bot.id}/memory/tidy`, { method: "POST" })).status).toBe(200);
    const rows = () => readUsage(session.info.dataDir, { from: new Date(Date.now() - 86_400_000), to: new Date() });
    await expect.poll(rows).toHaveLength(1);
    expect(rows()[0]!.costUsd).toBe(costUsd);
    expect(rows()[0]!.costSource).toBe(costSource);
  }, 60_000);

  it("refuses the next turn once the month reaches the cap, prices turns, and lets a raised cap through", async () => {
    const edition = (await (await api("/api/edition")).json()) as { edition: string; features: string[] };
    expect(edition).toMatchObject({ edition: "enterprise", features: ["billing", "budgets"] });

    // The fake engine reports $0.01 per turn: a $0.015 cap allows two turns and refuses the third.
    expect((await put({ budgets: { monthlyUsd: 0.015, warnAtPercent: 50 }, billing: { currency: "USD", prices: { default: { inputPerMillion: 1000, outputPerMillion: 2000 } } } })).status).toBe(200);
    const created = await control(["new-bot", "--name", "Cap probe"]);
    const botId = created.bot.id as string;

    // Admins hear about the warning and the cap once each; a chat-only
    // device's stream carries neither.
    const opened = (await (await api("/api/auth/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes: ["client"] }) })).json()) as { code: string };
    const paired = (await (await api("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: opened.code, label: "Member phone" }) })).json()) as { token: string };
    const adminStream = await openSse(`${session.info.url}/api/events`);
    const memberStream = await openSse(`${session.info.url}/api/events`, { authorization: `Bearer ${paired.token}` });
    const spendNotices = (frames: any[]) => frames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === "spend");

    try {
      for (const text of ["first", "second"]) {
        expect((await send(botId, text)).status).toBeLessThan(300);
        expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
      }
      // $0.01 of $0.015 crosses the 50% warning; $0.02 reaches the cap
      await adminStream.until((frame) => frame.kind === "notify" && frame.notification?.title === "Monthly spend limit reached", 20_000);
      expect(spendNotices(adminStream.frames).map((frame) => frame.notification)).toEqual([
        expect.objectContaining({ kind: "spend", botId, title: "Spend is at 67% of the monthly limit", body: expect.stringContaining("$0.01 of $0.015 spent this month") }),
        expect.objectContaining({ kind: "spend", botId, title: "Monthly spend limit reached" }),
      ]);
      expect(memberStream.frames.some((frame) => frame.kind === "notify" && frame.notification?.kind === "done")).toBe(true);
      expect(spendNotices(memberStream.frames)).toEqual([]);
    } finally {
      adminStream.close();
      memberStream.close();
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
    // The goal settles before the usage ledger's queued write is necessarily visible.
    await expect.poll(async () => (await (await api("/api/usage")).json() as any).total.turns,
      { timeout: 10_000 }).toBe(allowedTurns);
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
