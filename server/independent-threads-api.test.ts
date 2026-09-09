// Real harness + its isolated fake-engine launcher. Gates are per model so
// two tasks on one bot stay in flight until this test completes or stops each.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { memoryDate } from "./workspace.ts";

describe("independent bot tasks through the isolated control surface", () => {
  let session: VerificationServer;
  let models: string[];
  const sockets: Socket[] = [];
  let evidence: Array<Record<string, unknown>>;

  const api = async (method: string, path: string, body?: unknown, fromApp = false) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...(fromApp ? { origin: session.info.url } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (method !== "GET") evidence.push({ method, path, ...(path.startsWith("/api/auth/") ? {} : { body }), status: response.status });
    return { status: response.status, body: await response.json() as any };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result: any = await handleToolCall(name, args, (path, options) => request(path, options, session.info.url));
    if (name !== "list_bots" && name !== "list_available_models") evidence.push({ tool: name, args, result });
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", session.info.url]);
    evidence.push({ command: args, result });
    return result as any;
  };
  const internal = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = { status: response.status, body: await response.json() as any };
    // Record the exercised authorization boundary, never the bearer itself.
    evidence.push({ authority: "captured provider capability", method, path, body, result });
    return result;
  };
  const botState = async (botId: string) => (await tool("list_bots", {})).bots.find((bot: any) => bot.id === botId);
  const modelFile = (model: string, extension: string) => join(session.info.dataDir, `${model.replace(/[^\w-]/g, "_")}.${extension}`);
  const dump = async (model: string) => {
    await expect.poll(() => existsSync(modelFile(model, "json")), { timeout: 15_000 }).toBe(true);
    return JSON.parse(readFileSync(modelFile(model, "json"), "utf8"));
  };
  const permission = async (model: string, id: string) => {
    const launched = await dump(model);
    const socketPath = launched.mcpConfig.mcpServers.ogb.args.at(-1);
    const socket = connect(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const answers: any[] = [];
    createInterface({ input: socket }).on("line", (line) => answers.push(JSON.parse(line)));
    socket.write(`${JSON.stringify({ t: "ask", id, kind: "permission", tool: "Bash", input: { command: "ls -la ./dist" } })}\n`);
    return answers;
  };

  beforeEach(async () => {
    session = await launchVerificationServer();
    evidence = [{ fixture: session.info }];
    const wrapper = join(session.info.dataDir, "gated-claude.mjs");
    const fake = pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href;
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { join } from "node:path";',
      'const at = process.argv.indexOf("--model");',
      'const model = (at < 0 ? "probe" : process.argv[at + 1]).replace(/[^\\w-]/g, "_");',
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      'process.env.OMB_FIXTURE_CWD = process.cwd();',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(session.info.dataDir)}, model + ".gate");`,
      `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(session.info.dataDir)}, model + ".json");`,
      `await import(${JSON.stringify(fake)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
    const catalog = await tool("list_available_models", {});
    models = catalog.instances.find((instance: any) => instance.instanceId === "claude").models.options.map((model: any) => model.id);
    expect(models.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    if (!session) return;
    const evidencePath = `${session.info.logPath}.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ ...session.info, evidencePath }));
    await session.close();
  });

  it("rejects blank memory replacements, caps new titles, and retains project files after deletion", async () => {
    const created = await tool("create_bot", { name: "Release review fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    const task = await api("POST", `/api/bots/${botId}/tasks`, { title: `  ${"t".repeat(120)}  ` });
    expect(task.status).toBe(201);
    expect(task.body.task.title).toBe("t".repeat(80));
    const threadId = task.body.task.threadId;
    await control(["send", "--bot", botId, "--task", threadId, "--text", "REVIEW_MEMORY_OWNER"]);
    const launched = await dump(models[0]);
    const token = launched.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    expect((await internal(token, "POST", "/api/internal/memory", { action: "append", text: "A unique saved fact." })).status).toBe(200);
    for (const text of ["", " \n\t "]) {
      expect((await internal(token, "POST", "/api/internal/memory", { action: "replace", oldText: "unique saved fact", text })).status).toBe(400);
      // the append landed as one dated entry naming the thread it came from
      expect((await api("GET", `/api/bots/${botId}/memory`)).body.text).toBe(`- ${memoryDate()} · from chat "${"t".repeat(60)}…" · A unique saved fact.\n`);
    }
    const project = join(session.info.dataDir, "task-workspaces", botId, threadId, "result.txt");
    writeFileSync(project, "Generated project files are retained.");
    await control(["interrupt", "--bot", botId, "--task", threadId]);
    await expect.poll(async () => (await botState(botId)).busy, { timeout: 10_000 }).toBe(false);
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`)).status).toBe(200);
    expect((await api("DELETE", `/api/bots/${botId}`)).status).toBe(200);
    expect(readFileSync(project, "utf8")).toBe("Generated project files are retained.");
    evidence.push({ cappedTitleLength: 80, blankMemoryReplacementRejected: true, generatedFilesRetained: true });
  }, 30_000);

  it("exposes background waiting threads and pins paired approval answers to the displayed request", async () => {
    const created = await tool("create_bot", { name: "Phone approval fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    const threadA = created.bot.activeTaskId;
    await api("PATCH", `/api/bots/${botId}/tasks/${threadA}`, { approvalMode: "ask" });
    await control(["send", "--bot", botId, "--task", threadA, "--text", "Hold thread A for approval"]);
    const answersA = await permission(models[0], "phone-approval-a");

    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Phone background B" });
    const threadB = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", threadB, "--instance", "claude", "--model", models[1]]);
    await api("PATCH", `/api/bots/${botId}/tasks/${threadB}`, { approvalMode: "ask" });
    await control(["send", "--bot", botId, "--task", threadB, "--text", "Hold thread B for approval"]);
    const answersB = await permission(models[1], "phone-approval-b");
    await expect.poll(async () => (await botState(botId)).tasks.filter((task: any) => task.activity === "waiting-on-you").length).toBe(2);
    await tool("switch_task", { target_type: "bot", target_id: botId, task_id: threadA });

    const invitation = await api("POST", "/api/auth/pairing", { label: "Isolated iOS approval fixture", scopes: ["client", "admin"] });
    expect(invitation.status).toBe(200);
    const accepted = await api("POST", "/api/auth/pair", { code: invitation.body.code, label: "Isolated iOS client" });
    expect(accepted.status).toBe(200);
    const paired = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${session.info.url}${path}`, {
        method, headers: { "content-type": "application/json", authorization: `Bearer ${accepted.body.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    };
    const fleet = await paired("GET", "/api/bots?messages=50");
    const bot = fleet.body.bots.find((candidate: any) => candidate.id === botId);
    expect(bot.threadId).toBe(threadA);
    expect(bot.tasks.find((task: any) => task.threadId === threadB)?.activity).toBe("waiting-on-you");
    expect(bot.messages.some((message: any) => message.card?.requestId === "phone-approval-b")).toBe(false);
    const background = await paired("GET", `/api/threads/${threadB}/messages?limit=50`);
    expect(background.body.messages.some((message: any) => message.card?.requestId === "phone-approval-b" && !message.card.answered)).toBe(true);

    // A stale island's immutable A target must never authorize B's request.
    const stale = await paired("POST", `/api/threads/${threadA}/respond`, { requestId: "phone-approval-b", behavior: "allow" });
    expect(stale.body.outcome).toBe("unavailable");
    expect(answersA).toEqual([]);
    expect(answersB).toEqual([]);
    const answered = await paired("POST", `/api/threads/${threadB}/respond`, { requestId: "phone-approval-b", behavior: "allow" });
    expect(answered.status).toBe(200);
    expect(answered.body.outcome).toBe("allowed-once");
    await expect.poll(() => answersB.some((answer) => answer.id === "phone-approval-b")).toBe(true);
    expect(answersA).toEqual([]);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === threadA)?.activity).toBe("waiting-on-you");
    evidence.push({ phoneApproval: { botId, threadA, threadB, backgroundActivity: "waiting-on-you", staleOutcome: stale.body.outcome, displayedOutcome: answered.body.outcome } });
    await control(["interrupt", "--bot", botId, "--task", threadA]);
    await control(["interrupt", "--bot", botId, "--task", threadB]);
  }, 45_000);

  it("keeps A and B independent across selection, models, approvals, and stopping A", async () => {
    const created = await tool("create_bot", { name: "Independent fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    const taskA = created.bot.activeTaskId;
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskA}`, { approvalMode: "ask" })).status).toBe(200);
    await control(["send", "--bot", botId, "--task", taskA, "--text", "ONLY_A"]);
    const launchedA = await dump(models[0]);

    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Independent B" });
    const taskB = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", taskB, "--instance", "claude", "--model", models[1]]);
    // Loosening approval from an originless agent request stays forbidden;
    // this settings action models the trusted app's same-origin request.
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskB}`, { approvalMode: "auto" })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskB}`, { approvalMode: "auto" }, true)).status).toBe(200);
    await control(["send", "--bot", botId, "--task", taskB, "--text", "ONLY_B"]);
    const launchedB = await dump(models[1]);
    expect(launchedA.pid).not.toBe(launchedB.pid);
    expect(launchedA.argv[launchedA.argv.indexOf("--model") + 1]).toBe(models[0]);
    expect(launchedB.argv[launchedB.argv.indexOf("--model") + 1]).toBe(models[1]);
    expect(launchedA.argv[launchedA.argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(launchedB.argv[launchedB.argv.indexOf("--permission-mode") + 1]).toBe("auto");
    evidence.push({ providerSelections: [models[0], models[1]], distinctProcesses: true });
    expect(launchedA.env.OMB_FIXTURE_CWD).toBe(realpathSync(join(session.info.dataDir, "task-workspaces", botId, taskA)));
    expect(launchedB.env.OMB_FIXTURE_CWD).toBe(realpathSync(join(session.info.dataDir, "task-workspaces", botId, taskB)));

    const tokenA = launchedA.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const tokenB = launchedB.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    expect(tokenA).not.toBe(tokenB);
    const appended = await Promise.all([
      internal(tokenA, "POST", "/api/internal/memory", { botId, threadId: taskA, action: "append", text: "A remembers apples." }),
      internal(tokenB, "POST", "/api/internal/memory", { botId, threadId: taskB, action: "append", text: "B remembers berries." }),
    ]);
    expect(appended.map((result) => result.status)).toEqual([200, 200]);
    const memory = (await api("GET", `/api/bots/${botId}/memory`)).body.text;
    expect(memory).toContain("A remembers apples.");
    expect(memory).toContain("B remembers berries.");
    expect((await internal(tokenA, "POST", "/api/internal/memory", { action: "replace", oldText: "A remembers apples.", text: "A remembers apricots." })).status).toBe(200);
    expect((await internal(tokenB, "POST", "/api/internal/memory", { action: "replace", oldText: "A remembers apples.", text: "stale overwrite" })).status).toBe(409);
    const foreign = await tool("create_bot", { name: "Foreign memory owner" });
    expect((await internal(tokenA, "POST", "/api/internal/memory", { botId: foreign.bot.id, action: "append", text: "foreign write" })).status).toBe(403);
    expect((await internal(tokenA, "POST", "/api/internal/memory", { botId, threadId: taskB, action: "append", text: "wrong conversation" })).status).toBe(403);
    expect((await api("GET", `/api/bots/${foreign.bot.id}/memory`)).body.text).toBe("");

    await tool("switch_task", { target_type: "bot", target_id: botId, task_id: taskA });
    await tool("switch_task", { target_type: "bot", target_id: botId, task_id: taskB });
    expect((await botState(botId)).tasks.filter((task: any) => task.busy)).toHaveLength(2);
    expect((await control(["wait", "--bot", botId, "--task", taskA, "--timeout", "1"])).status).toBe("timed-out");
    const changeBusy = await api("PATCH", `/api/bots/${botId}/tasks/${taskA}`, { modelSelection: { instanceId: "claude", model: models[1] } });
    expect(changeBusy.status).toBe(409);

    const answerA = await permission(models[0], "approval-a");
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.taskId === taskA)?.activity).toBe("waiting-on-you");
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === taskB)?.activity).toBe("working");
    expect((await api("POST", `/api/bots/${botId}/respond`, { threadId: taskA, requestId: "approval-a", behavior: "allow" })).status).toBe(200);
    await expect.poll(() => answerA.some((answer) => answer.id === "approval-a")).toBe(true);

    await control(["interrupt", "--bot", botId, "--task", taskA]);
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.taskId === taskA)?.busy).toBe(false);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === taskB)?.busy).toBe(true);
    expect((await internal(tokenA, "POST", "/api/internal/memory", { action: "append", text: "expired write" })).status).toBe(401);
    expect((await internal(tokenB, "POST", "/api/internal/memory", { action: "append", text: "B is still authorized." })).status).toBe(200);
    expect((await control(["wait", "--bot", botId, "--task", taskA, "--timeout", "1"])).status).toBe("settled");
    writeFileSync(modelFile(models[1], "gate"), "finish B");
    expect((await control(["wait", "--bot", botId, "--task", taskB, "--timeout", "10"])).status).toBe("settled");
    const messagesA = await control(["messages", "--bot", botId, "--task", taskA]);
    const messagesB = await control(["messages", "--bot", botId, "--task", taskB]);
    expect(JSON.stringify(messagesA.messages)).not.toContain("ONLY_B");
    expect(JSON.stringify(messagesB.messages)).not.toContain("ONLY_A");
    expect(messagesB.messages.some((message: any) => message.role === "bot" && message.text?.includes("ONLY_B"))).toBe(true);

    const userA = messagesA.messages.find((message: any) => message.role === "user");
    expect((await api("POST", `/api/bots/${botId}/messages/${userA.id}/edit`, { threadId: taskB, text: "wrong task" })).status).toBe(404);
    expect((await api("POST", `/api/bots/${botId}/active-branch`, { threadId: taskB, messageId: userA.id })).status).toBe(404);

    // Compatibility: changing the profile model updates only the selected
    // idle task, not the independently configured sibling.
    const legacyModel = models.at(-1)!;
    expect((await api("PATCH", `/api/bots/${botId}`, { modelSelection: { instanceId: "claude", model: legacyModel } })).status).toBe(200);
    const final = await botState(botId);
    expect(final.tasks.find((task: any) => task.taskId === taskB).modelSelection.model).toBe(legacyModel);
    expect(final.tasks.find((task: any) => task.taskId === taskA).modelSelection.model).toBe(models[0]);
  }, 45_000);

  it("cancels a detached routine on its captured provider after an idle sibling changes the default", async () => {
    const created = await tool("create_bot", { name: "Routine provider fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    const selectedThread = created.bot.activeTaskId;
    const routine = await api("POST", "/api/routines", {
      name: "Captured routine provider", prompt: "ROUTINE_PROVIDER_OWNER", botId, runOn: "maus", enabled: false,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    expect(routine.status).toBe(201);
    const launched = await api("POST", `/api/routines/${routine.body.routine.id}/run`);
    expect(launched.status).toBe(201);
    await dump(models[0]);
    const run = (await api("GET", "/api/routines")).body.runs.find((item: any) => item.id === launched.body.run.id);
    expect(run.threadId).not.toBe(selectedThread);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === run.threadId)?.busy).toBe(true);
    // An offline profile default is supported; it must not become the
    // cancellation target for an already-running task on Claude.
    expect((await api("PATCH", `/api/bots/${botId}`, {
      modelSelection: { instanceId: "offline-fixture", model: "offline-model" },
    })).status).toBe(200);
    expect((await api("POST", `/api/routine-runs/${run.id}/cancel`)).status).toBe(200);
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.taskId === run.threadId)?.busy,
      { timeout: 10_000 }).toBe(false);
    const final = await botState(botId);
    expect(final.tasks.find((task: any) => task.taskId === run.threadId)?.modelSelection.instanceId).toBe("claude");
    expect(final.tasks.find((task: any) => task.taskId === selectedThread)?.modelSelection.instanceId).toBe("offline-fixture");
    evidence.push({ routineCancelledOnOriginalProvider: true, runId: run.id, taskId: run.threadId });
  }, 30_000);

  it("keeps a Group's profile model fixed while allowing independent idle task settings", async () => {
    const created = await tool("create_bot", { name: "Group model fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    const threadId = created.bot.activeTaskId;
    const group = (await api("POST", "/api/groups", { name: "Captured Group provider", memberIds: [botId] })).body.group;
    expect((await api("PATCH", `/api/groups/${group.id}/setup`, {
      action: "complete", cwd: null, bulletin: "", defaultResponder: { kind: "member", botId },
    })).status).toBe(200);
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "GROUP_MODEL_OWNER" })).status).toBe(202);
    await dump(models[0]);
    const selection = { instanceId: "claude", model: models[1] };
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { modelSelection: selection })).status).toBe(200);
    // The selected task already has B, but the Group still owns default A:
    // a no-op relative to the task is not a no-op relative to the Group.
    expect((await api("PATCH", `/api/bots/${botId}/model`, selection)).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${botId}`, { modelSelection: selection })).status).toBe(409);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === threadId)?.modelSelection).toEqual(selection);
    const profile = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(profile.modelSelection.model).toBe(models[0]);
    expect((await api("POST", `/api/groups/${group.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(async () => (await botState(botId)).busy, { timeout: 10_000 }).toBe(false);
    expect((await api("PATCH", `/api/bots/${botId}/model`, selection)).status).toBe(200);
    evidence.push({ groupDefaultPreservedUntilStop: true, groupId: group.id, selectedTaskId: threadId });
  }, 30_000);

  it("refuses a second engine in the same selected project folder until its owner stops", async () => {
    const created = await tool("create_bot", { name: "Shared project fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    const taskA = created.bot.activeTaskId;
    const cwd = join(session.info.dataDir, "selected-project");
    mkdirSync(cwd);
    expect((await api("PATCH", `/api/bots/${botId}`, { cwd })).status).toBe(200);
    await control(["send", "--bot", botId, "--task", taskA, "--text", "PROJECT_A"]);
    expect((await dump(models[0])).env.OMB_FIXTURE_CWD).toBe(realpathSync(cwd));
    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Project sibling" });
    const taskB = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", taskB, "--instance", "claude", "--model", models[1]]);
    await control(["send", "--bot", botId, "--task", taskB, "--text", "PROJECT_B_CONFLICT"]);
    const blocked = await control(["wait", "--bot", botId, "--task", taskB, "--timeout", "10"]);
    expect(blocked.status).toBe("failed");
    expect(JSON.stringify(blocked.messages)).toContain("project folder");
    expect(existsSync(modelFile(models[1], "json"))).toBe(false);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === taskA)?.busy).toBe(true);

    await control(["interrupt", "--bot", botId, "--task", taskA]);
    await control(["wait", "--bot", botId, "--task", taskA, "--timeout", "10"]);
    await control(["send", "--bot", botId, "--task", taskB, "--text", "PROJECT_B_NOW_OWNS_FOLDER"]);
    expect((await dump(models[1])).env.OMB_FIXTURE_CWD).toBe(realpathSync(cwd));
    await control(["interrupt", "--bot", botId, "--task", taskB]);
  }, 45_000);

  it.skipIf(process.platform !== "darwin")("claims the shared computer only on first use and keeps a sibling stop from releasing it", async () => {
    // The fake provider only receives this inert descriptor; no UI driver is
    // launched and the descriptor lives inside the fixture's disposable home.
    const descriptorDir = join(session.info.dataDir, "Library", "Application Support", "OpenMausBot");
    mkdirSync(descriptorDir, { recursive: true });
    writeFileSync(join(descriptorDir, "cua-connection.json"), JSON.stringify({
      mcpCommand: join(session.info.dataDir, "never-launched-computer"), mcpArgs: [], mcpEnv: {},
    }));
    const created = await tool("create_bot", { name: "Computer lease fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    const taskA = created.bot.activeTaskId;
    expect((await api("PATCH", `/api/bots/${botId}`, { computer: "local" })).status).toBe(200);
    await control(["send", "--bot", botId, "--task", taskA, "--text", "COMPUTER_A"]);
    const launchedA = await dump(models[0]);
    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Computer sibling" });
    const taskB = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", taskB, "--instance", "claude", "--model", models[1]]);
    await control(["send", "--bot", botId, "--task", taskB, "--text", "COMPUTER_B"]);
    const launchedB = await dump(models[1]);
    const gate = (launched: any) => {
      const env = launched.mcpConfig.mcpServers.computer.env;
      const url = new URL(env.OMB_CONTROL_URL);
      expect(url.origin).toBe(session.info.url);
      return internal(env.OMB_CONTROL_TOKEN, "GET", `${url.pathname}${url.search}`);
    };
    // B acquires first although A started first: mounting the tool did not
    // lock the shared computer. A receives an actionable hold, not authority.
    expect((await gate(launchedB)).body.held).toBe(false);
    expect((await gate(launchedA)).body).toMatchObject({ held: true, blockedReason: expect.stringContaining("Another thread") });
    await control(["interrupt", "--bot", botId, "--task", taskA]);
    expect((await gate(launchedA)).status).toBe(401);
    expect((await gate(launchedB)).body.held).toBe(false);
    await control(["interrupt", "--bot", botId, "--task", taskB]);
    expect((await gate(launchedB)).status).toBe(401);

    await control(["send", "--bot", botId, "--task", taskA, "--text", "COMPUTER_A_NEW_GENERATION"]);
    await expect.poll(async () => (await dump(models[0])).pid !== launchedA.pid).toBe(true);
    const relaunchedA = await dump(models[0]);
    expect((await gate(relaunchedA)).body.held).toBe(false);
    await control(["interrupt", "--bot", botId, "--task", taskA]);
  }, 45_000);

  it("keeps an unattended task's approval requirement while a sibling runs attended", async () => {
    const created = await tool("create_bot", { name: "Unattended fixture", instance_id: "claude", model: models[0] });
    const botId = created.bot.id;
    expect((await api("PATCH", `/api/bots/${botId}`, { approvalMode: "auto" })).status).toBe(200);
    const hook = await api("POST", "/api/webhooks", { name: "Fixture event", prompt: "UNATTENDED_ONLY", botId, runOn: "maus" });
    expect(hook.status).toBe(201);
    const delivered = await fetch(hook.body.credential.url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(delivered.status).toBe(202);
    const { runId } = await delivered.json() as { runId: string };
    let unattendedTask = "";
    await expect.poll(async () => {
      unattendedTask = (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId)?.threadId ?? "";
      return Boolean(unattendedTask);
    }, { timeout: 15_000 }).toBe(true);
    const unattendedLaunch = await dump(models[0]);
    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Attended sibling" });
    const attendedTask = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", attendedTask, "--instance", "claude", "--model", models[1]]);
    await control(["send", "--bot", botId, "--task", attendedTask, "--text", "ATTENDED_ONLY"]);
    const attendedLaunch = await dump(models[1]);
    expect(unattendedLaunch.argv[unattendedLaunch.argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(attendedLaunch.argv[attendedLaunch.argv.indexOf("--permission-mode") + 1]).toBe("auto");

    const unattendedAnswers = await permission(models[0], "unattended-permission");
    expect((await control(["wait", "--bot", botId, "--task", unattendedTask, "--timeout", "5"])).status).toBe("needs-user");
    const card = (await api("GET", `/api/threads/${unattendedTask}/messages`)).body.messages
      .find((message: any) => message.card?.requestId === "unattended-permission");
    expect(card.card.heldCode).toMatch(/unattended/);
    expect(unattendedAnswers).toEqual([]);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === attendedTask)?.activity).toBe("working");
    await control(["interrupt", "--bot", botId, "--task", attendedTask]);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === unattendedTask)?.activity).toBe("waiting-on-you");
    await control(["messages", "--bot", botId, "--task", unattendedTask]);
    await control(["interrupt", "--bot", botId, "--task", unattendedTask]);
  }, 45_000);
});
