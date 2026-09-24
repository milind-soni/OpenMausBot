import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

/** Run direct Chief/lead/specialist workflows against an isolated scripted server. */
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

it("does not grant a specialist direct access to its supervising Chief", () => fixture(async f => {
  f.plan[f.lead.id] = {
    steps: [{ expectError: true, arguments: { bot_ids: [f.chief.id], request_key: "supervisor", message: "Contact the Chief without a shared room" } }],
    reply: "The direct request was refused",
  };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "Check the direct peer boundary");
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "30")).status).toBe("settled");
  expect(f.nodes()).toEqual([]);
  const response = f.evidence().find((turn: any) => turn.botId === f.lead.id).evidence.find((entry: any) => entry.step).response;
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain("sender's section boundary");
  expect((await f.api("/api/bots")).groups).toEqual([]);
}), 45_000);

it.each([false, true])("starts independent work immediately and frees the Chief while waiting (source fails: %s)", fail => fixture(async f => {
  const sourceGate = join(f.session.info.dataDir, "source-ready");
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.chief.id].gateFile = sourceGate;
  f.plan[f.chief.id].fail = fail;
  f.plan[f.lead.id] = { gateFile: childGate, reply: "CSV export implemented and checked" };
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  expect(f.nodes().find((n: any) => n.botId === f.chief.id).status).toBe("source");
  writeFileSync(sourceGate, "finish the fixture source turn");
  const readChief = async () => (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.id === f.chief.id);
  await expect.poll(async () => {
    const b = await readChief();
    return !b.busy && b.waitingForTeammates && b.tasks.find((t: any) => t.threadId === f.chief.activeTaskId)?.waitingForTeammates;
  }, { timeout: 30_000 }).toBe(true);
  // No provider turn is occupying the Chief; its thread controls remain usable.
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
  const tools = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(tools).toContain("coordinate_bots");
  expect(tools).not.toContain("delegate_bot");
  expect(tools).not.toContain("start_thread");
  const chiefTools = f.evidence()[0].evidence[0].result.tools;
  const selfThread = chiefTools.find((tool: any) => tool.name === "start_thread");
  expect(selfThread.description).toContain("separate job on yourself");
  expect(selfThread.inputSchema.properties.bot_id.enum).toEqual([f.chief.id]);
  expect(bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === receipt.threadRef.threadId).openedBy)
    .toMatchObject({ botId: f.chief.id, name: "Clive" });
  expect(turn.system).toContain("only an actual coordinate_bots result proves that teammate participated");
}), 45_000);

