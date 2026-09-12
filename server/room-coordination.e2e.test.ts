import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";

async function withRooms(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  try {
    const sender = (await cli("new-bot", "--name", "Director", "--section", "A")).bot;
    const target = (await cli("new-bot", "--name", "Engineer", "--section", "A")).bot;
    const source = (await tool("create_channel", { name: "Planning", member_ids: [sender.id], bulletin: "SOURCE_ONLY" })).channel;
    const destination = (await tool("create_channel", { name: "Engineering", member_ids: [target.id], bulletin: "DESTINATION_ONLY" })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [sender.id]: { steps: [{ arguments: { group_id: destination.id, bot_ids: [target.id], request_key: "work", message: "Please build CSV" } }], reply: "Assigned", resumeReply: "Reviewed downstream outcome" },
      [target.id]: { reply: "Built CSV" },
    };
    const savePlan = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => {
      const file = join(session.info.dataDir, "room-handoffs.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    };
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const start = async () => { savePlan(); return cli("send-channel", "--channel", source.id, "--text", "@Director Start the assignment"); };
    const wait = async () => cli("wait", "--channel", source.id, "--timeout", "30");
    const provider = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    await test({ session, api, cli, tool, sender, target, source, destination, plan, savePlan, nodes, messages, start, wait, provider });
  } finally { await session.close(); }
}

it("refuses a disallowed peer without starting the recipient", () => withRooms(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  f.plan[f.sender.id].steps[0].expectError = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
}), 45_000);

it.each(["recipient", "source-reader", "destination-reader"])("refuses cross-section work involving a %s without leaking room history", role => withRooms(async f => {
  if (role === "recipient") await f.api(`/api/bots/${f.target.id}`, { section: "Other company" }, "PATCH");
  else {
    const outsider = (await f.cli("new-bot", "--name", "Outsider", "--section", "Other company")).bot;
    const room = role === "source-reader" ? f.source : f.destination;
    await f.tool("update_channel", { channel_id: room.id, member_ids: [...room.memberIds, outsider.id] });
  }
  f.plan[f.sender.id].steps[0].expectError = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Assigned")).toBe(true);
  const discovery = f.provider().find((turn: any) => turn.botId === f.sender.id).evidence[1];
  if (role === "source-reader") expect(discovery.result.isError).toBe(true);
  else expect(JSON.parse(discovery.result.content[0].text).rooms).toEqual([]);
}), 45_000);

it("refuses same-room coordination in a mixed section room", () => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Other company" }, "PATCH");
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id] });
  f.plan[f.sender.id].steps = [{ expectError: true, arguments: { bot_ids: [f.target.id], message: "Review CSV", request_key: "review" } }];
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
}), 45_000);

it("rechecks section membership before queued work dispatch and withholds its result", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 2000; f.savePlan();
  await f.cli("send", "--bot", f.target.id, "--text", "Independent task");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  // Model a user changing the fixture's settings from its served UI mid-turn.
  await request(`/api/bots/${f.target.id}`, { method: "PATCH", headers: { Origin: f.session.info.url },
    body: JSON.stringify({ section: "Other company" }) }, f.session.info.url);
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((n: any) => n.parentId).status).toBe("failed");
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.tool?.name.includes("Result withheld"))).toBe(true);
  await f.cli("wait", "--bot", f.target.id, "--timeout", "15");
}), 45_000);

it.each([4000, 4001])("enforces the %i-character request boundary on the real server", length => withRooms(async f => {
  f.plan[f.sender.id].steps[0].arguments.message = "x".repeat(length);
  f.plan[f.sender.id].steps[0].expectError = length > 4000;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  if (length > 4000) expect(f.nodes()).toEqual([]);
  else expect(f.nodes().find((n: any) => n.parentId).status).toBe("completed");
}), 45_000);

