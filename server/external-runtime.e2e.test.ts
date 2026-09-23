// A bot whose engine also runs outside this server (a Telegram gateway, a Slack
// bot) holds no turn-scoped capability. `<data dir>/external-runtimes.json`
// gives it a standing one for a pinned thread: real server, fake engine.
import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const TOKEN = "external-runtime-fixture-token-0123456789abcdef";

let fixture: VerificationServer;
let data = "";
let base = "";
const evidence: Array<{ method: string; path: string; status: number }> = [];

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  evidence.push({ method, path, status: response.status });
  return { status: response.status, body: await response.json() as any };
};
const asRuntime = (method: string, path: string, body?: unknown, token = TOKEN) =>
  api(method, path, body, { authorization: `Bearer ${token}` });
const createBot = async (name: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;
const botState = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === botId);
const runtimesFile = () => join(data, "external-runtimes.json");

beforeAll(async () => {
  fixture = await launchVerificationServer();
  data = fixture.info.dataDir;
  base = fixture.info.url;
}, 30_000);

afterAll(async () => {
  if (!fixture) return;
  writeFileSync(`${fixture.info.logPath}.external-runtime.json`, JSON.stringify(evidence, null, 2));
  console.log(`External runtime fixture evidence: ${fixture.info.logPath}.external-runtime.json`);
  await fixture.close();
});

// Hold a real HTTP body after the server accepts its headers, then revoke
// the credential before admitting any tool side effect.
async function delayedBody(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const req = request(`${base}${path}`, { method: "POST", headers: {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
    "content-length": Buffer.byteLength(raw), expect: "100-continue",
  } });
  const response = new Promise<number>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
  });
  void response.catch(() => {});
  const accepted = once(req, "continue");
  req.flushHeaders();
  await accepted;
  return { finish: () => { req.end(raw); return response; }, close: () => req.destroy() };
}

