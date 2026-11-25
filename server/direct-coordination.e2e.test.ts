import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rebuiltSessionNotice } from "./resume-recovery.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";
import { told, fixture, sendReceipts } from "./testing/direct-coordination-fixture.ts";

it("sends cross-bot work onward without resuming either sender", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "sent-work-ready");
  f.plan[f.chief.id] = { steps: [{ arguments: {
    bot_ids: [f.lead.id], message: "Own the release and send final QA to Reviewer.", thread: "new", reply: "none",
  } }], reply: "Release sent" };
  f.plan[f.lead.id] = { steps: [{ arguments: {
    bot_ids: [f.specialist.id], message: "Own final release QA.", thread: "new", reply: "none",
  } }], reply: "QA sent onward" };
  f.plan[f.specialist.id] = { gateFile: gate, reply: "Release QA complete" };

  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const sendOf = (botId: string) => f.evidence().find((turn: any) => turn.botId === botId)?.evidence
    .find((entry: any) => entry.step?.arguments?.reply === "none")?.response.result;
  const leadSend = () => sendOf(f.lead.id);
  await expect.poll(leadSend, { timeout: 15_000 }).toBeTruthy();
  expect(leadSend().isError).toBeFalsy();
  const sentThread = (botId: string) => JSON.parse(sendOf(botId).content[0].text).receipts[0].threadId;
  await expect.poll(async () => (await f.api("/api/bots?messages=0")).bots
    .find((bot: any) => bot.id === f.specialist.id)?.busy, { timeout: 15_000 }).toBe(true);
  await f.api(`/api/bots/${f.lead.id}`, { visibility: "admins" }, "PATCH");
  writeFileSync(gate, "finish detached work");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.specialist.id).length, { timeout: 15_000 }).toBe(1);
  const bots = (await f.api("/api/bots")).bots;
  const leadThread = bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === sentThread(f.chief.id));
  const qaThread = bots.find((bot: any) => bot.id === f.specialist.id).tasks.find((task: any) => task.threadId === sentThread(f.lead.id));
  expect(leadThread.title).toBe("Own the release and send final QA to Reviewer.");
  expect(qaThread.title).toBe("Own final release QA.");
  const qaMessages = await f.messages(qaThread.threadId);
  expect(qaMessages.some((message: any) => message.text === "Release QA complete")).toBe(true);
  expect(qaMessages.some((message: any) => message.tool?.name?.includes("Send failed"))).toBe(false);
  expect((await f.messages(leadThread.threadId)).some((message: any) => message.text?.includes("Release QA complete"))).toBe(false);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text?.includes("QA sent") || message.text?.includes("Release QA complete"))).toBe(false);
}), 60_000);

it("lets a teammate answer a one-way ask in the thread that asked, with a notice and nothing more", () => fixture(async f => {
  const asking = f.chief.activeTaskId;
  f.plan[f.chief.id] = { steps: [{ arguments: {
    bot_ids: [f.lead.id], message: `Ask the person which day suits, then tell me in thread ${asking}.`, thread: "new", reply: "none",
  } }], reply: "Asked Engineering", byPrompt: [{ promptIncludes: "Tuesday suits", plan: { reply: "Got Tuesday from Engineering" } }] };
  f.plan[f.lead.id] = { steps: [
    { arguments: { bot_ids: [f.chief.id], message: "Tuesday suits, please plan for it", thread: asking }, expectError: true },
    { arguments: { bot_ids: [f.chief.id], message: "Tuesday suits", thread: asking, reply: "none" } },
  ], reply: "Told Clive" };
  await f.start();
  const sends = () => f.evidence().find((turn: any) => turn.botId === f.lead.id)?.evidence.filter((entry: any) => entry.step?.arguments?.thread === asking);
  await expect.poll(() => sends()?.length, { timeout: 15_000 }).toBe(2);
  const [work, notice] = sends().map((entry: any) => entry.response.result);
  expect(JSON.stringify(work)).toContain("handed you work: answer it there with reply");
  expect(notice.isError).toBeFalsy();
  expect(JSON.parse(notice.content[0].text).receipts[0]).toMatchObject({ threadId: asking });
  await expect.poll(async () => (await f.messages(asking)).some((message: any) => message.text === "Got Tuesday from Engineering"), { timeout: 15_000 }).toBe(true);
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id).tasks.filter((task: any) => task.title?.includes("Tuesday"))).toEqual([]);
}), 60_000);

it("marks a failed one-way send so restart recovery cannot duplicate its notice", () => fixture(async f => {
  // The failed send reports an incident to Clive, the lead's Chief; answering it must not send the task again.
  f.plan[f.chief.id] = { steps: [{ arguments: {
    bot_ids: [f.lead.id], message: "Try the task", thread: "new", reply: "none",
  } }], reply: "Sent", byPrompt: [{ promptIncludes: "[From OpenMausBot · incident report", plan: { reply: "Noted the failed send" } }] };
  f.plan[f.lead.id] = { fail: true };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const failureNotice = async () => {
    const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
    const tasks = lead?.tasks.filter((item: any) => item.title === "Try the task") ?? [];
    expect(tasks.length).toBeLessThanOrEqual(1);
    if (!tasks[0]) return null;
    const messages = await f.messages(tasks[0].threadId);
    return messages.find((message: any) => message.tool?.name?.startsWith("Send failed")) ?? null;
  };
  await expect.poll(failureNotice, { timeout: 15_000 }).toBeTruthy();
  expect((await failureNotice())?.tool?.handoffId).toEqual(expect.any(String));
}), 45_000);

