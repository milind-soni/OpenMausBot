import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { hostTimeout } from "./testing/host-timeout.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";
import { count, fixture, warmUp, leadRunning, cursor, sourceWaiting } from "./testing/delta-context-fixture.ts";

it("gives a replacement session the full assignment when a result returns after its resume was rejected", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "REPLACED_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], `BRIEF_START ${"b".repeat(800)} BRIEF_END`), { reply: "4" }, { reply: "Reviewed" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  const original = cursor(f);
  await f.setMode("resume=dead-session");
  await f.send("Meanwhile, what is 2+2?");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "4"), { timeout: 10_000 }).toBe(true);
  await f.setMode();
  await expect.poll(() => cursor(f), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => cursor(f), { timeout: 15_000 }).not.toBe(original);
  const replacement = cursor(f);
  f.open(f.gate("lead"));
  await f.wait();

  const recovery = f.prompt(f.turns()[2]);
  const returned = f.prompt(f.turns().at(-1));
  expect(recovery).toContain("could not be resumed");
  expect(replacement).not.toBe(original);
  expect(f.launches().at(-1).resume).toBe(replacement);
  expect(count(recovery + returned, "REPLACED_RESULT")).toBe(1);
  const lead = f.nodes().find((node: any) => node.botId === f.lead.id);
  expect(returned).toContain(`[From @${f.lead.name} (bot) · report on assignment ${lead.id}: done · information only]`);
}), hostTimeout(90_000));

it("gives a replacement session an earlier round's result that its rebuild could not replay, and credits it only with that rebuild", () => fixture(async (f) => {
  await warmUp(f, "Warm up.");
  const chat = 21;
  f.plan[f.lead.id] = { turns: [{ reply: "ROUND_ONE_RESULT_TOKEN" }, { reply: "ROUND_TWO_RESULT", gateFile: f.gate("r2") }] };
  f.plan[f.chief.id] = { turns: [
    {},
    f.delegate("r1", [f.lead], "REQUEST_ONE build it"),
    { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "r2", message: "REQUEST_TWO also test it", rework: true } }], reply: "Round two sent" },
    ...Array.from({ length: chat }, (_, i) => ({ reply: `chat reply ${i}` })),
    { reply: "recovered reply" },
    { reply: "Final" },
  ] };
  await f.send("Please have Engineering build and then test it.");
  await expect.poll(() => f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.status).join(","), { timeout: 30_000 }).toBe("completed,running");
  await expect.poll(() => f.turns().length, { timeout: 10_000 }).toBe(3);
  await expect.poll(() => count(f.prompt(f.turns()[2]), "ROUND_ONE_RESULT_TOKEN"), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => f.consumed(f.lead.id), { timeout: 15_000 }).toBe(2);
  for (let i = 0; i < chat; i++) {
    await sourceWaiting(f);
    expect((await f.send(`chat ${i}`)).steered).toBeUndefined();
    await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(4 + i);
    await expect.poll(async () => (await f.messages()).some((m: any) => m.text === `chat reply ${i}` && m.turnTerminal), { timeout: 10_000 }).toBe(true);
  }
  const history = async () => (await f.api(`/api/threads/${f.thread}/messages?limit=200`)).messages.map((m: any) => m.id);
  const resultMessage = (await f.api(`/api/threads/${f.thread}/messages?limit=200`)).messages.find((m: any) => m.roomRequest?.phase === "result");
  const original = cursor(f);
  await f.setMode("resume=dead-session");
  await expect.poll(async () => (await f.messages()).some((m: any) => m.text === `chat reply ${chat - 1}` && m.turnTerminal), { timeout: 10_000 }).toBe(true);
  await sourceWaiting(f);
  expect((await f.send("One more question.")).steered).toBeUndefined();
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(4 + chat);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.text === "recovered reply"), { timeout: 10_000 }).toBe(true);
  await f.setMode();
  const recovery = f.prompt(f.turns().at(-1));
  expect(recovery).toContain("could not be resumed");
  expect(count(recovery, "ROUND_ONE_RESULT_TOKEN")).toBe(0);

  const replacement = cursor(f);
  expect(replacement).not.toBe(original);
  const records = Object.values(f.handed()) as any[];
  expect(records).toHaveLength(1);
  expect(records[0].session).toBe(replacement);
  const order = await history();
  expect(records[0].ids).not.toContain(resultMessage.id);
  expect(order.indexOf(records[0].omitted)).toBeGreaterThanOrEqual(order.indexOf(resultMessage.id));

  await sourceWaiting(f);
  f.open(f.gate("r2"));
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(5 + chat);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.text === "Final" && m.turnTerminal), { timeout: 15_000 }).toBe(true);
  await f.wait();
  const returned = f.prompt(f.turns().at(-1));
  expect(count(returned, "ROUND_TWO_RESULT")).toBe(1);
  expect(count(returned, "ROUND_ONE_RESULT_TOKEN")).toBe(1);
  expect(returned).not.toContain("already delivered");
}), hostTimeout(240_000));

