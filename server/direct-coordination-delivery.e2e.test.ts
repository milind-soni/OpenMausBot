import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { told, fixture, sendReceipts } from "./testing/direct-coordination-fixture.ts";

it("runs two assignments to one teammate from one turn in its thread, one after the other", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Benchmark finished" }] };
  f.plan[f.chief.id] = { steps: [
    { arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } },
    { arguments: { bot_ids: [f.lead.id], message: "Benchmark the exporter on the large fixture" } },
  ], reply: "Both assignments are out", resumeReply: "Both came back" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const tasks = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  expect(tasks).toHaveLength(2);
  const work = tasks.find((task: any) => task.openedBy?.kind === "work");
  expect(work).toMatchObject({ title: "@Clive · work", closedBy: { botId: f.chief.id } });
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId)).toEqual([work.threadId, work.threadId]);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => [turn.turnIndex, turn.threadId]))
    .toEqual([[0, work.threadId], [1, work.threadId]]);
  const transcript = (await f.messages(work.threadId)).map((message: any) => message.text).filter(Boolean).join("\n");
  expect(transcript).toContain("Implement the CSV export");
  expect(transcript).toContain("Benchmark the exporter");
}), 60_000);

it("starts a later send in a parallel work thread while the teammate's standing thread is busy, instead of queueing it", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "first-assignment.gate");
  f.plan[f.lead.id] = { gateFile: gate, reply: "Done" };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export", reply: "none" } }], reply: "Assigned the build" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Export the invoices", reply: "none" } }], reply: "Assigned the invoices" },
  ] };
  f.save();
  const leadNodes = () => f.nodes().filter((node: any) => node.botId === f.lead.id);
  try {
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Ask Engineering to build the CSV export.");
    expect((await f.wait()).status).toBe("settled");
    await expect.poll(() => leadNodes()[0]?.status, { timeout: 15_000 }).toBe("running");
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Now ask them to export the invoices.");
    expect((await f.wait()).status).toBe("settled");
    await expect.poll(() => leadNodes()[1]?.status, { timeout: 15_000 }).toBe("running");
    const [first, second] = leadNodes();
    expect(first.status, "the first assignment still runs").toBe("running");
    expect(second.threadId).not.toBe(first.threadId);
    writeFileSync(gate, "go");
    await expect.poll(() => leadNodes().map((node: any) => node.status), { timeout: 15_000 }).toEqual(["completed", "completed"]);
    const work = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks.filter((task: any) => task.openedBy?.kind === "work");
    expect(work.map((task: any) => task.threadId).sort()).toEqual([first.threadId, second.threadId].sort());
    for (const task of work) expect(task).toMatchObject({ title: "@Clive · work", openedBy: { botId: f.chief.id, threadId: f.chief.activeTaskId } });
    expect(sendReceipts(f, f.chief.id).map((receipt: any) => receipt.threadId)).toEqual([first.threadId, second.threadId]);
  } finally {
    writeFileSync(gate, "go");
  }
}), 60_000);

it("gives another conversation of the same Chief its own thread with the teammate", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Invoices exported" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned" },
    { reply: "Done" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Export the invoices" } }], reply: "Assigned" },
    { reply: "Done" },
  ] };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const other = (await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Invoices" })).task.threadId;
  await f.cli("send", "--bot", f.chief.id, "--task", other, "--text", "Ask Engineering to export the invoices.");
  expect((await f.cli("wait", "--bot", f.chief.id, "--task", other, "--timeout", "30")).status).toBe("settled");
  const work = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks.filter((task: any) => task.openedBy?.kind === "work");
  expect(work.map((task: any) => task.openedBy.threadId).sort()).toEqual([f.chief.activeTaskId, other].sort());
  expect(new Set(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId))).toEqual(new Set(work.map((task: any) => task.threadId)));
}), 60_000);

it("runs an identical call made twice in one turn once, without an extra recipient thread", () => fixture(async f => {
  f.plan[f.chief.id].steps.push(structuredClone(f.plan[f.chief.id].steps[0]));
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id)).toHaveLength(1);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(2);
  expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(1);
  const [sent, repeated] = sendReceipts(f, f.chief.id);
  expect(repeated).toMatchObject({ requestId: sent.requestId, threadId: sent.threadId });
  expect(repeated.detail).toContain("already sent");
}), 45_000);

