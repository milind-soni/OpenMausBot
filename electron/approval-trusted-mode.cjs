"use strict";

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVAL_MODES = new Set(["ask", "auto", "full", "custom"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function trustedApprovalModeRequest(requestId, botId, mode, acknowledgeLocalAuto = false) {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
    throw new Error("invalid trusted approval-mode request id");
  }
  if (typeof botId !== "string" || !BOT_ID.test(botId)) {
    throw new Error("invalid bot id for trusted approval mode");
  }
  if (!APPROVAL_MODES.has(mode)) throw new Error("invalid trusted approval mode");
  if (typeof acknowledgeLocalAuto !== "boolean") {
    throw new Error("invalid local Auto acknowledgement");
  }
  return {
    type: "approval-trusted-mode-set",
    requestId,
    botId,
    mode,
    ...(acknowledgeLocalAuto ? { acknowledgeLocalAuto: true } : {}),
  };
}

function trustedApprovalModeConfirmation(requestId, botId, mode) {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
    throw new Error("invalid trusted approval-mode confirmation id");
  }
  if (typeof botId !== "string" || !BOT_ID.test(botId)) {
    throw new Error("invalid bot id for trusted approval-mode confirmation");
  }
  if (mode !== "full" && mode !== "custom") {
    throw new Error("only elevated approval modes require confirmation");
  }
  return {
    type: "approval-trusted-mode-confirm",
    requestId,
    botId,
    mode,
  };
}

function trustedApprovalModeActivation(requestId, botId, mode) {
  const confirmation = trustedApprovalModeConfirmation(requestId, botId, mode);
  return { ...confirmation, type: "approval-trusted-mode-activate" };
}

function trustedApprovalModeFinalization(requestId, botId, mode) {
  const confirmation = trustedApprovalModeConfirmation(requestId, botId, mode);
  return { ...confirmation, type: "approval-trusted-mode-finalize" };
}

function trustedApprovalModeCommit(requestId, botId, mode) {
  const confirmation = trustedApprovalModeConfirmation(requestId, botId, mode);
  return { ...confirmation, type: "approval-trusted-mode-commit" };
}

function decodeTrustedApprovalModeResult(rawMessage) {
  const message = rawMessage?.data ?? rawMessage;
  if (!plainObject(message) || message.type !== "approval-trusted-mode-result") return null;
  if (typeof message.requestId !== "string" || !REQUEST_ID.test(message.requestId)) {
    throw new Error("invalid trusted approval-mode result id");
  }
  if (typeof message.ok !== "boolean") throw new Error("invalid trusted approval-mode result status");
  if (message.ok) {
    if (
      !plainObject(message.bot) ||
      typeof message.bot.id !== "string" ||
      !BOT_ID.test(message.bot.id) ||
      !APPROVAL_MODES.has(message.bot.approvalMode)
    ) {
      throw new Error("invalid bot in trusted approval-mode result");
    }
    return { requestId: message.requestId, ok: true, bot: message.bot };
  }
  if (message.error !== undefined && typeof message.error !== "string") {
    throw new Error("invalid trusted approval-mode result error");
  }
  const error = String(message.error ?? "The approval mode could not be enabled").trim();
  return {
    requestId: message.requestId,
    ok: false,
    error: (error || "The approval mode could not be enabled").slice(0, 300),
  };
}

/**
 * One-shot request/response coordinator for the private Electron -> embedded
 * server utilityProcess port. The process object is part of the correlation
 * key, so a stale or replacement child cannot answer another child's grant.
 */
