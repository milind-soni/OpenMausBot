// The Electron-only trusted approval state machine — extracted verbatim
// from index.ts: the parentPort handler for privileged approval-mode
// transitions (prepare → confirm → activate → finalize → commit) that the
// loopback HTTP authority model deliberately cannot reach. index.ts wires
// createDesktopApproval just before the parentPort listener that dispatches
// into it (runtime evaluation only — no module-eval by-value consumer);
// wireBot, wireTrustedApprovalBot and broadcast are consts index.ts declares
// after that wiring site and arrive as thunks.
import {
  approvalModeFor,
  isApprovalMode,
  isEmergencyApprovalDowngrade,
  supportsApprovalMode,
  type ApprovalMode,
} from "../shared/approval-mode.ts";
import type { WireBot } from "../shared/wire.ts";
import type { ModelSelection } from "./contracts.ts";
import { registry, store } from "./runtime.ts";
import { threadBusy } from "./turn-admission.ts";
import type { BotRecord } from "./store.ts";

/** The approval-shaped result frames this module posts — the subset of
 * index.ts's DesktopPrivateMessage union the moved body produces. */
type DesktopApprovalResultMessage =
  | {
      type: "approval-trusted-mode-result" | "approval-trusted-mode-commit-result";
      requestId: string;
      ok: boolean;
      bot?: WireBot;
      error?: string;
    }
  | {
      type: "approval-trusted-mode-confirm-result";
      requestId: string;
      ok: boolean;
      error?: string;
    }
  | {
      type: "approval-trusted-mode-activate-result" | "approval-trusted-mode-finalize-result";
      requestId: string;
      ok: boolean;
      error?: string;
    };

/** Everything the approval state machine reads from its host. The lateBound
 * family holds thunks for the consts index.ts declares after the factory is
 * wired; the helpers are hoisted function declarations and the
 * checkedTaskModelSwitch factory result, safe to pass by value. */
export interface DesktopApprovalDeps {
  lateBound: {
    wireBot(): (bot: BotRecord) => WireBot;
    wireTrustedApprovalBot(): (bot: BotRecord) => WireBot;
    broadcast(): (payload: Record<string, unknown>) => void;
  };
  helpers: {
    postDesktopPrivateMessage(message: DesktopApprovalResultMessage): boolean;
    checkedTaskModelSwitch(
      current: BotRecord,
      raw: unknown,
      updateBotDefault: boolean,
      resetApprovalToAsk: boolean,
      requireAvailableModel?: boolean,
      trusted?: boolean,
    ): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };
    stopBotForEmergencyApprovalDowngrade(botId: string): Promise<void>;
  };
}

