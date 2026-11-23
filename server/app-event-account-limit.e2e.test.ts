import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";

// An app-event run that is carried on later (here by a teammate's reply) checks the bot's account limit again right
// before that turn is sent, on a real server with a fake Composio behind the connected-apps service: once the owner
// takes the account away from the bot, the reply never reaches the engine and the run fails with the plain refusal.
let broker: BrokerFake;
let owner: { id: string; token: string; userId: string };
let sales = "";
let support = "";
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  broker = await startBrokerFake();
  owner = await broker.install();
  sales = broker.account(owner.userId, "gmail", "sales");
  support = broker.account(owner.userId, "gmail", "support");
  fixture = await launchVerificationServer({ ...process.env, OMB_COMPOSIO_BROKER_URL: broker.url, OMB_COMPOSIO_BROKER_TOKEN: owner.token }, undefined, undefined, undefined, undefined, { scripted: true });
}, 60_000);

afterAll(async () => {
  console.info(JSON.stringify({ logPath: fixture?.info.logPath }));
  await fixture?.close();
  await broker?.close();
  vi.restoreAllMocks();
});

it("does not carry an app-event run on after its bot loses the account, even when the turn continues a reply", async () => {
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const turns = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { planKey?: string })
    : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const { bot } = await cli("new-bot", "--name", "Scout");
  const { bot: sam } = await cli("new-bot", "--name", "Sam");
  const threadId = bot.activeTaskId as string;
  const samGate = join(fixture.info.dataDir, "sam-counts");
  writeFileSync(planPath, JSON.stringify({
    [bot.id]: { script: [
      { key: "setup", match: ["When I get an email from Acme"], reply: "Set up.", steps: [
        { tool: "list_trigger_events", arguments: { app: "gmail" } },
        { tool: "create_trigger", arguments: { when: "app_event", name: "Acme orders", app: "gmail", account: sales, event: "GMAIL_NEW_GMAIL_MESSAGE",
          filter: { from: "acme.com" }, instructions: "Ask Sam to count the boxes for the order in the email." } },
      ] },
      { key: "run", match: ["Ask Sam to count the boxes"], reply: "Asked Sam to count the boxes.",
        steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [sam.id], message: "Count the boxes for order 1042." } }] },
      { key: "resume", match: ["42 boxes"], reply: "Replied to Acme: 42 boxes are ready." },
    ] },
    [sam.id]: { script: [{ key: "count", match: ["Count the boxes for order 1042."], reply: "Counted 42 boxes.", gateFile: samGate }] },
  }));
  await cli("send", "--bot", bot.id, "--task", threadId, "--text", "When I get an email from Acme, ask Sam to count the boxes.");
  await expect.poll(() => turns().some((turn) => turn.planKey === "setup"), { timeout: 20_000 }).toBe(true);
  await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "20");
  const trigger = async () => (await api("GET", "/api/app-triggers")).triggers.find((candidate: any) => candidate.botId === bot.id);
  expect(await trigger()).toMatchObject({ app: "gmail", accountId: sales, enabled: true, remote: { state: "active" } });

  // An Acme email starts the run; it hands the count to Sam and waits for the reply.
  expect((await broker.deliver((await trigger()).remote.triggerId, { sender: "ada@acme.com", subject: "Order 1042", message_text: "How many boxes?" }, "msg_limit_1")).status).toBe(200);
  await expect.poll(async () => (await trigger())?.lastRunId, { timeout: 30_000 }).toBeTruthy();
  const runId = (await trigger()).lastRunId as string;
  const run = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === runId);
  await expect.poll(async () => (await run())?.status, { timeout: 30_000 }).toBe("waiting");
  expect(turns().filter((turn) => turn.planKey === "run")).toHaveLength(1);

  // While it waits, the owner limits Scout to the support account in its Access settings.
  await api("PATCH", `/api/bots/${bot.id}`, { connectorScopes: { apps: { gmail: "read" }, accounts: { gmail: [support] } } });
  writeFileSync(samGate, "done");

  // Sam's reply would carry the run on; the turn is refused before it is sent, and the run says why.
  await expect.poll(async () => (await run())?.status, { timeout: 30_000 }).toBe("failed");
  expect((await run()).error).toContain("Its bot may no longer use this account");
  expect(turns().filter((turn) => turn.planKey === "resume")).toEqual([]);
}, 180_000);