it("announces a settled delegation and its resume in the parent thread", () => fixture(async f => {
  const stream = await openSse(`${f.session.info.url}/api/events`);
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    // f.wait() resolves through the control CLI poll, an independent path
    // from the SSE reader loop; until() (which also resolves on frames
    // already seen) is what proves both settles are stored before the
    // assertions below count them
    await Promise.all([
      stream.until(frame => frame.kind === "notify"
        && frame.notification?.kind === "delegation-settled"
        && frame.notification.botId === f.chief.id),
      stream.until(frame => frame.kind === "notify"
        && frame.notification?.kind === "delegation-settled"
        && frame.notification.botId === f.lead.id),
    ]);
    const settles = () => stream.frames.filter(frame => frame.kind === "notify" && frame.notification?.kind === "delegation-settled");
    // the chief's resume is announced exactly once, pointing at the
    // conversation the notification opens
    const chiefFrames = settles().filter(frame => frame.notification.botId === f.chief.id);
    expect(chiefFrames).toHaveLength(1);
    expect(chiefFrames[0].notification).toMatchObject({
      threadId: f.chief.activeTaskId,
      title: "Clive resumed with results",
      body: "Results in from Engineering lead",
    });
    // the nested lead resume is announced too, on its delegated thread
    const leadFrames = settles().filter(frame => frame.notification.botId === f.lead.id);
    expect(leadFrames).toHaveLength(1);
    expect(leadFrames[0].notification.threadId).not.toBe(f.lead.activeTaskId);
    // the specialist ran the work and never resumed, so it earns no frame
    expect(settles().some(frame => frame.notification.botId === f.specialist.id)).toBe(false);
    // suppression of the delegated turns themselves is unchanged: neither
    // child earns a done frame. The chief's own asked-for outer turn still
    // may, exactly as before.
    expect(stream.frames.some(frame => frame.kind === "notify" && frame.notification?.kind === "done"
      && (frame.notification.botId === f.lead.id || frame.notification.botId === f.specialist.id))).toBe(false);
    // one visible chip per settle in the parent's conversation, never per steer
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
    // Waiting for teammates does not occupy a provider turn or disable edits.
    await api("PATCH", `/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" });
    const target = { threadId, messageId: waiting.messageId, expectedActiveLeafId: waiting.activeLeafId,
      expectedTurnId: waiting.activeTurnId, expectedExecutionId: waiting.executionId };
    if (action === "failed root") {
      await api("PATCH", `/api/bots/${f.chief.id}`, { chiefOfStaff: false, hidden: true });
      await expect.poll(() => f.nodes().find((node: any) => node.id === waiting.executionId)?.status, { timeout: 15_000 }).toBe("failed");
      writeFileSync(gate, "release the isolated teammate after its root failed");
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
      expect(f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("running");
    }
    writeFileSync(gate, "finish only the isolated teammate");
    const childWait = await f.cli("wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20");
    evidence.push({ command: ["wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20"], result: childWait });
    expect(childWait.status).toBe("settled");
    await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("completed");
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

it("uses only the coordinator for teammates and lets the opener find and close the completed task", () => fixture(async f => {
  f.plan[f.chief.id].steps.unshift({ tool: "start_thread", arguments: { bot_id: f.lead.id, title: "Wrong path", message: "Use teamwork" }, expectError: true });
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(2);
  const rejected = f.evidence()[0].evidence.find((entry: any) => entry.step?.tool === "start_thread");
  expect(rejected.response.result.content[0].text).toContain("Use coordinate_bots for teammates");
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

it("does not treat self-opened work or an abandoned human branch as new human authority", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PUT");
  const room = (await f.cli("new-channel", "--name", "Updates", "--members", f.chief.id, "--section", "Leadership")).channel;
  const post = (message: string, expectError = false) => ({ tool: "post_to_room", arguments: { group_id: room.id, message }, expectError });
  f.plan[f.chief.id] = { turns: [
    { steps: [post("First update"), post("Second update"), { tool: "start_thread", arguments: { title: "Independent job", message: "Continue the separate check." } }], reply: "Opened the independent job" },
    { steps: [post("A self-opened job is not another human answer", true), { tool: "request_credential", arguments: { credential_id: "ttsKey", reason: "Fixture continuation" } }], reply: "Waiting for the fixture credential decision" },
    { reply: "This alternative human branch will be abandoned" },
    { steps: [{ tool: "start_thread", arguments: { title: "Recursive job", message: "Must not start." }, expectError: true }], reply: "Continuing only the original self-opened job" },
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
  // The later human message remains in storage, but not in this active branch.
  expect((await f.messages(child.threadId)).some((message: any) => message.text === "An alternative human request.")).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/secret-cards/${secret.id}/dismiss`, { threadId: child.threadId });
  await providerFinished(4);
  expect((await childWait()).status).toBe("settled");
  const continuation = f.evidence().at(-1);
  expect(continuation.evidence[0].result.tools.some((tool: any) => tool.name === "start_thread")).toBe(false);
  const denied = continuation.evidence.find((entry: any) => entry.step?.tool === "start_thread");
  expect(denied).toBeDefined();
  expect(denied.response.error.message).toBe("Unknown tool: start_thread");
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

it("keeps one conversation per bot pair across separate user turns, titled for the sender", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Header row added" }, { reply: "Write-up published" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "build", message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { reply: "The export is implemented" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "header", message: "Add the header row to that export" } }], reply: "Assigned the header row" },
    { reply: "The header row is in" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "docs", message: "Document the export you just built" } }], reply: "Assigned the write-up" },
    { reply: "It is documented" },
  ] };
  f.save();
  const send = async (text: string) => {
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", text);
    expect((await f.wait()).status).toBe("settled");
  };
  const leadTasks = async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  await send("Ask Engineering to build the CSV export.");
  const opened = (await leadTasks()).filter((task: any) => task.threadId !== f.lead.activeTaskId);
  expect(opened).toHaveLength(1);
  const pair = opened[0];
  // the sender's name, not an 80-character slice of the brief
  expect(pair.title).toBe("@Clive");
  expect(pair.openedBy).toMatchObject({ botId: f.chief.id, name: "Clive", kind: "pair" });
  await send("Now ask them to add the header row.");
  await send("Now ask them to document it.");
  // three assignments, three user turns, one conversation
  expect(await leadTasks()).toHaveLength(2);
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId))
    .toEqual([pair.threadId, pair.threadId, pair.threadId]);
  const transcript = (await f.messages(pair.threadId)).map((message: any) => message.text).filter(Boolean).join("\n");
  for (const brief of ["Implement the CSV export", "Add the header row to that export", "Document the export you just built"]) {
    expect(transcript).toContain(brief);
  }
  // Claude snapshots the system prompt at the session's first request. The
  // briefs must therefore travel in their user turns so they remain current
  // whether the CLI process is retained or the session is resumed.
  const leadTurns = f.evidence().filter((turn: any) => turn.botId === f.lead.id);
  expect(leadTurns).toHaveLength(3);
  expect(leadTurns[0].prompt.message.content).toContain("Implement the CSV export");
  expect(leadTurns[1].prompt.message.content).toContain("Add the header row to that export");
  expect(leadTurns[2].prompt.message.content).toContain("Document the export you just built");
  expect(leadTurns.every((turn: any) => turn.system.includes("current request and returned results arrive in the user turn"))).toBe(true);
  expect(leadTurns.every((turn: any) => turn.snapshotMode === "off")).toBe(true);
  for (const brief of ["Implement the CSV export", "Add the header row to that export", "Document the export you just built"]) {
    expect(leadTurns.every((turn: any) => !turn.system.includes(brief))).toBe(true);
  }
  // a pair conversation is the standing line between two bots: it never
  // auto-closes, and every receipt in the sender's chat points at it
  expect((await leadTasks()).find((task: any) => task.threadId === pair.threadId)).not.toHaveProperty("closedBy");
  expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.threadRef?.threadId === pair.threadId)).toHaveLength(6);
}, { FAKE_CLAUDE_VERSION: "2.1.270" }), 90_000);

