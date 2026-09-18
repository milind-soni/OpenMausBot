import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import {
  launchVerificationServer,
  runControlOmb,
  type VerificationServer,
  type VerificationServerOptions,
} from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";

type FixtureOptions = Pick<VerificationServerOptions, "dataDir" | "continuity" | "fakeAcpMode">;

const semanticPromptAssertions: NonNullable<VerificationServerOptions["fakeAcpPromptAssertions"]> = [
  { contains: ["ROOM_A1_SENTINEL"], occurrences: [{ text: "ROOM_A1_SENTINEL" }] },
  { contains: ["ROOM_A2_SENTINEL"], absent: ["ROOM_A1_SENTINEL"], occurrences: [{ text: "ROOM_A2_SENTINEL" }] },
  { contains: ["ROOM_A1_SENTINEL", "ROOM_A2_SENTINEL", "ROOM_B1_SENTINEL"] },
  { contains: ["ROOM_B1_SENTINEL", "ROOM_A3_SENTINEL"], absent: ["ROOM_A1_SENTINEL", "ROOM_A2_SENTINEL"] },
  { contains: ["ROOM_A4_SENTINEL", "ROOM_MEMORY_A4_SENTINEL"], absent: ["ROOM_A1_SENTINEL"], occurrences: [{ text: "ROOM_MEMORY_A4_SENTINEL" }] },
  { contains: ["ROOM_A4S_SENTINEL", "ROOM_SOUL_A4S_SENTINEL"], absent: ["ROOM_A1_SENTINEL", "ROOM_A4_SENTINEL"], occurrences: [{ text: "ROOM_SOUL_A4S_SENTINEL" }] },
  { contains: ["ROOM_A1_SENTINEL", "ROOM_A5_SENTINEL"], occurrences: [{ text: "ROOM_A5_SENTINEL" }] },
  { contains: ["ROOM_A6_SENTINEL"], absent: ["ROOM_A1_SENTINEL", "ROOM_A5_SENTINEL"] },
  { contains: ["ROOM_A6_SENTINEL", "ROOM_A7_SENTINEL"], occurrences: [{ text: "ROOM_A6_SENTINEL" }, { text: "ROOM_A7_SENTINEL" }] },
  { contains: ["ROOM_FILL_25", "ROOM_A8_SENTINEL"], absent: ["ROOM_A1_SENTINEL", "ROOM_A2_SENTINEL"], occurrences: [{ text: "ROOM_A8_SENTINEL" }] },
  { contains: ["ROOM_FILL_25", "ROOM_A9_SENTINEL"], absent: ["ROOM_A1_SENTINEL", "ROOM_A2_SENTINEL"], occurrences: [{ text: "ROOM_A9_SENTINEL" }] },
];