it("does not turn incidental mentions into extra participants in initiating or dispatched turns", () => withRooms(async f => {
  const observer = (await f.cli("new-bot", "--name", "Observer", "--section", "A")).bot;
  for (const room of [f.source, f.destination]) {
    await f.tool("update_channel", { channel_id: room.id, member_ids: [...room.memberIds, observer.id] });
  }
  f.plan[f.sender.id].reply = "Assigned; @Observer is mentioned only as context";
  f.plan[f.sender.id].resumeReply = "Reviewed; @Observer is mentioned only as context";
  f.plan[f.target.id].reply = "Built CSV; @Observer is mentioned only as context";
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, f.sender.id]);
  expect(f.nodes().every((n: any) => n.status === "completed")).toBe(true);
}), 45_000);

it("returns a provider failure to the sender and resumes it to handle the failure", () => withRooms(async f => {
  f.plan[f.target.id].fail = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((n: any) => n.parentId);
  expect(child.status).toBe("failed");
  const source = await f.messages(f.source.activeTaskId);
  expect(source.some((m: any) => m.roomRequest?.phase === "result" && m.tool?.name.includes("failed"))).toBe(true);
  expect(source.some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
}), 45_000);

it("keeps a busy recipient queued and rejects revoked peer access before dispatch", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 2000;
  f.savePlan();
  await f.cli("send", "--bot", f.target.id, "--text", "Independent direct task");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((n: any) => n.parentId).status).toBe("failed");
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  await f.cli("wait", "--bot", f.target.id, "--timeout", "15");
}), 45_000);

it("stops an active downstream turn when the source group is interrupted", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 10_000;
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("running");
  await f.cli("interrupt", "--channel", f.source.id);
  await expect.poll(async () => {
    const { bots } = await f.api("/api/bots"); return bots.find((b: any) => b.id === f.target.id)?.busy;
  }, { timeout: 15_000 }).toBeFalsy();
  expect(f.nodes().every((n: any) => n.status === "cancelled")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(false);
}), 45_000);

it.each(["allow", "deny"])("honors %s on the sender's peer-approval card", behavior => withRooms(async f => {
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true }, "PATCH");
  f.plan[f.sender.id].steps[0].expectError = behavior === "deny";
  await f.start();
  let card: any;
  await expect.poll(async () => {
    card = (await f.messages(f.source.activeTaskId)).find((m: any) => m.card?.tool === "delegate_bot");
    return Boolean(card);
  }, { timeout: 10_000 }).toBe(true);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect((await f.cli("wait", "--channel", f.source.id, "--timeout", "3")).status).toBe("needs-user");
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: card.card.requestId, behavior });
  expect((await f.wait()).status).toBe("settled");
  if (behavior === "deny") expect(f.nodes()).toEqual([]);
  else expect(f.nodes().find((n: any) => n.parentId)).toMatchObject({ status: "completed", approvalGranted: true });
}), 45_000);

it.each(["allow", "deny"])("presents all peer approvals together and dispatches only if every recipient is allowed (%s)", behavior => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.destination.id, member_ids: [f.target.id, reviewer.id] });
  await f.api(`/api/bots/${f.sender.id}`, { approvePeerComms: true }, "PATCH");
  f.plan[reviewer.id] = { reply: "Reviewed CSV" };
  f.plan[f.sender.id].steps[0].arguments.bot_ids.push(reviewer.id);
  f.plan[f.sender.id].steps[0].expectError = behavior === "deny";
  await f.start();
  let cards: any[] = [];
  await expect.poll(async () => {
    cards = (await f.messages(f.source.activeTaskId)).filter((m: any) => m.card?.tool === "delegate_bot");
    return cards.length;
  }, { timeout: 10_000 }).toBe(2);
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  // Answer the second one first: approving one recipient cannot start
  // partial work or wait for another card to be created.
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: cards[1].card.requestId, behavior });
  expect(f.nodes()).toEqual([]);
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: cards[0].card.requestId, behavior: "allow" });
  expect((await f.wait()).status).toBe("settled");
  if (behavior === "deny") expect(f.nodes()).toEqual([]);
  else expect(f.nodes().filter((n: any) => n.parentId)).toMatchObject([
    { status: "completed", approvalGranted: true }, { status: "completed", approvalGranted: true },
  ]);
}), 45_000);