it("gives a second simultaneous assignment its own labelled thread, which closes once its result is reported", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Benchmark finished" }] };
  f.plan[f.chief.id] = { steps: [
    { arguments: { bot_ids: [f.lead.id], request_key: "build", message: "Implement the CSV export" } },
    { arguments: { bot_ids: [f.lead.id], request_key: "bench", message: "Benchmark the exporter on the large fixture", label: "Benchmark" } },
  ], reply: "Both assignments are out", resumeReply: "Both came back" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const tasks = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  expect(tasks).toHaveLength(3);
  const pair = tasks.find((task: any) => task.openedBy?.kind === "pair");
  const work = tasks.find((task: any) => task.openedBy?.kind === "work");
  expect(pair.title).toBe("@Clive");
  expect(work.title).toBe("@Clive · Benchmark");
  // the two jobs never share a transcript
  const threads = f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId);
  expect(new Set(threads)).toEqual(new Set([pair.threadId, work.threadId]));
  expect((await f.messages(pair.threadId)).some((message: any) => message.text?.includes("Implement the CSV export"))).toBe(true);
  expect((await f.messages(work.threadId)).some((message: any) => message.text?.includes("Benchmark the exporter"))).toBe(true);
  expect((await f.messages(pair.threadId)).some((message: any) => message.text?.includes("Benchmark the exporter"))).toBe(false);
  // scaffolding tidies up after itself; the standing conversation stays
  expect(work.closedBy).toMatchObject({ botId: f.chief.id, name: "Clive" });
  expect(pair).not.toHaveProperty("closedBy");
}), 60_000);

