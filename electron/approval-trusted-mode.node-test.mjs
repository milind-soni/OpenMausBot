import assert from "node:assert/strict";
import { test } from "node:test";

import approvalModule from "./approval-trusted-mode.cjs";

const {
  createTrustedApprovalModeCoordinator,
  decodeTrustedApprovalModeResult,
  trustedApprovalModeActivation,
  trustedApprovalModeCommit,
  trustedApprovalModeConfirmation,
  trustedApprovalModeFinalization,
  trustedApprovalModeRequest,
} = approvalModule;
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID_2 = "123e4567-e89b-42d3-a456-426614174001";

test("scoped composer grants wait for the real commit and keep the bot default", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID });
  let settled = false;
  const pending = coordinator.request(proc, "bot-1", "full", { threadId: "thread-1", threadOnly: true }).then(bot => { settled = true; return bot; });
  const before = { id: "bot-1", approvalMode: "ask", tasks: [{ threadId: "thread-1", approvalMode: "ask" }] };
  coordinator.receive(proc, { type: "approval-trusted-mode-result", requestId: REQUEST_ID, ok: true, bot: before });
  for (const phase of ["confirm", "activate", "finalize"]) coordinator.receive(proc, { type: `approval-trusted-mode-${phase}-result`, requestId: REQUEST_ID, ok: true });
  await Promise.resolve(); assert.equal(settled, false);
  const after = { ...before, tasks: [{ threadId: "thread-1", approvalMode: "full" }] };
  coordinator.receive(proc, { type: "approval-trusted-mode-commit-result", requestId: REQUEST_ID, ok: true, bot: after });
  assert.deepEqual(await pending, after);
});

test("an uncertain scoped commit compensates only its own thread", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: idSequence(REQUEST_ID, REQUEST_ID_2) });
  const pending = coordinator.request(proc, "bot-1", "full", { threadId: "thread-1", threadOnly: true });
  const before = { id: "bot-1", approvalMode: "custom", tasks: [{ threadId: "thread-1", approvalMode: "ask" }] };
  coordinator.receive(proc, { type: "approval-trusted-mode-result", requestId: REQUEST_ID, ok: true, bot: before });
  for (const phase of ["confirm", "activate", "finalize"]) coordinator.receive(proc, { type: `approval-trusted-mode-${phase}-result`, requestId: REQUEST_ID, ok: true });
  coordinator.receive(proc, { type: "approval-trusted-mode-commit-result", requestId: REQUEST_ID, ok: false });
  assert.deepEqual(proc.messages.at(-1), { type: "approval-trusted-mode-set", requestId: REQUEST_ID_2, botId: "bot-1", mode: "ask", threadId: "thread-1", threadOnly: true });
  coordinator.receive(proc, { type: "approval-trusted-mode-result", requestId: REQUEST_ID_2, ok: true, bot: before });
  await assert.rejects(pending, /not committed/);
});

test("thread-only options reject missing or mixed scopes", () => {
  for (const mode of ["ask", "edits", "auto", "full", "custom"]) assert.equal(trustedApprovalModeRequest(REQUEST_ID, "bot-1", mode, false, "thread-1", undefined, undefined, true).threadOnly, true);
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "full", false, undefined, undefined, undefined, true), /thread-only/);
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "full", false, "thread-1", undefined, true, true), /thread-only/);
});

function idSequence(...ids) {
  let index = 0;
  return () => ids[index++] ?? (() => { throw new Error("test request id sequence exhausted"); })();
}

function fakeProcess() {
  const messages = [];
  return { messages, postMessage: (message) => messages.push(message) };
}

test("confirmed model switches use only scoped Ask requests", () => {
  const selection = { instanceId: "claude", model: "sonnet" };
  assert.deepEqual(trustedApprovalModeRequest(REQUEST_ID, "bot-1", "ask", false, "thread-1", selection, false), {
    type: "approval-trusted-mode-set", requestId: REQUEST_ID, botId: "bot-1", mode: "ask",
    threadId: "thread-1", modelSelection: selection, updateBotDefault: false,
  });
  for (const mode of ["full", "custom", "auto"]) {
    assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", mode, false, "thread-1", selection, true), /invalid confirmed model switch/);
  }
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "ask", false, undefined, selection, true), /invalid confirmed model switch/);
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "ask", false, "thread-1", selection, "yes"), /invalid confirmed model switch/);
});