it("keeps private A/B/A room sessions isolated through recovery, rotation, restart, and deletion", async () => {
  const start = (options: FixtureOptions = {}) => launchVerificationServer(
    process.env,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ["acp"],
    undefined,
    { ...options, fakeAcpPromptAssertions: semanticPromptAssertions },
  );
  let fixture: VerificationServer = await start();
  let env = { OPENMAUSBOT_URL: fixture.info.url };
  let control = (args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  let fetcher = (path: string, options: RequestInit = {}) => request(path, options, fixture.info.url);
  const rebind = () => {
    env = { OPENMAUSBOT_URL: fixture.info.url };
    control = (args: string[]) => runControlOmb(args, { env }) as Promise<any>;
    fetcher = (path: string, options: RequestInit = {}) => request(path, options, fixture.info.url);
  };
  const restart = async (fakeAcpMode = "receipt") => {
    const dataDir = fixture.info.dataDir;
    await fixture.stop();
    fixture = await start({ dataDir, fakeAcpMode });
    rebind();
  };
  const wait = async (channelId: string) => {
    const result = await control(["wait", "--channel", channelId, "--timeout", "30"]);
    expect(result.status).toBe("settled");
  };
  const native = (threadId: string) => {
    const path = `${fixture.info.dataDir}/native/${threadId}.ndjson`;
    if (!existsSync(path)) return [] as any[];
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  const promptEntries = (threadId: string) => native(threadId)
    .filter((entry: any) => entry.msg?.method === "session/prompt");
  const protocolMethods = (threadId: string) => native(threadId)
    .filter((entry: any) => ["session/new", "session/load"].includes(entry.msg?.method))
    .map((entry: any) => entry.msg.method);
  const roomPlans = (threadId: string, botId: string) => native(threadId)
    .filter((entry: any) => entry.source === "prompt.plan" && entry.msg?.owner === "room" && entry.msg.botId === botId);
  const promptReceipts = () => readFileSync(fixture.fakeAcpReceiptPath, "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry: any) => entry.method === "session/prompt");
  const lastPromptAddedAfter = (threadId: string, before: number) => {
    const added = promptEntries(threadId).slice(before);
    expect(added).toHaveLength(1);
    return added[0]?.msg;
  };
  const postRoomMessage = (channelId: string, text: string) => fetcher(`/api/groups/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  try {
    const catalog = await control(["models"]);
    const acp = catalog.instances.find((instance: any) => instance.instanceId === "acp");
    expect(acp).toBeTruthy();
    const model = acp.models.options[0].id;
    const changedModel = acp.models.options.find((option: any) => option.id !== model)?.id;
    expect(changedModel).toBeTruthy();
    const a = (await control(["new-bot", "--name", "Alpha"])).bot;
    const b = (await control(["new-bot", "--name", "Beta"])).bot;
    await control(["set-model", "--bot", a.id, "--instance", "acp", "--model", model]);
    await control(["set-model", "--bot", b.id, "--instance", "acp", "--model", model]);
    const created = await handleToolCall("create_channel", {
      name: "Continuity room",
      member_ids: [a.id, b.id],
      default_responder: { kind: "mentions" },
    }, (path, options) => fetcher(path, options));
    const channel = (created as any).channel;
    const threadId = channel.activeTaskId;

    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A1_SENTINEL"]);
    await wait(channel.id);
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A2_SENTINEL"]);
    await wait(channel.id);
    await control(["send-channel", "--channel", channel.id, "--text", "@Beta ROOM_B1_SENTINEL"]);
    await wait(channel.id);
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A3_SENTINEL"]);
    await wait(channel.id);

    let entries = native(threadId);
    let alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(3);
    expect(alphaPlans[0].msg.systemSentBytes).toBeGreaterThan(0);
    expect(alphaPlans[1].msg.systemSentBytes).toBe(0);
    expect(alphaPlans[2].msg.systemSentBytes).toBe(0);
    expect(alphaPlans[1].msg.roomMessagesSent).toBeGreaterThan(0);
    expect(alphaPlans[2].msg.roomMessagesSent).toBeGreaterThan(0);
    expect(protocolMethods(threadId)).toEqual(["session/new", "session/load", "session/new", "session/load"]);
    expect(promptReceipts().slice(0, 4).map((entry: any) => entry.checks)).toEqual([
      { contains_0: true, occurrences_0: 1 },
      { contains_0: true, absent_0: true, occurrences_0: 1 },
      { contains_0: true, contains_1: true, contains_2: true },
      { contains_0: true, contains_1: true, absent_0: true, absent_1: true },
    ]);
    const prompts = promptEntries(threadId);
    // Native diagnostics retain only bounded byte/shape summaries. Prompt
    // bodies and room sentinels must never appear in logs or inspector data.
    expect(JSON.stringify(prompts)).not.toMatch(/ROOM_[A-Z0-9_]+/);

    // A4: a memory-only change refreshes one volatile instruction section while
    // preserving Alpha's native room session and cursor.
    const memoryUpdate = await fetcher(`/api/bots/${a.id}/memory`, {
      method: "PUT",
      body: JSON.stringify({ text: "ROOM_MEMORY_A4_SENTINEL" }),
    });
    expect(memoryUpdate.ok).toBe(true);
    const beforeA4Prompts = promptEntries(threadId).length;
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A4_SENTINEL"]);
    await wait(channel.id);
    const a4Prompt = lastPromptAddedAfter(threadId, beforeA4Prompts);
    alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(4);
    expect(alphaPlans.at(-1).msg.reason).toBe("resume");
    expect(alphaPlans.at(-1).msg.systemSentBytes).toBeGreaterThan(0);
    expect(alphaPlans.at(-1).msg.sections.find((section: any) => section.id === "memory")?.sent).toBe(true);
    expect(JSON.stringify(a4Prompt)).not.toContain("ROOM_A4_SENTINEL");
    expect(JSON.stringify(a4Prompt)).not.toContain("ROOM_MEMORY_A4_SENTINEL");
    expect(protocolMethods(threadId).at(-1)).toBe("session/load");
    expect(promptReceipts()[4]?.checks).toEqual({ contains_0: true, contains_1: true, absent_0: true, occurrences_0: 1 });

    // A4S: a SOUL.md edit changes only the standing-instructions section.
    // It must preserve Alpha's native session just like the volatile memory
    // update while sending neither old room history nor the prior turn again.
    const soulUpdate = await fetcher(`/api/bots/${a.id}`, {
      method: "PATCH",
      body: JSON.stringify({ soul: "ROOM_SOUL_A4S_SENTINEL" }),
    });
    expect(soulUpdate.bot).toMatchObject({ id: a.id, soul: "ROOM_SOUL_A4S_SENTINEL" });
    const beforeA4SPrompts = promptEntries(threadId).length;
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A4S_SENTINEL"]);
    await wait(channel.id);
    const a4sPrompt = lastPromptAddedAfter(threadId, beforeA4SPrompts);
    alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(5);
    expect(alphaPlans.at(-1).msg.reason).toBe("resume");
    expect(alphaPlans.at(-1).msg.mode).toBe("resume");
    expect(alphaPlans.at(-1).msg.systemSentBytes).toBeGreaterThan(0);
    expect(alphaPlans.at(-1).msg.sections.find((section: any) => section.id === "soul")?.sent).toBe(true);
    expect(JSON.stringify(a4sPrompt)).not.toMatch(/ROOM_(?:SOUL_)?A4S_SENTINEL/);
    expect(protocolMethods(threadId).at(-1)).toBe("session/load");
    expect(promptReceipts()[5]?.checks).toEqual({
      contains_0: true,
      contains_1: true,
      absent_0: true,
      absent_1: true,
      occurrences_0: 1,
    });

    // A5: changing the selected model invalidates the private owner and starts
    // a fresh bounded room context.
    await control(["set-model", "--bot", a.id, "--instance", "acp", "--model", changedModel]);
    const beforeA5Prompts = promptEntries(threadId).length;
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A5_SENTINEL"]);
    await wait(channel.id);
    const a5Prompt = lastPromptAddedAfter(threadId, beforeA5Prompts);
    alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(6);
    expect(alphaPlans.at(-1).msg.reason).toBe("model-changed");
    expect(alphaPlans.at(-1).msg.mode).toBe("fresh");
    expect(alphaPlans.at(-1).msg.systemSentBytes).toBeGreaterThan(0);
    expect(JSON.stringify(a5Prompt)).not.toContain("ROOM_A1_SENTINEL");
    expect(JSON.stringify(a5Prompt)).not.toContain("ROOM_A5_SENTINEL");
    expect(protocolMethods(threadId).at(-1)).toBe("session/new");
    expect(promptReceipts()[6]?.checks).toEqual({ contains_0: true, contains_1: true, occurrences_0: 1 });

    // A6: a new server process on the same private DATA_DIR reloads the
    // continuation record and loads Alpha's native session.
    await restart();
    const beforeA6Prompts = promptEntries(threadId).length;
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A6_SENTINEL"]);
    await wait(channel.id);
    const a6Prompt = lastPromptAddedAfter(threadId, beforeA6Prompts);
    alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(7);
    expect(alphaPlans.at(-1).msg.reason).toBe("resume");
    expect(alphaPlans.at(-1).msg.mode).toBe("resume");
    expect(alphaPlans.at(-1).msg.systemSentBytes).toBe(0);
    expect(JSON.stringify(a6Prompt)).not.toContain("ROOM_A6_SENTINEL");
    expect(JSON.stringify(a6Prompt)).not.toContain("ROOM_A5_SENTINEL");
    expect(protocolMethods(threadId).at(-1)).toBe("session/load");
    expect(promptReceipts()[7]?.checks).toEqual({ contains_0: true, absent_0: true, absent_1: true });

    // A7: the provider reports a dead native session. The driver sends one
    // bounded recovery prompt on a new session and never replays it.
    await restart("dead-session");
    const beforeA7Methods = protocolMethods(threadId).length;
    const beforeA7Prompts = promptEntries(threadId).length;
    const beforeA7Receipts = readFileSync(fixture.fakeAcpReceiptPath, "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A7_SENTINEL"]);
    await wait(channel.id);
    const a7Prompt = lastPromptAddedAfter(threadId, beforeA7Prompts);
    const a7Methods = protocolMethods(threadId).slice(beforeA7Methods);
    alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(8);
    expect(alphaPlans.at(-1).msg.reason).toBe("resume-rejected");
    expect(alphaPlans.at(-1).msg.mode).toBe("recovery");
    expect(a7Methods).toEqual(["session/load", "session/new"]);
    expect(JSON.stringify(a7Prompt)).not.toMatch(/ROOM_A[567]_SENTINEL/);
    const receiptsAfterA7 = readFileSync(fixture.fakeAcpReceiptPath, "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(receiptsAfterA7.filter((entry: any) => entry.method === "session/prompt").length -
      beforeA7Receipts.filter((entry: any) => entry.method === "session/prompt").length).toBe(1);
    expect(new Set(receiptsAfterA7
      .filter((entry: any) => entry.method === "session/prompt")
      .map((entry: any) => entry.sessionId)).size).toBeGreaterThan(1);
    expect(promptReceipts()[8]?.checks).toEqual({
      contains_0: true,
      contains_1: true,
      occurrences_0: 1,
      occurrences_1: 1,
    });

    // Put more than a bounded window of unseen room messages behind the last
    // accepted anchor without starting responder turns. The next Alpha turn
    // must rotate rather than ask the native session to span the window.
    for (let index = 1; index <= 25; index += 1) {
      await postRoomMessage(channel.id, `ROOM_FILL_${String(index).padStart(2, "0")}`);
    }
    const boundedTranscript = await control(["messages", "--channel", channel.id, "--limit", "200"]);
    expect(boundedTranscript.messages.length).toBeGreaterThan(30);

    // This room has used mention-only routing from creation, so adding these
    // unaddressed messages does not mutate room authority or start provider
    // turns. Alpha still owns its A7 cursor when the bounded window rotates.
    const beforeA8Prompts = promptEntries(threadId).length;
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A8_SENTINEL"]);
    await wait(channel.id);
    const a8Prompt = lastPromptAddedAfter(threadId, beforeA8Prompts);
    alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(9);
    expect(alphaPlans.at(-1).msg.reason).toBe("window-rotated");
    expect(alphaPlans.at(-1).msg.mode).toBe("rotate");
    expect(alphaPlans.at(-1).msg.systemSentBytes).toBeGreaterThan(0);
    expect(JSON.stringify(a8Prompt)).not.toMatch(/ROOM_(?:FILL|A8)_/);
    expect(protocolMethods(threadId).at(-1)).toBe("session/new");
    expect(promptReceipts()[9]?.checks).toEqual({
      contains_0: true,
      contains_1: true,
      absent_0: true,
      absent_1: true,
      occurrences_0: 1,
    });

    // A successful provider configuration mutation invalidates dormant room
    // cursors before the replacement registry is loaded. Reusing the same
    // fake CLI is intentional: the API path, not a model change, is the thing
    // under test.
    const providerMutation = await fetcher(`/api/instances/acp`, {
      method: "PATCH",
      body: JSON.stringify({ cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) }),
    });
    expect(providerMutation.instances).toBeDefined();
    const afterMutation = JSON.parse(readFileSync(`${fixture.info.dataDir}/room-continuations.json`, "utf8"));
    expect(afterMutation.records.filter((record: any) => record.groupId === channel.id)
      .every((record: any) => Object.keys(record.cursors).length === 0)).toBe(true);
    const receiptDirAfterMutation = `${fixture.info.dataDir}/acp-instructions`;
    expect(existsSync(receiptDirAfterMutation)
      ? readdirSync(receiptDirAfterMutation).filter((entry) => entry.endsWith(".json"))
      : []).toEqual([]);

    // The next room turn is a safe fresh rebuild rather than a resume under
    // the mutated provider account.
    const beforeA9Prompts = promptEntries(threadId).length;
    await control(["send-channel", "--channel", channel.id, "--text", "@Alpha ROOM_A9_SENTINEL"]);
    await wait(channel.id);
    const a9Prompt = lastPromptAddedAfter(threadId, beforeA9Prompts);
    alphaPlans = roomPlans(threadId, a.id);
    expect(alphaPlans).toHaveLength(10);
    expect(alphaPlans.at(-1).msg.reason).toBe("cursor-missing");
    expect(alphaPlans.at(-1).msg.mode).toBe("fresh");
    expect(JSON.stringify(a9Prompt)).not.toMatch(/ROOM_A[89]_SENTINEL/);
    expect(promptReceipts()[10]?.checks).toEqual({
      contains_0: true,
      contains_1: true,
      absent_0: true,
      absent_1: true,
      occurrences_0: 1,
    });
    expect(JSON.stringify(promptReceipts())).not.toMatch(/ROOM_|SENTINEL/);

    // Deleting the room task must remove both private owners and the ACP
    // instruction receipts keyed by the deleted thread. Creating a replacement
    // task first keeps the room's required canonical task intact.
    const createdTask = await fetcher(`/api/groups/${channel.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Continuity cleanup target" }),
    });
    expect(createdTask.task.threadId).not.toBe(threadId);
    const deleted = await fetcher(`/api/groups/${channel.id}/tasks/${threadId}`, { method: "DELETE" });
    expect(deleted.group.threadId).toBe(createdTask.task.threadId);

    const privateState = JSON.parse(readFileSync(`${fixture.info.dataDir}/room-continuations.json`, "utf8"));
    expect(privateState.records.filter((record: any) => record.groupId === channel.id)).toHaveLength(0);
    const receiptDir = `${fixture.info.dataDir}/acp-instructions`;
    const instructionReceipts = existsSync(receiptDir)
      ? readdirSync(receiptDir).filter((entry) => entry.endsWith(".json"))
      : [];
    expect(instructionReceipts).toEqual([]);
    entries = native(threadId);
    expect(entries).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 180_000);

it("blocks provider mutation while a room provider turn is awaiting approval", async () => {
  const fixture = await launchVerificationServer(
    process.env,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ["acp"],
    undefined,
    { fakeAcpMode: "permission" },
  );
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  try {
    const catalog = await runControlOmb(["models"], { env }) as any;
    const model = catalog.instances.find((instance: any) => instance.instanceId === "acp")?.models.options[0]?.id;
    expect(model).toBeTruthy();
    const a = (await runControlOmb(["new-bot", "--name", "Approval A"], { env }) as any).bot;
    const b = (await runControlOmb(["new-bot", "--name", "Approval B"], { env }) as any).bot;
    await runControlOmb(["set-model", "--bot", a.id, "--instance", "acp", "--model", model], { env });
    await runControlOmb(["set-model", "--bot", b.id, "--instance", "acp", "--model", model], { env });
    const created = await handleToolCall("create_channel", {
      name: "Approval room",
      member_ids: [a.id, b.id],
      default_responder: { kind: "member", bot_id: a.id },
    }, (path, options) => request(path, options, fixture.info.url)) as any;
    const channel = created.channel;
    await runControlOmb(["send-channel", "--channel", channel.id, "--text", "WAIT_FOR_APPROVAL"], { env });

    await expect.poll(async () => {
      const state = await runControlOmb(["channels"], { env }) as any;
      return state.channels.find((candidate: any) => candidate.id === channel.id)?.busyBotId ?? null;
    }, { timeout: 10_000 }).toBe(a.id);

    const mutation = await fetch(`${fixture.info.url}/api/instances/acp`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cli: "/tmp/fake-acp-cli" }),
    });
    expect(mutation.status).toBe(409);
    expect(await mutation.json()).toMatchObject({
      error: "Wait for bots using this account to finish before changing its settings.",
    });
    await runControlOmb(["interrupt", "--channel", channel.id], { env });
  } finally {
    await fixture.close();
  }
}, 30_000);

it("fences mutations during a disabled rollback but preserves mutation-free state", async () => {
  const start = (options: FixtureOptions = {}) => launchVerificationServer(
    process.env,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ["acp"],
    undefined,
    options,
  );
  let fixture: VerificationServer | undefined;
  const controlFor = (current: VerificationServer) => (args: string[]) =>
    runControlOmb(args, { env: { OPENMAUSBOT_URL: current.info.url } }) as Promise<any>;
  try {
    fixture = await start();
    let control = controlFor(fixture);
    const catalog = await control(["models"]);
    const acp = catalog.instances.find((instance: any) => instance.instanceId === "acp");
    const model = acp.models.options[0].id;
    const changedModel = acp.models.options.find((option: any) => option.id !== model)?.id;
    expect(changedModel).toBeTruthy();
    const bot = (await control(["new-bot", "--name", "Rollback bot"])).bot;
    await control(["set-model", "--bot", bot.id, "--instance", "acp", "--model", model]);
    const created = await handleToolCall("create_channel", {
      name: "Rollback room",
      member_ids: [bot.id],
      default_responder: { kind: "member", bot_id: bot.id },
    }, (path, options) => request(path, options, fixture!.info.url)) as any;
    const channel = created.channel;
    const threadId = channel.activeTaskId;
    await control(["send-channel", "--channel", channel.id, "--text", "ROLLBACK_A1"]);
    expect((await control(["wait", "--channel", channel.id, "--timeout", "30"])).status).toBe("settled");
    const dataDir = fixture.info.dataDir;

    await fixture.stop();
    fixture = await start({ dataDir, continuity: false });
    control = controlFor(fixture);
    await control(["set-model", "--bot", bot.id, "--instance", "acp", "--model", changedModel]);
    const disabledMutationState = JSON.parse(readFileSync(`${dataDir}/room-continuations.json`, "utf8"));
    expect(disabledMutationState.records.find((record: any) => record.threadId === threadId)?.cursors).toEqual({});
    await fixture.stop();
    fixture = await start({ dataDir, continuity: true });
    control = controlFor(fixture);
    await control(["send-channel", "--channel", channel.id, "--text", "ROLLBACK_A2"]);
    expect((await control(["wait", "--channel", channel.id, "--timeout", "30"])).status).toBe("settled");
    // Disabling continuity itself does not clear state. With no mutation in
    // the disabled interval, the following restart may load the same cursor.
    await fixture.stop();
    fixture = await start({ dataDir, continuity: false });
    await fixture.stop();
    fixture = await start({ dataDir, continuity: true });
    control = controlFor(fixture);
    const before = existsSync(`${dataDir}/native/${threadId}.ndjson`)
      ? readFileSync(`${dataDir}/native/${threadId}.ndjson`, "utf8").split("\n").filter(Boolean).length
      : 0;
    await control(["send-channel", "--channel", channel.id, "--text", "ROLLBACK_A3"]);
    expect((await control(["wait", "--channel", channel.id, "--timeout", "30"])).status).toBe("settled");
    const native = readFileSync(`${dataDir}/native/${threadId}.ndjson`, "utf8").split("\n").filter(Boolean).slice(before);
    expect(native.some((line) => JSON.parse(line).msg?.method === "session/load")).toBe(true);
  } finally {
    await fixture?.close();
  }
}, 120_000);

it("invalidates a room cursor for every authority field exposed by the bot API", async () => {
  const fixture = await launchVerificationServer(
    process.env,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ["acp"],
  );
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = (path: string, options: RequestInit = {}) => request(path, options, fixture.info.url);
  const privateState = () => JSON.parse(readFileSync(`${fixture.info.dataDir}/room-continuations.json`, "utf8"));
  const authorityPatches: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: "peers", patch: { peers: [] } },
    { name: "section", patch: { section: null } },
    { name: "managedSections", patch: { managedSections: [] } },
    { name: "chiefOfStaff", patch: { chiefOfStaff: false } },
    { name: "hidden", patch: { hidden: false } },
    { name: "approvePeerComms", patch: { approvePeerComms: false } },
    { name: "alwaysAllow", patch: { alwaysAllow: [] } },
  ];
  try {
    const catalog = await runControlOmb(["models"], { env }) as any;
    const model = catalog.instances.find((instance: any) => instance.instanceId === "acp")?.models.options[0]?.id;
    expect(model).toBeTruthy();
    const a = (await runControlOmb(["new-bot", "--name", "Authority A"], { env }) as any).bot;
    const b = (await runControlOmb(["new-bot", "--name", "Authority B"], { env }) as any).bot;
    await runControlOmb(["set-model", "--bot", a.id, "--instance", "acp", "--model", model], { env });
    await runControlOmb(["set-model", "--bot", b.id, "--instance", "acp", "--model", model], { env });
    const created = await handleToolCall("create_channel", {
      name: "Authority room",
      member_ids: [a.id, b.id],
      default_responder: { kind: "member", bot_id: a.id },
    }, (path, options) => api(path, options)) as any;
    const channel = created.channel;
    const secondCreated = await handleToolCall("create_channel", {
      name: "Authority room two",
      member_ids: [a.id, b.id],
      default_responder: { kind: "member", bot_id: a.id },
    }, (path, options) => api(path, options)) as any;
    const channels = [channel, secondCreated.channel];
    const ownerRecord = (candidate: any) => privateState().records.find((record: any) =>
      record.groupId === candidate.id && record.threadId === candidate.activeTaskId && record.botId === a.id);

    for (const { name, patch } of authorityPatches) {
      for (const [index, candidate] of channels.entries()) {
        await runControlOmb(["send-channel", "--channel", candidate.id, "--text", `AUTHORITY_SETUP_${name}_${index}`], { env });
        const settled = await runControlOmb(["wait", "--channel", candidate.id, "--timeout", "30"], { env }) as any;
        expect(settled.status, `setup turn for ${name} room ${index + 1}`).toBe("settled");
        expect(Object.keys(ownerRecord(candidate)?.cursors ?? {}), `cursor before ${name} room ${index + 1}`).toHaveLength(1);
      }
      const mutation = await fetch(`${fixture.info.url}/api/bots/${a.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      expect(mutation.status, `API mutation for ${name}`).toBe(200);
      await mutation.json();
      for (const [index, candidate] of channels.entries()) {
        expect(ownerRecord(candidate)?.cursors, `cursor after ${name} room ${index + 1}`).toEqual({});
      }
    }
  } finally {
    await fixture.close();
  }
}, 120_000);