it("refuses a reused request_key for different work and leaves no thread behind", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "Export implemented" };
  f.plan[f.chief.id] = { steps: [
    { arguments: { bot_ids: [f.lead.id], request_key: "build", message: "Implement the CSV export" } },
    { arguments: { bot_ids: [f.lead.id], request_key: "build", message: "Something else entirely" }, expectError: true },
  ], reply: "One assignment is out", resumeReply: "It came back" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const refused = f.evidence()[0].evidence.find((entry: any) => entry.step?.arguments?.message === "Something else entirely");
  expect(JSON.stringify(refused.response)).toContain("request_key was already used for different work");
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks).toHaveLength(2);
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id)).toHaveLength(1);
}), 45_000);

it("deduplicates a repeated direct request without creating extra recipient tasks", () => fixture(async f => {
  f.plan[f.chief.id].steps.push(structuredClone(f.plan[f.chief.id].steps[0]));
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id)).toHaveLength(1);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(2);
  expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(1);
}), 45_000);

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
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([f.lead.activeTaskId, f.nodes().find((node: any) => node.botId === f.lead.id).threadId]);
}), 45_000);

// Steering is not cancelling. A person who types while teammates work keeps
// the work: the new turn runs now, the assignments stay out, and it is told
// which ones — otherwise the model assumes its fan-out died and resends it.
it("runs a message sent while a teammate works, keeps the assignment, and names it in that turn", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 4000, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "Noted; Engineering is still working on it" },
    { reply: "The requested CSV export is implemented and verified" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  // It ran; it was not held behind the outstanding work.
  expect(receipt.queued).toBeUndefined();
  expect(receipt.message.text).toBe("Also make sure the export is UTF-8.");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(2);

  const steered = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[1];
  expect(steered.resumed).toBe(false);
  expect(steered.system).toContain("Assignments you already sent are still outstanding");
  expect(steered.system).toContain(assignment.id);
  expect(steered.system).toContain("Engineering lead");
  // The teammate was never touched: it finishes and still returns here.
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
}), 60_000);

// The opt-in from #1194: with parking on, the same message waits in the
// composer queue until the outstanding assignments settle — room-style
// parking for direct chat — and only then runs as its own follow-up turn.
it("parks a message behind outstanding teammate work when the bot opts in, then runs it after", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 4000, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "The requested CSV export is implemented and verified" },
    { reply: "Noted; the export is UTF-8 too" },
  ] };
  await f.api(`/api/bots/${f.chief.id}`, { parkDirectMessages: true }, "PATCH");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  // It parked: not run, not even on the transcript yet.
  expect(receipt.queued).toBe(true);
  expect(typeof receipt.queueId).toBe("string");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(false);
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");

  // The teammate finishes, the coordination resumes and settles, and only
  // then the parked words run as their own turn.
  expect((await f.wait()).status).toBe("settled");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(3);
  const parked = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[2];
  expect(parked.resumed).toBe(false);
  expect(parked.system).not.toContain("Assignments you already sent are still outstanding");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Noted; the export is UTF-8 too")).toBe(true);
}), 60_000);