function createTrustedApprovalModeCoordinator({ randomId, timeoutMs = 10_000 } = {}) {
  if (typeof randomId !== "function") throw new Error("trusted approval-mode request id generator is unavailable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("invalid trusted approval-mode request timeout");
  }
  const pending = new Map();
  const usedRequestIds = new Set();
  const latestRequestByBot = new Map();

  function nextMessage(botId, mode, acknowledgeLocalAuto = false) {
    const message = trustedApprovalModeRequest(randomId(), botId, mode, acknowledgeLocalAuto);
    if (usedRequestIds.has(message.requestId)) {
      throw new Error("Trusted approval-mode request id was reused");
    }
    usedRequestIds.add(message.requestId);
    return message;
  }

  function settle(requestId, action) {
    const request = pending.get(requestId);
    if (!request) return false;
    pending.delete(requestId);
    clearTimeout(request.timer);
    action(request);
    return true;
  }

  function request(proc, botId, mode, options = {}) {
    if (!plainObject(options)) {
      return Promise.reject(new Error("invalid trusted approval-mode options"));
    }
    let message;
    try {
      message = nextMessage(botId, mode, options.acknowledgeLocalAuto ?? false);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!proc || typeof proc.postMessage !== "function") {
      return Promise.reject(new Error("The embedded bot server is unavailable"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failAmbiguously(
          message.requestId,
          new Error("The embedded bot server did not answer the approval-mode request"),
        );
      }, timeoutMs);
      timer.unref?.();
      pending.set(message.requestId, {
        proc,
        botId: message.botId,
        mode: message.mode,
        resolve,
        reject,
        timer,
        posted: false,
        phase: "setting",
        resultBot: null,
      });
      try {
        proc.postMessage(message);
        const waiting = pending.get(message.requestId);
        if (waiting) waiting.posted = true;
        latestRequestByBot.set(message.botId, message.requestId);
      } catch (error) {
        settle(message.requestId, ({ reject: rejectPending }) => {
          rejectPending(error instanceof Error ? error : new Error(String(error)));
        });
      }
    });
  }

  /** A Full/Custom request that crossed postMessage may already be durable
   * even when its reply is lost or corrupt. Revoke it in-order on the same
   * private port before surfacing the original failure. A later explicit
   * selection wins and therefore suppresses this older compensation. */
  function failAmbiguously(requestId, error) {
    settle(requestId, (waiting) => {
      const elevated = waiting.mode === "full" || waiting.mode === "custom";
      const isLatest = latestRequestByBot.get(waiting.botId) === requestId;
      if (!waiting.posted || !elevated || !isLatest) {
        waiting.reject(error);
        return;
      }
      request(waiting.proc, waiting.botId, "ask").then(
        () => waiting.reject(error),
        (recoveryError) => waiting.reject(new Error(
          `${error instanceof Error ? error.message : String(error)}; the pending ${waiting.mode} selection could not be cleared: ${
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          }`,
        )),
      );
    });
  }

  function receive(proc, rawMessage) {
    const message = rawMessage?.data ?? rawMessage;
    if (!plainObject(message) || (
      message.type !== "approval-trusted-mode-result" &&
      message.type !== "approval-trusted-mode-confirm-result" &&
      message.type !== "approval-trusted-mode-activate-result" &&
      message.type !== "approval-trusted-mode-finalize-result"
    )) return false;

    if (message.type !== "approval-trusted-mode-result") {
      const steps = {
        "approval-trusted-mode-confirm-result": {
          phase: "confirming",
          nextPhase: "activating",
          nextMessage: trustedApprovalModeActivation,
        },
        "approval-trusted-mode-activate-result": {
          phase: "activating",
          nextPhase: "finalizing",
          nextMessage: trustedApprovalModeFinalization,
        },
        "approval-trusted-mode-finalize-result": {
          phase: "finalizing",
          nextPhase: null,
          nextMessage: null,
        },
      };
      const step = steps[message.type];
      const requestId = typeof message.requestId === "string" ? message.requestId : "";
      const waiting = pending.get(requestId);
      if (!REQUEST_ID.test(requestId) || typeof message.ok !== "boolean") {
        if (waiting?.proc === proc && waiting.phase === step.phase) {
          failAmbiguously(requestId, new Error("invalid trusted approval-mode handshake result"));
        }
        return true;
      }
      if (!waiting || waiting.proc !== proc || waiting.phase !== step.phase) return true;
      if (!message.ok) {
        const error = typeof message.error === "string" && message.error.trim()
          ? message.error.trim().slice(0, 300)
          : "The approval mode handshake was refused";
        settle(requestId, ({ reject }) => reject(new Error(error)));
        return true;
      }
      if (!step.nextMessage || !step.nextPhase) {
        // The server ACKs while a durable `committed` journal still keeps the
        // mode inert. Only after this client-visible commit point do we send
        // the exact one-way release. If the child dies before handling it,
        // startup revokes the surviving journal to Ask; a reported failure
        // can therefore never leave the bot elevated.
        try {
          proc.postMessage(trustedApprovalModeCommit(
            requestId,
            waiting.botId,
            waiting.mode,
          ));
        } catch (error) {
          failAmbiguously(requestId, error instanceof Error ? error : new Error(String(error)));
          return true;
        }
        settle(requestId, ({ resolve, resultBot }) => resolve(resultBot));
        return true;
      }
      try {
        waiting.phase = step.nextPhase;
        proc.postMessage(step.nextMessage(
          requestId,
          waiting.botId,
          waiting.mode,
        ));
      } catch (error) {
        failAmbiguously(requestId, error instanceof Error ? error : new Error(String(error)));
        return true;
      }
      return true;
    }

    let result;
    try {
      result = decodeTrustedApprovalModeResult(message);
    } catch (error) {
      const requestId = typeof message.requestId === "string" ? message.requestId : "";
      const waiting = pending.get(requestId);
      if (waiting?.proc === proc) failAmbiguously(requestId, error);
      return true;
    }

    const waiting = pending.get(result.requestId);
    // It is still our protocol even when the answer is late, duplicated, or
    // belongs to another child. Consume it, but never let it cross processes.
    if (!waiting || waiting.proc !== proc || waiting.phase !== "setting") return true;
    if (!result.ok) {
      settle(result.requestId, ({ reject }) => reject(new Error(result.error)));
      return true;
    }
    if (result.bot.id !== waiting.botId || result.bot.approvalMode !== waiting.mode) {
      failAmbiguously(result.requestId, new Error("Approval-mode result did not match the request"));
      return true;
    }
    if (waiting.mode === "full" || waiting.mode === "custom") {
      try {
        // The server keeps this selection executable as Ask while it records
        // confirmation. Do not resolve until its correlated acknowledgement
        // arrives and activation has been queued on this same ordered port.
        waiting.phase = "confirming";
        waiting.resultBot = result.bot;
        proc.postMessage(trustedApprovalModeConfirmation(
          result.requestId,
          waiting.botId,
          waiting.mode,
        ));
      } catch (error) {
        failAmbiguously(
          result.requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
        return true;
      }
      return true;
    }
    settle(result.requestId, ({ resolve }) => resolve(result.bot));
    return true;
  }

  function rejectProcess(proc, reason = "The embedded bot server stopped") {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const [requestId, request] of pending) {
      if (request.proc !== proc) continue;
      settle(requestId, ({ reject }) => reject(error));
    }
  }

  return { request, receive, rejectProcess };
}

module.exports = {
  createTrustedApprovalModeCoordinator,
  decodeTrustedApprovalModeResult,
  trustedApprovalModeActivation,
  trustedApprovalModeCommit,
  trustedApprovalModeConfirmation,
  trustedApprovalModeFinalization,
  trustedApprovalModeRequest,
};