it("lets a bot ask a bot in another department directly, with nothing set up first", () => fixture(async f => {
  // Engineering lead and Clive, the Chief in Leadership: different departments, no peers list, no grant either way.
  await f.api(`/api/bots/${f.chief.id}`, { managedSections: [] }, "PATCH");
  f.plan[f.lead.id] = {
    steps: [{ arguments: { bot_ids: ["Clive"], message: "Can we upgrade to the latest PHP version?", consult: true } }],
    reply: "Asked Clive", resumeReply: "Clive says yes: the latest PHP is fine for us.",
  };
  f.plan[f.chief.id] = { reply: "Yes, the latest PHP version is fine for us." };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "Please ask Clive if we can upgrade to the latest PHP version");
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "30")).status).toBe("settled");
  const asked = f.evidence().find((turn: any) => turn.botId === f.lead.id);
  expect(asked.system).toContain("You can reach every other bot on this team, in every department");
  expect(asked.system).toContain("Clive — General assistant (Leadership) [Chief of Staff]");
  const response = asked.evidence.find((entry: any) => entry.step).response;
  expect(response.result.isError).toBeFalsy();
  const child = f.nodes().find((node: any) => node.parentId);
  expect(child).toMatchObject({ botId: f.chief.id, mode: "consult", status: "completed" });
  const said = await f.messages(f.lead.activeTaskId);
  expect(said.some((message: any) => message.tool?.name === "Sent to Clive")).toBe(true);
  expect(said.some((message: any) => message.text === "Clive says yes: the latest PHP is fine for us.")).toBe(true);
}), 45_000);

it.each([false, true])("starts independent work immediately and frees the Chief while waiting (source fails: %s)", fail => fixture(async f => {
  const sourceGate = join(f.session.info.dataDir, "source-ready");
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.chief.id].gateFile = sourceGate;
  f.plan[f.chief.id].fail = fail;
  f.plan[f.lead.id] = { gateFile: childGate, reply: "CSV export implemented and checked", expectContextIncludes: ["[LIVE TEAMMATES]", `[id: ${f.specialist.id}]`] };
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  expect(f.nodes().find((n: any) => n.botId === f.chief.id).status).toBe("source");
  writeFileSync(sourceGate, "finish the fixture source turn");
  const readChief = async () => (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.id === f.chief.id);
  await expect.poll(async () => {
    const b = await readChief();
    return !b.busy && b.waitingForTeammates && b.tasks.find((t: any) => t.threadId === f.chief.activeTaskId)?.waitingForTeammates;
  }, { timeout: 30_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, { approvalMode: "ask" }, "PATCH");
  expect(f.nodes().find((n: any) => n.botId === f.lead.id).status).toBe("running");
  writeFileSync(childGate, "complete the fixture teammate");
  await expect.poll(() => f.nodes().find((n: any) => n.botId === f.chief.id)?.status, { timeout: 15_000 }).toBe("completed");
  expect((await f.wait()).status).toBe("settled");
  expect((await f.messages(f.chief.activeTaskId)).filter((m: any) => m.text === f.plan[f.chief.id].resumeReply)).toHaveLength(1);
  await expect.poll(async () => {
    const b = await readChief();
    return { busy: b.busy, waitingForTeammates: b.waitingForTeammates };
  }, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: false });
}), 60_000);

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
  const leadTools = turn.evidence[0].result.tools;
  const tools = leadTools.map((tool: any) => tool.name);
  expect(tools).toContain("coordinate_bots");
  expect(tools).toContain("assignment_status");
  for (const alias of ["delegate_bot", "ask_bot", "send_to_bot", "check_delegation", "wait_delegation"]) expect(tools).not.toContain(alias);
  const chiefTools = f.evidence()[0].evidence[0].result.tools;
  const selfThread = chiefTools.find((tool: any) => tool.name === "start_thread");
  expect(selfThread.description).toContain("separate job on yourself");
  expect(selfThread.inputSchema.properties.bot_id).toBeUndefined();
  expect(bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === receipt.threadRef.threadId).openedBy)
    .toMatchObject({ botId: f.chief.id, name: "Clive" });
  expect(turn.system).toContain("only an actual coordinate_bots result proves that teammate participated");
}), 45_000);