it("does not send a message again that a recovery replay carried, including one the unseen limit had deferred", () => fixture(async (f) => {
  await warmUp(f);
  await f.setMode("exit-early");
  const marks = Array.from({ length: 13 }, (_, i) => `DEFERRED_${String(i).padStart(2, "0")}_MARK`);
  for (const [i, mark] of marks.entries()) {
    expect((await f.send(`${mark} please note this`)).steered).toBeUndefined();
    await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(3 + 2 * i);
    await f.idle();
  }
  await f.setMode("resume=dead-session");
  f.plan[f.chief.id] = { reply: "Rebuilt" };
  await f.send("Recover now.");
  await f.wait();
  await f.setMode();
  const recovery = f.prompt(f.turns().at(-1));
  expect(recovery).toContain("could not be resumed");
  for (const mark of marks) expect(count(recovery, mark), mark).toBe(1);

  f.plan[f.chief.id] = { reply: "Nothing to repeat" };
  await f.send("Anything left?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(f.launches().at(-1).resume).toBe(cursor(f));
  for (const mark of marks) expect(count(next, mark), mark).toBe(0);
  expect(next).not.toContain("not seen yet");
}), hostTimeout(120_000));

it("replays again when a replacement session fails before the provider acts on it", () => fixture(async (f) => {
  await warmUp(f);
  await f.setMode("resume=dead-session,fresh=api-error");
  await f.send("REPLACEMENT_FAILS please answer this");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(3);
  await f.idle();
  await f.setMode();
  f.plan[f.chief.id] = { reply: "Answered" };
  await f.send("Try again.");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(f.launches().at(-1).resume).toBeNull();
  expect(next).toContain("ORCHID_7Q");
  expect(count(next, "REPLACEMENT_FAILS")).toBe(1);
}), hostTimeout(60_000));

it("gives an engine switched in while a teammate works the full assignment when the result returns", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "SWITCH_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], `ASSIGNMENT_START ${"a".repeat(400)} MUST_KEEP_CONSTRAINT`), { reply: "On Codex now" }, { reply: "Reviewed on Codex" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  const model = (await f.cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.thread}`, { modelSelection: { instanceId: "codex", model }, requireAvailableModel: true }, "PATCH");
  await f.send("Switching engines while Engineering works.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "On Codex now"), { timeout: 10_000 }).toBe(true);
  f.open(f.gate("lead"));
  await f.wait();
  const returned = f.turns().at(-1);
  expect(returned.resumedThread).toBeTruthy();
  expect(count(f.prompt(returned), "SWITCH_RESULT")).toBe(1);
  const lead = f.nodes().find((node: any) => node.botId === f.lead.id);
  expect(f.prompt(returned)).toContain(`[From @${f.lead.name} (bot) · report on assignment ${lead.id}: done · information only]`);
}, { codex: {} }), hostTimeout(90_000));

it("does not offer a message or steer the person stopped before any reply again", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { readyFile: f.gate("slow-ready"), reply: "never shown", gateFile: f.gate("slow") }, { reply: "Listed" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("STOPPED_ASK please drop the staging database");
  await expect.poll(() => existsSync(f.gate("slow-ready")), { timeout: 15_000 }).toBe(true);
  expect((await f.send("STOPPED_STEER and the backups")).steered).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.idle();
  f.open(f.gate("slow"));
  await f.send("Actually, just list the tables.");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(next).not.toContain("STOPPED_ASK");
  expect(next).not.toContain("STOPPED_STEER");
}), hostTimeout(60_000));