it.each<[string, Record<string, unknown>, string]>([
  ["finished", { reply: "3 tests fail" }, "not sent again: it already finished and its result stands; send it with rework=true to run it again"],
  ["failed", { fail: true }, "not sent again: it failed; send it with rework=true to retry"],
])("runs an identical brief again only with rework=true once its first run %s", (how, firstRun, refusal) => fixture(async f => {
  const brief = "Run the full test suite and report every failure";
  f.plan[f.lead.id] = { turns: [firstRun, { reply: "All tests pass" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: brief } }], reply: "Sent" },
    { steps: [
      { arguments: { bot_ids: [f.lead.id], message: brief }, expectError: true },
      ...(how === "finished" ? [{ arguments: { bot_ids: [f.lead.id], message: "Thanks, approved" }, expectError: true }] : []),
      { arguments: { bot_ids: [f.lead.id], message: brief, rework: true } },
    ], reply: "Sent again" },
    { reply: "The suite is green" },
  ] };
  await f.start();
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 30_000 }).toBe(3);
  expect((await f.wait()).status).toBe("settled");
  const results = f.evidence().filter((turn: any) => turn.botId === f.chief.id)
    .flatMap((turn: any) => turn.evidence.filter((entry: any) => entry.step)).map((entry: any) => entry.response.result);
  const [sent, repeated] = results;
  const rerun = results.at(-1);
  expect(repeated.isError).toBe(true);
  expect(repeated.content[0].text).toContain(refusal);
  if (how === "finished") expect(results[2].content[0].text).toContain("Only use rework=true for concrete additional work.");
  const [first, again] = [sent, rerun].map((result: any) => JSON.parse(result.content[0].text).receipts[0]);
  expect(again).toMatchObject({ outcome: "queued", threadId: first.threadId });
  expect(again.requestId).not.toBe(first.requestId);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([first.threadId, first.threadId]);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The suite is green")).toBe(true);
}), 60_000);

it("dispatches to a spare recipient thread without waiting for unrelated work", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 2 } }, "PUT");
  const gate = join(f.session.info.dataDir, "unrelated-work.gate");
  f.plan[f.lead.id] = { gateFile: gate, progress: "Unrelated work started", reply: "Unrelated work completed" };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  try {
    await expect.poll(async () => (await f.messages(f.lead.activeTaskId)).some((m: any) => m.text === "Unrelated work started"), { timeout: 10_000 }).toBe(true);
    f.plan[f.lead.id] = { reply: "Coordinated work completed" };
    await f.start();
    await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 8_000 }).toBe("completed");
    expect((await f.wait()).status).toBe("settled");
    const lead = (await f.api("/api/bots")).bots.find((b: any) => b.id === f.lead.id);
    expect(lead.tasks.find((t: any) => t.threadId === f.lead.activeTaskId).busy).toBe(true);
    expect((await f.messages(f.chief.activeTaskId)).some((m: any) => m.text === "The requested CSV export is implemented and verified")).toBe(true);
  } finally {
    writeFileSync(gate, "go");
  }
}), 45_000);

it("queues a recipient at capacity, preserving its existing task and resuming only the pinned parent", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PUT");
  f.plan[f.lead.id] = { turns: [{ delayMs: 2500, reply: "Unrelated work completed" }, { reply: "Coordinated work completed" }] };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await expect.poll(async () => {
    const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
    return { busy: chief.busy, waitingForTeammates: chief.waitingForTeammates };
  }, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: true });
  const next = await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Other conversation" });
  expect((await f.wait()).status).toBe("settled");
  expect(await f.messages(next.task.threadId)).toEqual([]);
  expect((await f.messages(f.lead.activeTaskId)).some((message: any) => message.text === "Unrelated work completed")).toBe(true);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([f.lead.activeTaskId, f.nodes().find((node: any) => node.parentId && node.botId === f.lead.id).threadId]);
}), 45_000);