it("shows a settled delegation and its resume in the parent thread, and notifies once, with the answer", () => fixture(async f => {
  const stream = await openSse(`${f.session.info.url}/api/events`);
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    // f.wait() resolves through the control CLI poll, independent of the SSE reader: until() proves the "done" is stored first.
    await stream.until(frame => frame.kind === "notify" && frame.notification?.kind === "done" && frame.notification.botId === f.chief.id);
    // The results coming back to the bot that asked notify nobody: its answer, the one "done", is what the person needs.
    const notes = stream.frames.filter(frame => frame.kind === "notify").map(frame => frame.notification);
    expect(notes.map(note => [note.kind, note.botId]), JSON.stringify(notes)).toEqual([["done", f.chief.id]]);
    expect(notes[0]).toMatchObject({ threadId: f.chief.activeTaskId, title: "Clive finished" });
    const { bots } = await f.api("/api/bots?messages=0");
    const work = bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.openedBy?.botId === f.chief.id);
    expect(work.unread, "no unread mark, on the desktop or the phone's To review, for a teammate's own step").toBeFalsy();
    expect(bots.find((bot: any) => bot.id === f.chief.id).tasks.find((task: any) => task.threadId === f.chief.activeTaskId).unread, "the person's own conversation still is").toBe(true);
    expect(stream.frames.some(frame => frame.kind === "notify" && frame.notification?.kind === "done"
      && (frame.notification.botId === f.lead.id || frame.notification.botId === f.specialist.id))).toBe(false);
    const chips = (await f.messages(f.chief.activeTaskId))
      .filter((message: any) => message.kind === "activity" && message.tool?.name.startsWith("Resumed with "));
    expect(chips.map((message: any) => message.tool.name)).toEqual(["Resumed with Engineering lead results, reviewing"]);
  } finally { stream.close(); }
}), 45_000);

