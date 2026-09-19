// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and preserves that history or reports a failed resume.

import { homedir } from "node:os";

import { stripWorkspaceCredentialEnv } from "../../config.ts";
import { describeSpawnFailure, killCliTree, spawnCli } from "../../procs.ts";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
  SteerOutcome,
} from "../../contracts.ts";
import { newId } from "../../contracts.ts";
import { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "../codex-catalog.ts";
import {
  customApprovalParams,
  namedApprovalParams,
  type CodexApprovalParams,
} from "../codex-approvals.ts";
import { createDriverSessionRuntime, createRefreshModels } from "../driver-runtime.ts";
import { augmentedPath } from "../../env-path.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../retry.ts";
import { appendNative } from "../native.ts";
import { commandSummary, toolDetailPreview } from "../../tool-summary.ts";
import { codexDeveloperInstructions, syncCodexInstructions } from "../codex-instructions.ts";
import type { ApprovalMode } from "../../../shared/approval-mode.ts";
import { CodexDeviceAuthController } from "../codex-device-auth.ts";
import { classifyResumeFailure, mayReplay, recoveryPromptFor } from "../../resume-recovery.ts";
import { CodexRpcError, missingNativeCodexThread } from "./rpc.ts";
import { type CodexConfig, decodeConfig } from "./config.ts";
import { codexNativeIncomingLogMessage, codexNativeLogMessage, permissionProfileUnsupported } from "./logs.ts";
import { assertCompanyTurnAllowed, assertNoReservedMcpEnv, codexAppServerArgs } from "./launch.ts";
import {
  bundledQuestionResponse,
  classifyServerRequest,
  DENY_TIMEOUT_NOTE,
  questionAnswersResult,
  QUESTION_TIMEOUT_NOTE,
  serverRequestChoices,
  serverRequestResult,
  serverRequestSummary,
  serverRequestTool,
  unsupportedServerRequestResponse,
} from "./requests.ts";
import { codexSnapshot } from "./snapshot.ts";
import {
  completedStopReason,
  exitBeforeCompletedMessage,
  itemStartedTitle,
  normalizeTokenUsage,
  turnUsageDelta,
  usageUpdateFields,
} from "./wire.ts";

const DRIVER_KIND = "codex";

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      win32: "npm install -g @openai/codex",
    },
    needsNode: true,
    docsUrl: "https://github.com/openai/codex",
    signInCommand: "codex login",
  },
  models: STATIC_CODEX_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...input.environment,
        PATH: augmentedPath(),
        NPM_CONFIG_LOGLEVEL: "error",
      };
      // The CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal).
      delete env.OPENAI_API_KEY;
      // The harness process may hold workspace credentials (xai/box/voice
      // keys, env-injected at boot); none of them are this CLI's to see.
      stripWorkspaceCredentialEnv(env);
      return env;
    };
    const catalogEnv = childEnv();
    const catalog = createRefreshModels({
      initial: config.managed ? { default: config.managed.models[0], options: config.managed.models.map(id => ({ id, label: id })) } : STATIC_CODEX_MODELS,
      // managed catalogs are fixed; a down local provider keeps the last usable catalog
      load: config.managed ? undefined : () => readCodexModelCatalog(catalogEnv, fetch, config.cli),
    });
    const refreshModels = catalog.refreshModels;
    await refreshModels();
    const authentication = new CodexDeviceAuthController({
      cli: config.cli,
      environment: childEnv,
      onAuthenticated: refreshModels,
    });
    interface Turn {
      stop: () => Promise<boolean>;
      /** Fold new user input into the running native turn (turn/steer).
       * "refused" when this attempt has nothing steerable; the caller
       * queues. "indeterminate" when delivery happened but the answer did
       * not come back — the caller must not re-queue those words. */
      steer?: (text: string) => Promise<SteerOutcome>;
      turnId: string;
      asks: Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>;
    }
    const runtime = createDriverSessionRuntime<Turn>({
      driverKind: DRIVER_KIND,
      stopTurn: async (turn) => {
        await turn.stop();
      },
    });
    const { emit, base } = runtime;

    const sendTurn = async (turn: SendTurnInput) => {
      assertCompanyTurnAllowed(config, turn, input.environment);
      // One driver instance serves many threads. Interrupt state belongs to
      // this turn so activity elsewhere cannot cancel or revive its retry.
      let stopRequested = false;
      let promptSubmitted = false;
      let recoveredMissingSession = false;
      // Wakes a retry backoff the moment Stop arrives, so the turn settles
      // now rather than after the full wait.
      const stopSignal = new AbortController();
      const { threadId } = turn;
      // Direct adapter callers predating the per-bot selector retain the
      // instance's legacy fullAuto setting. Harness turns always send an
      // explicit mode, which takes precedence.
      const approvalMode: ApprovalMode = turn.approvalMode ?? (config.fullAuto ? "full" : "ask");
      assertNoReservedMcpEnv(turn);
      let autoAcceptPermissions = approvalMode === "full";
      runtime.assertThreadIdle(threadId);
      const turnId = newId();
      // a retry relaunches the whole app-server; the backoff is scaled down in
      // tests so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");

      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        const appServerArgs = codexAppServerArgs(config, turn, env);

        const child = spawnCli(config.cli, appServerArgs, {
          cwd: turn.cwd ?? homedir(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

      let abandoned = false;
      let codexThreadId: string | null = null;
      let codexTurnId: string | null = null;
      let startingNativeTurn = false;
      const earlyNotifications: any[] = [];
      const state = {
        settled: false,
        lastError: "",
        lastText: "",
        sawStreamDelta: false,
        // codex reports token usage as a running total for this app-server
        // process. The harness wants this turn's figure: the total minus
        // whatever the process already carried before turn/start (a resumed
        // thread may restore earlier usage), banked on settle.
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
        usageBaseline: undefined as { input: number; output: number; cachedInput: number } | undefined,
      };

      const asks = new Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>();
      let nextId = 1;
      const sensitiveResponseIds = new Set<number>();
      const rpcPending = new Map<number, {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
      }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, {
          dir: "out",
          source: "codex.app-server",
          msg: codexNativeLogMessage(obj),
        });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          if (method === "config/read") sensitiveResponseIds.add(id);
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              if (method === "thread/start" || method === "thread/resume") {
                // Notifications can follow the thread response in the same
                // stdout chunk, before the handshake await resumes.
                const returnedId = v?.thread?.id;
                const requestedId = method === "thread/resume"
                  && params && typeof params === "object" && "threadId" in params
                  ? params.threadId : null;
                if (typeof returnedId === "string" && returnedId) codexThreadId = returnedId;
                else if (typeof requestedId === "string" && requestedId) codexThreadId = requestedId;
              }
              if (method === "turn/start") {
                if (typeof v?.turn?.id !== "string" || !v.turn.id) {
                  reject(new Error("Codex did not return a native turn id"));
                  return;
                }
                // Bind synchronously: a single stdout chunk can contain the
                // response, streamed events, completion and a late request.
                codexTurnId = v.turn.id;
                startingNativeTurn = false;
                for (const notification of earlyNotifications.splice(0)) {
                  if (state.settled) break;
                  handleNotification(notification);
                }
              }
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ jsonrpc: "2.0", id, method, params });
        });

      let stopping: Promise<boolean> | undefined;
      const terminate = () => stopping ??= killCliTree(child).then((stopped) => {
        if (!stopped) stopping = undefined;
        return stopped;
      });
      let completeStoppedTurn: (() => void) | undefined;
      // Stop asks the app-server to end the turn itself before any process
      // signal. Killing first surfaced routine stops as "codex exited null
      // (signal SIGTERM) before turn/completed"; the protocol interrupt keeps
      // the session the authority, and the kill below is only escalation for
      // a server that will not answer. settle() runs with state.settled
      // already true, so ordinary completion still tears down immediately.
      let interruptRequested = false;
      const stop = async () => {
        stopRequested = true;
        stopSignal.abort();
        if (!state.settled && !interruptRequested && codexThreadId && codexTurnId &&
            child.exitCode === null && child.signalCode === null) {
          interruptRequested = true;
          const graceMs = Math.max(1, Number(process.env.FAKE_CODEX_INTERRUPT_GRACE_MS ?? 750) || 750);
          try {
            await request("turn/interrupt", { threadId: codexThreadId, turnId: codexTurnId }, graceMs);
          } catch {
            // Old CLI without the method, or a wedged server: escalate below.
          }
          const deadline = Date.now() + graceMs;
          while (!state.settled && Date.now() < deadline) {
            await new Promise((wake) => setTimeout(wake, 15));
          }
          if (state.settled) return true;
        }
        const stopped = await terminate();
        if (stopped) completeStoppedTurn?.();
        return stopped;
      };

      const settle = async (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of Array.from(asks.values())) finish("deny", "OpenMausBot: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        const complete = () => {
          if (runtime.turn(threadId)?.stop !== stop) return;
          runtime.endTurn(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(state.usage ? { usage: state.usage } : {}) });
        };
        completeStoppedTurn = complete;
        if (!(await stop())) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "codex did not shut down after termination was requested" });
        }
      };

      // Live steering folds new input into the running turn without ending
      // it. expectedTurnId is the protocol's precondition: a turn that moved
      // on (or a CLI without turn/steer) answers with an explicit RPC error,
      // which becomes "refused" here so the caller queues for the next turn —
      // the child is never killed to steer. A timeout after delivery, a dead
      // transport, or a turn that settles while the answer is in flight is
      // "indeterminate": the words may already be running, so the caller must
      // not re-queue them.
      const steerActiveTurn = async (text: string): Promise<SteerOutcome> => {
        if (state.settled || abandoned || stopRequested || !codexThreadId || !codexTurnId) return "refused";
        if (child.exitCode !== null || child.signalCode !== null) return "refused";
        try {
          const steerTimeoutMs = Math.max(1, Number(process.env.FAKE_CODEX_STEER_TIMEOUT_MS ?? 10_000) || 10_000);
          await request("turn/steer", {
            threadId: codexThreadId,
            input: [{ type: "text", text }],
            expectedTurnId: codexTurnId,
          }, steerTimeoutMs);
          return "steered";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (state.settled || message.includes("timed out")) return "indeterminate";
          return "refused";
        }
      };

      // server→client approval request → canonical request.opened
      // Host-scope tagging mirrors claude.ts: when this turn mounts the real
      // Mac (not a VM), every card carries approvalScope so the harness's
      // local-computer-block backstop applies to remembered always-allows.
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      const handleServerRequest = (msg: any) => {
        const r = classifyServerRequest(msg);
        // A normal MCP elicitation is a form or URL asking for real user input,
        // not a permission. We cannot safely synthesize its structured answer.
        // Unknown future server requests also fail closed instead of being
        // mistaken for commands and accepted by Full Access.
        if (!r.isQuestion && !r.isPermission) {
          send(unsupportedServerRequestResponse(r));
          return;
        }
        // One ask card carries one question honestly: its choices would come
        // from the first question alone and its one reply (including the
        // timeout note) would be copied into every question id (#1237).
        // Refuse the bundled call with a teaching error instead of
        // fabricating per-question answers.
        if (r.isQuestion && (!Array.isArray(r.params.questions) || r.params.questions.length !== 1)) {
          send(bundledQuestionResponse(r));
          return;
        }
        const tool = serverRequestTool(r);
        if (autoAcceptPermissions && r.isPermission) {
          return send({ jsonrpc: "2.0", id: msg.id, result: serverRequestResult(r, true) });
        }
        const requestId = newId();
        const summary = serverRequestSummary(r);
        const choices = serverRequestChoices(r);
        const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (r.isQuestion) {
            send({ jsonrpc: "2.0", id: msg.id, result: questionAnswersResult(r, message) });
          } else {
            send({ jsonrpc: "2.0", id: msg.id, result: serverRequestResult(r, behavior === "allow") });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
        };
        const timer = setTimeout(
          () => (r.isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout") : finish("deny", DENY_TIMEOUT_NOTE, "timeout")),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: r.isQuestion ? "question" : "permission",
          tool,
          summary,
          choices,
          approvalScope: controlsHost ? "local-computer" : undefined,
          requiresExplicitApproval: r.isAdditionalPermission || undefined,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        // An app-server also emits notifications for native helper threads.
        // Only this request's parent may write its transcript/usage or settle
        // its run. Requests still use the approval broker above, including
        // helper requests; ignoring child *notifications* must not grant tools.
        const connectionError = msg.method === "error" &&
          !("threadId" in p) && !("turnId" in p);
        if (!connectionError) {
          if (!codexThreadId || p.threadId !== codexThreadId) return;
          if (!codexTurnId && msg.method === "thread/tokenUsage/updated" && p.tokenUsage?.total) {
            // A total reported before this turn exists is what the process
            // carried in — a resumed thread restoring earlier usage. It is the
            // baseline this turn's figure is measured from, never a reading to
            // buffer and replay as if this turn produced it. (Codex names the
            // turn before any model call, so a genuine first reading cannot
            // land here.)
            const t = p.tokenUsage.total;
            state.usageBaseline = normalizeTokenUsage(t);
            return;
          }
          if (!codexTurnId) {
            // Some servers stream before acknowledging turn/start. Retain a
            // bounded prefix, then filter against the authoritative response.
            if (startingNativeTurn) {
              if (earlyNotifications.length >= 1024) {
                void settle(false, "too_many_events_before_turn_start");
              } else {
                earlyNotifications.push(msg);
              }
            }
            return;
          }
          const eventTurnId = msg.method === "turn/started" || msg.method === "turn/completed"
            ? p.turn?.id : p.turnId;
          if (eventTurnId !== codexTurnId) return;
        }
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            const item = p.item ?? {};
            const title = itemStartedTitle(item);
            if (title) {
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: item.id,
                title,
                summary: item.type === "commandExecution" ? commandSummary({ command: item.command }) : undefined,
                input: toolDetailPreview(item.type === "commandExecution" ? { command: item.command, cwd: item.cwd } : item.type === "mcpToolCall" ? item.arguments : item.type === "fileChange" ? item.changes : item.query),
              });
            }
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (item.type === "imageGeneration" && item.status !== "failed") {
              // Current Codex app-server (the same schema consumed by T3
              // Code) returns the generated raster as base64 `result` and
              // may also expose a local `savedPath`. Use bytes, never the
              // provider-owned path: the harness will validate and copy
              // them into its private attachment store.
              if (typeof item.result === "string" && item.result.trim()) {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  itemId: item.id,
                  data: item.result,
                  alt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined,
                });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
                output: toolDetailPreview(item.type === "commandExecution" ? { output: item.aggregatedOutput, exitCode: item.exitCode } : item.type === "mcpToolCall" ? item.error ?? item.result : item.type === "fileChange" ? item.changes : item.action),
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            // `total` is everything this app-server process has used; `last`
            // is the most recent model call. This turn's figure is the total
            // minus what the process carried before turn/start went out (a
            // resumed thread can restore earlier usage), so it never grows by
            // the whole thread per message and never counts only the final
            // call of a multi-step turn. codex's inputTokens already includes
            // cachedInputTokens; the cached share rides alongside so the UI
            // can say how much was context re-read rather than new text.
            const t = p.tokenUsage?.total;
            const last = p.tokenUsage?.last;
            // (A total that arrived before this turn was named became the
            // baseline upstream and never reaches this switch.)
            if (t) {
              state.usage = turnUsageDelta(t, state.usageBaseline);
            } else if (last) {
              state.usage = { input: last.inputTokens ?? 0, output: last.outputTokens ?? 0, ...(typeof last.cachedInputTokens === "number" ? { cachedInput: last.cachedInputTokens } : {}) };
            }
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                ...usageUpdateFields(t, last, p.tokenUsage?.modelContextWindow),
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            const message = typeof t.error?.message === "string" ? t.error.message.slice(0, 400) : "";
            if (t.status !== "completed" && message && message !== state.lastError) {
              state.lastError = message;
              emit({ ...base(threadId, turnId), type: "runtime.error", message,
                ...(classifyError({ text: message }).reason === "auth" ? { setup: true } : {}),
              });
            }
            void settle(t.status === "completed", completedStopReason(t, message, state.lastError));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) {
                state.lastError = String(message).slice(0, 400);
                emit({ ...base(threadId, turnId), type: "runtime.error", message: state.lastError });
              }
            }
            break;
        }
      };

      let buf = "";
      // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
      // multibyte characters that straddle two reads and corrupts the text
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (abandoned || state.settled) return;
        buf += chunk;
        let nl;
        while (!state.settled && (nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          stderrSinceOutput = "";
          const loggedMessage = codexNativeIncomingLogMessage(msg, sensitiveResponseIds);
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg: loggedMessage });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              if (msg.error) pend.reject(new CodexRpcError(msg.error));
              else pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        }
      });

      let stderr = "";
      // Stderr that arrived after the last parsed protocol message. The
      // full buffer accumulates for the whole process lifetime, so its
      // tail can name a long-past event (a websocket 426 logged at turn
      // start, echoed half an hour later when something else kills the
      // process). Only this slice can explain an exit; older bytes are
      // context, not cause.
      let stderrSinceOutput = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        stderrSinceOutput += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
        if (stderrSinceOutput.length > 2048) stderrSinceOutput = stderrSinceOutput.slice(-2048);
      });
      child.on("error", (e) => {
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        void settle(false, "spawn_error");
      });
      child.on("close", (code, signal) => {
        if (abandoned) return;
        if (state.settled) {
          // Root exit alone cannot release a turn after an uncertain stop.
          // Recheck its group; an explicit later Stop can also retry this.
          void stop();
          return;
        }
        // An intentional stop killed (or outlived) the child before the
        // turn acknowledged its own end. That is the stop doing its job, not
        // a crash: settle quietly so Stop never reports the raw signal.
        if (stopRequested) {
          void settle(false, "interrupted");
          return;
        }
        // The child died before the turn completed. Attribute the exit
        // honestly: name the signal when it was killed, and only quote
        // stderr that arrived after the last protocol message. A stale
        // tail here once misattributed a whole day of killed turns to a
        // websocket 426 logged at turn start.
        const recentStderr = stderrSinceOutput.trim();
        const hadStreamedOutput = codexTurnId !== null || state.sawStreamDelta;
        // A signal exit is terminal no matter what the stderr says:
        // something killed the process (OOM, kill -9), and classifyError
        // cannot see the signal — with code null, transient-looking recent
        // stderr could still mark a killed attempt retryable.
        // Classification also reads only stderr received after the last
        // protocol output; the lifetime buffer's tail can name a
        // long-past event (the websocket-426 misattribution).
        const verdict =
          signal !== null
            ? { transient: false, reason: "interrupted" }
            : classifyError({ exitCode: code, stderr: recentStderr });
        // Safe re-dispatch: relaunch only when the app-server never
        // acknowledged turn/start — no native turn began, nothing was
        // streamed, so replaying the input cannot duplicate work. After
        // any acknowledgement (or any buffered pre-ack event) the turn
        // settles instead: a replay could re-run tools the user saw.
        if (
          !stopRequested && codexTurnId === null && earlyNotifications.length === 0 &&
          verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1
        ) {
          const delayMs = computeBackoff(attempt);
          attempt++;
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt,
            delayMs,
            reason: verdict.reason,
          });
          // Retire this attempt before anything async runs, so a late
          // rpc timer rejection in the handshake catch cannot relaunch
          // a second time on top of this one.
          abandoned = true;
          void (async () => {
            const alreadyDead = child.exitCode !== null || child.signalCode !== null;
            if (!alreadyDead && !(await terminate())) {
              void settle(false, "shutdown_timeout");
              return;
            }
            await interruptibleDelay(Math.max(1, Math.round(delayMs * retryScale)), stopSignal.signal).promise;
            if (!stopRequested) {
              void launchAttempt(attempt).catch(() => {});
            } else {
              await settle(false, "interrupted");
            }
          })().catch(() => {});
          return;
        }
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: exitBeforeCompletedMessage(code, signal, recentStderr, hadStreamedOutput, stderr),
        });
        void settle(false, "exit_before_result");
      });

      runtime.setTurn(threadId, { stop, turnId, asks, steer: steerActiveTurn });
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        await request("initialize", {
          clientInfo: { name: "openmausbot", version: "1" },
          // Named permission profiles are an experimental app-server field in
          // Codex 0.151. Negotiate them explicitly; older servers ignore this
          // capability and remain on the legacy Custom fallback below.
          capabilities: { experimentalApi: true },
        });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        // developerInstructions replaces, rather than appends to, native
        // config. Read it for every approval mode so existing rules survive.
        // request() already redacts config/read responses from native logs.
        let effectiveConfig: unknown;
        try {
          const configured = await request("config/read", {
            cwd: turn.cwd ?? homedir(),
            includeLayers: false,
          });
          effectiveConfig = configured?.config;
        } catch {
          // Do not expose a possibly secret-bearing native config error or
          // overwrite unknown instructions with an empty fallback.
          throw new Error("Could not read Codex configuration; cannot safely update bot instructions. Retry after checking Codex.");
        }
        const developerInstructions = codexDeveloperInstructions(effectiveConfig, turn.system ?? "");
        let approvalParams: CodexApprovalParams;
        if (approvalMode === "custom") {
          // config/read returns the effective global + project config for this
          // cwd. Reasserting those values is essential: simply omitting them
          // on a resumed thread would keep the previous named mode sticky.
          approvalParams = customApprovalParams(effectiveConfig);
        } else {
          approvalParams = namedApprovalParams(approvalMode);
        }
        // Codex's `never` means "do not ask to escalate", not "grant every
        // requested permission". Only the user's explicit OpenMausBot Full
        // mode may synthesize approvals; Custom must preserve the sandbox
        // boundary from config.toml (for example never + read-only).
        autoAcceptPermissions = approvalMode === "full";
        // Each turn launches a new app-server. Reassert current bot instructions
        // on start AND resume so Codex owns their lifetime through compaction.
        // Removed bot rules are cleared without dropping native configured rules.
        const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        let startedModel: string | null = null;
        let resumedNativeThread = false;
        let rebuiltFromReplay = false;
        let promptText = turn.text;
        if (cursor) {
          const resumeThread = () => request("thread/resume", {
            threadId: cursor,
            developerInstructions,
            ...approvalParams.thread,
          });
          try {
            let resumed;
            try {
              resumed = await resumeThread();
            } catch (error) {
              if (!approvalParams.fallback || !permissionProfileUnsupported(error)) throw error;
              // Older servers may require the legacy permission selector, but
              // still resume the same native thread before any user submission.
              approvalParams = approvalParams.fallback;
              resumed = await resumeThread();
            }
            codexThreadId = resumed?.thread?.id ?? cursor;
            resumedNativeThread = true;
          } catch (error) {
            const failure = classifyResumeFailure({
              attempted: true,
              rejected: error instanceof CodexRpcError,
              promptSubmitted,
              producedOutput: state.sawStreamDelta,
            });
            if ((!config.managed && !turn.recoveryIsReplay) || recoveredMissingSession || stopRequested || state.settled ||
                !turn.recoveryText?.trim() || !missingNativeCodexThread(error, cursor) || !mayReplay(failure)) throw error;
            // The prompt has never been submitted. Rebuild missing Company
            // histories, and a personal thread only for a turn whose recovery
            // text is the replay it would have had anyway; once, through the
            // same approved model/provider below.
            recoveredMissingSession = true;
            const rebuild = recoveryPromptFor({ recoveryText: turn.recoveryText, currentText: turn.text, failure });
            // Announced as rebuilt only when the replacement really carries the
            // replay; otherwise it holds no more than the turn text.
            rebuiltFromReplay = rebuild.replayed;
            promptText = rebuild.text;
          }
        }
        if (!codexThreadId) {
          const selection = config.managed ? { model: turn.model, modelProvider: "openmaus_company" } : decodeCodexSelection(turn.model);
          const startThread = () => request("thread/start", {
              developerInstructions,
              cwd: turn.cwd ?? homedir(),
              model: selection.model,
              ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
              ...approvalParams.thread,
              ephemeral: false,
            });
          let started;
          try {
            started = await startThread();
          } catch (error) {
            if (!approvalParams.fallback || !permissionProfileUnsupported(error)) throw error;
            approvalParams = approvalParams.fallback;
            started = await startThread();
          }
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
        }
        if (!codexThreadId) throw new Error("Codex did not return a native thread id");
        await syncCodexInstructions(threadId, codexThreadId, developerInstructions, resumedNativeThread, request);
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null, ...(rebuiltFromReplay ? { rebuilt: true } : {}) });
        const turnInput = [
          ...(promptText ? [{ type: "text" as const, text: promptText }] : []),
          ...(turn.images ?? []).map((image) => ({ type: "localImage" as const, path: image.path })),
        ];
        const startTurn = () => {
          promptSubmitted = true;
          startingNativeTurn = true;
          return request("turn/start", {
            threadId: codexThreadId,
            input: turnInput,
            ...approvalParams.turn,
            // Spread, not `effort: turn.effort ?? null`. Probed against
            // codex-cli 0.146.0: null is indistinguishable from an absent key
            // — both leave the thread's current effort alone, emitting no
            // thread/settings/updated, and thread/resume reads the old value
            // back. The app-server offers no way to clear a level either:
            // "" is rejected outright and thread/start takes no effort at
            // all. So a thread keeps the last level it was sent until it is
            // sent another, and choosing Default lands on the bot's next new
            // thread rather than the current one.
            ...(turn.effort ? { effort: turn.effort } : {}),
          });
        };
        try {
          await startTurn();
        } catch (error) {
          if (!approvalParams.fallback || !permissionProfileUnsupported(error)) throw error;
          approvalParams = approvalParams.fallback;
          await startTurn();
        }
      } catch (e) {
        const failure = e instanceof Error ? e : { text: String(e) };
        const message = e instanceof Error ? e.message : String(e);
        const needsAuth = /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(message);
        const verdict = classifyError(failure);
        // Three guards hold here: main's abandoned attempt never retries,
        // neither does a Company session already recovered once from canonical
        // history, and a Stop already asked for must not be undone by a relaunch.
        if (!state.settled && !abandoned && !recoveredMissingSession && !stopRequested && !needsAuth && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
          const delayMs = computeBackoff(attempt);
          attempt++;
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt,
            delayMs,
            reason: verdict.reason,
          });
          // This app-server never exits by itself. Retire the failed attempt
          // and silence its late handlers before the replacement launches.
          abandoned = true;
          if (!await terminate()) {
            void settle(false, "shutdown_timeout");
            return;
          }
          await interruptibleDelay(Math.max(1, Math.round(delayMs * retryScale)), stopSignal.signal).promise;
          if (!stopRequested) {
            void launchAttempt(attempt).catch(() => {});
          } else {
            await settle(false, "interrupted");
          }
          return;
        }
        // abandoned marks an attempt retired by a retry; its late rpc
        // timeouts must neither report a spurious error nor relaunch again
        if (!state.settled && !abandoned) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message,
            ...(needsAuth ? { setup: true } : {}),
          });
          await settle(false, needsAuth ? "auth_required" : verdict.reason === "provider_safety" ? "provider_safety" : "rpc_error");
        }
      }
    };

    void launchAttempt(0).catch(() => {});
    return { turnId };
  };

  const snapshot = async (): Promise<ProviderSnapshot> =>
    codexSnapshot({
      config,
      env: childEnv(),
      companyAuthenticated: Boolean(input.environment.OPENMAUSBOT_COMPANY_API_KEY && input.environment.CODEX_HOME),
      models: catalog.models,
    });

  return {
    instanceId,
    driverKind: DRIVER_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return catalog.models;
    },
    refreshModels,
    startAuthentication: () => authentication.start(),
    getAuthentication: (flowId) => authentication.get(flowId),
    cancelAuthentication: () => authentication.cancel(),
    signOut: () => authentication.signOut(),
    snapshot,
    adapter: {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported",
        queueing: true,
        computerMcp: true,
        localComputerMcp: true,
        composioMcp: true,
        agentsMcp: true,
      customMcp: true,
        phoneMcp: true,
        browserMcp: true,
        images: true,
        nativeImageInput: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        strictResume: true,
      },
      sendTurn,
      interruptTurn: async (threadId) => {
        await runtime.turn(threadId)?.stop();
      },
      steer: async (threadId, text) => {
        const turn = runtime.turn(threadId);
        return turn?.steer ? await turn.steer(text) : "refused";
      },
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = runtime.turn(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable"; // settled, timed out, or turn gone
        finish(decision.behavior, decision.message, "user");
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
      hasSession: (threadId) => runtime.hasSession(threadId),
      stopAll: () => runtime.stopAll(),
      onEvent: runtime.onEvent,
    },
    dispose: async () => {
      await authentication.dispose();
      await runtime.dispose();
    },
  };
},
};