// An automation turn is not the person cancelling either: a delegated
// (routine-driven) turn lands in the same conversation and leaves the
// outstanding assignment alone.
it("does not cancel a live coordination when an automation turn lands in the conversation", () => fixture(async f => {
  const ops = (await f.cli("new-bot", "--name", "Ops", "--section", "Leadership")).bot;
  f.plan[f.lead.id] = { delayMs: 6000, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "The requested CSV export is implemented and verified" },
    { reply: "Nothing further" },
  ] };
  f.plan[ops.id] = { turns: [
    { steps: [{ tool: "delegate_bot", arguments: { bot_id: f.chief.id, message: "Nightly note: confirm the export owner." } }], reply: "Delegated the nightly note" },
    { reply: "Recorded the outcome of the nightly note" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const { routine } = await f.api("/api/routines", { name: "Nightly note", prompt: "Send the nightly note.", botId: ops.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  await f.api(`/api/routines/${routine.id}/run`, {});
  // The delegated turn really reaches the conversation the coordination lives in.
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.peerAsk?.botId === ops.id), { timeout: 25_000 }).toBe(true);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");

  await expect.poll(() => f.nodes().find((node: any) => node.id === assignment.id)?.status, { timeout: 25_000 }).toBe("completed");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied"), { timeout: 15_000 }).toBe(true);
}), 60_000);

// Stop belongs to the conversation it was pressed in. It stops this bot and
// stops awaiting its teammates; a teammate already mid-turn keeps its own
// provider process and its result is still recorded here.
it("stops a waiting source without reaching into the teammate already working", () => fixture(async f => {
  f.plan[f.lead.id] = { delayMs: 4000, reply: "Finished after the source was stopped" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.chief.activeTaskId });

  // The source stops awaiting immediately; the teammate keeps running.
  await expect.poll(() => f.nodes().find((node: any) => !node.parentId)?.status).toBe("cancelled");
  expect(f.nodes().find((node: any) => node.parentId).status).toBe("running");
  expect((await f.wait()).status).toBe("settled");
  const chip = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name?.startsWith("Stopped here"));
  expect(chip.tool.name).toContain("Engineering lead");
  expect(chip.threadRef).toMatchObject({ botId: f.lead.id, threadId: f.nodes().find((node: any) => node.parentId).threadId });

  // Its work lands: the result is recorded and reported into the stopped chat.
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 20_000 }).toBe("completed");
  expect(f.nodes().find((node: any) => node.parentId).result).toContain("Finished after the source was stopped");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied")).toBe(true);
  // ...but nothing resumes the conversation the person stopped.
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
}), 60_000);

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
  expect(resumed.prompt.message.content).toContain("Result withheld");
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

it("runs the owed direct follow-up while the same bot works in another thread", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "hold-gate");
  f.plan[f.chief.id] = { turns: [
    { steps: [
      { tool: "coordinate_bots", arguments: { bot_ids: [f.specialist.id], request_key: "check", message: "Independently verify the CSV export" } },
      { tool: "start_thread", arguments: { title: "Independent hold", message: "Run the long independent check." } },
    ], reply: "Assigned the check and opened the hold" },
    { gateFile: gate, reply: "The follow-up ran while the hold worked" },
    // The hold's completion and the resume's plan read race: the resume
    // lands on slot 1 while the hold still waits, or slot 2 once the hold
    // has finished. Both must settle the same reply in this conversation.
    { reply: "The follow-up ran while the hold worked" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Assign the check, then open an independent job that runs long.");
  const chiefTasks = async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id).tasks;
  // The self-opened job stays mid-turn at its gate: the whole-bot busy flag
  // is held up by a thread that has nothing to do with this coordination.
  await expect.poll(async () => (await chiefTasks()).find((task: any) => task.title === "Independent hold")?.busy, { timeout: 20_000 }).toBe(true);
  // The owed follow-up belongs to this conversation alone: it must dispatch
  // even while the bot stays busy in its sibling thread.
  const root = () => f.nodes().find((node: any) => node.key === "root");
  await expect.poll(() => root()?.status, { timeout: 10_000 }).toBe("running");
  writeFileSync(gate, "");
  await expect.poll(() => root()?.status, { timeout: 10_000 }).toBe("completed");
  const tasks = await chiefTasks();
  expect(tasks.find((task: any) => task.threadId === f.chief.activeTaskId).busy).toBe(false);
  await expect.poll(async () => (await chiefTasks()).find((task: any) => task.title === "Independent hold")?.busy, { timeout: 10_000 }).toBe(false);
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

it("gives a teammate whose session is rebuilt its second request once, never also as a bare assistant line", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "round result" };
  for (const key of ["first", "second"]) {
    f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: key, message: `REQUEST_${key.toUpperCase()} please do it` } }], reply: "Assigned", resumeReply: "Done" };
    f.save();
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", `Delegate the ${key} request.`);
    expect((await f.wait()).status).toBe("settled");
  }
  const second = String(f.evidence().filter((turn: any) => turn.botId === f.lead.id).at(-1).prompt.message.content);
  expect(second.split("REQUEST_SECOND").length - 1).toBe(1);
  expect(second).toContain("could not be resumed");
  expect(second).not.toMatch(/^Assistant: @/m);
}, { FAKE_CLAUDE_MODE: "dead-session" }), 60_000);