it.each(["resume", "stop", "failed resume", "failed root"] as const)("keeps a guarded Chief request exact through coordination and %s", action => fixture(async f => {
  const threadId = f.chief.activeTaskId;
  const sendId = randomUUID();
  const route = `/api/bots/${f.chief.id}/requests/${sendId}`;
  const gate = join(f.session.info.dataDir, "guarded-coordination.gate");
  const evidence: unknown[] = [{ fixture: f.session.info, action }];
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(f.session.info.url + path, { method,
      headers: { "content-type": "application/json", origin: f.session.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  try {
    await api("PATCH", `/api/bots/${f.chief.id}`, { parkDirectMessages: true });
    await api("PATCH", `/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" });
    f.plan[f.lead.id] = { gateFile: gate, reply: "The gated CSV export check passed" };
    f.plan[f.chief.id].failResumed = action === "failed resume";
    f.save();
    const before = await api("GET", `/api/threads/${threadId}/messages`);
    const accepted = await api("POST", `/api/bots/${f.chief.id}/messages/guarded`, {
      threadId, sendId, text: "Coordinate the gated CSV export check and own the result.", expectedActiveLeafId: before.activeLeafId,
    }, 202);
    const snapshot = () => api("GET", `${route}?threadId=${threadId}`);
    await expect.poll(async () => {
      const current = await snapshot();
      return current.phase === "waiting" && current.activeTurnId === null &&
        current.messages.some((message: any) => message.text === "Assigned to Engineering" && message.turnTerminal);
    }, { timeout: 15_000 }).toBe(true);
    const waiting = await snapshot();
    expect(waiting).toMatchObject({ messageId: accepted.message.id, phase: "waiting", activeTurnId: null, executionId: expect.any(String) });
    expect(waiting.messages[0]).toMatchObject({ id: accepted.message.id, sendId, role: "user" });
    expect(waiting.messages.at(-1).id).toBe(waiting.activeLeafId);
    expect(waiting.messages.find((message: any) => message.text === "Assigned to Engineering").requestMessageId).toBe(accepted.message.id);
    await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
    const child = f.nodes().find((node: any) => node.botId === f.lead.id);
    await api("PATCH", `/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" });
    const target = { threadId, messageId: waiting.messageId, expectedActiveLeafId: waiting.activeLeafId,
      expectedTurnId: waiting.activeTurnId, expectedExecutionId: waiting.executionId };
    if (action === "failed root") {
      await api("PATCH", `/api/bots/${f.chief.id}`, { chiefOfStaff: false, hidden: true });
      writeFileSync(gate, "release the isolated teammate after its root lost its Chief");
      await expect.poll(() => f.nodes().find((node: any) => node.id === waiting.executionId)?.status, { timeout: 15_000 }).toBe("failed");
      const finalWait = await f.wait();
      evidence.push({ command: ["wait", "--bot", f.chief.id, "--task", threadId, "--timeout", "30"], result: finalWait });
      expect(finalWait.status).toBe("settled");
      const failed = await snapshot();
      expect(failed).toMatchObject({ messageId: accepted.message.id, phase: "untracked", activeTurnId: null, executionId: waiting.executionId });
      expect(failed.messages[0].requestPending).toBe(true);
      expect(failed.messages[0].requestCancelled).not.toBe(true);
      expect(failed.messages.find((message: any) => message.turnTerminal)).toMatchObject({
        text: "Assigned to Engineering", requestMessageId: accepted.message.id, turnSucceeded: true,
      });
      expect(failed.messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
      evidence.push({ command: ["messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30"],
        result: await f.cli("messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30") });
      return;
    }
    if (action === "stop") {
      await api("POST", `${route}/interrupt`, { ...target, expectedExecutionId: null }, 409);
      expect(await api("POST", `${route}/interrupt`, target)).toEqual({ ok: true, outcome: "stopped" });
      await api("POST", `${route}/interrupt`, target, 409);
      // Stop means stop: the teammate working for the request ends with it.
      expect(f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("cancelled");
    }
    writeFileSync(gate, "finish only the isolated teammate");
    const childWait = await f.cli("wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20");
    evidence.push({ command: ["wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20"], result: childWait });
    expect(childWait.status).toBe("settled");
    await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe(action === "stop" ? "cancelled" : "completed");
    const finalWait = await f.wait();
    evidence.push({ command: ["wait", "--bot", f.chief.id, "--task", threadId, "--timeout", "30"], result: finalWait });
    expect(action === "failed resume" ? ["settled", "failed"] : ["settled"]).toContain(finalWait.status);
    if (action === "stop") {
      // Give an erroneously queued resume time to handshake and publish a turn.
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
      const messages = await f.messages(threadId);
      expect(new Set(messages.filter((message: any) => message.turnId).map((message: any) => message.turnId)).size).toBe(1);
      expect(messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      await api("POST", `${route}/interrupt`, target, 409);
    } else if (action === "failed resume") {
      const failed = await snapshot();
      expect(failed).toMatchObject({ messageId: accepted.message.id, phase: "untracked", activeTurnId: null });
      expect(failed.executionId).not.toBe(waiting.executionId);
      const initial = failed.messages.find((message: any) => message.turnTerminal);
      expect(initial).toMatchObject({ text: "Assigned to Engineering", requestMessageId: accepted.message.id, turnSucceeded: true });
      expect(failed.messages.findLast((message: any) => message.turnSucceeded !== undefined).turnSucceeded).toBe(false);
      expect(failed.messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
      await api("POST", `${route}/interrupt`, target, 409);
    } else {
      const settled = await snapshot();
      expect(settled).toMatchObject({ messageId: accepted.message.id, phase: "settled", activeTurnId: null, executionId: expect.any(String) });
      expect(settled.executionId).not.toBe(waiting.executionId);
      expect(settled.messages[0].id).toBe(accepted.message.id);
      expect(settled.messages.at(-1).id).toBe(settled.activeLeafId);
      for (let index = 1; index < settled.messages.length; index++) expect(settled.messages[index].parentId).toBe(settled.messages[index - 1].id);
      const replies = settled.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.turnTerminal);
      expect(replies.map((message: any) => message.text)).toEqual(["Assigned to Engineering", "The requested CSV export is implemented and verified"]);
      expect(new Set(replies.map((message: any) => message.turnId)).size).toBe(2);
      expect(settled.messages.filter((message: any) => message.turnId).every((message: any) => message.requestMessageId === accepted.message.id)).toBe(true);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
      await api("POST", `${route}/interrupt`, target, 409);
    }
    evidence.push({ command: ["messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30"],
      result: await f.cli("messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30") });
  } finally {
    const evidencePath = `${f.session.info.logPath}.guarded-coordination-${action.replaceAll(" ", "-")}.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: f.session.info.logPath }));
  }
}), 45_000);

it("opens a fresh thread on a teammate with coordinate_bots thread \"new\" and gets the result back", () => fixture(async f => {
  const originalLead = await f.messages(f.lead.activeTaskId);
  f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: "NEW_THREAD_BRIEF verify the CSV export yourself", thread: "new" } }],
    reply: "Opened a fresh thread", resumeReply: "The fresh thread reported back" };
  f.plan[f.lead.id] = { reply: "NEW_THREAD_RESULT verified" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const answered = f.evidence()[0].evidence.find((entry: any) => entry.step?.arguments?.thread === "new").response.result;
  expect(answered.isError).toBeFalsy();
  expect(answered.content[0].text).not.toMatch(/Deprecated|alias/);
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  expect(child).toMatchObject({ mode: "work", reply: "resume", status: "completed", text: expect.stringContaining("NEW_THREAD_BRIEF") });
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks.find((task: any) => task.threadId === child.threadId)).toMatchObject({ title: "NEW_THREAD_BRIEF verify the CSV export yourself", openedBy: { botId: f.chief.id, name: "Clive" } });
  expect(child.threadId).not.toBe(f.lead.activeTaskId);
  expect(await f.messages(f.lead.activeTaskId)).toEqual(originalLead);
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied" && message.tool.output === "NEW_THREAD_RESULT verified")).toBe(true);
}), 45_000);

it("closes a thread \"new\" opened once its result is back, and opens it again for a follow-up sent to it", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "follow-up.gate");
  const opening = [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "FRESH_BRIEF verify the CSV export yourself", thread: "new" } }], reply: "Opened a fresh thread" },
    { reply: "The fresh thread reported back" },
  ];
  f.plan[f.chief.id] = { turns: opening };
  f.plan[f.lead.id] = { turns: [{ reply: "FRESH_RESULT verified" }, { gateFile: gate, reply: "FRESH_RESULT checked again" }] };
  const leadTask = async (threadId: string) => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === threadId);
  const leadNodes = () => f.nodes().filter((node: any) => node.botId === f.lead.id);
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const [child] = leadNodes();
  const closed = await leadTask(child.threadId);
  expect(closed.openedBy).not.toHaveProperty("kind");
  expect(closed.openedBy.oneShot).toBe(true);
  expect(closed.closedBy).toMatchObject({ botId: f.chief.id, name: "Clive" });
  expect(closed.archivedAt).toBe(closed.closedBy.at);
  expect((await f.messages(child.threadId)).map((message: any) => message.text).filter(Boolean).join("\n")).toContain("FRESH_RESULT verified");
  expect(await leadTask(f.lead.activeTaskId)).not.toHaveProperty("closedBy");

  f.plan[f.chief.id] = { turns: [...opening,
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "FRESH_FOLLOW_UP check it once more", thread: child.threadId } }], reply: "Sent the follow-up" },
    { reply: "The follow-up reported back" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Ask them to check once more in that thread.");
  await expect.poll(() => leadNodes().at(-1)?.status, { timeout: 15_000 }).toBe("running");
  expect(leadNodes().map((node: any) => node.threadId)).toEqual([child.threadId, child.threadId]);
  expect(await leadTask(child.threadId)).not.toHaveProperty("closedBy");
  expect(await leadTask(child.threadId)).not.toHaveProperty("archivedAt");
  writeFileSync(gate, "go");
  expect((await f.wait()).status).toBe("settled");
  await expect.poll(async () => (await leadTask(child.threadId)).closedBy, { timeout: 15_000 }).toMatchObject({ botId: f.chief.id });
  expect((await leadTask(child.threadId)).archivedAt).toBeGreaterThan(closed.archivedAt);
}), 90_000);

it("reruns an identical brief with rework=true in the archived thread \"new\" opened, which leaves the archive while it runs", () => fixture(async f => {
  const brief = "REWORK_BRIEF run the export check";
  const gate = join(f.session.info.dataDir, "rework.gate");
  const opening = [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: brief, thread: "new" } }], reply: "Opened a fresh thread" },
    { reply: "The fresh thread reported back" },
  ];
  f.plan[f.chief.id] = { turns: opening };
  f.plan[f.lead.id] = { turns: [{ reply: "REWORK_RESULT first" }, { gateFile: gate, reply: "REWORK_RESULT second" }] };
  const leadTask = async (threadId: string) => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === threadId);
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  await expect.poll(async () => (await leadTask(child.threadId)).archivedAt, { timeout: 15_000 }).toBeTypeOf("number");

  f.plan[f.chief.id] = { turns: [...opening,
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: brief, thread: child.threadId, rework: true } }], reply: "Sent it again" },
    { reply: "The rework reported back" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Have them run it once more in that thread.");
  await expect.poll(() => f.nodes().filter((node: any) => node.botId === f.lead.id).at(-1)?.status, { timeout: 15_000 }).toBe("running");
  const [sent] = f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1).evidence.filter((entry: any) => entry.step).map((entry: any) => entry.response.result);
  expect(sent.isError).toBeFalsy();
  expect(JSON.parse(sent.content[0].text).receipts[0]).toMatchObject({ outcome: "queued", threadId: child.threadId });
  const reopened = await leadTask(child.threadId);
  expect(reopened).not.toHaveProperty("archivedAt");
  expect(reopened).not.toHaveProperty("closedBy");
  writeFileSync(gate, "go");
  expect((await f.wait()).status).toBe("settled");
  await expect.poll(async () => (await leadTask(child.threadId)).archivedAt, { timeout: 15_000 }).toBeTypeOf("number");
  expect((await f.messages(child.threadId)).map((message: any) => message.text).filter(Boolean).join("\n")).toContain("REWORK_RESULT second");
}), 90_000);

it("lets the opener list and close a thread \"new\" opened after it was archived", () => fixture(async f => {
  f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: "LISTED_BRIEF verify the CSV export yourself", thread: "new" } }],
    reply: "Opened a fresh thread", resumeReply: "The fresh thread reported back" };
  f.plan[f.lead.id] = { reply: "LISTED_RESULT verified" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  await expect.poll(async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks
    .find((task: any) => task.threadId === child.threadId).archivedAt, { timeout: 15_000 }).toBeTypeOf("number");
  f.plan[f.chief.id] = { steps: [
    { tool: "list_threads", arguments: {} },
    { tool: "close_thread", arguments: { thread_id: child.threadId } },
  ], reply: "Checked the finished thread" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Find the finished engineering thread and close it.");
  expect((await f.wait()).status).toBe("settled");
  const [listed, closed] = f.evidence().at(-1).evidence.filter((entry: any) => entry.step).map((entry: any) => entry.response.result);
  const { title } = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === child.threadId);
  expect(listed.content[0].text).toContain(`- #${title} (on @Engineering lead, closed, archived: no longer in the person's sidebar) [thread id: ${child.threadId}]`);
  expect(closed.isError).toBeFalsy();
  expect(closed.content[0].text).toBe(`#${title} on @Engineering lead was already closed by @Clive, so nothing changed. It is archived: it is no longer in the person's sidebar.`);
}), 60_000);

it("keeps a thread \"new\" opened open when a person wrote in it before its result came back", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "person-wrote.gate");
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "JOINED_BRIEF verify the CSV export yourself", thread: "new" } }], reply: "Opened a fresh thread" },
    { reply: "The fresh thread reported back" },
  ] };
  f.plan[f.lead.id] = { turns: [{ gateFile: gate, reply: "JOINED_RESULT verified" }, { reply: "JOINED_RESULT noted" }] };
  const leadTask = async (threadId: string) => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === threadId);
  const stream = await openSse(`${f.session.info.url}/api/events`);
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  await f.api(`/api/bots/${f.lead.id}/messages`, { text: "Also check the header row while you are there.", threadId: child.threadId });
  await expect.poll(async () => (await f.messages(child.threadId)).some((message: any) => message.role === "user" && !message.peerAsk && message.text === "Also check the header row while you are there."), { timeout: 15_000 }).toBe(true);
  writeFileSync(gate, "go");
  expect((await f.wait()).status).toBe("settled");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.output === "JOINED_RESULT verified"), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await leadTask(child.threadId)).busy, { timeout: 15_000 }).toBeFalsy();
  stream.close();
  expect(stream.frames.some(frame => frame.kind === "bot" && frame.bot?.id === f.lead.id
    && frame.bot.tasks?.find((task: any) => task.threadId === child.threadId)?.closedBy)).toBe(false);
  expect(await leadTask(child.threadId)).not.toHaveProperty("closedBy");
}), 90_000);