test("a thread-only switch verifies the thread mode without changing the bot default", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID });
  const pending = coordinator.request(proc, "bot-1", "ask", {
    threadId: "thread-1", modelSelection: { instanceId: "claude", model: "sonnet" }, updateBotDefault: false,
  });
  const bot = { id: "bot-1", approvalMode: "custom", tasks: [{ threadId: "thread-1", approvalMode: "ask" }] };
  coordinator.receive(proc, { type: "approval-trusted-mode-result", requestId: REQUEST_ID, ok: true, bot });
  assert.deepEqual(await pending, bot);
  assert.equal(proc.messages.length, 1);
});

test("builds only bounded bot-scoped approval-mode requests", () => {
  assert.equal(trustedApprovalModeRequest(REQUEST_ID, "bot-1", "full", false, "thread-1").threadId, "thread-1");
  for (const threadId of ["", "../another-thread", null, 42]) {
    assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "full", false, threadId), /invalid thread/);
  }
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "ask", false, "thread-1"), /invalid thread/);
  assert.deepEqual(trustedApprovalModeRequest(REQUEST_ID, "bot-1", "full"), {
    type: "approval-trusted-mode-set",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "full",
  });
  assert.equal(trustedApprovalModeRequest(REQUEST_ID, "bot-1", "custom").mode, "custom");
  assert.equal(trustedApprovalModeRequest(REQUEST_ID, "bot-1", "ask").mode, "ask");
  assert.deepEqual(trustedApprovalModeRequest(REQUEST_ID, "bot-1", "auto", true), {
    type: "approval-trusted-mode-set",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "auto",
    acknowledgeLocalAuto: true,
  });
  assert.throws(() => trustedApprovalModeRequest("request-1", "bot-1", "full"), /request id/);
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "../another-bot", "full"), /bot id/);
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "unsafe"), /approval mode/);
  assert.throws(() => trustedApprovalModeRequest(REQUEST_ID, "bot-1", "auto", "yes"), /acknowledgement/);
  assert.deepEqual(trustedApprovalModeConfirmation(REQUEST_ID, "bot-1", "full"), {
    type: "approval-trusted-mode-confirm",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "full",
  });
  assert.deepEqual(trustedApprovalModeActivation(REQUEST_ID, "bot-1", "custom"), {
    type: "approval-trusted-mode-activate",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "custom",
  });
  assert.deepEqual(trustedApprovalModeFinalization(REQUEST_ID, "bot-1", "full"), {
    type: "approval-trusted-mode-finalize",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "full",
  });
  assert.deepEqual(trustedApprovalModeCommit(REQUEST_ID, "bot-1", "full"), {
    type: "approval-trusted-mode-commit",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "full",
  });
  assert.throws(() => trustedApprovalModeConfirmation(REQUEST_ID, "bot-1", "ask"), /elevated/);
});

test("validates successful and failed trusted approval-mode results", () => {
  const bot = { id: "bot-1", approvalMode: "custom", name: "Operator" };
  assert.deepEqual(decodeTrustedApprovalModeResult({
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: true,
    bot,
  }), { requestId: REQUEST_ID, ok: true, bot });
  assert.deepEqual(decodeTrustedApprovalModeResult({
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: false,
    error: "Bot not found",
  }), { requestId: REQUEST_ID, ok: false, error: "Bot not found" });
  assert.throws(() => decodeTrustedApprovalModeResult({
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: true,
    bot: { id: "bot-1", approvalMode: "unsafe" },
  }), /invalid bot/);
});

test("carries the local Auto warning acknowledgement through the private channel", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID, timeoutMs: 100 });
  const pending = coordinator.request(proc, "bot-1", "auto", { acknowledgeLocalAuto: true });
  assert.deepEqual(proc.messages[0], {
    type: "approval-trusted-mode-set",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "auto",
    acknowledgeLocalAuto: true,
  });
  coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: true,
    bot: { id: "bot-1", approvalMode: "auto" },
  });
  assert.equal((await pending).approvalMode, "auto");
});

test("sends through one utility process and returns the matching server bot", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID, timeoutMs: 100 });
  const pending = coordinator.request(proc, "bot-1", "custom");
  assert.deepEqual(proc.messages, [{
    type: "approval-trusted-mode-set",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "custom",
  }]);

  const bot = { id: "bot-1", approvalMode: "custom", name: "Operator" };
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: true,
    bot,
  }), true);
  assert.deepEqual(proc.messages[1], {
    type: "approval-trusted-mode-confirm",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "custom",
  });
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-confirm-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.deepEqual(proc.messages[2], {
    type: "approval-trusted-mode-activate",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "custom",
  });
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-activate-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.deepEqual(proc.messages[3], {
    type: "approval-trusted-mode-finalize",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "custom",
  });
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-finalize-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.deepEqual(proc.messages[4], {
    type: "approval-trusted-mode-commit",
    requestId: REQUEST_ID,
    botId: "bot-1",
    mode: "custom",
  });
  assert.deepEqual(await pending, bot);
});

