// Ordinary chat coordination through real ACP providers and their injected MCP.
// Legacy synchronous/one-hop calls are no longer advertised in ordinary chat.
// Keep the original admission, approval, failure and return-path scenarios on
// coordinate_bots; routines retain their separate legacy delegation coverage.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");

describe("comms e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let base: string;
  let planPath: string;
  let stderr = "";
  let plan: Record<string, any> = {};
  const created: string[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
  };
  const bots = async () => (await api("GET", "/api/bots")).body.bots as any[];
  const state = async (id: string) => (await bots()).find(bot => bot.id === id);
  const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
  const nodes = (): any[] => existsSync(join(home, ".openmausbot", "room-handoffs.json"))
    ? JSON.parse(readFileSync(join(home, ".openmausbot", "room-handoffs.json"), "utf8")) : [];
  const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const save = () => writeFileSync(planPath, JSON.stringify(plan));
  const create = async (name: string, instanceId = "grok", model = "fake-model") => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    created.push(bot.id);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model } })).status).toBe(200);
    return { ...bot, name };
  };
  const pair = async () => {
    const target = await create("Helper");
    const source = await create("Asker");
    plan = { [source.id]: { steps: [{ arguments: { bot_ids: [target.id], request_key: "work", message: "Verify the requested report" } }],
      reply: "Assigned", resumeReply: "The actual teammate report is verified" }, [target.id]: { reply: "Helper verified the report" } };
    return { source, target };
  };
  const start = async (bot: any, text = "Ask the actual teammate to verify the report") => {
    save();
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
  };
  const childNode = (source: any, target: any) => {
    const all = nodes();
    return all.find(node => node.parentId && node.botId === target.id
      && all.some(parent => parent.id === node.parentId && parent.botId === source.id));
  };
  const settled = async (source: any) => {
    await expect.poll(async () => {
      const root = nodes().find(node => !node.parentId && node.botId === source.id);
      return root?.status === "completed" && !(await state(source.id)).busy;
    }, { timeout: 25_000 }).toBe(true);
  };
  const approval = async (source: any) => {
    await expect.poll(async () => (await messages(source.threadId)).some(message => message.card?.tool === "delegate_bot" && !message.card.answered), { timeout: 15_000 }).toBe(true);
    return (await messages(source.threadId)).find(message => message.card?.tool === "delegate_bot" && !message.card.answered);
  };
  const respond = async (source: any, card: any, behavior: "allow" | "deny") => {
    expect((await api("POST", `/api/bots/${source.id}/respond`, { threadId: source.threadId, requestId: card.card.requestId, behavior })).status).toBe(200);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-comms-test-"));
    planPath = join(home, "plan.json");
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    const antigravity = join(home, "fake-antigravity");
    mkdirSync(antigravity);
    const geminiCli = join(antigravity, "agy_acp_server.ts");
    const geminiHarness = join(antigravity, process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
    copyFileSync(FAKE_CLI, geminiCli); copyFileSync(FAKE_CLI, geminiHarness);
    if (process.platform !== "win32") { chmodSync(geminiCli, 0o755); chmodSync(geminiHarness, 0o755); }
    const auth = join(data, "providers", "antigravity", createHash("sha256").update("geminiAsker").digest("hex"), "antigravity-acp");
    mkdirSync(auth, { recursive: true }); writeFileSync(join(auth, "acp_token.json"), "{}\n");
    const environment = { FAKE_ACP_COORDINATION_PLAN: planPath,
      FAKE_ACP_COORDINATION_AGENT: pathToFileURL(join(SERVER_DIR, "testing", "acp-coordination-agent.ts")).href };
    writeFileSync(join(data, "config.json"), JSON.stringify({ threads: { maxConcurrentPerBot: 2 }, instances: {
      grok: { driver: "grokAgent", environment, config: { cli: FAKE_CLI, fullAuto: true } },
      crash: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "exit-early" }, config: { cli: FAKE_CLI, fullAuto: true } },
      geminiAsker: { driver: "antigravityAgent", environment: { ...environment, FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash-high", FAKE_ACP_MODES: "default,yolo" }, config: { cli: geminiCli, fullAuto: true } },
    } }));
    const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_ASK_BOT_TIMEOUT_MS: "25" },
      stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.resume(); child.stderr!.on("data", chunk => { stderr += chunk; });
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Fixture exited: ${stderr}`);
      expect((await fetch(base + "/api/health")).status).toBe(200);
    }, { timeout: 20_000 });
    for (const bot of await bots()) await api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
  }, 30_000);
  afterEach(async context => {
    if (context.task.result?.state === "fail") {
      console.info(JSON.stringify({ failed: context.task.name, nodes: nodes().filter(node => created.includes(node.botId)),
        turns: evidence().filter(turn => created.includes(turn.botId)).map(turn => ({ botId: turn.botId, resumed: turn.resumed, steps: turn.evidence.slice(2) })), stderr: stderr.slice(-1800) }));
    }
    for (const id of created.splice(0)) {
      await api("POST", `/api/bots/${id}/interrupt`, {}).catch(() => undefined);
      await api("PATCH", `/api/bots/${id}`, { chiefOfStaff: false }).catch(() => undefined);
      await api("DELETE", `/api/bots/${id}`).catch(() => undefined);
    }
  });
  afterAll(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (home) await removeTempDir(home); });

  it("seals the internal comms endpoints behind the per-turn token", async () => {
    for (const path of ["/api/internal/ask-bot", "/api/internal/delegate-bot", "/api/internal/coordinate-bots", "/api/internal/threads"])
      expect((await api("POST", path, {})).status).toBe(401);
    expect((await api("GET", "/api/internal/agents")).status).toBe(401);
  });
  it("carries a question through the real ACP agents proxy and returns the actual peer result", async () => {
    const { source, target } = await pair();
    const originalMessages = await messages(target.threadId);
    await start(source); await settled(source);
    const node = childNode(source, target);
    expect(node).toMatchObject({ status: "completed", result: "Helper verified the report" });
    expect(node.threadId).not.toBe(target.threadId);
    expect(evidence().filter(turn => [source.id, target.id].includes(turn.botId)).map(turn => turn.botId)).toEqual([source.id, target.id, source.id]);
    const receipt = (await messages(source.threadId)).find(message => message.roomRequest?.id === node.id);
    expect(receipt).toMatchObject({ from: { botId: target.id }, tool: { ok: true }, threadRef: { botId: target.id, threadId: node.threadId } });
    expect((await messages(node.threadId)).find(message => message.roomRequest?.phase === "request")).toMatchObject({ from: { botId: source.id } });
    expect(await messages(target.threadId)).toEqual(originalMessages);
    expect((await messages(target.threadId)).some(message => message.roomRequest)).toBe(false);
    expect((await api("GET", "/api/bots")).body.groups).toEqual([]);
    expect(evidence().find(turn => turn.botId === source.id && turn.resumed).system).toContain("Helper verified the report");
  }, 40_000);
  it("lets Gemini Antigravity coordinate through its temporary agents MCP mount", async () => {
    const { source, target } = await pair();
    await api("PATCH", `/api/bots/${source.id}`, { modelSelection: { instanceId: "geminiAsker", model: "gemini-3.8-flash-high" } });
    await start(source); await settled(source);
    expect(childNode(source, target)).toMatchObject({ status: "completed", result: "Helper verified the report" });
    expect(evidence().find(turn => turn.botId === source.id && turn.resumed).system).toContain("Helper verified the report");
    expect(existsSync(join(home, ".gemini", "config", "mcp_config.json"))).toBe(false);
  }, 40_000);
  it("lets a section Chief create a safe operator and then coordinate real work to it", async () => {
    const chief = await create("Atlas");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, section: "Launch" });
    plan = { [chief.id]: { steps: [{ tool: "create_bot", arguments: { name: "Pixel", role: "Product designer", instructions: "Design and review the user experience." } }], reply: "Operator created" } };
    await start(chief, "Create the specialist");
    await expect.poll(async () => (await bots()).some(bot => bot.name === "Pixel"), { timeout: 15_000 }).toBe(true);
    const operator = (await bots()).find(bot => bot.name === "Pixel"); created.push(operator.id);
    expect(operator).toMatchObject({ title: "Product designer", description: "Design and review the user experience.", section: "Launch", composio: false, autoApprove: false, approvePeerComms: false, modelSelection: { instanceId: "grok", model: "fake-model" } });
    expect(operator.chiefOfStaff).toBeFalsy();
    await expect.poll(async () => (await state(chief.id)).busy, { timeout: 15_000 }).toBe(false);
    plan = { [chief.id]: { steps: [{ arguments: { bot_ids: [operator.id], request_key: "design", message: "Review the new onboarding flow" } }] }, [operator.id]: { reply: "Onboarding reviewed" } };
    await start(chief); await settled(chief);
    expect(childNode(chief, operator)).toMatchObject({ status: "completed", result: "Onboarding reviewed" });
  }, 45_000);
  it("dispatches addressed work after the source provider finishes and resumes its pinned task", async () => {
    const { source, target } = await pair();
    const release = join(home, `${source.id}.release`); plan[source.id].waitForFile = release;
    await start(source);
    await expect.poll(() => childNode(source, target)?.status, { timeout: 15_000 }).toBe("queued");
    expect(evidence().some(turn => turn.botId === target.id)).toBe(false);
    writeFileSync(release, "continue");
    await settled(source);
    expect(evidence().filter(turn => turn.botId === source.id).map(turn => turn.threadId)).toEqual([source.threadId, source.threadId]);
    expect((await messages(source.threadId)).filter(message => message.tool?.name === "Sent to Helper")).toHaveLength(1);
    expect((await messages(source.threadId)).filter(message => message.roomRequest?.phase === "result")).toHaveLength(1);
  }, 40_000);
  it("keeps a Chief available in a separate task while its coordinated teammate works", async () => {
    const { source, target } = await pair(); await api("PATCH", `/api/bots/${source.id}`, { chiefOfStaff: true });
    const release = join(home, `${target.id}.release`); plan[target.id].waitForFile = release;
    plan[source.id] = { turns: [{ steps: plan[source.id].steps, reply: "Assigned" }, { reply: "Available in another task" }, { reply: "Reviewed returned work" }] };
    await start(source); await expect.poll(() => childNode(source, target)?.status, { timeout: 15_000 }).toBe("running");
    const other = (await api("POST", `/api/bots/${source.id}/tasks`, { title: "Other request" })).body.task;
    expect((await api("POST", `/api/bots/${source.id}/messages`, { threadId: other.threadId, text: "Are you available?" })).status).toBe(202);
    await expect.poll(async () => (await messages(other.threadId)).some(message => message.text === "Available in another task"), { timeout: 15_000 }).toBe(true);
    expect(childNode(source, target).status).toBe("running");
    writeFileSync(release, "continue");
    await settled(source);
    expect((await messages(source.threadId)).some(message => message.text === "Reviewed returned work")).toBe(true);
    expect((await messages(other.threadId)).some(message => message.roomRequest)).toBe(false);
  }, 40_000);
  it("queues a recipient at capacity and leaves its current conversation untouched", async () => {
    expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
    try {
      const { source, target } = await pair();
      const release = join(home, `${target.id}.release`);
      plan[target.id] = { turns: [{ waitForFile: release, reply: "Existing work" }, { reply: "Fresh coordinated result" }] };
      await start(target, "Existing unrelated work"); await start(source);
      await expect.poll(() => childNode(source, target)?.status, { timeout: 15_000 }).toBe("queued");
      writeFileSync(release, "continue");
      await settled(source);
      expect(childNode(source, target)).toMatchObject({ status: "completed", result: "Fresh coordinated result" });
      expect((await messages(target.threadId)).some(message => message.text === "Existing work")).toBe(true);
      expect((await messages(target.threadId)).some(message => message.roomRequest)).toBe(false);
    } finally {
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 40_000);
  it("retries queued work after provider reload without approving or delivering it twice", async () => {
    expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
    try {
      const { source, target } = await pair();
      await api("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true });
      const release = join(home, `${target.id}.reload-release`);
      plan[target.id] = { waitForFile: release, reply: "Existing work" };
      await start(target, "Existing work"); await start(source);
      await respond(source, await approval(source), "allow");
      // A queued child can exist while its source still finishes the MCP call.
      // Reload only after the source yields ownership to the durable coordinator.
      await expect.poll(() => nodes().find(node => !node.parentId && node.botId === source.id)?.status, { timeout: 15_000 }).toBe("waiting");
      await expect.poll(() => childNode(source, target)?.status, { timeout: 15_000 }).toBe("queued");
      const id = childNode(source, target).id;
      plan[target.id] = { reply: "Fresh coordinated result after reload" };
      save();
      expect((await api("PUT", "/api/config", { composio: { apiKey: "" } })).status).toBe(200);
      writeFileSync(release, "continue");
      await settled(source);
      expect(nodes().find(node => node.id === id)).toMatchObject({ status: "completed", result: "Fresh coordinated result after reload" });
      expect((await messages(source.threadId)).filter(message => message.card?.tool === "delegate_bot")).toHaveLength(1);
      expect((await messages(childNode(source, target).threadId)).filter(message => message.roomRequest?.phase === "request")).toHaveLength(1);
    } finally {
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 40_000);
  it("returns a slow peer result beyond the old synchronous ask timeout without losing it", async () => {
    const { source, target } = await pair(); plan[target.id].delayMs = 250;
    await start(source); await settled(source);
    expect(childNode(source, target)).toMatchObject({ status: "completed", result: "Helper verified the report" });
    expect(evidence().find(turn => turn.botId === source.id && turn.resumed).system).toContain("Helper verified the report");
    expect((await messages(source.threadId)).filter(message => message.roomRequest?.phase === "result")).toHaveLength(1);
  }, 40_000);
  it("records an empty successful peer reply as a successful terminal receipt", async () => {
    const { source, target } = await pair(); plan[target.id].reply = "";
    await start(source); await settled(source);
    const node = childNode(source, target);
    expect(node.status).toBe("completed");
    expect((await messages(source.threadId)).find(message => message.roomRequest?.id === node.id)).toMatchObject({ tool: { ok: true } });
  }, 40_000);
  it("finalizes a running coordinated turn interrupted by provider reload", async () => {
    const { source, target } = await pair(); plan[target.id].delayMs = 4000;
    plan[source.id].resumeReply = "The worker failed; reporting its failure";
    await start(source); await expect.poll(() => childNode(source, target)?.status, { timeout: 15_000 }).toBe("running");
    await api("PUT", "/api/config", { composio: { apiKey: "" } });
    await expect.poll(() => ["failed", "cancelled"].includes(childNode(source, target)?.status), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await state(source.id)).busy || (await state(target.id)).busy, { timeout: 20_000 }).toBe(false);
    expect((await messages(source.threadId)).some(message => message.text === "The actual teammate report is verified")).toBe(false);
    expect(evidence().find(turn => turn.botId === source.id && turn.resumed).system).toContain('"status":"failed"');
  }, 40_000);
  it("returns a crashed peer as a failed terminal receipt to the source", async () => {
    const { source, target } = await pair(); await api("PATCH", `/api/bots/${target.id}`, { modelSelection: { instanceId: "crash", model: "fake-model" } });
    await start(source); await settled(source);
    const node = childNode(source, target); expect(node.status).toBe("failed");
    expect((await messages(source.threadId)).find(message => message.roomRequest?.id === node.id)).toMatchObject({ tool: { ok: false } });
    expect(evidence().find(turn => turn.botId === source.id && turn.resumed).system).toContain('"status":"failed"');
  }, 40_000);
  it("does not start queued work for a deleted recipient or recreate its task", async () => {
    const { source, target } = await pair(); plan[source.id].delayMs = 700;
    await start(source); await expect.poll(() => childNode(source, target)?.status, { timeout: 15_000 }).toBe("queued");
    const recipientThread = childNode(source, target).threadId;
    expect((await api("DELETE", `/api/bots/${target.id}`)).status).toBe(200);
    await expect.poll(() => ["failed", "cancelled"].includes(childNode(source, target)?.status), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await state(source.id)).busy, { timeout: 15_000 }).toBe(false);
    expect(await state(target.id)).toBeUndefined();
    expect(evidence().some(turn => turn.threadId === recipientThread)).toBe(false);
  }, 40_000);
  it("holds coordinate_bots behind the actual approval card and runs only after Allow", async () => {
    const { source, target } = await pair(); await api("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true });
    await start(source); const card = await approval(source);
    expect(card.card.allowKey).toBe(`delegate_bot:${target.id}`);
    expect(childNode(source, target)).toBeUndefined();
    expect(evidence().some(turn => turn.botId === target.id)).toBe(false);
    await respond(source, card, "allow"); await settled(source);
    expect(childNode(source, target).status).toBe("completed");
    expect((await messages(source.threadId)).filter(message => message.card?.tool === "delegate_bot")).toHaveLength(1);
    expect(evidence().filter(turn => turn.botId === target.id)).toHaveLength(1);
  }, 40_000);
  it("refuses a denied coordination request and never starts or creates peer work", async () => {
    const { source, target } = await pair(); await api("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true });
    plan[source.id].steps[0].expectError = true;
    await start(source); await respond(source, await approval(source), "deny");
    await expect.poll(async () => (await state(source.id)).busy, { timeout: 15_000 }).toBe(false);
    expect(childNode(source, target)).toBeUndefined();
    expect((await state(target.id)).tasks).toHaveLength(1);
    expect(evidence().some(turn => turn.botId === target.id)).toBe(false);
    expect(evidence().find(turn => turn.botId === source.id).evidence.at(-1).response.result.isError).toBe(true);
  }, 40_000);
  it("allows bounded nested coordination while refusing a return to an ancestor bot", async () => {
    const { source, target } = await pair(); const reviewer = await create("Reviewer");
    plan[target.id].steps = [{ arguments: { bot_ids: [reviewer.id], request_key: "review", message: "Verify independently" } }];
    plan[reviewer.id] = { steps: [{ expectError: true, arguments: { bot_ids: [source.id], request_key: "cycle", message: "Return to the ancestor" } }], reply: "Verified without a cycle" };
    await start(source); await settled(source);
    expect(nodes().filter(node => [source.id, target.id, reviewer.id].includes(node.botId))).toHaveLength(3);
    expect(evidence().filter(turn => [source.id, target.id, reviewer.id].includes(turn.botId)).map(turn => turn.botId)).toEqual([source.id, target.id, reviewer.id, target.id, source.id]);
    const tools = evidence().find(turn => turn.botId === target.id).evidence[0].result.tools.map((tool: any) => tool.name);
    expect(tools).toContain("coordinate_bots");
    for (const removed of ["ask_bot", "delegate_bot", "start_thread"]) expect(tools).not.toContain(removed);
    expect(evidence().find(turn => turn.botId === reviewer.id).evidence.at(-1).response.result.isError).toBe(true);
  }, 40_000);
});
