// Real server + injected MCP tools; only the provider's planning is scripted. Ported from @AdityaUmale's test.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";

// A Chief's level reached the teammate it handed work to and stopped there: Clive on Approve for me, Ada ran at auto,
// and the work Ada handed Bea ran at Ask ("default").
it("carries a Chief's level down every hop it hands out, in threads and in a room, and never an ordinary bot's", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: any[] }> = {};
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
  const chips = async (threadId: string) => (await messages(threadId))
    .filter(message => message.kind === "activity" && / — delegated by /.test(message.tool?.name ?? "")).map(message => message.tool.name);
  const coordinate = (botId: string, key: string, message: string) =>
    ({ tool: "coordinate_bots", arguments: { bot_ids: [botId], request_key: key, message }, expectError: false });
  const plan = (botId: string, ...turns: any[]) => { (plans[botId] ??= { turns: [] }).turns.push(...turns); writeFileSync(planPath, JSON.stringify(plans)); };
  const turnOf = (botId: string, index = 0) => providerTurns().filter(turn => turn.botId === botId)[index];
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await cli("new-bot", "--name", "Ada", "--section", "Operations")).bot;
    const bea = (await cli("new-bot", "--name", "Bea", "--section", "Operations")).bot;
    const ola = (await cli("new-bot", "--name", "Ola", "--section", "Operations")).bot;
    // The person put Clive, and Ola, an ordinary bot, on Approve for me; Ada and Bea on Ask, below the Full default.
    for (const auto of [chief, ola]) await api("PATCH", `/api/bots/${auto.id}`, { approvalMode: "auto", acknowledgeLocalAuto: true, applyToAllThreads: true });
    for (const teammate of [ada, bea]) await api("PATCH", `/api/bots/${teammate.id}`, { approvalMode: "ask" });

    // Clive → Ada → Bea, each in a thread of its own.
    plan(chief.id,
      { steps: [coordinate(ada.id, "hop-ada", "Have Bea run the check; do not run it yourself.")], reply: "Handed to Ada." },
      { reply: "Ada reported Bea's result." });
    plan(ada.id,
      { steps: [coordinate(bea.id, "hop-bea", "Run the check and report the result.")], reply: "Handed to Bea." },
      { reply: "Bea ran the check." });
    plan(bea.id, { reply: "Check done." });
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Ada to get Bea to run the check.");
    await expect.poll(() => providerTurns().filter(turn => turn.botId === chief.id).length, { timeout: 30_000 }).toBe(2);
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "25")).status).toBe("settled");
    const adaTurn = turnOf(ada.id);
    const beaTurn = turnOf(bea.id);
    expect(adaTurn.permissionMode).toBe("auto");
    expect(beaTurn.permissionMode, "the second hop runs at the Chief's level too").toBe("auto");
    expect(await unanswered(adaTurn.threadId)).toHaveLength(0);
    expect(await unanswered(beaTurn.threadId)).toHaveLength(0);
    const current = await bots();
    expect(current.find(bot => bot.id === ada.id).approvalMode).toBe("ask");
    expect(current.find(bot => bot.id === bea.id).approvalMode).toBe("ask");
    expect(current.find(bot => bot.id === bea.id).tasks.find((task: any) => task.threadId === beaTurn.threadId).approvalMode).toBe("auto");
    expect(await chips(adaTurn.threadId)).toEqual(["Approve for me — delegated by Clive, a Chief of Staff on Approve for me"]);
    expect(await chips(beaTurn.threadId)).toEqual(["Approve for me — delegated by Ada, from Clive, a Chief of Staff on Approve for me"]);

    // Ola's own Approve for me came from the person, not a Chief: the work she hands Bea stays on Bea's level.
    plan(ola.id,
      { steps: [coordinate(bea.id, "ordinary-bea", "Run the check and report the result.")], reply: "Handed to Bea." },
      { reply: "Bea ran the check." });
    plan(bea.id, { reply: "Check done again." });
    await cli("send", "--bot", ola.id, "--task", ola.activeTaskId, "--text", "Ask Bea to run the check.");
    await expect.poll(() => providerTurns().filter(turn => turn.botId === ola.id).length, { timeout: 30_000 }).toBe(2);
    expect((await cli("wait", "--bot", ola.id, "--task", ola.activeTaskId, "--timeout", "25")).status).toBe("settled");
    const ordinaryTurn = turnOf(bea.id, 1);
    expect(ordinaryTurn.threadId).not.toBe(beaTurn.threadId);
    expect(ordinaryTurn.permissionMode).toBe("default");
    expect(await chips(ordinaryTurn.threadId)).toEqual([]);

    // The same chain inside a room. The room thread is shared, so nothing is patched onto it: each turn's level rides
    // its hand-off back up to Clive.
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
    expect(roomAda.permissionMode).toBe("auto");
    expect(roomBea.permissionMode, "the second hop in a room runs at the Chief's level too").toBe("auto");
    expect(await unanswered(room.activeTaskId)).toHaveLength(0);
    const after = await bots();
    expect(after.find(bot => bot.id === ada.id).approvalMode).toBe("ask");
    expect(after.find(bot => bot.id === bea.id).approvalMode).toBe("ask");
    expect(readFileSync(logPath, "utf8")).not.toMatch(/ReferenceError|change listener threw|Unexpected extra fixture turn/);
  } finally {
    console.info(JSON.stringify({ logPath, providerTurns: providerTurns().map(turn => ({ botId: turn.botId, threadId: turn.threadId, permissionMode: turn.permissionMode })) }));
    await fixture.close();
  }
}, 150_000);