test("rejects a response for another trusted mode", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({
    randomId: idSequence(REQUEST_ID, REQUEST_ID_2),
    timeoutMs: 100,
  });
  const pending = coordinator.request(proc, "bot-1", "custom");
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: true,
    bot: { id: "bot-1", approvalMode: "full" },
  }), true);
  assert.equal(proc.messages[1].mode, "ask");
  coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID_2,
    ok: true,
    bot: { id: "bot-1", approvalMode: "ask" },
  });
  await assert.rejects(pending, /did not match/);
});

test("revokes an elevated grant before rejecting a malformed matching reply", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({
    randomId: idSequence(REQUEST_ID, REQUEST_ID_2),
    timeoutMs: 100,
  });
  const pending = coordinator.request(proc, "bot-1", "full");
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: "yes",
  }), true);
  assert.deepEqual(proc.messages[1], {
    type: "approval-trusted-mode-set",
    requestId: REQUEST_ID_2,
    botId: "bot-1",
    mode: "ask",
  });
  coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID_2,
    ok: true,
    bot: { id: "bot-1", approvalMode: "ask" },
  });
  await assert.rejects(pending, /invalid trusted approval-mode result status/);
});

test("another utility process cannot resolve a pending request", async () => {
  const proc = fakeProcess();
  const replacement = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID, timeoutMs: 100 });
  const pending = coordinator.request(proc, "bot-1", "full");
  const result = {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: true,
    bot: { id: "bot-1", approvalMode: "full" },
  };
  assert.equal(coordinator.receive(replacement, result), true);
  assert.equal(coordinator.receive(proc, result), true);
  assert.equal(coordinator.receive(replacement, {
    type: "approval-trusted-mode-confirm-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-confirm-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.equal(coordinator.receive(replacement, {
    type: "approval-trusted-mode-activate-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-activate-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.equal(coordinator.receive(replacement, {
    type: "approval-trusted-mode-finalize-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.equal(coordinator.receive(proc, {
    type: "approval-trusted-mode-finalize-result",
    requestId: REQUEST_ID,
    ok: true,
  }), true);
  assert.equal(proc.messages[4].type, "approval-trusted-mode-commit");
  assert.equal((await pending).approvalMode, "full");
});

test("does not resolve an elevated selection when server confirmation is refused", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID, timeoutMs: 100 });
  const pending = coordinator.request(proc, "bot-1", "full");
  coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID,
    ok: true,
    bot: { id: "bot-1", approvalMode: "full" },
  });
  coordinator.receive(proc, {
    type: "approval-trusted-mode-confirm-result",
    requestId: REQUEST_ID,
    ok: false,
    error: "The bot changed providers",
  });
  await assert.rejects(pending, /changed providers/);
  assert.equal(proc.messages.some((message) => message.type === "approval-trusted-mode-activate"), false);
});

test("rejects pending grants immediately when their utility process exits", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID, timeoutMs: 100 });
  const pending = coordinator.request(proc, "bot-1", "full");
  coordinator.rejectProcess(proc, "server exited");
  await assert.rejects(pending, /server exited/);
  assert.equal(proc.messages.length, 1);
});

test("times out only after an ambiguous elevated grant is revoked", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({
    randomId: idSequence(REQUEST_ID, REQUEST_ID_2),
    timeoutMs: 100,
  });
  const pending = coordinator.request(proc, "bot-1", "custom");
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(proc.messages[1].mode, "ask");
  coordinator.receive(proc, {
    type: "approval-trusted-mode-result",
    requestId: REQUEST_ID_2,
    ok: true,
    bot: { id: "bot-1", approvalMode: "ask" },
  });
  await assert.rejects(pending, /did not answer/);
});

test("safe Ask timeouts do not enqueue a redundant recovery", async () => {
  const proc = fakeProcess();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => REQUEST_ID, timeoutMs: 5 });
  await assert.rejects(coordinator.request(proc, "bot-1", "ask"), /did not answer/);
  assert.equal(proc.messages.length, 1);
});