/** A message sent while the Chief's assigning turn is still finishing is steered into that turn, so it is never parked or started on its own. */
const assigningTurnEnded = (f: any) => expect.poll(async () => {
  const chief = (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.chief.id);
  return { busy: chief.busy, waitingForTeammates: chief.waitingForTeammates };
}, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: true });

it("runs a message sent while a teammate works, keeps the assignment, and names it in that turn", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "steered-assignment-ready");
  f.plan[f.lead.id] = { gateFile: gate, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "Noted; Engineering is still working on it" },
    { reply: "The requested CSV export is implemented and verified" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  await assigningTurnEnded(f);
  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  expect(receipt.queued).toBeUndefined();
  expect(receipt.message.text).toBe("Also make sure the export is UTF-8.");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(2);

  const steered = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[1];
  expect(steered.resumed).toBe(false);
  expect(told(steered)).toContain("Assignments you already sent are still outstanding");
  expect(told(steered)).toContain(assignment.id);
  expect(told(steered)).toContain("Engineering lead");
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).toBe("running");
  writeFileSync(gate, "finish after the steered turn read its assignments");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
}), 60_000);

it("parks a message behind outstanding teammate work when the bot opts in, then runs it after", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "parked-assignment-ready");
  f.plan[f.lead.id] = { gateFile: gate, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "The requested CSV export is implemented and verified" },
    { reply: "Noted; the export is UTF-8 too" },
  ] };
  await f.api(`/api/bots/${f.chief.id}`, { parkDirectMessages: true }, "PATCH");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);
  await assigningTurnEnded(f);

  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  expect(receipt.queued).toBe(true);
  expect(typeof receipt.queueId).toBe("string");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(false);
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).toBe("running");
  writeFileSync(gate, "finish after the message was parked");

  expect((await f.wait()).status).toBe("settled");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(3);
  const parked = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[2];
  expect(parked.resumed).toBe(false);
  expect(told(parked)).not.toContain("Assignments you already sent are still outstanding");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Noted; the export is UTF-8 too")).toBe(true);
}), 60_000);