it("names a fresh teammate thread with coordinate_bots title", () => fixture(async f => {
  f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: "TITLED_BRIEF verify the CSV export yourself", thread: "new", title: "CSV export: verify" } }],
    reply: "Opened a titled thread", resumeReply: "The titled thread reported back" };
  f.plan[f.lead.id] = { reply: "TITLED_RESULT verified" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const answered = f.evidence()[0].evidence.find((entry: any) => entry.step?.arguments?.title).response.result;
  expect(answered.isError).toBeFalsy();
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks.find((task: any) => task.threadId === child.threadId)).toMatchObject({ title: "CSV export: verify", openedBy: { botId: f.chief.id, name: "Clive" } });
}), 45_000);

it("lets the opener find and close the completed task", () => fixture(async f => {
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(2);
  f.plan[f.chief.id] = {
    steps: [
      { tool: "list_threads", arguments: {} },
      { tool: "close_thread", arguments: { thread_id: child.threadId } },
      { tool: "list_threads", arguments: {} },
    ],
    reply: "I read the result and closed its completed task",
  };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Find the completed engineering task and close it after reading the result.");
  expect((await f.wait()).status).toBe("settled");
  const inspection = f.evidence().at(-1).evidence;
  const listed = inspection.filter((entry: any) => entry.step?.tool === "list_threads");
  expect(listed).toHaveLength(2);
  expect(listed[0].response.result.content[0].text).toContain(child.threadId);
  expect(listed[0].response.result.content[0].text).not.toContain(f.lead.activeTaskId);
  expect(listed[1].response.result.content[0].text).toContain("closed");
  const closedLead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(closedLead.tasks.find((task: any) => task.threadId === child.threadId).closedBy).toMatchObject({ botId: f.chief.id });
  expect((await f.messages(child.threadId)).some((message: any) => message.text === "Implemented and reviewer confirmed checks")).toBe(true);
}), 45_000);

