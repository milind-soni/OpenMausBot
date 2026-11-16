// Usage caps on a real server with the scripted engine, whose every turn books $0.01: a cap set through the owner's route
// lets the turn that reaches it finish, then refuses a Bot API call and a webhook, counts a routine's scheduled run on one
// skipped row, tells the owner once, still answers the owner's own message, and lets everything start again once raised.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fixture: VerificationServer | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const client = (url: string) => {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const answer = await call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    return answer.body;
  };
  return { call, ok };
};
const outside = async (endpoint: string, key: string, message: string) => {
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ message }) });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() as any };
};
const newBot = async (url: string, name: string) => (await runControlOmb(["new-bot", "--name", name, "--url", url]) as { bot: { id: string; activeTaskId: string } }).bot;
const replies = async (ok: ReturnType<typeof client>["ok"], threadId: string) =>
  ((await ok("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[]).filter((line) => line.role === "bot" && line.kind === "text").length;

it("stops unattended work at a reached cap with one line each and one notice, keeps the owner's own message running, and resumes when raised", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284" });
  const { url, logPath } = fixture.info;
  const { call, ok } = client(url);
  const scout = await newBot(url, "Scout");
  const other = await newBot(url, "Other");
  const api = await ok("POST", `/api/bots/${scout.id}/bot-api`, { enabled: true });
  const hook = await ok("POST", "/api/webhooks", { name: "New lead", prompt: "Handle the lead.", botId: scout.id });

  // Nothing is capped until the owner sets a cap.
  expect(await ok("GET", "/api/usage/caps")).toEqual({ stops: "unattended", savedStops: "unattended", server: {}, bots: {}, env: { stops: false, server: [], values: { server: {} } }, caps: [] });
  expect((await call("PUT", "/api/usage/caps", { server: { dailyUsd: -1 } })).status).toBe(400);
  expect((await call("PUT", "/api/usage/caps", { bots: { nobody: { dailyUsd: 1 } } })).status).toBe(404);
  const set = await ok("PUT", "/api/usage/caps", { bots: { [scout.id]: { dailyUsd: 0.01, monthlyTokens: 0 } } });
  expect(set).toMatchObject({ stops: "unattended", server: {}, bots: { [scout.id]: { dailyUsd: 0.01 } } });
  expect(set.caps).toEqual([expect.objectContaining({ id: `bot:${scout.id}:day:usd`, limit: 0.01, used: 0, reached: false })]);
  expect(JSON.parse(readFileSync(`${fixture.info.dataDir}/config.json`, "utf8")).usageCaps).toEqual({ stops: "unattended", server: {}, bots: { [scout.id]: { dailyUsd: 0.01 } } });

  // The call that reaches the cap is answered in full: nothing is cut off mid-turn.
  const first = await outside(api.url, api.key, "Hello");
  expect([first.status, first.body.reply]).toEqual([200, "hello from fake claude"]);
  await expect.poll(async () => (await ok("GET", "/api/usage/caps")).caps[0], { timeout: hostTimeout(20_000) }).toMatchObject({ used: 0.01, percent: 100, warn: true, reached: true });

  // A Bot API call and a webhook delivery each get a clear refusal, and each is listed where its owner looks.
  const refused = await outside(api.url, api.key, "Hello again");
  expect(refused.status).toBe(429);
  expect(refused.body.error).toMatch(/^This bot has reached a usage cap its owner set, so it takes no new calls for now\. Try again after \d{4}-/);
  expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  expect((await ok("GET", `/api/bots/${scout.id}/bot-api`)).calls[0]).toMatchObject({ outcome: "rejected", statusCode: 429, reason: expect.stringContaining("Scout’s daily usage cap ($0.01) is reached") });
  const delivery = await fetch(hook.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "lead-1" }, body: JSON.stringify({ lead: "Ada" }) });
  expect(delivery.status).toBe(429);
  expect((await delivery.json() as any).error).toContain("Scout’s daily usage cap ($0.01) is reached");

  // A scheduled run is skipped and counted on one row; its routine stays on and nothing asks for attention.
  const { routine } = await ok("POST", "/api/routines", { name: "Hourly check", prompt: "Check.", botId: scout.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_000 } });
  await expect.poll(async () => (await ok("GET", "/api/routines")).runs.filter((run: any) => run.routineId === routine.id).map((run: any) => run.status), { timeout: hostTimeout(90_000), interval: 1_000 }).toEqual(["missed"]);
  const state = await ok("GET", "/api/routines");
  const skipped = state.runs.find((run: any) => run.routineId === routine.id);
  expect(skipped).toMatchObject({ skipped: { count: 1, behind: expect.stringMatching(new RegExp(`^cap:${routine.id}:bot:.+:day:usd:\\d{4}-\\d\\d-\\d\\d$`)) }, errorCode: "routines.server.capSkippedOne" });
  expect(skipped.error).toMatch(/^Skipped: this bot’s daily usage cap \(\$0\.01\) is reached\. Runs start again after /);
  expect(skipped.threadId).toBeUndefined();
  expect(state.routines.find((each: any) => each.id === routine.id)).toMatchObject({ enabled: true });
  expect(state.routines.find((each: any) => each.id === routine.id).nextRunAt).toBeGreaterThan(Date.now());

  // The owner's own message still runs, and so does a run they start by hand; another bot is not touched by this bot's cap.
  const before = await replies(ok, scout.activeTaskId);
  expect((await call("POST", `/api/bots/${scout.id}/messages`, { text: "Are you there?", threadId: scout.activeTaskId, sendId: randomUUID() })).status).toBeLessThan(300);
  await expect.poll(() => replies(ok, scout.activeTaskId), { timeout: hostTimeout(30_000) }).toBe(before + 1);
  const otherApi = await ok("POST", `/api/bots/${other.id}/bot-api`, { enabled: true });
  expect((await outside(otherApi.url, otherApi.key, "Hello")).status).toBe(200);

  // In a room too: the owner's line gets its answer from the capped bot.
  const room = (await ok("POST", "/api/groups", { name: "Desk", memberIds: [scout.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: scout.id } } })).group;
  expect((await call("POST", `/api/groups/${room.id}/messages`, { text: "Scout, are you there?" })).status).toBe(202);
  await runControlOmb(["wait", "--channel", room.id, "--timeout", "60", "--url", url]);
  const roomLines = (await ok("GET", `/api/threads/${room.threadId}/messages?limit=50`)).messages as any[];
  expect(roomLines.filter((line) => line.role === "bot" && line.kind === "text" && line.from?.botId === scout.id)).toHaveLength(1);
  expect(roomLines.filter((line) => /usage cap/.test(line.tool?.name ?? ""))).toEqual([]);

  // One notice for the cap, however many runs it skipped, and one line in the server log; no card anywhere.
  expect((await outside(api.url, api.key, "And again")).status).toBe(429);
  const notices = ((await ok("GET", "/api/notifications")).notifications as any[]).filter((notice) => notice.title === "Usage cap reached");
  expect(notices).toHaveLength(1);
  expect(notices[0].body).toContain("Scout’s daily usage cap ($0.01) is reached");
  expect(notices[0].body).toContain("Your own messages still run.");
  expect(readFileSync(logPath, "utf8").split("\n").filter((line) => line.startsWith("usage cap reached: "))).toHaveLength(1);
  const cards = ((await ok("GET", `/api/threads/${scout.activeTaskId}/messages?limit=200`)).messages as any[]).filter((line) => line.card);
  expect(cards).toEqual([]);

  // Under "everything" the owner's own message is refused too, in place.
  await ok("PUT", "/api/usage/caps", { stops: "everything", bots: { [scout.id]: { dailyUsd: 0.01 } } });
  const stopped = await call("POST", `/api/bots/${scout.id}/messages`, { text: "And now?", threadId: scout.activeTaskId, sendId: randomUUID() });
  expect([stopped.status, stopped.body.code]).toEqual([409, "spend_cap"]);
  expect(stopped.body.error).toContain("Scout’s daily usage cap ($0.01) is reached");

  expect((await call("POST", `/api/groups/${room.id}/messages`, { text: "And in here?" })).status).toBe(202);
  await runControlOmb(["wait", "--channel", room.id, "--timeout", "60", "--url", url]);
  const refusedInRoom = ((await ok("GET", `/api/threads/${room.threadId}/messages?limit=50`)).messages as any[]).filter((line) => /usage cap/.test(line.tool?.name ?? ""));
  expect(refusedInRoom).toHaveLength(1);
  expect(refusedInRoom[0].tool.name).toContain("Scout’s daily usage cap ($0.01) is reached");

  // Raising the cap is all it takes: the next call is answered.
  await ok("PUT", "/api/usage/caps", { bots: { [scout.id]: { dailyUsd: 5 } } });
  const resumed = await outside(api.url, api.key, "Back?");
  expect([resumed.status, resumed.body.reply]).toEqual([200, "hello from fake claude"]);

  // The Usage page's own data carries the caps for the owner, and how much of the period is unpriced or not billed.
  const today = new Date().toISOString().slice(0, 10);
  const usage = await ok("GET", `/api/usage?from=${today}&to=${today}&groupBy=bot`);
  expect(usage.caps.caps).toEqual([expect.objectContaining({ id: `bot:${scout.id}:day:usd`, limit: 5, reached: false })]);
  expect(usage.total).toMatchObject({ unpriced: 0 });
  expect(usage.notBilled).toEqual({ usd: expect.any(Number), turns: expect.any(Number) });
}, hostTimeout(300_000));