function bridge(botId: string, threadId: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./drivers/agents-proxy.ts", import.meta.url))], {
    env: { ...verificationServerEnvironment({}, data, Number(new URL(base).port)),
      OMB_HARNESS_URL: base, OMB_BOT_ID: botId, OMB_THREAD_ID: threadId,
      OMB_COMMS_TOKEN: TOKEN, OMB_EXTERNAL_RUNTIME: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  return {
    async rpc(method: string, params?: unknown) {
      const reply = once(lines, "line", { signal: AbortSignal.timeout(10_000) });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`);
      const value = JSON.parse(String((await reply)[0]));
      expect(value.id).toBe(id);
      expect(value.error).toBeUndefined();
      return value.result;
    },
    async close() { await waitForExit(child, { signal: "SIGTERM" }); lines.close(); },
  };
}

describe("a bot's external runtime", () => {
  it("gets a standing agents capability for its pinned thread from external-runtimes.json", async () => {
    const runtime = await createBot("Gateway");
    const peer = await createBot("Peer");
    try {
      // nothing configured: the bearer is just an unknown token
      expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);

      // the file is read on demand — no restart between writing it and using it
      writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: { token: TOKEN, threadId: runtime.threadId } }), { mode: 0o600 });
      const roster = await asRuntime("GET", "/api/internal/agents");
      expect(roster.status).toBe(200);
      const names = roster.body.bots.map((bot: { name: string }) => bot.name);
      expect(names).toContain("Peer");
      expect(names).not.toContain("Gateway"); // the caller itself is never a peer
      expect((await asRuntime("GET", "/api/internal/agents", undefined, `${TOKEN}x`)).status).toBe(401);
      expect((await asRuntime("GET", `/api/internal/agents?self=${peer.id}`)).status).toBe(403);
      for (const claim of [{ fromBotId: peer.id }, { fromThreadId: peer.threadId }, { depth: 1 }]) {
        expect((await asRuntime("POST", "/api/internal/delegate-bot", {
          toBotId: peer.id, message: "must not run", ...claim,
        })).status).toBe(403);
      }

      // a token another user could read is not a secret
      if (process.platform !== "win32") {
        chmodSync(runtimesFile(), 0o644);
        expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);
        chmodSync(runtimesFile(), 0o600);
      }

      // The runtime has no live turn on this server, so its delegation cannot
      // wait for one to finish: it is picked up immediately, from the bot's
      // own main thread, which never needed a warm-up task.
      const tasksBefore = (await botState(peer.id)).tasks.length;
      const delegated = await asRuntime("POST", "/api/internal/delegate-bot", {
        fromBotId: runtime.id,
        toBotId: peer.id,
        message: "Peer, take this one",
      });
      expect(delegated.status).toBe(200);
      expect(delegated.body).toMatchObject({ queued: true });
      expect(String(delegated.body.message)).toContain("picking it up now");
      await expect.poll(async () => {
        const state = await botState(peer.id);
        return state.tasks.length > tasksBefore || !!state.busy;
      }, { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await botState(peer.id)).busy, { timeout: 15_000 }).toBeFalsy();

      // the capability is peer comms only: nothing that creates or changes state
      for (const [method, path, body] of [
        ["POST", "/api/internal/threads", { fromBotId: runtime.id, fromThreadId: runtime.threadId, title: "Side quest", message: "go" }],
        ["POST", "/api/internal/create-bot", { fromBotId: runtime.id, name: "Minion" }],
        ["POST", "/api/internal/create-room", { fromBotId: runtime.id, name: "War room" }],
        ["POST", "/api/internal/coordinate-bots", { message: "all hands" }],
        ["POST", "/api/internal/skills/stage", { name: "x" }],
        ["GET", "/api/internal/memory", undefined],
      ] as const) {
        expect((await asRuntime(method, path, body)).status, `${method} ${path}`).toBe(403);
      }
      const gateway = await botState(runtime.id);
      expect(gateway.tasks.length).toBe(1); // no task was opened on the runtime's bot either
    } finally {
      for (const bot of [runtime, peer]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 40_000);

  it("revokes slow ask and delegate requests without starting the peer", async () => {
    const runtime = await createBot("Revocable gateway");
    const peer = await createBot("Unused peer");
    try {
      for (const path of ["/api/internal/ask-bot", "/api/internal/delegate-bot"]) {
        writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: { token: TOKEN, threadId: runtime.threadId } }), { mode: 0o600 });
        const held = await delayedBody(path, { toBotId: peer.id, message: "revoked work must not run" });
        try {
          writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: { token: `${TOKEN}-rotated`, threadId: runtime.threadId } }));
          expect(await held.finish()).toBe(401);
          expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);
          expect((await asRuntime("GET", "/api/internal/agents", undefined, `${TOKEN}-rotated`)).status).toBe(200);
        } finally { held.close(); }
      }
      expect((await botState(peer.id)).tasks).toHaveLength(1);
      const messages = (await api("GET", `/api/threads/${peer.threadId}/messages`)).body.messages;
      expect(messages.some((message: { text?: string }) => message.text?.includes("revoked work"))).toBe(false);
    } finally {
      for (const bot of [runtime, peer]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("pins a configured thread across sidebar selection and refuses deleted bindings", async () => {
    const runtime = await createBot("Pinned gateway");
    const peer = await createBot("Pinned peer");
    try {
      writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: { token: TOKEN, threadId: runtime.threadId } }), { mode: 0o600 });
      const sibling = await api("POST", `/api/bots/${runtime.id}/tasks`, { title: "Other work" });
      expect(sibling.status).toBe(201);
      expect((await botState(runtime.id)).threadId).toBe(sibling.body.task.threadId);
      expect((await asRuntime("GET", `/api/internal/agents?fromThreadId=${runtime.threadId}`)).status).toBe(200);
      expect((await asRuntime("GET", `/api/internal/agents?fromThreadId=${sibling.body.task.threadId}`)).status).toBe(403);
      // A bare token cannot identify a stable conversation.
      writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: TOKEN }));
      expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);
      writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: { token: TOKEN, threadId: peer.threadId } }));
      expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);
      writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: { token: TOKEN, threadId: runtime.threadId } }));
      expect((await api("DELETE", `/api/bots/${runtime.id}/tasks/${runtime.threadId}`)).status).toBe(200);
      expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);
      expect((await botState(runtime.id)).threadId).toBe(sibling.body.task.threadId);
    } finally {
      for (const bot of [runtime, peer]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("uses the documented MCP bridge to delegate and poll in the same long-running process", async () => {
    const runtime = await createBot("MCP gateway");
    const peer = await createBot("MCP teammate");
    writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: { token: TOKEN, threadId: runtime.threadId } }), { mode: 0o600 });
    const client = bridge(runtime.id, runtime.threadId);
    try {
      await client.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
      const tools = await client.rpc("tools/list");
      expect(tools.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        "ask_bot", "check_delegation", "delegate_bot", "list_bots", "wait_delegation",
      ]);
      const roster = await client.rpc("tools/call", { name: "list_bots", arguments: {} });
      expect(roster.content[0].text).toContain("MCP teammate");
      const delegated = await client.rpc("tools/call", { name: "delegate_bot", arguments: { bot_id: peer.id, message: "Bridge acceptance task" } });
      expect(delegated.isError).not.toBe(true);
      const taskId = /Task id: ([\w-]+)\./.exec(delegated.content[0].text)?.[1];
      expect(taskId).toBeTruthy();
      await expect.poll(async () => (await asRuntime("GET", `/api/internal/delegations/${taskId}`)).body.status,
        { timeout: 15_000 }).toBe("done");
      const receipt = await client.rpc("tools/call", { name: "check_delegation", arguments: { task_id: taskId } });
      expect(receipt.isError).not.toBe(true);
      expect(receipt.content[0].text).toContain("finished task");
      evidence.push({ method: "MCP", path: "delegate_bot → check_delegation (same process)", status: 200 });
    } finally {
      await client.close();
      for (const bot of [runtime, peer]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {});
        await api("DELETE", `/api/bots/${bot.id}`);
      }
    }
  }, 30_000);
});
