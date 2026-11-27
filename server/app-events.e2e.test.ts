import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";

// App events end to end on a real server (temporary home, scripted engine) against the connected-apps service's own
// code with a fake Composio behind it: a chat request becomes an app-event automation, a Composio delivery reaches the
// service's queue, the server's long-poll turns it into a run, and the automation shows what happened.
let broker: BrokerFake;
let owner: { id: string; token: string; userId: string };
let gmail = "";
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
const evidence: unknown[] = [];

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  broker = await startBrokerFake();
  owner = await broker.install();
  gmail = broker.account(owner.userId, "gmail", "sales");
  fixture = await launchVerificationServer({ ...process.env, OMB_COMPOSIO_BROKER_URL: broker.url, OMB_COMPOSIO_BROKER_TOKEN: owner.token }, undefined, undefined, undefined, undefined, { scripted: true });
  evidence.push({ fixture: fixture.info, broker: broker.url });
}, 60_000);

afterAll(async () => {
  writeFileSync(`${fixture.info.logPath}.app-events.json`, JSON.stringify(evidence, null, 2));
  console.info(JSON.stringify({ logPath: fixture.info.logPath, evidence: `${fixture.info.logPath}.app-events.json` }));
  await fixture?.close();
  await broker?.close();
  vi.restoreAllMocks();
});

it("sets up an app-event automation from chat, runs on a Composio event, and shows pause, skips, reconnect and undo", async () => {
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const turns = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const { bot } = await cli("new-bot", "--name", "Scout");
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const threadId = bot.activeTaskId as string;
  const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
  const turn = async (text: string, steps: unknown[], reply = "Done.") => {
    const before = turns().length;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply } }));
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
    await expect.poll(() => turns().length, { timeout: 20_000 }).toBe(before + 1);
    await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "20");
    const latest = turns().at(-1);
    evidence.push({ turn: latest });
    return latest.evidence as Array<{ step?: { tool: string }; response: any }>;
  };
  const toolText = (entries: Array<{ step?: { tool: string }; response: any }>, tool: string) =>
    entries.find((entry) => entry.step?.tool === tool)!.response.result.content[0].text as string;
  const snapshot = async () => api("GET", "/api/app-triggers");
  const trigger = async (id: string) => (await snapshot()).triggers.find((candidate: any) => candidate.id === id);
  const binding = (triggerId: string) => broker.harness.d1.rows<{ disabled_at: number | null }>("SELECT disabled_at FROM trigger_bindings WHERE composio_trigger_id = ?", triggerId)[0];

  // 1. "When I get an email from Acme, draft a reply": the bot looks up Gmail's events and sets it up in the same turn.
  const created = await turn("When I get an email from Acme, draft a reply.", [
    { tool: "list_trigger_events", arguments: { app: "gmail" } },
    { tool: "create_trigger", arguments: { when: "app_event", name: "Acme replies", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE",
      filter: { from: "acme.com" }, instructions: "Draft a reply to the email in the event data. Do not send it." } },
  ]);
  const listed = toolText(created, "list_trigger_events");
  expect(listed).toContain("GMAIL_NEW_GMAIL_MESSAGE");
  expect(listed).toContain('"delivery": "poll"');
  expect(toolText(created, "create_trigger")).toContain("applied at once");
  const card = (await messages()).findLast((message) => message.card?.appTriggerRequest)!.card;
  expect(card).toMatchObject({ autoApplied: true, answered: "allow", tool: "create_trigger" });
  expect(card.subtitle).toContain("When an email arrives in Gmail (sales) from acme.com (it checks every 15 minutes), Scout follows");
  expect((await messages()).filter((message) => message.card && !message.card.answered && !message.card.dismissed)).toEqual([]);
  const id = card.appTriggerRequest.resultId as string;
  const made = await trigger(id);
  expect(made).toMatchObject({ botId: bot.id, app: "gmail", accountId: gmail, delivery: "poll", enabled: true, remote: { state: "active" }, received: 0 });
  const remoteId = made.remote.triggerId as string;
  expect(broker.harness.composio.instances.get(remoteId)?.trigger_config).toEqual({ query: "from:acme.com" });

  // 2. A Composio delivery reaches the service's queue; the server's long-poll starts a run that completes.
  writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps: [], reply: "Drafted a reply to Ada about order #1042." } }));
  expect((await broker.deliver(remoteId, { sender: "Ada <ada@acme.com>", subject: "Where is order #1042?", message_text: "Hi" }, "msg_e2e_1")).status).toBe(200);
  await expect.poll(async () => (await trigger(id))?.received, { timeout: 30_000 }).toBe(1);
  const runId = (await trigger(id)).lastRunId as string;
  await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === runId)?.status, { timeout: 30_000 }).toBe("completed");
  const run = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === runId);
  expect(run).toMatchObject({ routineId: id, triggerSource: "webhook", eventSource: "app", deliveryId: "msg_e2e_1" });
  expect(run.output).toContain("Drafted a reply");
  expect((await snapshot()).attempts.find((attempt: any) => attempt.eventId === "msg_e2e_1")).toMatchObject({ outcome: "started", runId, preview: "From Ada <ada@acme.com> · Where is order #1042?" });
  await expect.poll(() => broker.harness.d1.rows("SELECT * FROM events WHERE acked_at IS NULL").length, { timeout: 30_000 }).toBe(0);
  expect((await messages()).some((message) => message.kind === "routine.run")).toBe(false);

  // 3. Pause and resume from chat reach the service; nothing waits on a card.
  const paused = await turn("Pause the Acme replies.", [{ tool: "manage_trigger", arguments: { trigger_id: id, action: "pause" } }]);
  expect(toolText(paused, "manage_trigger")).toContain("applied at once");
  expect((await trigger(id)).enabled).toBe(false);
  expect(binding(remoteId)?.disabled_at).not.toBeNull();
  await turn("Turn the Acme replies back on.", [{ tool: "manage_trigger", arguments: { trigger_id: id, action: "resume" } }]);
  expect((await trigger(id)).enabled).toBe(true);
  expect(binding(remoteId)?.disabled_at).toBeNull();

  // 4. Past the desktop's 500 events a day the service keeps nothing more, and the automation says how many it skipped.
  broker.setQueuedToday(owner.id, 500);
  await broker.deliver(remoteId, { sender: "bo@acme.com", subject: "Over the limit" });
  const synced = await api("POST", "/api/app-triggers/sync");
  expect(synced.service).toMatchObject({ available: true, plan: "desktop", eventsPerDay: 500 });
  expect(synced.triggers.find((candidate: any) => candidate.id === id).skipped).toMatchObject({ dailyLimit: 1 });

  // 5. An expired Gmail connection shows as Reconnect.
  await broker.expire(gmail);
  await expect.poll(async () => (await trigger(id))?.problem?.kind, { timeout: 30_000 }).toBe("reconnect");
  const listedAgain = await turn("How are my automations?", [{ tool: "list_triggers", arguments: {} }]);
  expect(toolText(listedAgain, "list_triggers")).toContain("needs to be reconnected");

  // 6. Undo on the card deletes it here and at the service.
  await api("POST", `/api/threads/${threadId}/undo`, { requestId: card.requestId });
  expect(await trigger(id)).toBeUndefined();
  expect(broker.harness.composio.instances.has(remoteId)).toBe(false);
  expect((await messages()).find((message) => message.card?.requestId === card.requestId)!.card.undone).toBe(true);
}, 180_000);
