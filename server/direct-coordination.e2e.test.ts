import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";

async function fixture(test: (f: any) => Promise<void>, fakeEnv: NodeJS.ProcessEnv = {}) {
  const session = await launchVerificationServer({ ...process.env, ...fakeEnv }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    const specialist = (await cli("new-bot", "--name", "Reviewer", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [chief.id]: { steps: [{ arguments: { bot_ids: [lead.id], request_key: "build", message: "Implement and independently verify the CSV export" } }], reply: "Assigned to Engineering", resumeReply: "The requested CSV export is implemented and verified" },
      [lead.id]: { steps: [{ arguments: { bot_ids: [specialist.id], request_key: "verify", message: "Independently verify the CSV export" } }], reply: "Sent for verification", resumeReply: "Implemented and reviewer confirmed checks" },
      [specialist.id]: { reply: "CSV boundary cases verified" },
    };
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => existsSync(join(session.info.dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8")) : [];
    const evidence = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const start = async () => { save(); return cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Please have Engineering build and independently verify a CSV export. Own the result."); };
    const wait = () => cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30");
    await test({ session, cli, api, chief, lead, specialist, plan, save, start, wait, nodes, evidence, messages });
  } finally { await session.close(); }
}

it("coordinates a lead and its specialist from ordinary chat, returns to Clive, and leaves unrelated tasks untouched", () => fixture(async f => {
  const originalLead = await f.messages(f.lead.activeTaskId);
  const originalSpecialist = await f.messages(f.specialist.activeTaskId);
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  expect(f.nodes().every((node: any) => !node.groupId && node.status === "completed")).toBe(true);
  expect((await f.api("/api/bots")).groups).toEqual([]);
  expect(await f.messages(f.lead.activeTaskId)).toEqual(originalLead);
  expect(await f.messages(f.specialist.activeTaskId)).toEqual(originalSpecialist);
  const receipt = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name === "Sent to Engineering lead");
  expect(receipt.threadRef).toMatchObject({ botId: f.lead.id, threadId: f.nodes().find((node: any) => node.botId === f.lead.id).threadId });
  expect(receipt.threadRef.threadId).not.toBe(f.lead.activeTaskId);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
  const bots = (await f.api("/api/bots")).bots;
  expect(bots.find((bot: any) => bot.id === f.lead.id).managedSections).toBeUndefined();
  const turn = f.evidence().find((entry: any) => entry.botId === f.lead.id);
  const tools = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(tools).toContain("coordinate_bots");
  expect(tools).not.toContain("delegate_bot");
  expect(tools).not.toContain("start_thread");
  expect(turn.system).toContain("only an actual coordinate_bots result proves that teammate participated");
}), 45_000);

it("returns a nested coordinated result after Claude retries a transient provider exit", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-coordination-retry-"));
  try {
    await fixture(async f => {
      await f.start();
      expect((await f.wait()).status).toBe("settled");
      expect(f.nodes()).toHaveLength(3);
      expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
      expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
      expect(Number(readFileSync(join(scratch, "launches"), "utf8"))).toBeGreaterThan(5);
    }, { FAKE_CLAUDE_TRANSIENTS: "1", FAKE_CLAUDE_STATE: join(scratch, "launches"), FAKE_CLAUDE_RETRY_SCALE: "0.001" });
  } finally { await removeTempDir(scratch); }
}, 45_000);

it("returns nested results after Claude rejects the source's prior resume cursor", () => fixture(async f => {
  const coordination = f.plan[f.chief.id];
  f.plan[f.chief.id] = { reply: "Earlier conversation" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Hello before the task");
  expect((await f.wait()).status).toBe("settled");
  f.plan[f.chief.id] = coordination;
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toHaveLength(3);
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  const transcript = await f.messages(f.chief.activeTaskId);
  expect(transcript.some((message: any) => message.tool?.name?.includes("resume_rejected"))).toBe(true);
}, { FAKE_CLAUDE_MODE: "dead-session" }), 45_000);

it("uses recipient bot defaults for its new task, never the sender's or its selected old thread's settings", () => fixture(async f => {
  const models = await f.cli("models");
  const options = models.instances.find((instance: any) => instance.instanceId === f.lead.modelSelection.instanceId).models.options;
  const selected = options.find((model: any) => model.id !== f.lead.modelSelection.model);
  await f.api(`/api/bots/${f.lead.id}/tasks/${f.lead.activeTaskId}`, { modelSelection: { instanceId: f.lead.modelSelection.instanceId, model: selected.id }, approvalMode: "edits" }, "PATCH");
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const node = f.nodes().find((entry: any) => entry.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks.find((task: any) => task.threadId === f.lead.activeTaskId)).toMatchObject({ modelSelection: { model: selected.id }, approvalMode: "edits" });
  expect(lead.tasks.find((task: any) => task.threadId === node.threadId)).toMatchObject({ modelSelection: f.lead.modelSelection, approvalMode: "ask" });
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).every((turn: any) => turn.model === f.lead.modelSelection.model && turn.permissionMode === "default")).toBe(true);
}), 45_000);

it("deduplicates a repeated direct request without creating extra recipient tasks", () => fixture(async f => {
  f.plan[f.chief.id].steps.push(structuredClone(f.plan[f.chief.id].steps[0]));
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id)).toHaveLength(1);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(2);
  expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(1);
}), 45_000);