it("pins a busy destination's task even when its active task changes", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 1500;
  f.savePlan(); await f.cli("send", "--bot", f.target.id, "--text", "Independent work");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  const created = await f.tool("create_task", { target_type: "channel", target_id: f.destination.id, title: "Unrelated conversation" });
  expect((await f.wait()).status).toBe("settled");
  const nodes = f.nodes(); expect(nodes.find((n: any) => n.parentId).threadId).toBe(f.destination.activeTaskId);
  expect((await f.messages(f.destination.activeTaskId)).some((m: any) => m.text === "Built CSV")).toBe(true);
  const current = (await f.api("/api/bots")).groups.find((g: any) => g.id === f.destination.id);
  expect(current.threadId).not.toBe(f.destination.activeTaskId);
  expect(await f.messages(current.threadId)).toEqual([]);
  expect(created.success).toBe(true);
}), 45_000);
it("consults multiple existing members and returns once, with no discussion prerequisite or new room settings", () => withRooms(async f => {
  const reviewer = (await f.cli("new-bot", "--name", "Reviewer", "--section", "A")).bot;
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id, reviewer.id] });
  f.plan[f.sender.id].steps = [{ arguments: { bot_ids: [f.target.id, reviewer.id], message: "Give one risk from your role", request_key: "consult" } }];
  f.plan[reviewer.id] = { reply: "Privacy risk" };
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.provider().map((turn: any) => turn.botId)).toEqual([f.sender.id, f.target.id, reviewer.id, f.sender.id]);
  const source = await f.messages(f.source.activeTaskId);
  expect(source.filter((m: any) => m.comm).map((m: any) => m.comm.withBotId)).toEqual([f.target.id, reviewer.id]);
  expect(source.filter((m: any) => m.text === "Reviewed downstream outcome")).toHaveLength(1);
  const tools = f.provider()[0].evidence[0].result.tools.map((t: any) => t.name);
  expect(tools).toContain("coordinate_bots");
  expect(tools).toContain("request_credential");
  for (const old of ["discuss_room", "assign_room_member", "delegate_bot", "ask_bot", "start_thread"]) expect(tools).not.toContain(old);
}), 45_000);

it.each([false, true])("retains reports behind compact receipts for later turns, unless access is revoked (%s)", revoked => withRooms(async f => {
  const report = "Nora executed python3 -m unittest: 3 tests passed.";
  const firstSteps = f.plan[f.sender.id].steps;
  f.plan[f.sender.id] = { turns: [
    { steps: firstSteps, reply: "Assigned" },
    { reply: "Reviewed downstream outcome" },
    { reply: "Follow-up answered", expectContextIncludes: [revoked ? "Teammate result withheld" : report] },
  ] };
  f.plan[f.target.id].reply = report;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const receipt = (await f.messages(f.source.activeTaskId)).find((m: any) => m.roomRequest?.phase === "result");
  expect(receipt.kind).toBe("activity");
  expect(receipt.text).toBeUndefined();
  if (revoked) await f.api(`/api/bots/${f.sender.id}`, { peers: [] }, "PATCH");
  await f.cli("send-channel", "--channel", f.source.id, "--text", "Did the reviewer actually run tests? Do not start new work.");
  expect((await f.wait()).status).toBe("settled");
  const followup = f.provider().filter((turn: any) => turn.botId === f.sender.id).at(-1);
  expect(followup.turnIndex).toBe(2);
  expect(JSON.stringify(followup.prompt).includes(report)).toBe(!revoked);
  expect(f.nodes()).toHaveLength(2);
}), 45_000);

it("waits for busy peers and then completes without the user relaying messages", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 1500;
  f.savePlan(); await f.cli("send", "--bot", f.target.id, "--text", "Independent work");
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().every((n: any) => n.status === "completed")).toBe(true);
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
}), 45_000);