it("takes a headless server's caps from the environment, and they win over the saved ones", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284", OMB_USAGE_CAP_DAILY_TOKENS: "1", OMB_USAGE_CAP_STOPS: "unattended" });
  const { url } = fixture.info;
  const { ok } = client(url);
  const scout = await newBot(url, "Scout");
  const api = await ok("POST", `/api/bots/${scout.id}/bot-api`, { enabled: true });
  expect(await ok("PUT", "/api/usage/caps", { stops: "everything", server: { dailyTokens: 1_000_000_000 } }))
    .toMatchObject({ stops: "unattended", server: { dailyTokens: 1_000_000_000 }, env: { stops: true, server: ["dailyTokens"] }, caps: [expect.objectContaining({ id: "server:day:tokens", limit: 1 })] });
  expect((await outside(api.url, api.key, "Hello")).status).toBe(200);
  await expect.poll(async () => (await ok("GET", "/api/usage/caps")).caps[0].reached, { timeout: hostTimeout(20_000) }).toBe(true);
  const refused = await outside(api.url, api.key, "Hello again");
  expect(refused.status).toBe(429);
  expect((await ok("GET", `/api/bots/${scout.id}/bot-api`)).calls[0].reason).toContain("the daily usage cap for all bots (1 tokens) is reached");
}, hostTimeout(180_000));