it("does not offer a message the person stopped before any reply again on Codex", () => fixture(async (f) => {
  await f.useModel("codex");
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { reply: "never shown", gateFile: f.gate("slow") }, { reply: "Listed" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("CODEX_STOPPED_ASK please drop the staging database");
  await expect.poll(() => f.codexCalls().filter((call: any) => call.method === "turn/start").length, { timeout: 15_000 }).toBe(2);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.idle();
  f.open(f.gate("slow"));
  await f.send("Actually, just list the tables.");
  await f.wait();
  const next = f.turns().at(-1);
  expect(next.resumedThread).toBeTruthy();
  expect(f.prompt(next)).not.toContain("CODEX_STOPPED_ASK");
}, { codex: {} }), hostTimeout(90_000));

it("offers a steered message again when the turn fails before the provider used it", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { progress: "Looking into it", gateFile: f.gate("turn"), fail: true }, { reply: "Covered" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("Start on the report.");
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Looking into it"), { timeout: 15_000 }).toBe(true);
  expect((await f.send("UNUSED_STEER also cover costs")).steered).toBe(true);
  f.open(f.gate("turn"));
  await f.idle();
  await f.send("Is it done?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(count(next, "UNUSED_STEER")).toBe(1);
  expect(next).not.toContain("Start on the report.");
}), hostTimeout(60_000));

it("does not offer a steered message again after the person stops the turn it went into", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { progress: "Looking into it", reply: "never shown", gateFile: f.gate("turn") }, { reply: "Covered" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("Start on the report.");
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Looking into it"), { timeout: 15_000 }).toBe(true);
  expect((await f.send("STOPPED_TURN_STEER also cover costs")).steered).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.idle();
  f.open(f.gate("turn"));
  await f.send("Is it done?");
  await f.wait();
  expect(f.prompt(f.turns().at(-1))).not.toContain("STOPPED_TURN_STEER");
}), hostTimeout(60_000));

it("does not offer a message again that the person steered out of the queue into a turn they then stopped", () => {
  const refuseLiveSteers = join(tmpdir(), `omb-queue-steer-${process.pid}-${Date.now()}.gate`);
  writeFileSync(refuseLiveSteers, "refuse live steers until the queue is lifted");
  return fixture(async (f) => {
    await f.useModel("codex");
    f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { readyFile: f.gate("slow-ready"), reply: "never shown", gateFile: f.gate("slow") }, { reply: "Listed" }] };
    await f.send("Warm up.");
    await f.wait();
    await f.send("Start on the report.");
    await expect.poll(() => existsSync(f.gate("slow-ready")), { timeout: 15_000 }).toBe(true);
    // The engine refuses the live steer, so the words wait in the queue.
    const queued = await f.send("QUEUED_STEER also cover costs");
    expect(queued.queued).toBe(true);
    rmSync(refuseLiveSteers, { force: true });
    // A refused steer restores the queue untouched, so ask again until the engine is far enough into the turn.
    await expect.poll(async () =>
      (await f.api(`/api/bots/${f.chief.id}/queue/${queued.queueId}/steer`, { threadId: f.thread })).steered,
    { timeout: 20_000 }).toBe(true);
    await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
    await f.idle();
    f.open(f.gate("slow"));
    await f.send("Is it done?");
    await f.wait();
    expect(f.prompt(f.turns().at(-1))).not.toContain("QUEUED_STEER");
  }, { codex: { FAKE_CODEX_STEER_ERROR_FILE: refuseLiveSteers } });
}, hostTimeout(90_000));

it("offers the results again when the provider reports an API error instead of answering", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "API_ERROR_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Here is what Engineering found" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  await f.setMode("api-error");
  f.open(f.gate("lead"));
  await expect.poll(() => f.root()?.status, { timeout: 20_000 }).toBe("failed");
  await f.idle();
  await f.setMode();
  await f.send("What did Engineering find?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "API_ERROR_RESULT")).toBe(1);
}), hostTimeout(60_000));

