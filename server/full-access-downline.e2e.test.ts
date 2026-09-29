// Real server + injected MCP tools; only the provider's planning is scripted.
// Persisted Full grants below belong exclusively to this stopped fixture.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

// MOCA-226: a Chief's Full access reached the teammate it delegated to, but
// stopped there — that teammate's own delegation asked the person again.
it("passes a Chief's delegated Full access down the line, and never Full a bot got any other way", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: any[] }> = {};
  let restarted: ChildProcess | undefined;
  const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, { method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) =>
    handleToolCall(name, args, (path, options) => request(path, options, url)) as Promise<any>;
  const bots = async () => (await api("GET", "/api/bots")).bots as any[];
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const unanswered = async (threadId: string) => (await messages(threadId)).filter(message => message.card && !message.card.answered && !message.card.dismissed);
  const coordinate = (botId: string, key: string, message: string) =>
    ({ tool: "coordinate_bots", arguments: { bot_ids: [botId], request_key: key, message }, expectError: false });
  const plan = (botId: string, ...turns: any[]) => { (plans[botId] ??= { turns: [] }).turns.push(...turns); writeFileSync(planPath, JSON.stringify(plans)); };
  const turnOf = (botId: string, index = 0) => providerTurns().filter(turn => turn.botId === botId)[index];
  const restart = async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase()) && value) env[key.toUpperCase()] = value;
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1), PATH: dirname(process.execPath),
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: fixture.fixtureDumpPath,
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, `see ${logPath}`).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await cli("new-bot", "--name", "Ada", "--section", "Operations")).bot;
    const bea = (await cli("new-bot", "--name", "Bea", "--section", "Operations")).bot;
    const ola = (await cli("new-bot", "--name", "Ola", "--section", "Operations")).bot;

    // This is fixture setup, not a production grant endpoint or bypass flag.
    // Stop the exact owned server before changing its disposable persisted
    // data: Clive gets Full as a person would give it, and so does Ola —
    // an ordinary bot, not a Chief. Ada and Bea stay on Ask.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const savedBots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    for (const id of [chief.id, ola.id]) {
      const saved = savedBots.find((bot: any) => bot.id === id);
      saved.approvalMode = "full"; saved.autoApprove = false;
      for (const task of saved.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
    }
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(savedBots, null, 2));
    await restart();

    // Clive → Ada → Bea, the chain from the report.
    plan(chief.id,
      { steps: [coordinate(ada.id, "downline-ada", "Have Bea run the check; do not run it yourself.")], reply: "Handed to Ada." },
      { reply: "Ada reported Bea's result." });
    plan(ada.id,
      { steps: [coordinate(bea.id, "downline-bea", "Run the check and report the result.")], reply: "Handed to Bea." },
      { reply: "Bea ran the check." });
    plan(bea.id, { reply: "Check done." });
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Ada to get Bea to run the check.");
    await expect.poll(() => providerTurns().filter(turn => turn.botId === chief.id).length, { timeout: 30_000 }).toBe(2);
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "25")).status).toBe("settled");

    const adaTurn = turnOf(ada.id);
    const beaTurn = turnOf(bea.id);
    expect(adaTurn.permissionMode).toBe("bypassPermissions");
    // The fix: Bea's work runs Full too, although her own level is Ask.
    expect(beaTurn.permissionMode).toBe("bypassPermissions");
    expect(await unanswered(adaTurn.threadId)).toHaveLength(0);
    expect(await unanswered(beaTurn.threadId)).toHaveLength(0);
    const current = await bots();
    expect(current.find(bot => bot.id === ada.id).approvalMode ?? "ask").toBe("ask");
    expect(current.find(bot => bot.id === bea.id).approvalMode ?? "ask").toBe("ask");
    expect(current.find(bot => bot.id === bea.id).tasks.find((task: any) => task.threadId === beaTurn.threadId).approvalMode).toBe("full");
    // Each thread says where its Full came from, once.
    const chips = async (threadId: string) => (await messages(threadId))
      .filter(message => message.kind === "activity" && (message.tool?.name ?? "").startsWith("Full access — ")).map(message => message.tool.name);
    expect(await chips(adaTurn.threadId)).toEqual(["Full access — delegated by Clive, a Chief of Staff with Full access"]);
    expect(await chips(beaTurn.threadId)).toEqual(["Full access — delegated by Ada, passing on Full access from Clive, a Chief of Staff"]);
    // Where it came from is server bookkeeping, not wire data.
    expect(JSON.stringify(current)).not.toContain("fullAccessDelegation");

    // Ola has Full from the person, but no Chief handed it to her: her
    // delegation keeps Bea on Bea's own level, as before.
    plan(ola.id,
      { steps: [coordinate(bea.id, "ordinary-bea", "Run the check and report the result.")], reply: "Handed to Bea." },
      { reply: "Bea ran the check." });
    plan(bea.id, { reply: "Check done again." });
    await cli("send", "--bot", ola.id, "--task", ola.activeTaskId, "--text", "Ask Bea to run the check.");
    await expect.poll(() => providerTurns().filter(turn => turn.botId === ola.id).length, { timeout: 30_000 }).toBe(2);
    expect((await cli("wait", "--bot", ola.id, "--task", ola.activeTaskId, "--timeout", "25")).status).toBe("settled");
    const ordinaryTurn = turnOf(bea.id, 1);
    expect(ordinaryTurn.threadId).not.toBe(beaTurn.threadId);
    expect(ordinaryTurn.permissionMode).not.toBe("bypassPermissions");
    expect((await bots()).find(bot => bot.id === bea.id).tasks.find((task: any) => task.threadId === ordinaryTurn.threadId).approvalMode ?? "ask").not.toBe("full");
    expect(await chips(ordinaryTurn.threadId)).toEqual([]);

    // The same chain inside a room. The room thread is shared, so nothing is
    // stored on it: Bea's level rides the handoff back to Clive.
    const room = (await tool("create_channel", { name: "Operations room", member_ids: [chief.id, ada.id, bea.id] })).channel;
    plan(chief.id,
      { steps: [coordinate(ada.id, "room-ada", "Have Bea run the check here; do not run it yourself.")], reply: "Handed to Ada in the room." },
      { reply: "Ada reported Bea's room result." });
    plan(ada.id,
      { steps: [coordinate(bea.id, "room-bea", "Run the check and report the result.")], reply: "Handed to Bea in the room." },
      { reply: "Bea ran the room check." });
    plan(bea.id, { reply: "Room check done." });
    await cli("send-channel", "--channel", room.id, "--text", "@Clive Ask Ada to get Bea to run the check.");
    await expect.poll(() => providerTurns().filter(turn => turn.botId === chief.id).length, { timeout: 30_000 }).toBe(4);
    expect((await cli("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
    const roomAda = turnOf(ada.id, 2);
    const roomBea = turnOf(bea.id, 2);
    expect(roomAda.threadId).toBe(room.activeTaskId);
    expect(roomBea.threadId).toBe(room.activeTaskId);
    expect(roomAda.permissionMode).toBe("bypassPermissions");
    expect(roomBea.permissionMode).toBe("bypassPermissions");
    expect(await unanswered(room.activeTaskId)).toHaveLength(0);

    // Where Bea's Full came from is saved with her thread, so she can pass
    // it on again after a restart.
    await waitForExit(restarted, { signal: "SIGTERM" });
    const persisted = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const persistedBea = persisted.find((bot: any) => bot.id === bea.id).tasks.find((task: any) => task.threadId === beaTurn.threadId);
    expect(persistedBea.fullAccessDelegation).toEqual({ fromBotId: ada.id, fromName: "Ada", chiefBotId: chief.id, chiefName: "Clive" });
    expect(readFileSync(logPath, "utf8")).not.toMatch(/ReferenceError|change listener threw|Unexpected extra fixture turn/);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    console.info(JSON.stringify({ logPath, providerTurns: providerTurns().map(turn => ({ botId: turn.botId, threadId: turn.threadId, permissionMode: turn.permissionMode })) }));
    await fixture.close();
  }
}, 150_000);
