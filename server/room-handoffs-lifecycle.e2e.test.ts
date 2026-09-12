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
    await cli("room-routes", "--channel", destination.id, "--from", source.id);
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [sender.id]: { steps: [{ arguments: { group_id: destination.id, bot_id: target.id, request_key: "work", message: "Please build CSV" } }], reply: "Assigned", resumeReply: "Reviewed downstream outcome" },
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

it("refuses a disabled incoming route without starting the recipient", () => withRooms(async f => {
  await f.cli("room-routes", "--channel", f.destination.id, "--from", "");
  f.plan[f.sender.id].steps[0].expectError = true;
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
}), 45_000);

it("normalizes duplicate route IDs through the real MCP handler and server", () => withRooms(async f => {
  await f.tool("update_channel", { channel_id: f.destination.id, incoming_group_ids: [f.source.id, f.source.id] });
  const group = (await f.api("/api/bots")).groups.find((g: any) => g.id === f.destination.id);
  expect(group.incomingGroupIds).toEqual([f.source.id]);
}), 45_000);

it.each(["recipient", "source-reader", "destination-reader"])("refuses cross-section work involving a %s even with an incoming route", role => withRooms(async f => {
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

it.each(["discuss_room", "assign_room_member"])("refuses cross-section %s inside a mixed room", tool => withRooms(async f => {
  await f.api(`/api/bots/${f.target.id}`, { section: "Other company" }, "PATCH");
  await f.tool("update_channel", { channel_id: f.source.id, member_ids: [f.sender.id, f.target.id] });
  f.plan[f.sender.id].steps = [{ tool, expectError: true, arguments: tool === "discuss_room"
    ? { member_ids: [f.target.id], topic: "Discuss CSV", request_key: "discussion" }
    : { member_id: f.target.id, message: "Build CSV", request_key: "assignment" } }];
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
  expect((await f.messages(f.source.activeTaskId)).some((m: any) => m.text?.includes("Result withheld"))).toBe(true);
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
  expect(source.some((m: any) => m.roomRequest?.phase === "result" && m.text.includes("failed"))).toBe(true);
  expect(source.some((m: any) => m.text === "Reviewed downstream outcome")).toBe(true);
}), 45_000);

it("keeps a busy recipient queued and rejects a revoked route before dispatch", () => withRooms(async f => {
  f.plan[f.target.id].delayMs = 2000;
  f.savePlan();
  await f.cli("send", "--bot", f.target.id, "--text", "Independent direct task");
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await f.cli("room-routes", "--channel", f.destination.id, "--from", "");
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
    card = (await f.messages(f.source.activeTaskId)).find((m: any) => m.card?.tool === "send_room_message");
    return Boolean(card);
  }, { timeout: 10_000 }).toBe(true);
  expect(await f.messages(f.destination.activeTaskId)).toEqual([]);
  expect((await f.cli("wait", "--channel", f.source.id, "--timeout", "3")).status).toBe("needs-user");
  await f.api(`/api/threads/${f.source.activeTaskId}/respond`, { requestId: card.card.requestId, behavior });
  expect((await f.wait()).status).toBe("settled");
  if (behavior === "deny") expect(f.nodes()).toEqual([]);
  else expect(f.nodes().find((n: any) => n.parentId)).toMatchObject({ status: "completed", approvalGranted: true });
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