it("lets a run that already started carry on when its hand-off comes back after the cap is reached, and the owner's webhook test run", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284" }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const { ok } = client(url);
  const pepper = await newBot(url, "Pepper");
  const sam = await newBot(url, "Sam");
  const samGate = join(dataDir, "sam-counts");
  writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
    [pepper.id]: { script: [
      { key: "run", match: ["Do the stock check."], steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [sam.id], message: "Count the boxes in stock." } }], reply: "Asked Sam to count the stock." },
      { key: "resume", match: ["42 boxes"], reply: "We have 42 boxes in stock." },
      { key: "test", match: ["Do the stock check."], reply: "Test run done." },
    ] },
    [sam.id]: { script: [{ key: "count", match: ["Count the boxes in stock."], reply: "Counted 42 boxes.", gateFile: samGate }] },
  }));
  // Pepper's cap is reached by the first turn of the webhook's run: the run's hand-off is under way by then.
  await ok("PUT", "/api/usage/caps", { bots: { [pepper.id]: { dailyTokens: 1 } } });
  const hook = await ok("POST", "/api/webhooks", { name: "Stock", prompt: "Do the stock check.", botId: pepper.id });
  const delivery = await fetch(hook.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "stock-1" }, body: JSON.stringify({ shelf: "A" }) });
  expect(delivery.status).toBeLessThan(300);
  const run = async () => ((await ok("GET", "/api/routines")).runs as any[]).find((each) => each.webhookId === hook.webhook.id);
  await expect.poll(async () => (await run())?.status, { timeout: hostTimeout(60_000), interval: 500 }).toBe("waiting");
  await expect.poll(async () => (await ok("GET", "/api/usage/caps")).caps[0]?.reached, { timeout: hostTimeout(20_000) }).toBe(true);

  // Sam answers; Pepper's run picks the result up and finishes, though new work for Pepper is refused now.
  writeFileSync(samGate, "done");
  await expect.poll(async () => (await run())?.status, { timeout: hostTimeout(60_000), interval: 500 }).toBe("completed");
  const { threadId } = await run();
  const lines = ((await ok("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[]);
  expect(lines.filter((line) => line.role === "bot" && line.kind === "text").map((line) => line.text)).toContain("We have 42 boxes in stock.");
  expect(lines.filter((line) => /usage cap/.test(`${line.tool?.name ?? ""} ${line.text ?? ""}`))).toEqual([]);
  const again = await fetch(hook.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "stock-2" }, body: JSON.stringify({ shelf: "B" }) });
  expect(again.status).toBe(429);

  // The owner's own Run now of the webhook is theirs, as a routine started by hand is: it runs under the cap.
  const test = await ok("POST", `/api/webhooks/${hook.webhook.id}/test`, { shelf: "C" });
  const tested = async () => ((await ok("GET", "/api/routines")).runs as any[]).find((each) => each.id === test.runId);
  await expect.poll(async () => (await tested())?.status, { timeout: hostTimeout(60_000), interval: 500 }).toBe("completed");
  const testLines = ((await ok("GET", `/api/threads/${(await tested()).threadId}/messages?limit=200`)).messages as any[]);
  expect(testLines.filter((line) => line.role === "bot" && line.kind === "text").map((line) => line.text)).toContain("Test run done.");
}, hostTimeout(240_000));