export function createDesktopApproval(deps: DesktopApprovalDeps) {
  const { wireBot, wireTrustedApprovalBot, broadcast } = deps.lateBound;
  const { postDesktopPrivateMessage, checkedTaskModelSwitch, stopBotForEmergencyApprovalDowngrade } = deps.helpers;
/** Privileged approval-mode transitions are deliberately absent from the
 * loopback HTTP authority model: a bot with shell access can curl that
 * surface itself. Only Electron's private utility-process channel can deliver
 * this message. */
function handleDesktopTrustedApprovalMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  const grantTarget = (bot: BotRecord) => bot.approvalGrant?.threadOnly
    ? store.projectBotForTask(bot.id, bot.approvalGrant.threadId!) : bot;
  const grantBusy = (bot: BotRecord) => bot.approvalGrant?.threadOnly
    ? threadBusy(bot.id, bot.approvalGrant.threadId!) : bot.busy;
  const grantSupported = (bot: BotRecord, mode: ApprovalMode) => supportsApprovalMode(
    registry.cliTarget(grantTarget(bot)?.modelSelection.instanceId ?? "")?.driverKind, mode);
  const clearGrant = (bot: BotRecord) => store.patchBot(bot.id, {
    ...(!bot.approvalGrant?.threadOnly ? { approvalMode: "ask" as const, autoApprove: false } : {}),
    approvalGrant: undefined,
  });
  const threadCanReceiveGrant = (bot: BotRecord): boolean => {
    const threadId = bot.approvalGrant?.threadId;
    if (!threadId) return true;
    const target = store.projectBotForTask(bot.id, threadId);
    return Boolean(target && !threadBusy(bot.id, threadId) && (bot.approvalGrant?.threadOnly ||
      registry.cliTarget(target.modelSelection.instanceId)?.driverKind === registry.cliTarget(bot.modelSelection.instanceId)?.driverKind));
  };
  if (message.type === "approval-trusted-mode-commit") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    if (!botId || !mode) return true;
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "committed" &&
      (bot.approvalGrant.threadOnly || bot.approvalMode === mode) &&
      !grantBusy(bot) &&
      threadCanReceiveGrant(bot) &&
      grantSupported(bot, mode)
    ) {
      if (bot.approvalGrant.threadId) {
        store.patchTask(botId, bot.approvalGrant.threadId, { approvalMode: mode, autoApprove: false });
      }
      store.patchBot(botId, { approvalGrant: undefined });
      postDesktopPrivateMessage({ type: "approval-trusted-mode-commit-result", requestId, ok: true, bot: wireBot()(store.bot(botId)!) });
    } else if (bot?.approvalGrant?.requestId === requestId) {
      clearGrant(bot);
      postDesktopPrivateMessage({ type: "approval-trusted-mode-commit-result", requestId, ok: false });
    } else {
      postDesktopPrivateMessage({ type: "approval-trusted-mode-commit-result", requestId, ok: false });
    }
    return true;
  }
  if (message.type === "approval-trusted-mode-confirm") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    const confirm = (ok: boolean, error?: string) => {
      postDesktopPrivateMessage({
        type: "approval-trusted-mode-confirm-result",
        requestId,
        ok,
        ...(error ? { error } : {}),
      });
    };
    if (!botId || !mode) {
      confirm(false, "The approval confirmation was invalid");
      return true;
    }
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "prepared" &&
      (bot.approvalGrant.threadOnly || bot.approvalMode === mode)
    ) {
      if (!grantSupported(bot, mode)) {
        clearGrant(bot);
        confirm(false, "This provider does not support the selected approval level");
        return true;
      }
      store.patchBot(botId, {
        approvalGrant: { ...bot.approvalGrant, requestId, mode, phase: "confirmed" },
      });
      confirm(true);
      return true;
    }
    // A matching journal whose other fields no longer agree is ambiguous.
    // Revoke only that request; never clear a newer grant for the same bot.
    if (bot?.approvalGrant?.requestId === requestId) {
      clearGrant(bot);
    }
    confirm(false, "The approval confirmation no longer matches this bot");
    return true;
  }
  if (message.type === "approval-trusted-mode-activate") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    const activate = (ok: boolean, error?: string) => {
      postDesktopPrivateMessage({
        type: "approval-trusted-mode-activate-result",
        requestId,
        ok,
        ...(error ? { error } : {}),
      });
    };
    if (!botId || !mode) {
      activate(false, "The approval activation was invalid");
      return true;
    }
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "confirmed" &&
      (bot.approvalGrant.threadOnly || bot.approvalMode === mode)
    ) {
      if (grantBusy(bot) || !grantSupported(bot, mode)) {
        clearGrant(bot);
        activate(false, grantBusy(bot)
          ? "Stop this bot's turn before changing its approval level"
          : "This provider does not support the selected approval level");
        return true;
      }
      // Still inert: Electron must receive this acknowledgement and request
      // finalization before the durable mode can affect any turn.
      store.patchBot(botId, { approvalGrant: { ...bot.approvalGrant, requestId, mode, phase: "activated" } });
      activate(true);
      return true;
    }
    if (bot?.approvalGrant?.requestId === requestId) {
      clearGrant(bot);
    }
    activate(false, "The approval activation no longer matches this bot");
    return true;
  }
  if (message.type === "approval-trusted-mode-finalize") {
    const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
      ? message.requestId
      : null;
    const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
      ? message.botId
      : null;
    const mode = message.mode === "full" || message.mode === "custom" ? message.mode : null;
    if (!requestId) return true;
    const finalize = (ok: boolean, error?: string) => {
      postDesktopPrivateMessage({
        type: "approval-trusted-mode-finalize-result",
        requestId,
        ok,
        ...(error ? { error } : {}),
      });
    };
    if (!botId || !mode) {
      finalize(false, "The approval finalization was invalid");
      return true;
    }
    const bot = store.bot(botId);
    if (
      bot?.approvalGrant?.requestId === requestId &&
      bot.approvalGrant.mode === mode &&
      bot.approvalGrant.phase === "activated" &&
      (bot.approvalGrant.threadOnly || bot.approvalMode === mode) &&
      !grantBusy(bot) &&
      threadCanReceiveGrant(bot) &&
      grantSupported(bot, mode)
    ) {
      // Durable but still inert. Electron must observe this exact ACK before
      // sending the one-way commit release that clears the journal.
      store.patchBot(botId, { approvalGrant: { ...bot.approvalGrant, requestId, mode, phase: "committed" } });
      finalize(true);
      return true;
    }
    if (bot?.approvalGrant?.requestId === requestId) {
      clearGrant(bot);
    }
    finalize(false, bot?.busy
      ? "Stop this bot's turn before changing its approval level"
      : "The approval finalization no longer matches this bot");
    return true;
  }
  if (message.type !== "approval-trusted-mode-set") return false;
  const requestId = typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)
    ? message.requestId
    : null;
  if (!requestId) return true;
  const respond = (result: { ok: boolean; bot?: WireBot; error?: string }) => {
    postDesktopPrivateMessage({
      type: "approval-trusted-mode-result",
      requestId,
      ...result,
    });
  };
  const botId = typeof message.botId === "string" && /^[\w-]{1,128}$/.test(message.botId)
    ? message.botId
    : null;
  if (!botId) {
    respond({ ok: false, error: "The bot id is invalid" });
    return true;
  }
  const mode = isApprovalMode(message.mode) ? message.mode : null;
  if (!mode) {
    respond({ ok: false, error: "The approval mode is invalid" });
    return true;
  }
  const existing = store.bot(botId);
  if (!existing) {
    respond({ ok: false, error: "No such bot" });
    return true;
  }
  const currentMode = approvalModeFor(existing);
  const threadId = message.threadId;
  if (message.threadOnly !== undefined && typeof message.threadOnly !== "boolean") {
    respond({ ok: false, error: "Invalid thread approval scope" });
    return true;
  }
  if (message.threadOnly === true) {
    const target = typeof threadId === "string" ? store.projectBotForTask(botId, threadId) : null;
    if (!target || message.modelSelection !== undefined || message.updateBotDefault !== undefined) {
      respond({ ok: false, error: "Choose an existing thread for this approval change" });
      return true;
    }
    // An ambiguous scoped grant may be cleared, but never a different grant.
    const clearsOwnGrant = mode === "ask" && existing.approvalGrant?.threadOnly && existing.approvalGrant.threadId === threadId;
    if ((existing.approvalGrant && !clearsOwnGrant) || threadBusy(botId, target.threadId)) {
      respond({ ok: false, error: "Stop this thread and finish its pending approval change first" });
      return true;
    }
    if (!supportsApprovalMode(registry.cliTarget(target.modelSelection.instanceId)?.driverKind, mode)) {
      respond({ ok: false, error: "This thread's provider does not support that approval level" });
      return true;
    }
    if (mode === "auto" && target.computer === "local" && approvalModeFor(target) !== "auto" && message.acknowledgeLocalAuto !== true) {
      respond({ ok: false, error: "Auto mode on this computer requires confirming the warning" });
      return true;
    }
    if (mode === "full" || mode === "custom") {
      store.patchBot(botId, { approvalGrant: { requestId, mode, phase: "prepared", threadId: target.threadId, threadOnly: true } });
    } else {
      if (clearsOwnGrant) clearGrant(existing);
      store.patchTask(botId, target.threadId, { approvalMode: mode, autoApprove: mode === "auto", alwaysAllow: [] });
    }
    respond({ ok: true, bot: wireTrustedApprovalBot()(store.bot(botId)!) });
    return true;
  }
  if (message.modelSelection !== undefined) {
    const target = typeof threadId === "string" ? store.projectBotForTask(botId, threadId) : null;
    if (mode !== "ask" || !target || typeof message.updateBotDefault !== "boolean") {
      respond({ ok: false, error: "A confirmed model switch must select a thread and Ask permissions" });
      return true;
    }
    const checked = checkedTaskModelSwitch(target, message.modelSelection, message.updateBotDefault, true, false, true);
    if (!checked.ok) { respond({ ok: false, error: checked.error }); return true; }
    try {
      store.switchTaskModel(botId, threadId as string, checked.selection, message.updateBotDefault, true);
      const fresh = { ...wireBot()(store.bot(botId)!), approvalMode: approvalModeFor(store.bot(botId)!) };
      broadcast()({ kind: "bot", bot: fresh });
      respond({ ok: true, bot: fresh });
    } catch {
      respond({ ok: false, error: "The model switch could not be saved. No settings were changed." });
    }
    return true;
  }
  if (threadId !== undefined) {
    const target = typeof threadId === "string" && /^[\w-]{1,128}$/.test(threadId)
      ? store.projectBotForTask(botId, threadId) : null;
    if (!target || (mode !== "full" && mode !== "custom") || currentMode !== mode || existing.approvalGrant) {
      respond({ ok: false, error: "Choose this bot's approval level in bot settings before applying it to an existing thread" });
      return true;
    }
    if (threadBusy(botId, threadId as string) ||
      registry.cliTarget(target.modelSelection.instanceId)?.driverKind !== registry.cliTarget(existing.modelSelection.instanceId)?.driverKind) {
      respond({ ok: false, error: "Stop this thread and use the bot's provider before applying its approval level" });
      return true;
    }
  }
  const emergencyDowngrade = existing.busy && isEmergencyApprovalDowngrade(currentMode, mode);
  const clearsPendingElevation = mode === "ask" && existing.approvalGrant !== undefined;
  if (existing.busy && !emergencyDowngrade && !clearsPendingElevation) {
    respond({ ok: false, error: "Stop this bot's turn before changing its approval level" });
    return true;
  }
  if (!supportsApprovalMode(registry.cliTarget(existing.modelSelection.instanceId)?.driverKind, mode)) {
    respond({
      ok: false,
      error: mode === "full"
        ? "This provider does not support Full access"
        : "Custom approval settings are available only for Codex bots",
    });
    return true;
  }
  if (
    mode === "auto" &&
    existing.computer === "local" &&
    approvalModeFor(existing) !== "auto" &&
    message.acknowledgeLocalAuto !== true
  ) {
    respond({ ok: false, error: "Auto mode on this computer requires confirming the warning" });
    return true;
  }
  const updated = store.patchBot(botId, {
    approvalMode: mode,
    autoApprove: mode === "auto",
    approvalGrant: mode === "full" || mode === "custom"
      ? { requestId, mode, phase: "prepared", ...(typeof threadId === "string" ? { threadId } : {}) }
      : undefined,
  });
  if (!updated) {
    respond({ ok: false, error: "No such bot" });
    return true;
  }
  if (emergencyDowngrade) {
    // A lost Full/Custom reply is ambiguous: Electron compensates with Ask.
    // Persist that fail-closed state before the first await, then stop the
    // exact setup/turn that may already hold an elevated per-turn snapshot.
    // Only answer once the interrupt has been issued, so Electron cannot
    // advance a newer selection while the old turn is still live.
    void stopBotForEmergencyApprovalDowngrade(updated.id).then(
      () => respond({ ok: true, bot: wireBot()(store.bot(updated.id) ?? updated) }),
      (error) => respond({
        ok: false,
        error: `Approval was reset to Ask, but the active turn could not be stopped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
    return true;
  }
  respond({ ok: true, bot: wireTrustedApprovalBot()(updated) });
  return true;
}
return handleDesktopTrustedApprovalMessage;
}
