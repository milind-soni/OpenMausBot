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

function idSequence(...ids) {
  let index = 0;
  return () => ids[index++] ?? (() => { throw new Error("test request id sequence exhausted"); })();
}

function fakeProcess() {
  const messages = [];
  return { messages, postMessage: (message) => messages.push(message) };
}

test("builds only bounded bot-scoped approval-mode requests", () => {
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