it("does not hand the model a queued follow-up that a restart recovered with an unknown outcome", () => fixture(async (f) => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PATCH");
  const other = (await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Second conversation" })).task.threadId;
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { readyFile: f.gate("hold-ready"), reply: "Held", gateFile: f.gate("hold") }, { reply: "never", gateFile: f.gate("never") }] };
  await f.send("Warm up.", other);
  await f.wait(other);
  await f.send("Hold the only slot.");
  await expect.poll(() => existsSync(f.gate("hold-ready")), { timeout: 15_000 }).toBe(true);
  expect((await f.send("RECOVERED_FOLLOWUP deploy it", other)).queued).toBe(true);
  f.open(f.gate("hold"));
  await expect.poll(() => f.consumed(), { timeout: 15_000 }).toBe(3);
  const interruptedPid = f.launches().at(-1).pid;
  await f.restart(() => {}, "SIGKILL");
  await expect.poll(() => {
    try { process.kill(interruptedPid, 0); return true; } catch { return false; }
  }, { timeout: 5_000 }).toBe(false);
  await expect.poll(async () => (await f.messages(other)).some((m: any) => m.kind === "activity" && m.tool?.name?.includes("Review the result")), { timeout: 20_000 }).toBe(true);
  expect((await f.messages(other)).filter((m: any) => m.role === "user" && m.text?.includes("RECOVERED_FOLLOWUP"))).toHaveLength(1);

  // The crashed turn never completes its evidence record, so the next reply is named explicitly.
  f.plan[f.chief.id] = { reply: "Answered" };
  await f.send("Anything new?", other);
  await f.wait(other);
  const next = f.turns().filter((turn: any) => f.prompt(turn).includes("Anything new?")).at(-1);
  expect(next).toBeDefined();
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(f.prompt(next)).not.toContain("RECOVERED_FOLLOWUP");
}), hostTimeout(90_000));

it("gives a delegated return the fresh session and replay it always had when the bot's soul changed while teammates worked", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "SOUL_CHANGE_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed in German" }, { reply: "Still German" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}`, { soul: "NEW_SOUL_MARK Always answer in German." }, "PATCH");
  f.open(f.gate("lead"));
  await f.wait();

  const returned = f.turns().at(-1);
  expect(f.launches().at(-1).resume).toBeNull();
  const replacement = f.nativeSession();
  expect(returned.system).toContain("NEW_SOUL_MARK");
  expect(f.prompt(returned)).toContain("received an update outside your provider session");
  expect(f.prompt(returned)).toContain("ORCHID_7Q");
  expect(count(f.prompt(returned), "SOUL_CHANGE_RESULT")).toBe(1);

  await f.send("And now?");
  await f.wait();
  expect(f.nativeSession()).toBe(replacement);
  expect(count(f.prompt(f.turns().at(-1)), "SOUL_CHANGE_RESULT")).toBe(0);
}), hostTimeout(90_000));

it("keeps resuming an ordinary turn after a soul change, as before", () => fixture(async (f) => {
  await warmUp(f);
  await f.api(`/api/bots/${f.chief.id}`, { soul: "NEW_SOUL_MARK Always answer in German." }, "PATCH");
  f.plan[f.chief.id] = { reply: "Noted again." };
  await f.send("Second message.");
  await f.wait();
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(withoutTurnClock(f.prompt(f.turns().at(-1)))).toBe("Second message.");
}), hostTimeout(60_000));

it("offers a steer written into a resume the provider then rejected on the next turn", () => fixture(async (f) => {
  await warmUp(f);
  await f.setMode("resume=dead-session,holdresume=1");
  f.plan[f.chief.id] = { reply: "Four." };
  await f.send("QUESTION_ONE what is 2+2?");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(2);
  expect((await f.send("LOST_STEER_MARK and also mention the backups")).steered).toBe(true);
  f.open(f.gate("resume-hold"));
  await f.wait();
  await f.setMode();
  expect(count(f.prompt(f.turns().at(-1)), "LOST_STEER_MARK")).toBe(0);

  f.plan[f.chief.id] = { reply: "Nothing else." };
  await f.send("NEXT_Q anything else?");
  await f.wait();
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(count(f.prompt(f.turns().at(-1)), "LOST_STEER_MARK")).toBe(1);
}), hostTimeout(90_000));

it("offers a steered message again when only output of the model call already running follows it before the turn fails", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [
    { reply: "Noted." },
    { progress: "Looking into it", gateFile: f.gate("turn"), progressAfterGate: "Still answering the first question", fail: true },
    { reply: "Covered" },
  ] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("Start on the report.");
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Looking into it"), { timeout: 15_000 }).toBe(true);
  expect((await f.send("BUFFERED_STEER also cover costs")).steered).toBe(true);
  f.open(f.gate("turn"));
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Still answering the first question"), { timeout: 15_000 }).toBe(true);
  await f.idle();
  await f.send("Is it done?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "BUFFERED_STEER")).toBe(1);
}), hostTimeout(60_000));

it("rebuilds a delegated return whose Codex thread is gone into a new thread with today's replay", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "MISSING_THREAD_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Rebuilt on Codex" }, { reply: "Still on Codex" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  // The personal (unmanaged) Codex app-server no longer has the thread.
  await f.setMode("happy", "codex");
  f.open(f.gate("lead"));
  await f.wait();
  await f.setMode(undefined, "codex");

  expect(f.root().status).toBe("completed");
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(returned).toContain("ORCHID_7Q");
  expect(count(returned, "MISSING_THREAD_RESULT")).toBe(1);

  await f.send("And now?");
  await f.wait();
  const next = f.turns().at(-1);
  expect(next.resumedThread).toBeTruthy();
  expect(count(f.prompt(next), "MISSING_THREAD_RESULT")).toBe(0);
}, { codex: {} }), hostTimeout(90_000));

it("replays a result that reaches an engine switched in before it arrived with today's update preamble", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "EARLY_SWITCH_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed on Codex" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  const model = (await f.cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.thread}`, { modelSelection: { instanceId: "codex", model }, requireAvailableModel: true }, "PATCH");
  f.open(f.gate("lead"));
  await f.wait();
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(returned).not.toContain("switched this bot over to you");
  expect(returned).toContain("ORCHID_7Q");
  expect(count(returned, "EARLY_SWITCH_RESULT")).toBe(1);
}, { codex: {} }), hostTimeout(90_000));