it("lets a bot rename only the thread it is working in", () => fixture(async f => {
  f.plan[f.chief.id] = {
    steps: [{ tool: "rename_thread", arguments: { title: "Acme: carousel design" } }],
    reply: "Renamed this thread",
  };
  f.save();
  const before = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id).tasks.find((task: any) => task.threadId === f.chief.activeTaskId).title;
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Terminei o design e a skill de carrossel pra cliente Acme, pode dar um nome melhor a esta conversa?");
  expect((await f.wait()).status).toBe("settled");
  const step = f.evidence().at(-1).evidence.find((entry: any) => entry.step?.tool === "rename_thread");
  expect(step.response.result.isError).toBeFalsy();
  expect(step.response.result.content[0].text).toContain("#Acme: carousel design");
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  const renamed = chief.tasks.find((task: any) => task.threadId === f.chief.activeTaskId);
  expect(renamed.title).toBe("Acme: carousel design");
  expect(renamed.title).not.toBe(before);
}), 45_000);

it("does not treat self-opened work or an abandoned human branch as new human authority", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PUT");
  const room = (await f.cli("new-channel", "--name", "Updates", "--members", f.chief.id, "--section", "Leadership")).channel;
  const post = (message: string, expectError = false) => ({ tool: "post_to_room", arguments: { group_id: room.id, message }, expectError });
  f.plan[f.chief.id] = { turns: [
    { steps: [post("First update"), post("Second update"), { tool: "start_thread", arguments: { title: "Independent job", message: "Continue the separate check." } }], reply: "Opened the independent job" },
    { steps: [post("A self-opened job is not another human answer", true), { tool: "request_credential", arguments: { credential_id: "ttsKey", reason: "Fixture continuation" } }], reply: "Waiting for the fixture credential decision" },
    { reply: "This alternative human branch will be abandoned" },
    { reply: "Continuing only the original self-opened job" },
    { steps: [post("A real user explicitly asked for this update")], reply: "Posted the requested update" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Post two updates and open one independent check.");
  await expect.poll(() => f.evidence().length, { timeout: 20_000 }).toBe(2);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  const child = chief.tasks.find((task: any) => task.title === "Independent job");
  expect(child).toBeDefined();
  const childWait = () => f.cli("wait", "--bot", f.chief.id, "--task", child.threadId, "--timeout", "20");
  const providerFinished = async (turns: number) => {
    await expect.poll(() => f.evidence().length, { timeout: 20_000 }).toBe(turns);
    await expect.poll(async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id)
      .tasks.find((task: any) => task.threadId === child.threadId).busy).toBe(false);
  };
  await providerFinished(2);
  expect((await childWait()).status).toBe("needs-user");
  const attempt = f.evidence()[1].evidence.find((entry: any) => entry.step?.tool === "post_to_room");
  expect(attempt.response.result.isError).toBe(true);
  expect(attempt.response.result.content[0].text).toContain("nobody has answered");
  expect((await f.messages(room.activeTaskId)).filter((message: any) => message.peerPost)).toHaveLength(2);
  const secret = (await f.messages(child.threadId)).find((message: any) => message.kind === "secret");
  expect(secret).toBeDefined();
  const opening = (await f.messages(child.threadId)).find((message: any) => message.peerAsk?.botId === f.chief.id);
  await f.api(`/api/bots/${f.chief.id}/messages/${opening.id}/edit`, { threadId: child.threadId, text: "An alternative human request." });
  await providerFinished(3);
  await f.api(`/api/bots/${f.chief.id}/active-branch`, { threadId: child.threadId, messageId: secret.id });
  expect((await f.messages(child.threadId)).some((message: any) => message.text === "An alternative human request.")).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/secret-cards/${secret.id}/dismiss`, { threadId: child.threadId });
  await providerFinished(4);
  expect((await childWait()).status).toBe("settled");
  expect(f.evidence().at(-1).evidence[0].result.tools.find((tool: any) => tool.name === "start_thread").inputSchema.properties.bot_id).toBeUndefined();
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id).tasks).toHaveLength(2);
  await f.cli("send", "--bot", f.chief.id, "--task", child.threadId, "--text", "Now I want you to post one new update.");
  await providerFinished(5);
  expect((await childWait()).status).toBe("settled");
  expect((await f.messages(room.activeTaskId)).filter((message: any) => message.peerPost)).toHaveLength(3);
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

// The CLI ends between turns here, so each later turn resumes and is refused.
it("returns nested results after Claude rejects the source's prior resume cursor", () => fixture(async f => {
  const coordination = f.plan[f.chief.id];
  f.plan[f.chief.id] = { reply: "Earlier conversation" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Hello before the task");
  expect((await f.wait()).status).toBe("settled");
  f.plan[f.chief.id] = coordination;
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toHaveLength(4);
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  const transcript = await f.messages(f.chief.activeTaskId);
  expect(transcript.some((message: any) => message.tool?.name === `notice: ${rebuiltSessionNotice("Claude Code")}`)).toBe(true);
}, { FAKE_CLAUDE_MODE: "dead-session", FAKE_CLAUDE_EXIT_AFTER_TURN: "1" }), 45_000);

it("uses recipient bot defaults for its new task, never the sender's or its selected old thread's settings", () => fixture(async f => {
  const models = await f.cli("models");
  const options = models.instances.find((instance: any) => instance.instanceId === f.lead.modelSelection.instanceId).models.options;
  const selected = options.find((model: any) => model.id !== f.lead.modelSelection.model);
  await f.api(`/api/bots/${f.lead.id}/tasks/${f.lead.activeTaskId}`, { modelSelection: { instanceId: f.lead.modelSelection.instanceId, model: selected.id }, approvalMode: "edits" }, "PATCH");
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const node = f.nodes().find((entry: any) => entry.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks.find((task: any) => task.threadId === f.lead.activeTaskId)).toMatchObject({ modelSelection: { model: selected.id }, approvalMode: "edits" });
  expect(lead.tasks.find((task: any) => task.threadId === node.threadId)).toMatchObject({ modelSelection: f.lead.modelSelection, approvalMode: "full" });
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).every((turn: any) => turn.model === f.lead.modelSelection.model && turn.permissionMode === "bypassPermissions")).toBe(true);
}), 45_000);

it("continues one recipient thread for every follow-up from the same conversation", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Header row added" }, { reply: "Write-up published" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { reply: "The export is implemented" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Add the header row to that export" } }], reply: "Assigned the header row" },
    { reply: "The header row is in" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Document the export you just built" } }], reply: "Assigned the write-up" },
    { reply: "It is documented" },
  ] };
  f.save();
  const send = async (text: string) => {
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", text);
    expect((await f.wait()).status).toBe("settled");
  };
  const leadTasks = async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  await send("Ask Engineering to build the CSV export.");
  const first = (await leadTasks()).find((task: any) => task.threadId !== f.lead.activeTaskId);
  expect(first.title).toBe("@Clive · work");
  expect(first.openedBy).toMatchObject({ botId: f.chief.id, name: "Clive", kind: "work", threadId: f.chief.activeTaskId });
  expect(first.closedBy).toMatchObject({ botId: f.chief.id });
  expect(first).not.toHaveProperty("archivedAt");
  await send("Now ask them to add the header row.");
  await send("Now ask them to document it.");
  const tasks = await leadTasks();
  expect(tasks).toHaveLength(2);
  expect(tasks.find((task: any) => task.threadId === first.threadId)).toMatchObject({ title: "@Clive · work", closedBy: { botId: f.chief.id } });
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId)).toEqual([first.threadId, first.threadId, first.threadId]);
  const briefs = ["Implement the CSV export", "Add the header row to that export", "Document the export you just built"];
  const transcript = (await f.messages(first.threadId)).map((message: any) => message.text).filter(Boolean).join("\n");
  for (const brief of briefs) expect(transcript).toContain(brief);
  // Claude snapshots the system prompt at the session's first request, so briefs must travel in their user turns.
  const leadTurns = f.evidence().filter((turn: any) => turn.botId === f.lead.id);
  expect(leadTurns.map((turn: any) => turn.threadId)).toEqual([first.threadId, first.threadId, first.threadId]);
  for (const [index, brief] of briefs.entries()) expect(leadTurns[index].prompt.message.content).toContain(brief);
  expect(leadTurns.every((turn: any) => turn.system.includes("current request and returned results arrive in the user turn"))).toBe(true);
  expect(leadTurns.every((turn: any) => turn.snapshotMode === "off")).toBe(true);
  for (const brief of briefs) expect(leadTurns.every((turn: any) => !turn.system.includes(brief))).toBe(true);
  const receipts = sendReceipts(f, f.chief.id);
  expect(receipts.map((receipt: any) => receipt.threadId)).toEqual([first.threadId, first.threadId, first.threadId]);
  for (const receipt of receipts) expect(receipt.detail).toBe('sent to "@Clive · work"; it runs after anything still running there');
  const chips = (await f.messages(f.chief.activeTaskId)).filter((message: any) => message.threadRef?.threadId === first.threadId);
  expect(chips.filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(3);
  expect((await leadTasks()).find((task: any) => task.threadId === f.lead.activeTaskId)).not.toHaveProperty("closedBy");
}, { FAKE_CLAUDE_VERSION: "2.1.270" }), 90_000);

it.each<[string, NodeJS.ProcessEnv]>([
  ["a headless server", {}],
  ["the desktop app", { OMB_TEST_DESKTOP_OWNER_TOKEN: randomBytes(32).toString("base64url") }],
])("on %s, hands a follow-up sent while the teammate still works to its running turn, and one result comes back", (_where, env) => fixture(async f => {
  expect((await f.api("/.well-known/openmausbot/environment", undefined, "GET")).capabilities.selfUpdate)
    .toBe(env.OMB_TEST_DESKTOP_OWNER_TOKEN ? "desktop-managed" : "operator");
  const gate = join(f.session.info.dataDir, "first-request.gate");
  f.plan[f.lead.id] = { turns: [{ gateFile: gate, reply: "Export implemented, with the header row" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Also add a header row to that export" } }], reply: "Sent the change" },
    { reply: "Reviewed" },
  ] };
  const chiefTurns = () => f.evidence().filter((turn: any) => turn.botId === f.chief.id);
  const stream = await openSse(`${f.session.info.url}/api/events`);
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(() => chiefTurns().length, { timeout: 15_000 }).toBe(1);
  await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Change of plan: the export also needs a header row.", threadId: f.chief.activeTaskId });
  await expect.poll(() => chiefTurns().length, { timeout: 20_000 }).toBe(2);
  expect(told(chiefTurns()[1])).toContain("send the change to the same teammate with coordinate_bots");
  const [running, ...others] = f.nodes().filter((node: any) => node.botId === f.lead.id);
  expect(others, "the change started no second job").toEqual([]);
  expect(sendReceipts(f, f.chief.id)[1]).toMatchObject({ outcome: "injected", threadId: running.threadId, requestId: running.id });
  expect((await f.messages(running.threadId)).filter((message: any) => message.peerAsk?.name === "Clive" && message.text === "Also add a header row to that export"))
    .toHaveLength(1);
  writeFileSync(gate, "go");
  expect((await f.wait()).status).toBe("settled");
  await expect.poll(() => f.nodes().filter((node: any) => node.parentId).every((node: any) => node.status === "completed"), { timeout: 15_000 }).toBe(true);
  const leadTurns = f.evidence().filter((turn: any) => turn.botId === f.lead.id);
  expect(leadTurns.map((turn: any) => [turn.turnIndex, turn.threadId])).toEqual([[0, running.threadId]]);
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks).toHaveLength(2);
  await stream.until(frame => frame.kind === "bot" && frame.bot?.id === f.lead.id
    && frame.bot.tasks?.find((task: any) => task.threadId === running.threadId)?.closedBy);
  const closed = stream.frames.filter(frame => frame.kind === "bot" && frame.bot?.id === f.lead.id)
    .map(frame => Boolean(frame.bot.tasks?.find((task: any) => task.threadId === running.threadId)?.closedBy));
  stream.close();
  expect(closed.filter((now, at) => now && !closed[at - 1])).toHaveLength(1);
}, env), 60_000);