it("queues a busy recipient, preserving its existing task and resuming only the pinned parent", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ delayMs: 2500, reply: "Unrelated work completed" }, { reply: "Coordinated work completed" }] };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  expect(chief.busy).toBe(true);
  const next = await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Other conversation" });
  expect((await f.wait()).status).toBe("settled");
  expect(await f.messages(next.task.threadId)).toEqual([]);
  expect((await f.messages(f.lead.activeTaskId)).some((message: any) => message.text === "Unrelated work completed")).toBe(true);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([f.lead.activeTaskId, f.nodes().find((node: any) => node.botId === f.lead.id).threadId]);
}), 45_000);

it("stops a waiting source and its running subtree without needing to delete any bot", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 5000, reply: "Must not finish after Stop" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.chief.activeTaskId });
  await expect.poll(() => f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
}), 45_000);

it("deleting the waiting source cancels its tree and never recreates the deleted conversation", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 5000, reply: "Must not return to a deleted task" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, {}, "DELETE");
  await expect.poll(() => f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  expect(chief.tasks.some((task: any) => task.threadId === f.chief.activeTaskId)).toBe(false);
  expect(await f.messages(chief.threadId)).toEqual([]);
}), 45_000);

it("withholds direct results when the owner's cross-team grant is revoked", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 3000, reply: "PRIVATE_ENGINEERING_RESULT" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}`, { managedSections: [] }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((node: any) => node.parentId).status).toBe("failed");
  const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
  expect(resumed.system).toContain("Result withheld");
  expect(JSON.stringify(resumed)).not.toContain("PRIVATE_ENGINEERING_RESULT");
}), 45_000);

it("retains returned direct reports for follow-up turns but rechecks access before replay", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "PRIVATE_ENGINEERING_FACT_8347" };
  f.plan[f.chief.id].resumeReply = "Finished";
  await f.start(); expect((await f.wait()).status).toBe("settled");
  f.plan[f.chief.id] = { reply: "Follow-up answered" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Summarize the existing engineering report");
  expect((await f.wait()).status).toBe("settled");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Follow-up answered")).toBe(true);
  const followup = (await f.messages(f.chief.activeTaskId)).findLast((message: any) => message.role === "user");
  f.plan[f.chief.id].expectContextIncludes = ["PRIVATE_ENGINEERING_FACT_8347"];
  f.save();
  await f.api(`/api/bots/${f.chief.id}/messages/${followup.id}/edit`, { threadId: f.chief.activeTaskId, text: "Check the earlier engineering report" });
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1).prompt.message.content).toContain("PRIVATE_ENGINEERING_FACT_8347");
  await f.api(`/api/bots/${f.chief.id}`, { managedSections: [] }, "PATCH");
  f.plan[f.chief.id] = { reply: "Access removed", expectContextIncludes: ["Teammate result withheld"] };
  f.save();
  // Editing the follow-up forces a fresh replay while retaining the earlier
  // result receipt, rather than assuming a native provider forgot its cache.
  const edited = (await f.messages(f.chief.activeTaskId)).findLast((message: any) => message.role === "user");
  await f.api(`/api/bots/${f.chief.id}/messages/${edited.id}/edit`, { threadId: f.chief.activeTaskId, text: "What can you access now?" });
  expect((await f.wait()).status).toBe("settled");
  const final = f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1);
  expect(final.prompt.message.content).toContain("Teammate result withheld");
  expect(JSON.stringify({ system: final.system, prompt: final.prompt })).not.toContain("PRIVATE_ENGINEERING_FACT_8347");
}), 45_000);
