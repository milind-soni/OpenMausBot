// Muse Code, Meta's coding agent, driven over its own Muse Session Protocol
// (MSP) through Meta's SDK, the way t3code does (MIT, pingdotgg/t3code
// packages/provider-muse). Muse Code speaks no ACP: `muse serve` hosts MSP
// sessions over stdio. The person signs in once with `muse login` (or gives
// the instance a META_API_KEY), and the models come from Muse itself, so a
// new Muse model reaches the picker without an app release.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, MspError, type DuplexTransport } from "@muse-code/sdk";
import { z } from "zod";
import { instanceEnvNames } from "../bot-box/env.ts";
import { PROVIDER_CREDENTIAL_ENV, stripControlPlaneEnv, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import type {
  ModelCatalog, ProviderDriver, ProviderInstance, ProviderSnapshot, RequestOutcome, RuntimeEvent,
  RuntimeEventListener, SendTurnInput, SteerOutcome,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli, type CliOwner } from "../procs.ts";
import { redactSecretsInText } from "../redact.ts";
import { answersAlone } from "./permission-command.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { parseProtocolAskQuestions, questionAnswersById, type ProtocolAskQuestion } from "../../shared/ask-question.ts";
import type { EffortLevel } from "../../shared/wire.ts";
import { promptHalves, readPromptSplitReceipt, splitSessionPrompt, writePromptSplitReceipt, type PromptSplitReceipt } from "./prompt-split.ts";
import { turnStdioMcpServers } from "./turn-mcp.ts";

const DRIVER_KIND = "museCode";
const PROVIDER_ID = "meta";
const CLIENT_INFO = { name: "openmausbot", title: "OpenMausBot", version: "1" };
const MUSE_CONTEXT_WINDOW = 1_048_576;
const RE_ANCHOR_TURNS = 8;
const STARTUP_TIMEOUT_MS = 30_000;
const MODEL_LIST_TIMEOUT_MS = 20_000;
const INTERRUPT_CONFIRM_MS = 5_000;
const SHUTDOWN_DRAIN_MS = 10_000;
const SHUTDOWN_KILL_GRACE_MS = 2_000;
const MAX_TOOL_OUTPUT = 4_000;

// Muse's catalog for a signed-in account (`model/list`), until the live list answers.
const DEFAULT_MODELS: ModelCatalog = {
  default: "muse-wonder-1.0",
  options: [
    { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", contextWindow: MUSE_CONTEXT_WINDOW },
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: MUSE_CONTEXT_WINDOW },
    { id: "muse-spark-1.2", label: "Muse Spark 1.2", contextWindow: MUSE_CONTEXT_WINDOW },
  ],
};

/** Muse has no "none" for its reasoning models, so the lowest level asks for its shortest pass. */
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const museEffort = (effort: EffortLevel | undefined) => effort === "none" ? "minimal" : effort;

const configSchema = z.object({
  cli: z.string().trim().min(1).default("muse"),
  model: z.string().trim().min(1).optional(),
});
type MuseConfig = z.output<typeof configSchema>;

/** "muse-spark-1.3-contributor" → "Muse Spark 1.3 Contributor". */
export function museModelLabel(id: string, displayLabel?: string): string {
  if (displayLabel && displayLabel !== id) return displayLabel;
  if (!/^muse-/i.test(id)) return id;
  return id.split("-").map(word => /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function museCatalog(result: unknown, preferred?: string): ModelCatalog | null {
  const rows = (result as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows)) return null;
  const options: ModelCatalog["options"] = [];
  let listedDefault: string | undefined;
  for (const row of rows) {
    const entry = (row ?? {}) as { modelId?: unknown; displayLabel?: unknown; isDefault?: unknown; contextLimit?: unknown };
    if (typeof entry.modelId !== "string" || !entry.modelId.trim()) continue;
    if (options.some(option => option.id === entry.modelId)) continue;
    const id = entry.modelId;
    options.push({
      id, label: museModelLabel(id, typeof entry.displayLabel === "string" ? entry.displayLabel : undefined),
      contextWindow: typeof entry.contextLimit === "number" && entry.contextLimit > 0 ? entry.contextLimit : MUSE_CONTEXT_WINDOW,
    });
    if (entry.isDefault === true) listedDefault ??= id;
  }
  if (!options.length) return null;
  if (preferred && !options.some(option => option.id === preferred)) {
    options.unshift({ id: preferred, label: museModelLabel(preferred), custom: true });
  }
  return { default: preferred ?? listedDefault ?? options[0].id, options };
}

/** Full runs without asking or Muse's sandbox; every other level lets Muse's own policy ask. */
export function museApprovalMode(mode: ApprovalMode | undefined): "allowAll" | "promptUnmatched" {
  return mode === "full" ? "allowAll" : "promptUnmatched";
}

export function museServeArgs(mode: ApprovalMode | undefined): string[] {
  return ["serve", "--trust-workspace", ...(mode === "full" ? ["--disable-sandbox"] : [])];
}

interface MuseChoice { choiceId: string; label: string; decision: string; scope: string }
interface MuseApproval {
  approvalId: string;
  sessionId: string;
  turnId?: string;
  toolName?: string;
  currentRequirementId: unknown;
  availableChoices: MuseChoice[];
  subject?: { kind?: string; command?: string; path?: string; host?: string; target?: string; toolName?: string; workspaceRoot?: string };
}

/** The native choice for an answer: the narrowest allow (once before session),
 * a session-wide allow for "Always allow this session", and Muse's own deny,
 * or its Reject (abort) where a shell ask offers no deny. */
export function museChoice(choices: readonly MuseChoice[], behavior: "allow" | "deny", always = false): MuseChoice | undefined {
  if (behavior === "allow") {
    const once = choices.find(choice => choice.decision === "approved");
    const session = choices.find(choice => choice.decision === "approvedForSession")
      ?? choices.find(choice => choice.decision === "approvedPolicyAmendment" && choice.scope === "session");
    return always ? session ?? once : once ?? session;
  }
  return choices.find(choice => choice.decision === "denied") ?? choices.find(choice => choice.decision === "abort");
}

interface MuseItem {
  itemId: string;
  kind: string;
  status: string;
  turnId?: string | null;
  text?: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  failureReason?: string;
  commandText?: string;
  exitCode?: number;
  objective?: string;
  role?: string;
  summary?: string[];
  fallbackText?: string;
  result?: { summary?: string; text?: string };
  retracted?: boolean;
}

const TOOL_KINDS = new Set(["toolCall", "userShell", "webSearch", "subagent", "workflow"]);
const isRunning = (status: string) => /^(?:inProgress|pending|awaiting|queued|running)/i.test(status);

function parseArgs(args: string | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined; // streaming model-authored arguments may not be JSON yet
  }
}

export function museToolStart(item: MuseItem): { title: string; summary?: string; input?: string } {
  const args = parseArgs(item.args);
  const title = item.kind === "subagent" ? item.objective || item.role || "Muse agent"
    : item.kind === "webSearch" ? "web_search"
      : item.tool || item.kind;
  const command = item.commandText ?? (typeof args?.command === "string" ? args.command : typeof args?.cmd === "string" ? args.cmd : undefined);
  const summary = command ? commandSummary({ command }) : undefined;
  const input = toolDetailPreview(args ?? item.args);
  return { title, ...(summary ? { summary } : {}), ...(input ? { input } : {}) };
}

export function museToolOutput(item: MuseItem): { ok: boolean; output?: string } {
  const ok = item.status === "completed" && item.exitCode === undefined ? true
    : item.status === "completed" && item.exitCode === 0;
  const text = item.visibleOutput ?? item.result?.summary ?? item.text ?? item.summary?.join("\n") ?? item.fallbackText ?? "";
  const output = [item.status !== "completed" ? item.failureReason || `Muse reported ${item.status}.` : "", text]
    .filter(Boolean).join("\n");
  return { ok, ...(output ? { output: redactSecretsInText(output.slice(0, MAX_TOOL_OUTPUT)) } : {}) };
}

export function museQuestions(questions: unknown): ProtocolAskQuestion[] | null {
  if (!Array.isArray(questions)) return null;
  return parseProtocolAskQuestions(questions.map((question) => {
    const q = question as { id?: unknown; header?: unknown; question?: unknown; options?: unknown; selection?: { mode?: unknown } };
    return { id: q.id, header: q.header, question: q.question, options: q.options, multiSelect: q.selection?.mode === "multiple" };
  }));
}

interface Pending {
  kind: "approval" | "question";
  sessionId: string;
  approval?: MuseApproval;
  userInputId?: string;
  questions?: ProtocolAskQuestion[];
}

interface ActiveTurn {
  turnId: string;
  /** Muse's turn id: the turn/start command id the host mints; unset until sent. */
  nativeTurnId?: string;
  items: Map<string, MuseItem>;
  streamed: Map<string, string>;
  finished: boolean;
  /** Set once Stop sends turn/interrupt: resolves when the turn has ended, so a later Stop and dispose wait for the same shutdown. */
  stopping?: Promise<void>;
  onFinished?: () => void;
  receipt?: { key: string; receipt: PromptSplitReceipt };
}

interface Host {
  connection: Connection;
  close(): Promise<unknown>;
  exited: Promise<unknown>;
  grantedMcp: boolean;
  /** A turn needing another posture or other MCP servers gets a fresh host resuming the same session. */
  key: string;
  closed: boolean;
}

interface ThreadState {
  threadId: string;
  host?: Host;
  sessionId?: string;
  model?: string;
  approvalMode?: string;
  active?: ActiveTurn;
  pending: Map<string, Pending>;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Security: @muse-code/sdk 1.4.6's spawnMspConnection starts `muse serve` with its own child_process.spawn, outside
 * the bot box and the conversation's engine home. MSP runs over the stdio of a spawnCli process instead. */
function stdioTransport(child: ReturnType<typeof spawnCli>, exited: Promise<void>): DuplexTransport {
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  return {
    incoming: child.stdout,
    write: (chunk) => new Promise((resolve, reject) => {
      child.stdin.write(chunk, "utf8", (error) => error ? reject(error) : resolve());
    }),
    async close(flushed) {
      const drained = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref?.());
      await Promise.race([flushed?.catch(() => {}), drained]);
      child.stdin.end();
      await Promise.race([exited, drained]);
      await killCliTree(child, SHUTDOWN_KILL_GRACE_MS);
    },
  };
}

export const MuseCodeDriver: ProviderDriver<MuseConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true, access: "subscription" },
  models: DEFAULT_MODELS,
  install: {
    command: {
      darwin: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      linux: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      win32: "irm https://dev.meta.ai/install.ps1 | iex",
    },
    docsUrl: "https://dev.meta.ai/docs/muse-code",
    signInCommand: "muse login",
  },
  decodeConfig: (raw) => configSchema.parse(raw ?? {}),
  defaultConfig: () => configSchema.parse({}),
  async create(input): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    const threads = new Map<string, ThreadState>();
    let catalog: ModelCatalog = config.model ? museCatalog({ models: DEFAULT_MODELS.options.map(option => ({ modelId: option.id })) }, config.model)! : DEFAULT_MODELS;
    let catalogLoaded = false;
    let catalogError: string | null = null;

    const emit = (event: Record<string, unknown> & { type: RuntimeEvent["type"]; threadId: string }) => {
      const full = { eventId: newEventId(), provider: DRIVER_KIND, providerInstanceId: instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
      for (const listener of listeners) listener(full);
    };

    /** `muse login`'s saved sign-in; META_API_KEY only when this instance was given one. */
    const childEnv = (): NodeJS.ProcessEnv => {
      const env: Record<string, string | undefined> = { ...process.env, ...input.environment, PATH: augmentedPath(), MUSE_NO_AUTO_UPDATE: "1" };
      for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) delete env[key];
      stripControlPlaneEnv(env);
      if (input.environment.META_API_KEY) env.META_API_KEY = input.environment.META_API_KEY;
      return env;
    };

    /** Node's spawn runs no shell; Windows runs Muse's .cmd launcher through cmd.exe. */
    const launch = (args: string[]) => process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", config.cli, ...args] }
      : { command: config.cli, args };

    const startHost = async (args: string[], cwd: string, key: string, requestMcp: boolean, owner: CliOwner): Promise<Host> => {
      const { command, args: argv } = launch(args);
      const env = childEnv();
      const child = spawnCli(command, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"],
        ...(owner === "bot" ? { box: { allowEnv: instanceEnvNames(input.environment, env) } } : {}) }, owner);
      let spawnError: NodeJS.ErrnoException | undefined;
      child.once("error", (error) => { spawnError = error; });
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const connection = new Connection(stdioTransport(child, exited));
      let timer: NodeJS.Timeout | undefined;
      try {
        const initialized = await Promise.race([
          connection.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { requestedCapabilities: requestMcp ? ["sessionMcp"] : [] } }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Muse Code did not start within 30 seconds.")), STARTUP_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        connection.notify("initialized");
        await connection.flush();
        const granted = initialized.grantedCapabilities;
        const host: Host = {
          connection, exited, key, closed: false,
          grantedMcp: Array.isArray(granted) && granted.includes("sessionMcp"),
          close: () => { host.closed = true; return connection.close(); },
        };
        // Approval and question requests are receipts only: notifications open the cards, answers go as commands.
        connection.onServerRequest(async (request) => {
          if (request.method === "approval/request" || request.method === "userInput/request") return {};
          throw new Error(`Unsupported Muse request: ${request.method}`);
        });
        return host;
      } catch (error) {
        await connection.close().catch(() => {});
        throw spawnError ? new Error(describeSpawnFailure(spawnError, config.cli, cwd).message) : error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const refreshModels = async () => {
      const cwd = mkdtempSync(join(tmpdir(), "omb-muse-models-"));
      let host: Host | undefined;
      try {
        host = await startHost(["serve", "--disable-shell", "--disable-write", "--no-session-log"], cwd, "models", false, "openmausbot");
        const result = await Promise.race([
          host.connection.request("model/list", {}),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Muse Code did not list its models.")), MODEL_LIST_TIMEOUT_MS).unref?.()),
        ]);
        const listed = museCatalog(result, config.model);
        if (listed) {
          catalog = listed;
          catalogLoaded = true;
          catalogError = null;
        }
      } catch (error) {
        catalogError = error instanceof Error ? error.message : String(error);
      } finally {
        await host?.close().catch(() => {});
        rmSync(cwd, { recursive: true, force: true });
      }
    };

    /** `muse login` saves under the engine's HOME, so an instance with its own HOME is its own account. */
    const signedIn = () => {
      if (input.environment.META_API_KEY) return true;
      const env = childEnv();
      const home = env.HOME || homedir();
      return existsSync(join(env.XDG_CONFIG_HOME || join(home, ".config"), "muse", "auth.json"))
        || existsSync(join(home, ".config", "muse", "auth.json"));
    };

    let version: string | null | undefined;
    const probeVersion = () => new Promise<string | null>((resolve) => {
      execCli(config.cli, ["--version"], { env: childEnv(), timeout: 15_000 }, (error, stdout) => {
        resolve(error ? null : (/(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout)?.[1] ?? stdout.trim()) || null);
      });
    });

    const threadOf = (threadId: string) => {
      let state = threads.get(threadId);
      if (!state) threads.set(threadId, state = { threadId, pending: new Map() });
      return state;
    };

    const finishTurn = (state: ThreadState, active: ActiveTurn, completed: { ok: boolean; stopReason?: string; usage?: { input: number; output: number; cachedInput?: number } }) => {
      if (active.finished) return;
      active.finished = true;
      active.onFinished?.();
      if (state.active === active) state.active = undefined;
      for (const requestId of state.pending.keys()) {
        emit({ type: "request.resolved", threadId: state.threadId, turnId: active.turnId, requestId, behavior: "deny", source: "system" });
      }
      state.pending.clear();
      if (completed.ok && active.receipt) writePromptSplitReceipt(DRIVER_KIND, active.receipt.key, active.receipt.receipt);
      emit({ type: "turn.completed", threadId: state.threadId, turnId: active.turnId, ok: completed.ok,
        ...(completed.stopReason ? { stopReason: completed.stopReason } : {}), ...(completed.usage ? { usage: completed.usage } : {}) });
    };

    const failTurn = (state: ThreadState, active: ActiveTurn, message: string) => {
      if (active.finished) return;
      emit({ type: "runtime.error", threadId: state.threadId, turnId: active.turnId, message: redactSecretsInText(message), terminal: true });
      finishTurn(state, active, { ok: false, stopReason: "error" });
    };

    const onNotification = (state: ThreadState, host: Host, method: string, params: Record<string, unknown>) => {
      if (state.host !== host || params.sessionId !== state.sessionId) return;
      const active = state.active;
      const threadId = state.threadId;
      switch (method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const item = params.item as MuseItem | undefined;
          if (!active || !item || item.turnId !== active.nativeTurnId) return;
          const seen = active.items.get(item.itemId);
          active.items.set(item.itemId, item);
          if (item.kind === "agentMessage") {
            if (item.status !== "completed" || item.retracted) return;
            const text = item.text ?? "";
            const streamed = active.streamed.get(item.itemId) ?? "";
            if (text.startsWith(streamed) && text.length > streamed.length) {
              emit({ type: "content.delta", threadId, turnId: active.turnId, itemId: item.itemId, streamKind: "assistant_text", delta: text.slice(streamed.length) });
            }
            if (text) emit({ type: "item.completed", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "assistant_text", text });
          } else if (item.kind === "reasoning") {
            if (!seen) emit({ type: "item.started", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "reasoning" });
          } else if (TOOL_KINDS.has(item.kind)) {
            if (!seen) emit({ type: "item.started", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "tool", ...museToolStart(item) });
            if (!isRunning(item.status) && (!seen || isRunning(seen.status))) {
              emit({ type: "item.completed", threadId, turnId: active.turnId, itemId: item.itemId, itemType: "tool", ...museToolOutput(item) });
            }
          }
          return;
        }
        case "item/delta": {
          if (!active || typeof params.itemId !== "string" || typeof params.delta !== "string") return;
          const item = active.items.get(params.itemId);
          if (item?.kind === "agentMessage" && (params.field === undefined || params.field === "text")) {
            active.streamed.set(params.itemId, (active.streamed.get(params.itemId) ?? "") + params.delta);
            emit({ type: "content.delta", threadId, turnId: active.turnId, itemId: params.itemId, streamKind: "assistant_text", delta: params.delta });
          } else if (item?.kind === "reasoning") {
            emit({ type: "content.delta", threadId, turnId: active.turnId, itemId: params.itemId, streamKind: "reasoning_text", delta: params.delta });
          }
          return;
        }
        case "turn/retryScheduled":
          if (active && params.turnId === active.nativeTurnId) {
            emit({ type: "turn.retrying", threadId, turnId: active.turnId, attempt: Number(params.nextAttempt) || 1,
              delayMs: Number(params.retryDelayMs) || 0, reason: String(params.reason ?? "retry") });
          }
          return;
        case "session/tokenUsage": {
          const usage = asRecord(params.usage);
          if (typeof usage.inputTokens !== "number") return;
          const window = catalog.options.find(option => option.id === (params.modelId ?? state.model))?.contextWindow;
          emit({ type: "thread.token-usage.updated", threadId, ...(active ? { turnId: active.turnId } : {}),
            input: usage.inputTokens, output: Number(usage.outputTokens) || 0,
            ...(typeof usage.cachedTokens === "number" ? { cachedInput: usage.cachedTokens } : {}),
            ...(typeof params.promptTokens === "number" ? { contextTokens: params.promptTokens } : {}),
            ...(window ? { contextWindow: window } : {}) });
          return;
        }
        case "turn/completed": {
          if (!active || params.turnId !== active.nativeTurnId) return;
          const usage = asRecord(params.usage);
          const tokens = typeof usage.inputTokens === "number"
            ? { input: usage.inputTokens, output: Number(usage.outputTokens) || 0, ...(typeof usage.cachedTokens === "number" ? { cachedInput: usage.cachedTokens } : {}) }
            : undefined;
          const terminal = String(params.terminal);
          if (terminal === "completed") finishTurn(state, active, { ok: true, usage: tokens });
          else if (terminal === "cancelled") finishTurn(state, active, { ok: false, stopReason: "interrupted", usage: tokens });
          else failTurn(state, active, String(asRecord(params.error).message ?? params.reason ?? `Muse turn ${terminal}.`));
          return;
        }
        case "approval/requested": {
          const approval = params as unknown as MuseApproval;
          if (!active || !Array.isArray(approval.availableChoices)) return;
          if (state.approvalMode === "allowAll" && answersAlone(approval.subject?.command)) {
            const choice = museChoice(approval.availableChoices, "allow");
            if (choice) void decide(state, approval, choice).catch(() => {});
            return;
          }
          const subject = approval.subject ?? {};
          const command = subject.command;
          state.pending.set(approval.approvalId, { kind: "approval", sessionId: approval.sessionId, approval });
          emit({
            type: "request.opened", threadId, turnId: active.turnId, requestId: approval.approvalId, requestType: "permission",
            tool: approval.toolName || subject.toolName || subject.kind || "tool",
            summary: redactSecretsInText(command ?? subject.path ?? subject.host ?? subject.target ?? approval.toolName ?? "Muse Code asks to continue"),
            ...(command ? { command: { command, cwd: subject.workspaceRoot ?? "" }, commandLine: command } : {}),
            allowSession: Boolean(museChoice(approval.availableChoices, "allow", true)?.decision.startsWith("approvedFor")
              || approval.availableChoices.some(choice => choice.scope === "session")),
          });
          return;
        }
        case "approval/resolved": {
          const approvalId = String(params.approvalId ?? "");
          if (state.pending.delete(approvalId)) {
            emit({ type: "request.resolved", threadId, ...(active ? { turnId: active.turnId } : {}), requestId: approvalId,
              behavior: String(params.decision ?? "").startsWith("approved") ? "allow" : "deny", source: "system" });
          }
          return;
        }
        case "userInput/requested": {
          if (!active || typeof params.userInputId !== "string") return;
          const questions = museQuestions(params.questions);
          if (!questions) return;
          state.pending.set(params.userInputId, { kind: "question", sessionId: String(params.sessionId), userInputId: params.userInputId, questions });
          emit({ type: "request.opened", threadId, turnId: active.turnId, requestId: params.userInputId, requestType: "question",
            tool: String(params.toolName ?? "ask_user"), summary: questions[0].question.question, questions: questions.map(entry => entry.question) });
          return;
        }
      }
    };

    const decide = (state: ThreadState, approval: MuseApproval, choice: MuseChoice) =>
      state.host!.connection.command("approval/decide", {
        sessionId: approval.sessionId, approvalId: approval.approvalId,
        requirementId: approval.currentRequirementId, choiceId: choice.choiceId,
      } as Record<string, unknown>);

    const attach = (state: ThreadState, host: Host) => {
      host.connection.onNotification((notification) => {
        try {
          onNotification(state, host, notification.method, asRecord(notification.params));
        } catch (error) {
          if (state.active) failTurn(state, state.active, error instanceof Error ? error.message : String(error));
        }
      });
      host.connection.onProtocolError((error) => {
        if (state.host === host && state.active) failTurn(state, state.active, `Muse Code protocol error: ${error instanceof Error ? error.message : String(error)}`);
      });
      void host.exited.then(() => {
        if (state.host !== host) return;
        state.host = undefined;
        if (!host.closed && state.active) failTurn(state, state.active, "Muse Code stopped unexpectedly. Send the message again to continue.");
      });
    };

    const closeHost = async (state: ThreadState) => {
      const host = state.host;
      state.host = undefined;
      await host?.close().catch(() => {});
    };

    /** Muse goes on working until it confirms the interrupt; a turn it does not confirm stops only with its host. */
    const endUnconfirmed = async (state: ThreadState, active: ActiveTurn): Promise<void> => {
      if (active.finished || state.active !== active) return;
      await closeHost(state);
      finishTurn(state, active, { ok: false, stopReason: "interrupted" });
    };

    const ensureSession = async (state: ThreadState, turn: SendTurnInput, turnId: string): Promise<{ text: string; rebuilt: boolean; started: boolean }> => {
      const cwd = turn.cwd ?? process.cwd();
      const servers = turnStdioMcpServers(turn);
      const mcpServers = Object.fromEntries(servers.map(server => [server.name,
        { transport: "stdio", command: server.command, args: server.args, env: server.env, mode: "optional" }]));
      const approvalMode = museApprovalMode(turn.approvalMode);
      const key = JSON.stringify([cwd, museServeArgs(turn.approvalMode), servers]);
      if (turn.sessionReset) {
        await closeHost(state);
        state.sessionId = undefined;
      }
      const cursor = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : undefined;
      if (state.host && !state.host.closed && state.host.key === key && state.sessionId && (!cursor || cursor === state.sessionId)) {
        if (state.approvalMode !== approvalMode) {
          await state.host.connection.command("session/setApprovalMode", { sessionId: state.sessionId, mode: approvalMode });
          state.approvalMode = approvalMode;
        }
        return { text: turn.text, rebuilt: false, started: false };
      }
      await closeHost(state);
      const host = await startHost(museServeArgs(turn.approvalMode), cwd, key, servers.length > 0, "bot");
      if (state.active?.turnId !== turnId) {
        await host.close().catch(() => {});
        throw new Error("Muse Code was stopped while it was starting.");
      }
      state.host = host;
      attach(state, host);
      if (servers.length && !host.grantedMcp) {
        emit({ type: "runtime.notice", threadId: state.threadId, turnId,
          message: "This Muse Code cannot take OpenMausBot's tools (browser, teammates, apps). Update Muse Code to use them." });
      }
      const config = servers.length && host.grantedMcp ? { config: { mcpServers } } : {};
      const resumeId = cursor ?? state.sessionId;
      if (resumeId) {
        try {
          await host.connection.command("session/resume", { sessionId: resumeId, excludeItems: true, ...config });
          state.sessionId = resumeId;
          await host.connection.command("session/setApprovalMode", { sessionId: resumeId, mode: approvalMode });
          state.approvalMode = approvalMode;
          return { text: turn.text, rebuilt: false, started: true };
        } catch (error) {
          const kind = error instanceof MspError ? (error as MspError & { kind?: string }).kind : undefined;
          if (kind !== "sessionNotFound" && kind !== "notFound") throw error;
        }
      }
      const model = turn.model || catalog.default;
      const started = asRecord(await host.connection.command("session/start", {
        workspaceRoot: cwd, providerId: PROVIDER_ID, approvalMode, ...(model ? { modelId: model } : {}), ...config,
      }));
      const session = asRecord(started.session);
      if (typeof session.sessionId !== "string") throw new Error("Muse Code started a session without an id.");
      state.sessionId = session.sessionId;
      state.model = typeof session.modelId === "string" ? session.modelId : model;
      state.approvalMode = approvalMode;
      const rebuilt = Boolean(resumeId && turn.recoveryText);
      return { text: rebuilt ? turn.recoveryText! : turn.text, rebuilt, started: true };
    };

    const runTurn = async (state: ThreadState, turn: SendTurnInput, active: ActiveTurn) => {
      const threadId = turn.threadId;
      try {
        const session = await ensureSession(state, turn, active.turnId);
        const host = state.host!;
        const sessionId = state.sessionId!;
        if (session.started) {
          emit({ type: "session.started", threadId, turnId: active.turnId, sessionId, model: state.model ?? turn.model ?? null, ...(session.rebuilt ? { rebuilt: true } : {}) });
        }
        if (turn.model && turn.model !== state.model) {
          await host.connection.command("session/setModel", { sessionId, model: { modelId: turn.model, providerId: PROVIDER_ID } });
          state.model = turn.model;
        }
        const halves = promptHalves(turn);
        let text = session.text;
        if (halves.stable !== null) {
          const receiptKey = JSON.stringify([threadId, sessionId]);
          const composed = splitSessionPrompt(halves.stable, halves.volatile, readPromptSplitReceipt(DRIVER_KIND, receiptKey),
            turn.system, text, Boolean(turn.mentionTurn), RE_ANCHOR_TURNS);
          text = composed.text;
          active.receipt = { key: receiptKey, receipt: composed.receipt };
        } else if (turn.system && session.started) {
          text = `${turn.system}\n\n${text}`;
        }
        const images = await Promise.all((turn.images ?? []).map(async (image) => ({
          type: "image", mediaType: image.mime, base64Data: (await readFile(image.path)).toString("base64"),
        })));
        if (active.finished) return;
        emit({ type: "turn.started", threadId, turnId: active.turnId });
        const effort = museEffort(turn.effort);
        // Notifications may settle the turn before turn/start's answer arrives.
        active.nativeTurnId = host.connection.mintCommandId();
        await host.connection.command("turn/start", {
          sessionId, input: [{ type: "text", text }, ...images], ...(effort ? { reasoningEffort: effort } : {}),
        }, { commandId: active.nativeTurnId });
      } catch (error) {
        failTurn(state, active, error instanceof Error ? error.message : String(error));
      }
    };

    const adapter: ProviderInstance["adapter"] = {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "in-session",
        agentsMcp: true,
        customMcp: true,
        computerMcp: true,
        composioMcp: true,
        browserMcp: true,
        dataMcp: true,
        highlevelMcp: true, deviceMcp: true,
        images: true,
        nativeImageInput: true,
        effortLevels: EFFORT_LEVELS,
        queueing: true,
        strictResume: true,
        localComputerMcp: true,
      },
      async sendTurn(turn) {
        const state = threadOf(turn.threadId);
        if (state.active && !state.active.finished) throw new Error("Muse Code is still working on this thread.");
        const turnId = newId();
        const active: ActiveTurn = { turnId, items: new Map(), streamed: new Map(), finished: false };
        state.active = active;
        void runTurn(state, turn, active);
        return { turnId };
      },
      async interruptTurn(threadId) {
        const state = threads.get(threadId);
        const active = state?.active;
        if (!state || !active || active.finished) return;
        if (active.stopping) return active.stopping;
        if (state.host && state.sessionId && active.nativeTurnId) {
          const interrupt = state.host.connection.command("turn/interrupt", { sessionId: state.sessionId, turnId: active.nativeTurnId });
          const ended = new Promise<void>((resolve) => { active.onFinished = resolve; });
          const stopping = active.stopping = Promise.race([
            interrupt.then(() => ended), // turn/completed (cancelled) settles it
            new Promise((resolve) => setTimeout(resolve, INTERRUPT_CONFIRM_MS).unref?.()),
          ]).catch(() => {}).then(() => endUnconfirmed(state, active));
          return Promise.race([interrupt.then(() => {}, () => stopping), stopping]);
        }
        finishTurn(state, active, { ok: false, stopReason: "interrupted" });
      },
      async respondToRequest(threadId, requestId, decision): Promise<RequestOutcome> {
        const state = threads.get(threadId);
        const pending = state?.pending.get(requestId);
        if (!state?.host || !pending) return "unavailable";
        state.pending.delete(requestId);
        const turnId = state.active?.turnId;
        try {
          if (pending.kind === "approval" && pending.approval) {
            const behavior = decision.behavior === "allow" ? "allow" : "deny";
            const choice = museChoice(pending.approval.availableChoices, behavior, decision.always);
            if (!choice) return "unavailable";
            await decide(state, pending.approval, choice);
            emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior, source: "user" });
            return behavior === "allow" ? "allowed-once" : "rejected";
          }
          if (decision.behavior !== "answer" || !decision.message) {
            await state.host.connection.command("userInput/cancel", { sessionId: pending.sessionId, userInputId: requestId,
              reason: "The person closed this question without answering." });
            emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior: "deny", source: "user" });
            return "rejected";
          }
          const byId = questionAnswersById(decision.message, pending.questions ?? []);
          type Answer = { questionId: string; selectedLabel?: string; selectedLabels?: string[]; freeText?: string };
          const answers = (pending.questions ?? []).flatMap(({ id, question }): Answer[] => {
            const answer = byId[id];
            if (answer === undefined) return [];
            const labels = question.options.map(option => option.label);
            if (question.multiSelect) {
              const picked = answer.split(/,\s*/).filter(label => labels.includes(label));
              return [picked.length ? { questionId: id, selectedLabels: picked } : { questionId: id, freeText: answer }];
            }
            return [labels.includes(answer) ? { questionId: id, selectedLabel: answer } : { questionId: id, freeText: answer }];
          });
          await state.host.connection.command("userInput/answer", { sessionId: pending.sessionId, userInputId: requestId, answers });
          emit({ type: "request.resolved", threadId, ...(turnId ? { turnId } : {}), requestId, behavior: "answer", source: "user" });
          return "answered";
        } catch {
          return "unavailable";
        }
      },
      async steer(threadId, text): Promise<SteerOutcome> {
        const state = threads.get(threadId);
        const active = state?.active;
        if (!state?.host || !state.sessionId || !active?.nativeTurnId || active.finished) return "refused";
        try {
          await state.host.connection.command("turn/steer", { sessionId: state.sessionId, expectedTurnId: active.nativeTurnId,
            input: [{ type: "text", text }] });
          return "steered";
        } catch (error) {
          return error instanceof MspError ? "refused" : "indeterminate";
        }
      },
      hasSession: (threadId) => Boolean(threads.get(threadId)?.sessionId),
      async stopAll() {
        await Promise.all([...threads.values()].map(async (state) => {
          if (state.active) await (state.active.stopping ??= endUnconfirmed(state, state.active));
          await closeHost(state);
        }));
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    void refreshModels();
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() { return catalog; },
      refreshModels,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        version ??= await probeVersion();
        if (version === null) {
          version = undefined;
          return { state: "unavailable", reason: "Muse Code isn't installed on this computer.", authenticated: false };
        }
        if (!signedIn()) {
          return { state: "unavailable", reason: "Sign in to Muse Code: run `muse login` in a terminal.", authenticated: false, version };
        }
        return {
          state: "available", authenticated: true, version, billing: input.environment.META_API_KEY ? "metered" : "subscription",
          ...(!catalogLoaded && catalogError ? { warning: { title: "Muse Code models", message: "Muse Code did not list its models yet; showing the known ones." } } : {}),
          account: { method: input.environment.META_API_KEY ? "api-key" : "login" },
        };
      },
      async dispose() {
        await adapter.stopAll();
        threads.clear();
        listeners.clear();
      },
    };
  },
};
