import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const MODEL = "fixture/context";
const REPORTED_WINDOW = 200_000;
// Long enough that three exchanges are a few hundred tokens of transcript.
const LINE = "Keep the quarterly report in the shared folder, name each chart after its source table, and say which figures changed since the last draft. ";
const ASKS = ["FIRST", "SECOND", "THIRD", "FOURTH"].map((label) => `${label} ${LINE}${LINE}`);

let url = "";
let usageFile = "";
let updatesFile = "";

const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
/** What the agent reports before each prompt result: nothing, or these sizes. */
const reports = (...used: number[]) => writeFileSync(usageFile, JSON.stringify(used));
const acpBot = async (name: string) => {
  const { bot } = await control("new-bot", "--name", name);
  await control("set-model", "--bot", bot.id, "--instance", "opencodeGo", "--model", MODEL);
  return bot as { id: string; activeTaskId: string };
};
const taskOf = async (bot: { id: string; activeTaskId: string }) => (await api("GET", "/api/bots")).body.bots
  .find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === bot.activeTaskId);

/** One fresh 1:1 conversation of four asks: how many compaction records it
 * holds after each, and the context the conversation shows at the end. */
async function conversation(name: string, ...used: number[]) {
  reports(...used);
  const bot = await acpBot(name);
  const compactions: number[] = [];
  for (const text of ASKS) {
    await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const messages = (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).body.messages as any[];
    compactions.push(messages.filter((message) => message.kind === "compaction").length);
  }
  return { compactions, context: (await taskOf(bot)).usage?.context };
}

async function withAcpServer(run: () => Promise<void>): Promise<void> {
  const fixture = await launchVerificationServer();
  const { dataDir, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  try {
    url = fixture.info.url;
    usageFile = join(dataDir, "acp-usage.json");
    updatesFile = join(dataDir, "acp-updates.json");
    reports();
    writeFileSync(updatesFile, "[]");
    // Never discover the person's own CLI or home.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.opencodeGo = {
      driver: "opencodeGo", displayName: "Context fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FAKE_ACP_MODELS: MODEL, FAKE_ACP_USAGE_UPDATES_FILE: usageFile, FAKE_ACP_UPDATES_FILE: updatesFile },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await run();
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}

it("shows the engine's context and still folds a 1:1 conversation at the same turn", () => withAcpServer(async () => {
  // Default 80% threshold; a few hundred tokens of transcript never folds, whatever the agent reports.
  const quiet = await conversation("Quiet agent");
  const full = await conversation("Nearly full agent", 190_000);
  expect(quiet.compactions).toEqual([0, 0, 0, 0]);
  expect(full.compactions).toEqual(quiet.compactions);
  expect(quiet.context).toBeUndefined();
  expect(full.context).toEqual({ tokens: 190_000, window: REPORTED_WINDOW });

  // The fourth ask folds the first exchange even when the agent reports almost nothing.
  expect((await api("PATCH", "/api/config", { context: { compactAt: 100 } })).status).toBe(200);
  const folded = await conversation("Quiet agent, low threshold");
  const empty = await conversation("Nearly empty agent, low threshold", 10);
  expect(folded.compactions).toEqual([0, 0, 0, 1]);
  expect(empty.compactions).toEqual(folded.compactions);
  expect(empty.context).toEqual({ tokens: 10, window: REPORTED_WINDOW });
}), 180_000);

it("does not start a room member on a fresh session because its engine reports a nearly full context", () => withAcpServer(async () => {
  // 95%: above the 90% at which a room resets a member whose reading it trusts.
  reports(190_000);
  const bot = await acpBot("Editor");
  const room = (await control("new-channel", "--name", "Edit bay", "--members", bot.id)).channel as { id: string; activeTaskId: string };
  const group = async () => (await api("GET", "/api/bots?messages=0")).body.groups.find((entry: any) => entry.id === room.id);
  const send = async (text: string) => {
    await control("send-channel", "--channel", room.id, "--text", `@Editor ${text}`);
    expect((await control("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
  };
  await send("Cut the intro.");
  await send("Trim the middle.");
  const messages = (await api("GET", `/api/threads/${room.activeTaskId}/messages?limit=100`)).body.messages as any[];
  expect(messages.filter((message) => message.role === "bot" && message.kind === "text")).toHaveLength(2);
  expect(messages.filter((message) => message.kind === "activity" && /compacted/.test(message.tool?.name ?? ""))).toEqual([]);
  expect((await group()).memberContext ?? null).toBeNull();
  expect((await api("POST", `/api/groups/${room.id}/members/${bot.id}/compact`, {})).status).toBe(409);
}), 120_000);

it("shows an agent's plan in the chat as activity only once plan lines are switched on", () => withAcpServer(async () => {
  writeFileSync(updatesFile, JSON.stringify([{ update: { sessionUpdate: "plan", entries: [
    { content: "Read the brief", priority: "high", status: "in_progress" },
    { content: "Write the tests", priority: "medium", status: "pending" },
  ] } }]));
  /** One ask in a fresh conversation: the plan rows its transcript holds. */
  const planRows = async (name: string) => {
    const bot = await acpBot(name);
    await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Plan the launch.");
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const messages = (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).body.messages as any[];
    return messages.filter((message) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("Plan:"))
      .map((message) => ({ name: message.tool.name, ok: message.tool.ok }));
  };
  expect(await planRows("Planner, lines off")).toEqual([]);
  expect((await api("PATCH", "/api/config", { features: { acpPlanLines: true } })).status).toBe(200);
  expect(await planRows("Planner, lines on")).toEqual([{ name: "Plan: 0 of 2 done — Read the brief", ok: true }]);
}), 120_000);