it("runs a teammate's hand-off to the Chief in the Chief's work thread for that sender, cancelling no live coordination", () => fixture(async f => {
  const ops = (await f.cli("new-bot", "--name", "Ops", "--section", "Leadership")).bot;
  const assign = structuredClone(f.plan[f.chief.id].steps);
  f.plan[f.lead.id] = { delayMs: 6000, reply: "CSV export implemented" };
  // Turns whose order nothing pins pick their entry by what they were asked.
  f.plan[f.chief.id] = { script: [
    { key: "assign", match: ["Please have Engineering build"], steps: assign, reply: "Assigned to Engineering" },
    { key: "note", match: ["Nightly note: confirm the export owner."], reply: "The export owner is Engineering." },
    { key: "review", match: ["Your downstream room requests have settled."], reply: "The requested CSV export is implemented and verified" },
  ] };
  f.plan[ops.id] = { script: [
    { key: "send", match: ["Send the nightly note."], steps: [{ arguments: { bot_ids: [f.chief.id], message: "Nightly note: confirm the export owner." } }], reply: "Delegated the nightly note" },
    { key: "resume", match: ["Your downstream room requests have settled."], reply: "Recorded the outcome of the nightly note" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const { routine } = await f.api("/api/routines", { name: "Nightly note", prompt: "Send the nightly note.", botId: ops.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  await f.api(`/api/routines/${routine.id}/run`, {});
  await expect.poll(() => f.evidence().some((turn: any) => turn.planKey === "note"), { timeout: 25_000 }).toBe(true);
  const note = f.evidence().find((turn: any) => turn.planKey === "note");
  expect(note.threadId).not.toBe(f.chief.activeTaskId);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  expect(chief.tasks.find((task: any) => task.threadId === note.threadId)).toMatchObject({ title: "@Ops · work", openedBy: { botId: ops.id, kind: "work" } });
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.peerAsk?.botId === ops.id || String(message.text ?? "").includes("Nightly note"))).toBe(false);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");

  await expect.poll(() => f.nodes().find((node: any) => node.id === assignment.id)?.status, { timeout: 25_000 }).toBe("completed");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied"), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => f.evidence().map((turn: any) => turn.planKey).filter(Boolean).sort(), { timeout: 20_000 }).toEqual(["assign", "note", "resume", "review", "send"]);
  // The last settlement lands a tick after its turn's end.
  await expect.poll(() => f.nodes().every((node: any) => node.status === "completed"), { timeout: 10_000 }).toBe(true);
}), 60_000);

it("stops a waiting source and the teammate already working for it, with no late result and no pill", () => fixture(async f => {
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.lead.id] = { gateFile: childGate, reply: "Finished after the source was stopped" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await assigningTurnEnded(f);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.chief.activeTaskId });

  await expect.poll(() => f.nodes().map((node: any) => [Boolean(node.parentId), node.status])).toEqual([[false, "cancelled"], [true, "cancelled"]]);
  writeFileSync(childGate, "finish after the source was stopped");
  expect((await f.wait()).status).toBe("settled");
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const rows = await f.messages(f.chief.activeTaskId);
  expect(rows.some((message: any) => message.tool?.name?.startsWith("Stopped here"))).toBe(false);
  expect(rows.some((message: any) => message.tool?.output?.includes("Finished after the source was stopped"))).toBe(false);
  expect(f.nodes().find((node: any) => node.parentId).status).toBe("cancelled");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect(rows.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
}), 60_000);

it("deleting the waiting source cancels its tree and never recreates the deleted conversation", () => fixture(async f => {
  // The teammate holds its reply until the source is gone, however slowly the runner settles the Chief's own turn.
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.lead.id] = { gateFile: childGate, reply: "Must not return to a deleted task" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  // A running task cannot be deleted (409): the source is "waiting" only once its own turn has settled.
  await expect.poll(async () => {
    const waiting = (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.chief.id);
    return !waiting.busy && waiting.tasks.find((task: any) => task.threadId === f.chief.activeTaskId)?.waitingForTeammates;
  }, { timeout: 30_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, {}, "DELETE");
  await expect.poll(() => f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  writeFileSync(childGate, "finish after the source was deleted");
  await expect.poll(async () => (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.lead.id).busy, { timeout: 15_000 }).toBe(false);
  expect(f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  expect(chief.tasks.some((task: any) => task.threadId === f.chief.activeTaskId)).toBe(false);
  expect(await f.messages(chief.threadId)).toEqual([]);
  for (const task of chief.tasks) {
    expect((await f.messages(task.threadId)).some((message: any) => message.text?.includes("Must not return to a deleted task"))).toBe(false);
  }
}), 45_000);

it("withholds direct results when the sender's peers list cuts the teammate off mid-turn", () => fixture(async f => {
  // Revoke while the teammate's engine is inside its turn: a "running" record is written at dispatch, before setup.
  const ready = join(f.session.info.dataDir, "private-work.ready");
  const gate = join(f.session.info.dataDir, "private-work.gate");
  f.plan[f.lead.id] = { readyFile: ready, gateFile: gate, reply: "PRIVATE_ENGINEERING_RESULT" };
  await f.start();
  await expect.poll(() => existsSync(ready), { timeout: 15_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}`, { visibility: "admins" }, "PATCH");
  writeFileSync(gate, "finish the private work after the teammate was cut off");
  expect((await f.wait()).status).toBe("settled");
  const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
  expect(JSON.stringify(resumed), told(resumed).slice(-1_500)).not.toContain("PRIVATE_ENGINEERING_RESULT");
  const child = f.nodes().find((node: any) => node.parentId);
  expect(child.status, `${JSON.stringify(child)}\n${told(resumed).slice(-1_500)}`).toBe("failed");
  expect(resumed.prompt.message.content).toContain("Result withheld");
}), 45_000);

it("retains returned direct reports for follow-up turns but rechecks reach before replay", () => fixture(async f => {
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
  await f.api(`/api/bots/${f.chief.id}`, { visibility: "admins" }, "PATCH");
  f.plan[f.chief.id] = { reply: "Access removed", expectContextIncludes: ["Teammate result withheld"] };
  f.save();
  const edited = (await f.messages(f.chief.activeTaskId)).findLast((message: any) => message.role === "user");
  await f.api(`/api/bots/${f.chief.id}/messages/${edited.id}/edit`, { threadId: f.chief.activeTaskId, text: "What can you access now?" });
  expect((await f.wait()).status).toBe("settled");
  const final = f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1);
  expect(final.prompt.message.content).toContain("Teammate result withheld");
  expect(JSON.stringify({ system: final.system, prompt: final.prompt })).not.toContain("PRIVATE_ENGINEERING_FACT_8347");
}), 45_000);

it("runs the owed direct follow-up while the same bot works in another thread", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "hold-gate");
  // The hold's turn starts while the assigning turn is still open, so each turn picks its plan by its own text.
  f.plan[f.chief.id] = { script: [
    { key: "assign", match: ["Assign the check, then open an independent job"], steps: [
      { tool: "coordinate_bots", arguments: { bot_ids: [f.specialist.id], message: "Independently verify the CSV export" } },
      { tool: "start_thread", arguments: { title: "Independent hold", message: "Run the long independent check." } },
    ], reply: "Assigned the check and opened the hold" },
    { key: "hold", match: ["Run the long independent check."], gateFile: gate, reply: "The hold finished" },
    { key: "resume", match: ["Your downstream room requests have settled."], reply: "The follow-up ran while the hold worked" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Assign the check, then open an independent job that runs long.");
  const chiefTasks = async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id).tasks;
  const holdBusy = async () => (await chiefTasks()).find((task: any) => task.title === "Independent hold")?.busy;
  // The self-opened job stays mid-turn at its gate, so the whole-bot busy flag stays up for an unrelated thread.
  await expect.poll(holdBusy, { timeout: 20_000 }).toBe(true);
  const root = () => f.nodes().find((node: any) => !node.parentId);
  await expect.poll(() => root()?.status, { timeout: 15_000 }).toBe("completed");
  expect(await holdBusy()).toBe(true);
  const tasks = await chiefTasks();
  expect(tasks.find((task: any) => task.threadId === f.chief.activeTaskId).busy).toBe(false);
  writeFileSync(gate, "");
  await expect.poll(holdBusy, { timeout: 10_000 }).toBe(false);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The follow-up ran while the hold worked")).toBe(true);
}), 45_000);

it("sends each teammate result once in the turn that reviews it", () => fixture(async f => {
  f.plan[f.lead.id].resumeReply = "LEAD_RESULT_ONCE implemented and verified";
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const text = String(f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1).prompt.message.content);
  expect(text).toContain("Your downstream room requests have settled.");
  expect(text.split("LEAD_RESULT_ONCE").length - 1).toBe(1);
}), 45_000);

it("gives a teammate each request once, never also as a bare assistant line", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "round result" };
  for (const key of ["first", "second"]) {
    f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: `REQUEST_${key.toUpperCase()} please do it` } }], reply: "Assigned", resumeReply: "Done" };
    f.save();
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", `Delegate the ${key} request.`);
    expect((await f.wait()).status).toBe("settled");
  }
  const second = String(f.evidence().filter((turn: any) => turn.botId === f.lead.id).at(-1).prompt.message.content);
  expect(second.split("REQUEST_SECOND").length - 1).toBe(1);
  expect(second).not.toMatch(/^Assistant: @/m);
}, { FAKE_CLAUDE_MODE: "dead-session" }), 60_000);

/** The Engineering lead on a loopback OpenAI-compatible engine where `answer` replies to every chat request. */
async function onLoopbackEngine(f: any, answer: (res: ServerResponse) => void): Promise<() => Promise<void>> {
  const llm = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    // The chat engine asks a local server whether it is Ollama (/api/version); this one is not, and that is no model call.
    if (req.url?.endsWith("/api/version")) { res.statusCode = 404; res.end(); return; }
    // Naming the work thread the hand-off opened is a one-shot of its own, not a step of the turn: it gets no title.
    if (body.includes("Reply with only a short title")) { res.statusCode = 404; res.end(); return; }
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "loop-model" }] })); return; }
    answer(res);
  });
  await new Promise<void>(resolve => llm.listen(0, "127.0.0.1", resolve));
  const port = (llm.address() as { port: number }).port;
  await f.api("/api/config", { openaiCompat: { key: "fixture-loop-key", url: `http://127.0.0.1:${port}/v1`, model: "loop-model" } }, "PATCH");
  await f.cli("set-model", "--bot", f.lead.id, "--instance", "openaiCompat", "--model", "loop-model");
  return () => new Promise<void>(resolve => llm.close(() => resolve()));
}

it("continues a teammate's step cap in place and stops it once it makes no progress", () => fixture(async f => {
  let calls = 0;
  const close = await onLoopbackEngine(f, res => {
    // Never a final answer: one more tool call, every round.
    const call = { tool_calls: [{ index: 0, id: `call_${++calls}`, type: "function", function: { name: "missing_tool", arguments: JSON.stringify({ attempt: calls }) } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: call, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    const leads = f.nodes().filter((node: any) => node.botId === f.lead.id);
    expect(leads).toHaveLength(1);
    const child = leads[0];
    expect(child).toMatchObject({ status: "failed", outcome: "stalled", executions: 2,
      result: expect.stringMatching(/^Stopped after 200 tool calls without a final answer\./) });
    expect(child.outcomeDetail).toMatch(/^Stopped after 2 continuations without progress: Stopped after 200 tool calls without a final answer\./);
    expect(child.result).not.toContain("assign what is left");
    expect(f.eventsOf(child.id).filter((kind: string) => kind === "continued")).toHaveLength(1);
    expect(f.eventsOf(child.id)).toContain("stalled");
    const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
    expect(resumed.prompt.message.content).toContain("Stopped after 2 continuations without progress");
    expect(resumed.prompt.message.content).not.toContain("assign what is left");
    const chip = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.roomRequest?.phase === "result");
    expect(chip.tool.name).toContain("Engineering lead — failed: Stopped after 200 tool calls without a final answer");
    expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.roomRequest?.phase === "result")).toHaveLength(1);
    const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
    expect(lead.tasks.map((task: any) => task.title).filter((title: string) => title.startsWith("Continue:"))).toEqual([]);
    expect(calls).toBe(402);
  } finally { await close(); }
}), 90_000);

it("tells the Chief a teammate's provider refused the turn, in the provider's words", () => fixture(async f => {
  const close = await onLoopbackEngine(f, res => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Rate limit reached for loop-model: 30 requests per minute" } }));
  });
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    const child = f.nodes().find((node: any) => node.botId === f.lead.id);
    expect(child.status).toBe("failed");
    expect(child.result).toContain("429");
    expect(child.result).toContain("Rate limit reached for loop-model: 30 requests per minute");
    const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
    expect(resumed.prompt.message.content).toContain("Rate limit reached for loop-model");
  } finally { await close(); }
}), 45_000);

it("keeps a teammate working through a provider settings save that does not touch its engine", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "lead-ready");
  f.plan[f.lead.id] = { gateFile: gate, reply: "CSV export implemented and checked" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  const compat = async () => (await f.api("/api/instances")).instances.find((instance: any) => instance.instanceId === "openaiCompat");
  expect((await compat()).snapshot.state).toBe("unavailable");
  await f.api("/api/config", { openaiCompat: { key: "fixture-compat-key", url: "http://127.0.0.1:9/v1" } }, "PATCH");
  expect((await compat()).snapshot.state).toBe("available");
  await f.api("/api/config", { openaiCompat: { key: "fixture-compat-key", url: "http://127.0.0.1:9/v1" } }, "PATCH");
  expect(f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("running");
  writeFileSync(gate, "finish the teammate");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((node: any) => node.botId === f.lead.id)).toMatchObject({ status: "completed", result: "CSV export implemented and checked" });
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  for (const task of lead.tasks) {
    expect((await f.messages(task.threadId)).some((message: any) => message.tool?.name?.includes("provider settings changed"))).toBe(false);
  }
}), 45_000);

it("tells the Chief a teammate's turn stopped because its engine's settings changed", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "lead-ready");
  f.plan[f.lead.id] = { gateFile: gate, reply: "Never reached" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await f.api("/api/config", { anthropic: { key: "fixture-anthropic-key" } }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  expect(child.status).toBe("failed");
  expect(child.result).toMatch(/^Turn interrupted — provider settings changed\.(?: |$)/);
  const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
  expect(resumed.prompt.message.content).toContain("Turn interrupted — provider settings changed.");
  expect(resumed.prompt.message.content).not.toContain("The coordinated turn was interrupted");
}), 45_000);

// Each title reply is keyed to the job it names, so a thread named from the wrong message would show it.
const titledHandoffs = () => {
  const routes = join(mkdtempSync(join(tmpdir(), "omb-handed-title-")), "routes.json");
  writeFileSync(routes, JSON.stringify({
    "Message:\nImplement the CSV export": "CSV export build",
    "Message:\nAdd the header row": "Header row follow-up",
    "Message:\nSpec the PDF export": "PDF export spec",
    "Message:\nRun the release QA": "Named by the model",
  }));
  return { FAKE_CLAUDE_TEXT_ROUTES: routes };
};

it("names a thread a teammate opened from the job it was handed, once, unless the sender named it", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Header row added" }] };
  f.plan[f.specialist.id] = { turns: [{ reply: "PDF spec written" }, { reply: "QA passed" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { reply: "The export is implemented" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Add the header row to that export" } }], reply: "Assigned the header row" },
    { reply: "The header row is in" },
    { steps: [
      { arguments: { bot_ids: [f.specialist.id], message: "Spec the PDF export", thread: "new", reply: "none" } },
      { arguments: { bot_ids: [f.specialist.id], message: "Run the release QA", thread: "new", title: "Release QA", reply: "none" } },
    ], reply: "Sent both" },
  ] };
  f.save();
  const send = async (text: string) => {
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", text);
    expect((await f.wait()).status).toBe("settled");
  };
  const tasksOf = async (botId: string) => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === botId).tasks;
  await send("Ask Engineering to build the CSV export.");
  const work = (await tasksOf(f.lead.id)).find((task: any) => task.openedBy?.kind === "work");
  await expect.poll(async () => (await tasksOf(f.lead.id)).find((task: any) => task.threadId === work.threadId)?.title, { timeout: 15_000 })
    .toBe("@Clive · CSV export build");
  await send("Now ask them to add the header row.");
  await send("Now have Reviewer spec the PDF export and run the release QA.");
  await expect.poll(async () => (await tasksOf(f.specialist.id)).map((task: any) => task.title), { timeout: 15_000 })
    .toEqual(expect.arrayContaining(["PDF export spec", "Release QA"]));
  expect((await tasksOf(f.lead.id)).find((task: any) => task.threadId === work.threadId).title).toBe("@Clive · CSV export build");
  expect((await tasksOf(f.specialist.id)).map((task: any) => task.title)).not.toContain("Named by the model");
}, titledHandoffs()), 90_000);

// The small model's word is the fixture's: what matters here is what the runtime does with it.
const withStatusAnswer = (answer: string) => {
  const routes = join(mkdtempSync(join(tmpdir(), "omb-status-reply-")), "routes.json");
  writeFileSync(routes, JSON.stringify({ "<teammate_reply>": answer }));
  return { FAKE_CLAUDE_TEXT_ROUTES: routes };
};

it("spends no requester turn on a reply that only acknowledged, and the reply stays in its thread", () => fixture(async f => {
  f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: "FYI: the mailbox moved." } }], reply: "I told the lead.", resumeReply: "This is just a confirmation, no action needed." };
  f.plan[f.lead.id] = { reply: "Noted, thanks." };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  const messages = await f.messages(f.chief.activeTaskId);
  expect(messages.some((message: any) => message.text === "This is just a confirmation, no action needed.")).toBe(false);
  expect(messages.find((message: any) => message.roomRequest?.phase === "result")?.tool?.output).toBe("Noted, thanks.");
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
}, withStatusAnswer("ACK")));

it("wakes the requester for a reply that carries something, in any language", () => fixture(async f => {
  f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Hast du die IMAP-Zugangsdaten?" } }], reply: "Ich habe gefragt.", resumeReply: "Es sind keine hinterlegt." };
  f.plan[f.lead.id] = { reply: "Nein, ich habe nichts gespeichert." };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(2);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Es sind keine hinterlegt.")).toBe(true);
}, withStatusAnswer("NEEDS")));