// A `git` on PATH that holds its first command while `hold` exists, so a turn's checkpoint waits inside turn setup.
const holdingGit = (dataDir: string, hold: string, held: string) => {
  const real = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path));
  if (!real) throw new Error("this test needs git on PATH");
  const bin = join(dataDir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), [
    "#!/usr/bin/env node",
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    "const args = process.argv.slice(2);",
    `if (args[0] !== "--version" && existsSync(${JSON.stringify(hold)})) {`,
    `  writeFileSync(${JSON.stringify(held)}, "held");`,
    `  while (existsSync(${JSON.stringify(hold)})) await new Promise((r) => setTimeout(r, 20));`,
    "}",
    `process.exit(spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" }).status ?? 1);`,
  ].join("\n"), { mode: 0o700 });
  return bin;
};

// POSIX only: the holding `git` is a node shebang script, and on Windows git is git.exe and a shebang file is not executable.
it.skipIf(process.platform === "win32")("gives a delegated return today's fresh session and replay when the soul changes while that turn is being set up", () => fixture(async (f) => {
  const project = join(f.dataDir, "project");
  mkdirSync(project);
  await f.api(`/api/bots/${f.chief.id}`, { cwd: project }, "PATCH");
  const hold = join(f.dataDir, "git.hold");
  const held = join(f.dataDir, "git.held");
  await f.restart(() => {}, "SIGTERM", { PATH: [holdingGit(f.dataDir, hold, held), dirname(process.execPath)].join(delimiter) });
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "SETUP_SOUL_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  writeFileSync(hold, "hold");
  f.open(f.gate("lead"));
  await expect.poll(() => existsSync(held), { timeout: 20_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}`, { soul: "SETUP_SOUL_MARK Always answer in German." }, "PATCH");
  rmSync(hold);
  await f.wait();

  const returned = f.turns().at(-1);
  expect(returned.system).toContain("SETUP_SOUL_MARK");
  expect(f.launches().at(-1).resume).toBeNull();
  expect(f.prompt(returned)).toContain("received an update outside your provider session");
  expect(count(f.prompt(returned), "SETUP_SOUL_RESULT")).toBe(1);
  const record = Object.values(f.handed())[0] as any;
  expect(record.session).toBe(Object.values(f.task().resumeCursors)[0]);
  expect(record.omitted).toBeUndefined();
  expect(record.through).toBeTruthy();

  f.plan[f.chief.id] = { reply: "Nothing new" };
  await f.send("And now?");
  await f.wait();
  expect(f.nativeSession()).toBe(Object.values(f.task().resumeCursors)[0]);
  expect(count(f.prompt(f.turns().at(-1)), "SETUP_SOUL_RESULT")).toBe(0);
}), hostTimeout(90_000));

it("gives a Codex return the model chosen while its teammate worked", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "CODEX_MODEL_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed on the new model" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  await sourceWaiting(f);
  // Codex applies a model only when a thread starts: thread/resume would keep the old one.
  const [, other] = await f.codexModels();
  await f.selectModel(other);
  f.open(f.gate("lead"));
  await f.wait();

  const started = f.codexCalls().filter((call: any) => call.method === "thread/start");
  expect(started).toHaveLength(1);
  expect(started[0].params.model).toBe(other);
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(count(returned, "CODEX_MODEL_RESULT")).toBe(1);
}, { codex: {} }), hostTimeout(90_000));

it("gives a Codex return today's fresh thread when explicit effort is cleared while its teammate worked", () => fixture(async (f) => {
  await f.useModel("codex");
  const [model] = await f.codexModels();
  await f.selectModel(model, { effort: "high" });
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "CODEX_EFFORT_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed on default effort" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  await sourceWaiting(f);
  // An effort the driver does not send leaves the native thread's last value.
  await f.selectModel(model);
  f.open(f.gate("lead"));
  await f.wait();

  expect(f.codexCalls().filter((call: any) => call.method === "thread/start")).toHaveLength(1);
  expect(f.codexCalls().find((call: any) => call.method === "turn/start")?.params.effort).toBeUndefined();
  expect(count(f.prompt(f.turns().at(-1)), "CODEX_EFFORT_RESULT")).toBe(1);
}, { codex: {} }), hostTimeout(90_000));

it("moves a Codex chat to a new thread with its history when the person clears an effort its thread holds", () => fixture(async (f) => {
  await f.useModel("codex");
  const [model] = await f.codexModels();
  await f.selectModel(model);
  await warmUp(f);
  await f.selectModel(model, { effort: "high" });
  f.plan[f.chief.id] = { reply: "On high effort" };
  await f.send("Think harder about this one.");
  await f.wait();
  expect(f.codexCalls().filter((call: any) => call.method === "thread/start")).toHaveLength(1);
  expect(f.codexCalls().filter((call: any) => call.method === "turn/start").at(-1)?.params.effort).toBe("high");

  // turn/start cannot clear it: resuming would keep the thread on "high".
  await f.selectModel(model);
  f.plan[f.chief.id] = { reply: "On default effort" };
  await f.send("What is the codename?");
  await f.wait();
  expect(f.codexCalls().filter((call: any) => call.method === "thread/resume")).toHaveLength(0);
  expect(f.codexCalls().filter((call: any) => call.method === "thread/start")).toHaveLength(1);
  expect(f.codexCalls().find((call: any) => call.method === "turn/start")?.params.effort).toBeUndefined();
  expect(count(f.prompt(f.turns().at(-1)), "ORCHID_7Q")).toBe(1);

  f.plan[f.chief.id] = { reply: "Still on default effort" };
  await f.send("And now?");
  await f.wait();
  const next = f.turns().at(-1);
  expect(next.resumedThread).toBeTruthy();
  expect(f.prompt(next)).not.toContain("ORCHID_7Q");
}, { codex: {} }), hostTimeout(90_000));

it("keeps today's fresh return on a Claude CLI that cannot refresh a resumed system prompt", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "OLD_CLI_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  f.open(f.gate("lead"));
  await f.wait();

  expect(f.launches().at(-1).resume).toBeNull();
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(returned).toContain("ORCHID_7Q");
  expect(count(returned, "OLD_CLI_RESULT")).toBe(1);
  expect(f.handed()).toBeUndefined();
}, { env: { FAKE_CLAUDE_VERSION: "2.1.200" } }), hostTimeout(90_000));
