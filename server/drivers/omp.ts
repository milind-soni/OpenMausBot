// omp — oh-my-pi (@oh-my-pi/pi-coding-agent), the pi fork, as a native engine.
//
// omp speaks pi's JSONL RPC family but with its own lifecycle, so it gets its
// own driver instead of riding piAgent's dialect guesses:
//
// - `omp --mode rpc-ui`: the tool UI context is on, so omp's own `ask` tool
//   reaches OpenMausBot as one question card (`set_ask_dialog`), next to the
//   extension dialogs (approvals, the OpenMausBot extension's host gates).
// - Sessions persist in omp's own store. The resume cursor is the session file
//   `get_state` reports after `new_session`; later turns `switch_session` to
//   it. omp starts a blank session at any path it is handed, so a missing file
//   is a refused resume: the turn rebuilds from recoveryText or fails, never
//   runs blank (capabilities.strictResume).
// - A prompt completes on its `prompt_result`; when background work was still
//   pending at that yield, the turn stays open until `session_settled`.
// - Per-bot approval levels map onto `--approval-mode`, and omp's Approve/Deny
//   select arrives as a permission card the harness can answer for Full access.
// - Usage is summed from every assistant message: cache reads ride inside
//   `input` with `cachedInput` naming them (the Claude convention), plus omp's
//   computed cost.
// - OpenMausBot's integrations mount through the same pi-mcp-extension the pi
//   driver uses, registered top-level rather than as `xd://` devices, and a
//   live local model host is registered for the turn through the extension —
//   the person's ~/.omp/agent/models.yml is never rewritten.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { splitCliString } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { ompVersionBehind, parseOmpVersion, readLatestOmpRelease } from "./omp-release.ts";
import {
  deletePromptSplitReceipt,
  promptHalves,
  readPromptSplitReceipt,
  splitSessionPrompt,
  writePromptSplitReceipt,
} from "./prompt-split.ts";
import type { PromptSplitReceipt } from "./prompt-split.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { classifyResumeFailure, recoveryPromptFor } from "../resume-recovery.ts";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  SteerOutcome,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { EFFORT_LEVELS } from "../../shared/wire.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import {
  parseAskQuestions,
  parseChoices,
  parseProtocolAskQuestions,
  questionAnswersById,
  questionAnswersByQuestion,
  questionChoices,
} from "../../shared/ask-question.ts";
import type { AskQuestion } from "../../shared/ask-question.ts";
import { parseToolScope } from "../../shared/tool-scope.ts";
import { decodeInjectId, hostApiKey, localHost } from "./local-inject.ts";
import { appendNative } from "./native.ts";
import { permissionCommand, permissionLaunchCwd } from "./permission-command.ts";
import {
  applyPiLocalCatalog,
  buildMcpServers,
  piEnvironment,
  piNativeLogMessage,
  piThinkingLevel,
  readPiPromptImages,
  splitPiModel,
} from "./pi.ts";

const DRIVER_KIND = "ompAgent";
const OMP_TURN_ARGS = ["--mode", "rpc-ui"];
const OMP_CATALOG_ARGS = ["--mode", "rpc", "--no-session"];
const OMP_MODEL_REFRESH_ARGS = ["models", "refresh"];
/** Protocol v2 already exists in 18.1.18; 18.4.9 added set_ask_dialog,
 * structured ask answers and dialog cancellation; 18.3.1 added
 * prompt_result.status/sessionSettled and session_settled.
 * Every command we send exists at this floor; none is an optional probe. */
const MIN_OMP_VERSION: readonly [number, number, number] = [18, 4, 9];
/** Same backstop as pi: the full prompt rides again after this many bare
 * turns even when no compaction event announced a history rewrite. */
const OMP_PROMPT_RE_ANCHOR_TURNS = 8;
/** omp flushes its session file when stdin closes; give it that long before
 * the process tree is killed anyway. */
const OMP_EXIT_GRACE_MS = 5_000;
const ASK_TIMEOUT_MS = 15 * 60_000;
// Match the generated clients' ordinary deadline, including slow discovery.
const COMMAND_TIMEOUT_MS = 30_000;
/** A prompt is acknowledged once admitted, which may include image
 * normalization; omp caps that at 20s, so this leaves room for a slow disk. */
const PROMPT_ACK_TIMEOUT_MS = 120_000;
const CATALOG_TIMEOUT_MS = COMMAND_TIMEOUT_MS;
const OMP_APPROVE = "Approve";
const OMP_DENY = "Deny";
const EMPTY: ModelCatalog = { default: "", options: [] };

/** omp answered a command with success:false — an explicit refusal from a
 * live runtime, not a transport failure. */
class OmpRpcRefusalError extends Error {}

const OmpEnvelope = z.looseObject({ type: z.string() });
const OmpReady = z.object({
  type: z.literal("ready"),
  protocolVersion: z.literal(1),
  supportedProtocolVersions: z.array(z.number()).refine((versions) => versions.includes(2)),
  maxFrameBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxReassembledFrameBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const OmpProtocol = z.object({ protocolVersion: z.literal(2) });
const OmpChunk = z.object({
  type: z.literal("rpc_chunk"),
  chunkId: z.string().min(1).max(128),
  index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  count: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  data: z.string().min(1),
});

/** Mirrors omp's RpcFrameDecoder, with the limits advertised by ready and a
 * deadline/EOF check so an unfinished sequence cannot strand a turn. */
class OmpFrameDecoder {
  #limits?: { frame: number; reassembled: number; payload: number };
  #pending?: { chunkId: string; count: number; byteLength: number; nextIndex: number; chunks: Buffer[]; receivedBytes: number };
  #timer?: NodeJS.Timeout;
  readonly #onError: (error: Error) => void;

  constructor(onError: (error: Error) => void) {
    this.#onError = onError;
  }

  dispose() {
    clearTimeout(this.#timer);
    this.#pending = undefined;
  }

  end() {
    const incomplete = this.#pending !== undefined;
    this.dispose();
    if (incomplete) throw new Error("omp RPC transport: incomplete rpc chunk sequence");
  }

  push(value: unknown): unknown {
    const envelope = OmpEnvelope.parse(value);
    if (envelope.type !== "rpc_chunk") {
      if (this.#pending) throw new Error("rpc chunk sequence interrupted");
      if (envelope.type === "ready") {
        const ready = OmpReady.parse(value);
        const frame = Math.min(ready.maxFrameBytes, 1024 * 1024);
        this.#limits = {
          frame,
          reassembled: Math.min(ready.maxReassembledFrameBytes, 64 * 1024 * 1024),
          payload: Math.floor(frame / 4),
        };
      }
      if ((envelope.type === "response" && envelope.success === false && envelope.error === "RPC response exceeded the transport limit")
        || envelope.type === "rpc_frame_error") {
        throw new Error(`omp RPC transport overflow: ${String(envelope.error ?? "RPC frame exceeded the transport limit")}`);
      }
      return value;
    }
    const chunk = OmpChunk.parse(value);
    const limits = this.#limits;
    if (!limits || chunk.index >= chunk.count || chunk.count > Math.ceil(limits.reassembled / limits.payload)
      || chunk.byteLength < limits.frame || chunk.byteLength > limits.reassembled) {
      throw new Error("invalid rpc chunk metadata or reassembly limit exceeded");
    }
    if (chunk.data.length > Math.ceil(limits.payload / 3) * 4) throw new Error("rpc chunk payload exceeds the transport limit");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) {
      throw new Error("invalid rpc chunk data");
    }
    const bytes = Buffer.from(chunk.data, "base64");
    if (bytes.toString("base64") !== chunk.data) throw new Error("invalid rpc chunk data");
    if (bytes.byteLength > limits.payload) throw new Error("rpc chunk payload exceeds the transport limit");
    if (!this.#pending) {
      if (chunk.index !== 0) throw new Error("rpc chunk sequence must start at index 0");
      this.#pending = { chunkId: chunk.chunkId, count: chunk.count, byteLength: chunk.byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
      this.#timer = setTimeout(() => {
        this.dispose();
        this.#onError(new Error("omp RPC transport: rpc chunk sequence timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.#timer.unref?.();
    }
    const pending = this.#pending;
    if (pending.chunkId !== chunk.chunkId || pending.count !== chunk.count
      || pending.byteLength !== chunk.byteLength || pending.nextIndex !== chunk.index) {
      throw new Error("rpc chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;
    if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");
    this.dispose();
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks)));
    OmpEnvelope.parse(decoded);
    return decoded;
  }
}

const OmpModel = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().optional().catch(undefined),
  contextWindow: z.number().optional().catch(undefined),
});
const OmpModels = z.object({ models: z.array(z.unknown()) });
const OmpState = z.object({
  sessionFile: z.string().nullable().optional(),
  model: OmpModel.nullable().optional(),
});
const OmpSessionChange = z.object({ cancelled: z.boolean() });
const OmpPromptAck = z.object({ agentInvoked: z.boolean().optional() });
const OmpAskWireQuestion = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() })),
  multi: z.boolean().default(false),
  recommended: z.number().int().optional(),
});
const OmpUsage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.object({ total: z.number() }),
  contextTokens: z.number().optional(),
});
const OmpMessage = z.object({ role: z.string(), usage: OmpUsage.optional() });
const OmpResponse = z.discriminatedUnion("success", [
  z.object({ type: z.literal("response"), id: z.string().optional(), command: z.string(), success: z.literal(true), data: z.unknown().optional() }),
  z.object({ type: z.literal("response"), id: z.string().optional(), command: z.string(), success: z.literal(false), error: z.string() }),
]);
const OmpUiRequest = z.discriminatedUnion("method", [
  z.object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.literal("select"), title: z.string(), options: z.array(z.string()) }),
  z.object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.literal("confirm"), title: z.string(), message: z.string() }),
  z.object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.enum(["input", "editor"]), title: z.string() }),
  z.object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.literal("ask"), questions: z.array(OmpAskWireQuestion) }),
  z.object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.literal("cancel"), targetId: z.string() }),
]);
/** Validate the fields we consume at the JSONL boundary. Other wire events and
 * presentation-only fields are deliberately ignored, not cast to trusted data. */
const OmpFrameSchema = z.union([
  OmpResponse,
  OmpUiRequest,
  z.object({
    type: z.literal("prompt_result"), id: z.string().optional(), agentInvoked: z.boolean(),
    status: z.enum(["completed", "aborted", "error"]), sessionSettled: z.boolean(),
    error: z.object({ message: z.string(), retryable: z.boolean() }).optional(),
  }),
  z.object({ type: z.literal("session_settled") }),
  z.object({
    type: z.literal("message_update"),
    assistantMessageEvent: z.object({ type: z.enum(["text_delta", "thinking_delta"]), delta: z.string() }),
  }),
  z.object({ type: z.literal("message_end"), message: OmpMessage }),
  z.object({ type: z.literal("tool_execution_start"), toolCallId: z.string(), toolName: z.string(), args: z.unknown().optional() }),
  z.object({ type: z.literal("tool_execution_end"), toolCallId: z.string(), toolName: z.string(), result: z.unknown().optional(), isError: z.boolean().optional() }),
  z.object({ type: z.enum(["auto_compaction_start", "auto_compaction_end"]) }),
]);
type OmpFrame = z.infer<typeof OmpFrameSchema>;

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The OpenMausBot level → omp's `--approval-mode`. omp has no automatic
 * reviewer, so Approve for me asks like Ask (docs/approval-levels.md). Full
 * runs yolo; anything omp still asks (provider safety checks, the
 * extension's host-computer gate) the harness answers for Full access. */
export function ompApprovalMode(mode: ApprovalMode | undefined): "always-ask" | "write" | "yolo" {
  if (mode === "full") return "yolo";
  if (mode === "edits") return "write";
  return "always-ask";
}


function versionAtLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < floor.length; i++) {
    if ((version[i] ?? 0) !== floor[i]) return (version[i] ?? 0) > floor[i]!;
  }
  return true;
}

/** Ask the configured executable to update itself (`omp update`), so a
 * non-PATH omp is updated in place instead of a second copy being installed
 * that OpenMausBot never runs. Quoted for the shell the person pastes into;
 * a real path with spaces stays one token, as resolveCliSpawn treats it. */
export function ompUpdateCommand(cli: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = cli.trim();
  if (trimmed === "omp") return "omp update";
  const tokens = trimmed.includes(" ") && existsSync(trimmed) ? [trimmed] : splitCliString(trimmed);
  const quote = platform === "win32"
    ? (token: string) => `'${token.replace(/'/g, "''")}'`
    : (token: string) => `'${token.replace(/'/g, `'\\''`)}'`;
  const command = (tokens.length > 0 ? tokens : [trimmed]).map(quote).join(" ");
  return platform === "win32" ? `& ${command} update` : `${command} update`;
}

/** The Engines notice for an omp behind the newest stable release. */
async function ompReleaseUpdate(installed: string, cli: string): Promise<ProviderSnapshot["update"] | undefined> {
  const latest = await readLatestOmpRelease();
  if (!latest || !ompVersionBehind(installed, latest)) return undefined;
  return {
    title: `Update omp to ${latest}`,
    message: `A newer omp is available (installed: ${installed}). Update it, then refresh models.`,
    command: ompUpdateCommand(cli),
  };
}

/** omp drives its on-demand tools through `write xd://<device>`. Name such a
 * call after the device, so the activity row and the digest show the tool
 * that ran instead of a file write. Every other call keeps its own name. */
export function ompToolCall(toolName: unknown, args: unknown): { title: string; input: unknown } {
  const name = typeof toolName === "string" && toolName ? toolName : "tool";
  const parsed = z.object({ path: z.string(), content: z.unknown().optional() }).safeParse(args);
  const path = parsed.success ? parsed.data.path : undefined;
  if (name === "write" && path?.startsWith("xd://") && path.length > "xd://".length) {
    return { title: path.slice("xd://".length), input: parsed.success ? parsed.data.content : undefined };
  }
  return { title: name, input: args };
}

/** omp's tool approval is a select titled `Allow tool: <name>` with exactly
 * Approve/Deny (extensions/wrapper.ts). Anything else is a question. */
export function ompApprovalRequest(title: unknown, options: unknown): { tool: string; summary: string } | null {
  if (!Array.isArray(options) || options.length !== 2 || options[0] !== OMP_APPROVE || options[1] !== OMP_DENY) return null;
  const lines = String(title ?? "").split("\n");
  const head = /^Allow tool: (.+)$/.exec(lines[0]?.trim() ?? "");
  if (!head) return null;
  const tool = head[1]!.trim();
  const detail = lines.slice(1).join("\n").trim();
  return { tool, summary: detail || tool };
}

/** The part of an omp `ask` question its answer is validated against. */
export interface OmpAskQuestion {
  id: string;
  options: Array<{ label: string }>;
  multi?: boolean;
}

export interface OmpAskAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

/** One card label → the exact omp option label, compared the way the card
 * trimmed and capped it. Two labels that read alike are never guessed. */
function exactOption(labels: readonly string[], answer: string): string | undefined {
  const matches = labels.filter((label) => label.trim().slice(0, 120).trim() === answer.trim());
  return matches.length === 1 ? matches[0] : undefined;
}

/** The person's single card reply → omp's per-question `answers`, in request
 * order with every id present (omp rejects anything else). A picked label is
 * sent as the option itself, anything else as free text; a multi-select
 * answer is the card's ", "-joined list, rebuilt greedily so a label that
 * itself contains ", " still matches. An unanswered question is left empty. */
export function ompAskAnswers(questions: readonly OmpAskQuestion[], byId: Record<string, string>): OmpAskAnswer[] {
  return questions.map((question) => {
    const labels = question.options.map((option) => option.label);
    const answer = byId[question.id]?.trim();
    if (!answer) return { id: question.id, selectedOptions: [] };
    if (!question.multi) {
      const picked = exactOption(labels, answer);
      return picked ? { id: question.id, selectedOptions: [picked] } : { id: question.id, selectedOptions: [], customInput: answer };
    }
    const parts = answer.split(", ");
    const selected: string[] = [];
    const custom: string[] = [];
    for (let i = 0; i < parts.length;) {
      let matched = false;
      for (let j = parts.length; j > i; j--) {
        const picked = exactOption(labels, parts.slice(i, j).join(", "));
        if (picked && !selected.includes(picked)) {
          selected.push(picked);
          i = j;
          matched = true;
          break;
        }
      }
      if (!matched) custom.push(parts[i++]!);
    }
    return custom.length
      ? { id: question.id, selectedOptions: selected, customInput: custom.join(", ") }
      : { id: question.id, selectedOptions: selected };
  });
}

/** `get_available_models` + `get_state` data → the picker catalog. Every
 * option is `custom` (omp is BYOK) and keyed `provider/id`, the form
 * `set_model` splits; the default is the model omp itself would run. */
export function parseOmpCatalog(models: unknown, state: unknown): ModelCatalog {
  const options: ModelCatalog["options"] = [];
  const parsed = OmpModels.safeParse(models);
  for (const row of parsed.success ? parsed.data.models : []) {
    const model = OmpModel.safeParse(row);
    if (!model.success) continue;
    const { provider, id, name, contextWindow } = model.data;
    options.push({
      id: `${provider}/${id}`,
      label: name || id,
      custom: true,
      provider,
      ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    });
  }
  const current = OmpState.safeParse(state);
  const model = current.success ? current.data.model : null;
  const currentId = model ? `${model.provider}/${model.id}` : "";
  const def = options.some((option) => option.id === currentId) ? currentId : (options[0]?.id ?? "");
  return { default: def, options };
}

/** A failed probe is distinct from a successful empty catalog (signed out). */
export async function fetchOmpModels(cli: string, env: Record<string, string | undefined>): Promise<ModelCatalog | null> {
  let resolve!: (catalog: ModelCatalog | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ModelCatalog | null>((done, fail) => { resolve = done; reject = fail; });
  const child = spawnCli(cli, OMP_CATALOG_ARGS, { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume();
  let buf = "";
  let done = false;
  let state: unknown;
  let models: unknown;
  const finish = (catalog: ModelCatalog | null = null, error?: Error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    decoder.dispose();
    try {
      killCliTree(child);
    } catch {
      /* already gone */
    }
    if (error) reject(error);
    else resolve(catalog);
  };
  const decoder = new OmpFrameDecoder((error) => finish(null, error));
  const timer = setTimeout(() => finish(null, new Error("omp catalog probe timed out")), CATALOG_TIMEOUT_MS);
  timer.unref?.();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (done || !line.trim()) continue;
      let frame: unknown;
      try {
        frame = decoder.push(JSON.parse(line));
      } catch (error) {
        finish(null, new Error(`omp RPC transport: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const parsed = OmpResponse.safeParse(frame);
      if (!parsed.success) continue;
      const response = parsed.data;
      if (!response.success) {
        finish(null, response.id === "protocol" ? new Error(`omp protocol negotiation failed: ${response.error}`) : undefined);
        return;
      }
      if (response.id === "protocol") {
        try {
          OmpProtocol.parse(response.data);
          child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
          child.stdin.write(JSON.stringify({ id: "models", type: "get_available_models" }) + "\n");
        } catch (error) {
          finish(null, new Error(`omp protocol negotiation failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (response.id === "state") {
        const parsedState = OmpState.safeParse(response.data);
        if (!parsedState.success) { finish(); return; }
        state = parsedState.data;
      }
      if (response.id === "models") {
        const parsedModels = OmpModels.safeParse(response.data);
        if (!parsedModels.success) { finish(); return; }
        models = parsedModels.data;
      }
      if (state !== undefined && models !== undefined) finish(parseOmpCatalog(models, state));
    }
  });
  child.on("error", () => finish());
  child.stdin.on("error", () => finish());
  child.stdout.on("end", () => {
    if (done) return;
    try { decoder.end(); }
    catch (error) { finish(null, error instanceof Error ? error : new Error(String(error))); }
  });
  child.on("close", () => finish());
  try {
    child.stdin.write(JSON.stringify({ id: "protocol", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");
  } catch {
    finish();
  }
  return promise;
}

/** Refresh omp's provider-owned model cache (`omp models refresh`). Only the
 * explicit Refresh action calls this; failure keeps the last catalog. */
export async function refreshOmpModelCatalog(cli: string, env: Record<string, string | undefined>): Promise<boolean> {
  return new Promise((resolve) => {
    execCli(cli, OMP_MODEL_REFRESH_ARGS, { env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error) => resolve(!error));
  });
}

export interface OmpConfig {
  cli: string;
}

const OmpConfigSchema = z.object({ cli: z.string().optional() });
function decodeConfig(raw: unknown): OmpConfig {
  const { cli } = OmpConfigSchema.parse(raw ?? {});
  return { cli: cli?.trim() || "omp" };
}


type Decision = { behavior: "allow" | "deny" | "answer"; message?: string };
type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
/** A card's own fields; the driver adds ids, timestamps and the type. */
type RequestCard = Pick<RequestOpened, "requestType" | "tool" | "summary" | "command" | "choices" | "questions" | "approvalScope">;

export const OmpDriver: ProviderDriver<OmpConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "omp", supportsMultipleInstances: true, access: "custom" },
  install: {
    command: {
      darwin: "curl -fsSL https://omp.sh/install | sh",
      linux: "curl -fsSL https://omp.sh/install | sh",
      win32: "irm https://omp.sh/install.ps1 | iex",
    },
    docsUrl: "https://github.com/can1357/oh-my-pi",
    signInCommand: "omp login",
  },
  models: EMPTY,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OmpConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const catalogEnv = piEnvironment({ ...process.env, ...input.environment });
    let ompModels = EMPTY;
    let models = EMPTY;
    let catalogError: string | null = null;
    // omp lists only models it holds credentials for; the local hosts merged
    // in below say nothing about whether omp itself is signed in.
    let signedIn = false;
    const readModels = async () => {
      let base = ompModels;
      try {
        const resolved = await fetchOmpModels(config.cli, catalogEnv);
        if (resolved) {
          catalogError = null;
          ompModels = base = resolved;
          signedIn = resolved.options.length > 0;
        }
      } catch (error) {
        catalogError = error instanceof Error ? error.message : String(error);
        // Keep the last usable catalog when the probe fails.
      }
      try {
        models = await applyPiLocalCatalog(base, catalogEnv);
      } catch {
        models = base;
      }
    };
    const refreshModels = async () => {
      await refreshOmpModelCatalog(config.cli, catalogEnv);
      await readModels();
    };
    await readModels();

    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, {
      stop: () => void;
      turnId: string;
      pending: Map<string, (decision: Decision) => void>;
      steer: (text: string) => Promise<SteerOutcome>;
    }>();
    // A completed turn can still be flushing its session on EOF. Keep the
    // child owned until close, and serialize the next turn behind that close.
    const children = new Map<string, { closed: Promise<void>; kill: () => Promise<boolean> }>();
    let disposed = false;

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      const selection = parseToolScope(turn.toolScope);
      if (!selection.ok) throw new Error(selection.error);
      const toolScope = selection.scope;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      await children.get(threadId)?.closed;
      if (disposed) throw new Error("omp instance disposed");
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      // Like codex and the ACP engines: a turn that mounts the real Mac stamps
      // every permission card, so remembered grants never cover it.
      const approvalScope = turn.integrations?.localComputer?.scope === "local-computer" ? ("local-computer" as const) : undefined;
      const turnId = newId();
      const pending = new Map<string, (decision: Decision) => void>();
      const askTimers = new Map<string, NodeJS.Timeout>();
      let settled = false;
      // Read before spawning: an attachment that disappeared is one clear
      // dispatch error, not a child that can never receive its prompt.
      const images = readPiPromptImages(turn);
      const childEnv = { ...process.env, ...input.environment };

      const inject = typeof turn.model === "string" ? decodeInjectId(turn.model) : null;
      const host = inject ? localHost(inject.host) : undefined;
      const localProvider = inject && host
        ? { name: host.id, baseUrl: host.baseUrl, apiKey: hostApiKey(host, childEnv), model: inject.model }
        : undefined;

      // Integrations, tool scope and a local model host reach omp through the
      // extension. The config carries credentials, so it lives in a 0600 temp
      // file removed once the child is gone — never on argv.
      const mcpServers = buildMcpServers(turn);
      let mcpTempDir: string | null = null;
      let scopeReadyPath: string | undefined;
      if (mcpServers || toolScope !== undefined || localProvider) {
        mcpTempDir = mkdtempSync(join(tmpdir(), "omb-omp-mcp-"));
        if (toolScope !== undefined) scopeReadyPath = join(mcpTempDir, "scope-ready.json");
        try {
          writeFileSync(
            join(mcpTempDir, "mcp.json"),
            JSON.stringify({ mcpServers: mcpServers ?? {}, toolScope, scopeReadyPath, approvalMode: turn.approvalMode, localProvider }),
            { mode: 0o600 },
          );
        } catch (err) {
          rmSync(mcpTempDir, { recursive: true, force: true });
          throw err;
        }
      }
      const removeTempDir = () => {
        if (!mcpTempDir) return;
        try {
          rmSync(mcpTempDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        mcpTempDir = null;
      };
      const childArgs = [
        ...OMP_TURN_ARGS,
        "--approval-mode",
        ompApprovalMode(turn.approvalMode),
        ...(mcpTempDir ? ["-e", SPAWNED_PROXIES.piMcpExtension] : []),
      ];

      const child = (() => {
        try {
          return spawnCli(config.cli, childArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: turn.cwd,
            env: piEnvironment({
              ...childEnv,
              ...(mcpTempDir ? { OMB_MCP_CONFIG: join(mcpTempDir, "mcp.json") } : {}),
            }),
          });
        } catch (err) {
          removeTempDir();
          throw err;
        }
      })();
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
      children.set(threadId, { closed, kill: () => killCliTree(child) });
      // Drained so a chatty omp never blocks on a full pipe; the tail
      // explains an unexpected exit.
      let stderrTail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2_000);
      });

      let buf = "";
      let assistantText = "";
      let compactionObserved = false;
      let sessionFile: string | null = null;
      let promptId: string | null = null;
      let promptResult: { status: string; error?: string } | null = null;
      const usage = { input: 0, output: 0, cachedInput: 0, cost: 0, seen: false, costSeen: false };
      const contextWindow = models.options.find((option) => option.id === turn.model)?.contextWindow;
      // In-flight tool calls, so an approval for `bash` can carry the exact
      // command it would run (for saved-command grants).
      const running = new Map<string, { toolName: string; args: unknown }>();
      let seq = 0;
      const waiters = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
      const rejectWaiters = (err: Error) => {
        for (const waiter of waiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        waiters.clear();
      };
      child.stdin.on("error", () => rejectWaiters(new Error("omp stdin closed")));
      const send = (frame: Record<string, unknown>) => {
        appendNative(threadId, { dir: "out", source: "omp.rpc", msg: piNativeLogMessage(frame) });
        child.stdin.write(JSON.stringify(frame) + "\n");
      };
      /** Send one command and wait for the response carrying its id. Once
       * the turn has settled (the child died, Stop) nothing will answer, so
       * the handshake fails at once instead of waiting out a timeout. */
      const request = (frame: Record<string, unknown> & { type: string }, timeoutMs = COMMAND_TIMEOUT_MS) => {
        const id = `${frame.type}:${++seq}`;
        if (settled) return { id, answered: Promise.reject<unknown>(new Error("turn settled")) };
        const answered = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(id);
            reject(new Error(`omp ${frame.type} timed out`));
          }, timeoutMs);
          timer.unref?.();
          waiters.set(id, { resolve, reject, timer });
        });
        try {
          send({ ...frame, id });
        } catch (error) {
          const waiter = waiters.get(id);
          if (waiter) {
            clearTimeout(waiter.timer);
            waiters.delete(id);
            waiter.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return { id, answered };
      };

      const flushAssistantText = () => {
        const text = assistantText;
        assistantText = "";
        if (!text.trim()) return;
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
      };

      let exitTimer: NodeJS.Timeout | undefined;
      const settle = (ok: boolean, stopReason?: string) => {
        if (settled) return;
        settled = true;
        decoder.dispose();
        for (const timer of askTimers.values()) clearTimeout(timer);
        askTimers.clear();
        pending.clear();
        rejectWaiters(new Error("turn settled"));
        flushAssistantText();
        active.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok,
          stopReason: stopReason ?? (ok ? "end_turn" : "failed"),
          ...(usage.costSeen ? { cost: usage.cost } : {}),
          ...(usage.seen ? { usage: { input: usage.input, output: usage.output, cachedInput: usage.cachedInput } } : {}),
        });
        // omp persists the session on a clean stdin EOF; kill only a child
        // that does not leave in time.
        if (child.exitCode !== null || child.signalCode !== null) {
          removeTempDir();
          return;
        }
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
        exitTimer = setTimeout(() => {
          try {
            killCliTree(child);
          } catch {
            /* already gone */
          }
        }, OMP_EXIT_GRACE_MS);
        exitTimer.unref?.();
      };
      const fail = (message: string) => {
        if (settled) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message: message.slice(0, 2_000) });
        settle(false);
      };
      const finishRun = () => {
        if (!promptResult) return;
        if (promptResult.status === "error") fail(promptResult.error ?? "omp turn failed");
        else settle(true, promptResult.status === "aborted" ? "cancelled" : "end_turn");
      };

      const stop = () => {
        if (settled) return;
        try {
          send({ type: "abort", id: `abort:${++seq}` });
        } catch {
          /* ignore */
        }
        settle(true, "cancelled");
      };

      // Mid-turn input rides omp's steer frame. success:false is an explicit
      // refusal (safe to re-queue); a timeout or death after the write is
      // indeterminate, so the caller never runs the words twice.
      const steer = async (text: string): Promise<SteerOutcome> => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return "refused";
        let ack: Promise<unknown>;
        try {
          ack = request({ type: "steer", message: text }).answered;
        } catch {
          return "refused";
        }
        try {
          await ack;
          return "steered";
        } catch (error) {
          return error instanceof OmpRpcRefusalError ? "refused" : "indeterminate";
        }
      };
      active.set(threadId, { stop, turnId, pending, steer });

      /** Open a card, hold the answer callback, and fail it safe after 15
       * minutes. Registered before emitting: the harness may answer from
       * inside its synchronous request.opened listener. */
      const openRequest = (uiId: string, card: RequestCard, answer: (decision: Decision) => Record<string, unknown>) => {
        if (settled) return;
        flushAssistantText();
        let timer: NodeJS.Timeout | undefined;
        pending.set(uiId, (decision) => {
          if (timer) {
            clearTimeout(timer);
            askTimers.delete(uiId);
          }
          send({ type: "extension_ui_response", id: uiId, ...answer(decision) });
        });
        timer = setTimeout(() => {
          askTimers.delete(uiId);
          if (settled || !pending.delete(uiId)) return;
          // A timedOut ask chooses recommended options inside omp. Our card
          // deadline must instead deny exactly as an explicit cancellation.
          send({ type: "extension_ui_response", id: uiId, ...answer({ behavior: "deny" }) });
          emit({
            ...base(threadId, turnId),
            requestId: uiId,
            type: "request.resolved",
            behavior: "deny",
            source: "timeout",
            ...(card.approvalScope ? { approvalScope: card.approvalScope } : {}),
          });
        }, ASK_TIMEOUT_MS);
        askTimers.set(uiId, timer);
        timer.unref?.();
        emit({ ...base(threadId, turnId), requestId: uiId, type: "request.opened", ...card });
      };

      const onUiRequest = (evt: z.infer<typeof OmpUiRequest>) => {
        if (settled) return;
        const uiId = evt.id;
        const title = "title" in evt ? evt.title : "";
        switch (evt.method) {
          case "select": {
            const approval = ompApprovalRequest(evt.title, evt.options);
            if (approval) {
              // The call omp is asking about already started; when it is the
              // only shell call in flight its args are the exact command.
              const shell = approval.tool === "bash" ? [...running.values()].filter((call) => call.toolName === "bash") : [];
              const args = shell.length === 1 ? shell[0]!.args : undefined;
              const shellArgs = z.object({ command: z.unknown().optional(), cwd: z.unknown().optional() }).safeParse(args);
              const shellCommand = shellArgs.success ? shellArgs.data.command : undefined;
              const cwd = (shellArgs.success ? shellArgs.data.cwd : undefined) ?? (turn.cwd ? permissionLaunchCwd(turn.cwd) : undefined);
              const command = permissionCommand(shellCommand, cwd);
              openRequest(uiId, {
                requestType: "permission",
                tool: approval.tool,
                summary: (typeof shellCommand === "string" ? shellCommand : approval.summary).slice(0, 2_000),
                ...(command ? { command } : {}),
                ...(approvalScope ? { approvalScope } : {}),
              }, (decision) => ({ value: decision.behavior === "allow" ? OMP_APPROVE : OMP_DENY }));
              return;
            }
            const options = (evt.options ?? []).filter((option): option is string => typeof option === "string");
            const summary = (title || "omp has a question").slice(0, 200);
            const question = (parseAskQuestions({ questions: [{ question: summary, options }] }) ?? [])[0];
            const choices = question?.options.length ? question.options.map((option) => option.label) : undefined;
            openRequest(uiId, {
              requestType: "question",
              tool: "ask_user",
              summary,
              ...(choices ? { choices } : {}),
              ...(question ? { questions: [question] } : {}),
            }, (decision) => {
              if (decision.behavior === "deny") return { cancelled: true };
              const value = question
                ? questionAnswersByQuestion(decision.message ?? "", [question])[question.question] ?? decision.message ?? ""
                : decision.message ?? "";
              // Display labels are trimmed and capped; omp wants the option.
              const matched = options.filter((option) => parseChoices([option], 1)?.[0] === value);
              return matched.length > 1 ? { cancelled: true } : { value: matched[0] ?? value };
            });
            return;
          }
          case "input":
          case "editor": {
            const summary = (title || "omp has a question").slice(0, 200);
            openRequest(uiId, { requestType: "question", tool: "ask_user", summary }, (decision) =>
              decision.behavior === "deny" ? { cancelled: true } : { value: decision.message ?? "" });
            return;
          }
          case "confirm": {
            const detail = typeof evt.message === "string" ? evt.message : "";
            openRequest(uiId, {
              requestType: "permission",
              tool: title || "omp",
              summary: [title, detail].filter(Boolean).join(" — ").slice(0, 200) || "omp wants confirmation",
              ...(approvalScope ? { approvalScope } : {}),
            }, (decision) => ({ confirmed: decision.behavior === "allow" }));
            return;
          }
          case "ask": {
            const raw = evt.questions;
            const asked: OmpAskQuestion[] = raw;
            // OpenMausBot's card reads multiSelect; omp calls it multi.
            const protocol = parseProtocolAskQuestions(raw.map((entry) => ({ ...entry, multiSelect: entry.multi })));
            // omp validates one answer per question it asked; a set the card
            // cannot carry whole is closed rather than answered partially.
            if (!protocol || asked.length !== raw.length || protocol.length !== raw.length) {
              send({ type: "extension_ui_response", id: uiId, cancelled: true });
              emit({ ...base(threadId, turnId), type: "runtime.notice", message: "omp's questions were declined because the complete question set could not be shown. Ask for at most six questions with distinct ids." });
              return;
            }
            const cards: AskQuestion[] = protocol.map((pair) => pair.question);
            const choices = questionChoices(cards);
            openRequest(uiId, {
              requestType: "question",
              tool: "ask_user",
              summary: cards.map((question) => question.question).join(" · ").slice(0, 200),
              questions: cards,
              ...(choices ? { choices } : {}),
            }, (decision) => decision.behavior === "answer"
              ? { answers: ompAskAnswers(asked, questionAnswersById(decision.message ?? "", protocol)) }
              : { cancelled: true });
            return;
          }
          case "cancel": {
            // omp closed its own dialog (timeout or abort): the card goes too.
            const target = typeof evt.targetId === "string" ? evt.targetId : "";
            if (target && pending.delete(target)) {
              clearTimeout(askTimers.get(target));
              askTimers.delete(target);
              emit({ ...base(threadId, turnId), requestId: target, type: "request.resolved", behavior: "deny", source: "system" });
            }
            return;
          }
          default:
            // notify / setStatus / setWidget / setTitle / set_editor_text are
            // TUI bookkeeping with no answer.
            return;
        }
      };

      const onFrame = (evt: OmpFrame) => {
        if (settled) return;
        switch (evt.type) {
          case "response": {
            const waiter = typeof evt.id === "string" ? waiters.get(evt.id) : undefined;
            if (!waiter) return;
            waiters.delete(evt.id!);
            clearTimeout(waiter.timer);
            if (evt.success) waiter.resolve(evt.data);
            else waiter.reject(new OmpRpcRefusalError(evt.error));
            return;
          }
          case "prompt_result": {
            if (evt.id !== promptId || settled) return;
            promptResult = { status: evt.status, ...(evt.error ? { error: evt.error.message } : {}) };
            // Background work (an auto-backgrounded command, an async task)
            // can still wake the agent: the turn ends at session_settled.
            if (evt.sessionSettled) finishRun();
            return;
          }
          case "session_settled":
            finishRun();
            return;
          case "message_update": {
            const e = evt.assistantMessageEvent;
            if (e?.type === "text_delta" && typeof e.delta === "string") {
              assistantText += e.delta;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: e.delta });
            } else if (e?.type === "thinking_delta" && typeof e.delta === "string") {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: e.delta });
            }
            return;
          }
          case "message_end": {
            if (evt.message.role !== "assistant" || !evt.message.usage) return;
            const u = evt.message.usage;
            const fresh = count(u.input);
            const cacheRead = count(u.cacheRead);
            const output = count(u.output);
            const cost = u.cost.total;
            usage.seen = true;
            usage.input += fresh + cacheRead;
            usage.cachedInput += cacheRead;
            usage.output += output;
            if (typeof cost === "number" && Number.isFinite(cost)) {
              usage.costSeen = true;
              usage.cost += cost;
            }
            emit({
              ...base(threadId, turnId),
              type: "thread.token-usage.updated",
              input: fresh + cacheRead,
              output,
              cachedInput: cacheRead,
              // this call's prompt is what fills the window: fresh text plus
              // cache reads and writes, unless omp reports it outright
              contextTokens: count(u.contextTokens) || fresh + cacheRead + count(u.cacheWrite),
              ...(contextWindow ? { contextWindow } : {}),
            });
            return;
          }
          case "tool_execution_start": {
            flushAssistantText();
            if (evt.toolCallId) running.set(evt.toolCallId, { toolName: String(evt.toolName ?? ""), args: evt.args });
            const call = ompToolCall(evt.toolName, evt.args);
            emit({
              ...base(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: evt.toolCallId,
              title: call.title.slice(0, 80),
              summary: commandSummary(call.input),
              input: toolDetailPreview(call.input),
            });
            return;
          }
          case "tool_execution_end": {
            if (evt.toolCallId) running.delete(evt.toolCallId);
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "tool",
              itemId: evt.toolCallId,
              ok: !evt.isError,
              output: toolDetailPreview(evt.result),
            });
            return;
          }
          case "extension_ui_request":
            onUiRequest(evt);
            return;
          case "auto_compaction_start":
          case "auto_compaction_end":
            // A summarized history may have absorbed the turn that carried
            // the standing prompt: the next turn sends it in full again.
            if (sessionFile) {
              compactionObserved = true;
              deletePromptSplitReceipt("omp", JSON.stringify([threadId, sessionFile]));
            }
            return;
          default:
            return;
        }
      };

      const decoder = new OmpFrameDecoder((error) => fail(error.message));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (settled || !line.trim()) continue;
          try {
            const raw = decoder.push(JSON.parse(line));
            if (raw === undefined) continue;
            appendNative(threadId, { dir: "in", source: "omp.rpc", msg: raw });
            const frame = OmpFrameSchema.safeParse(raw);
            if (frame.success) onFrame(frame.data);
          } catch (error) {
            fail(`omp RPC transport: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });
      child.stdout.on("end", () => {
        if (settled) return;
        try { decoder.end(); }
        catch (error) { fail(error instanceof Error ? error.message : String(error)); }
      });
      child.on("error", (err) => {
        const failure = describeSpawnFailure(err as NodeJS.ErrnoException, config.cli);
        rejectWaiters(new Error(failure.message));
        if (settled) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message: failure.message, setup: failure.setup });
        settle(false);
      });
      child.on("close", () => {
        clearTimeout(exitTimer);
        removeTempDir();
        children.delete(threadId);
        resolveClosed();
        rejectWaiters(new Error("omp process exited before replying"));
        const tail = stderrTail.trim().split("\n").slice(-3).join("\n");
        fail(`omp exited before finishing the turn${tail ? `: ${tail}` : ""}`);
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });

      try {
        // Even the 18.4.9 floor supports v2. Wait for its acknowledgement
        // before requesting anything that could exceed the v1 frame limit.
        OmpProtocol.parse(await request({ type: "negotiate_protocol", protocolVersion: 2 }).answered);
        // Every supported omp has set_ask_dialog; refusal is a real setup
        // failure, not an optional probe with a legacy select fallback.
        await request({ type: "set_ask_dialog", enabled: true }).answered;

        const cursor = !turn.sessionReset && typeof turn.resumeCursor === "string" && turn.resumeCursor ? turn.resumeCursor : null;
        let resumed = false;
        let rebuilt = false;
        let promptText = turn.text;
        if (cursor) {
          // omp opens a blank session at a path that does not exist, so a
          // missing file is a refused resume, decided before omp sees it.
          let refused = !existsSync(cursor);
          if (!refused) {
            try {
              const switched = OmpSessionChange.parse(await request({ type: "switch_session", sessionPath: cursor }).answered);
              const state = OmpState.parse(await request({ type: "get_state" }).answered);
              refused = switched.cancelled || state.sessionFile !== cursor;
              resumed = !refused;
            } catch (error) {
              if (!(error instanceof OmpRpcRefusalError)) throw error;
              refused = true;
            }
          }
          if (refused) {
            if (!turn.recoveryText?.trim()) {
              fail("omp could not reopen this conversation's session. Start a new conversation to continue.");
              return { turnId };
            }
            const rebuild = recoveryPromptFor({
              recoveryText: turn.recoveryText,
              currentText: turn.text,
              failure: classifyResumeFailure({ attempted: true, rejected: true, promptSubmitted: false, producedOutput: false }),
            });
            rebuilt = rebuild.replayed;
            promptText = rebuild.text;
          }
        }
        if (!resumed) {
          const created = OmpSessionChange.parse(await request({ type: "new_session" }).answered);
          if (created.cancelled) throw new OmpRpcRefusalError("omp refused to start a new session");
        }
        const state = OmpState.parse(await request({ type: "get_state" }).answered);
        sessionFile = state.sessionFile || null;
        emit({
          ...base(threadId, turnId),
          type: "session.started",
          sessionId: sessionFile,
          model: turn.model ?? null,
          ...(rebuilt ? { rebuilt: true } : {}),
        });

        // The picked model must be the one that runs: a refused pick fails
        // the turn instead of quietly spending on omp's default.
        const chosen = typeof turn.model === "string" ? splitPiModel(turn.model) : null;
        if (chosen) {
          try {
            await request({ type: "set_model", provider: chosen.provider, modelId: chosen.modelId }).answered;
          } catch (error) {
            fail(error instanceof OmpRpcRefusalError
              ? `omp cannot run ${turn.model}: ${error.message}. Pick another model, or sign in with \`omp login\`.`
              : `omp did not confirm the model ${turn.model}.`);
            return { turnId };
          }
        }
        // The level set is model-dependent; a refusal keeps omp's default.
        if (turn.effort) {
          await request({ type: "set_thinking_level", level: piThinkingLevel(turn.effort) }).answered.catch(() => undefined);
        }

        if (scopeReadyPath) {
          let ready = false;
          try {
            const receipt = z.object({ ok: z.boolean(), toolScope: z.unknown() }).parse(JSON.parse(readFileSync(scopeReadyPath, "utf8")));
            ready = receipt.ok && JSON.stringify(receipt.toolScope) === JSON.stringify(toolScope);
          } catch { /* Missing or malformed readiness is never a grant. */ }
          if (!ready) {
            fail("omp tool selection enforcement is unavailable. Update omp and check the OpenMausBot extension before retrying.");
            return { turnId };
          }
        }

        // Same stable/volatile split as pi: the full prompt rides the turn
        // that establishes (or re-instructs) this omp session, receipts are
        // keyed by its session file, and compaction drops the receipt.
        const halves = promptHalves(turn);
        let message: string;
        let pendingReceipt: { key: string; receipt: PromptSplitReceipt } | null = null;
        if (halves.stable !== null && sessionFile) {
          const key = JSON.stringify([threadId, sessionFile]);
          const composed = splitSessionPrompt(
            halves.stable,
            halves.volatile,
            readPromptSplitReceipt("omp", key),
            turn.system,
            promptText,
            Boolean(turn.mentionTurn),
            OMP_PROMPT_RE_ANCHOR_TURNS,
          );
          message = composed.text;
          pendingReceipt = { key, receipt: composed.receipt };
        } else {
          message = turn.system ? `${turn.system}\n\n${promptText}` : promptText;
        }
        const prompt = request({ type: "prompt", message, ...(images.length ? { images } : {}) }, PROMPT_ACK_TIMEOUT_MS);
        promptId = prompt.id;
        void prompt.answered.then(
          (data) => {
            const ack = OmpPromptAck.safeParse(data ?? {});
            if (!ack.success) { fail("omp returned an invalid prompt acknowledgement"); return; }
            if (ack.data.agentInvoked === false) {
              // Local commands can rewrite history (/compact, /branch, ...),
              // without auto-compaction events. They never deliver standing
              // instructions to the agent, so cannot establish a receipt.
              if (sessionFile) deletePromptSplitReceipt("omp", JSON.stringify([threadId, sessionFile]));
              settle(true, "end_turn");
              return;
            }
            if (pendingReceipt && !compactionObserved) {
              try {
                writePromptSplitReceipt("omp", pendingReceipt.key, pendingReceipt.receipt);
              } catch {
                /* an unwritten receipt only re-delivers the full prompt next turn */
              }
            }
          },
          (error: Error) => fail(String(error?.message ?? error)),
        );
      } catch (error) {
        fail(String((error as Error)?.message ?? error));
      }
      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      let resolve!: (output: string | null) => void;
      const promise = new Promise<string | null>((done) => (resolve = done));
      const child = spawnCli(config.cli, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: catalogEnv });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (out += c));
      const timer = setTimeout(() => {
        try {
          killCliTree(child);
        } catch {
          /* ignore */
        }
        resolve(null);
      }, 8000);
      timer.unref?.();
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out.trim() || null);
      });
      const output = await promise;
      if (!output) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const version = parseOmpVersion(output);
      if (version && (!versionAtLeast(version.parts, MIN_OMP_VERSION)
        || (version.prerelease && version.parts.join(".") === MIN_OMP_VERSION.join(".")))) {
        const floor = MIN_OMP_VERSION.join(".");
        return {
          state: "unavailable",
          version: output,
          reason: `omp ${version.version} is too old; OpenMausBot needs ${floor} or newer.`,
          // Known without a network check: this omp cannot run a turn at all.
          update: {
            title: `Update omp to ${floor} or newer`,
            message: `omp ${version.version} predates the prompt lifecycle and question dialogs OpenMausBot relies on. Update it, then refresh Engines.`,
            command: ompUpdateCommand(config.cli),
          },
        };
      }
      const update = await ompReleaseUpdate(output, config.cli);
      if (catalogError && !signedIn) return { state: "unavailable", version: output, reason: catalogError, ...(update ? { update } : {}) };
      // An empty omp catalog means nothing is signed in yet (`omp login`).
      return { state: "available", version: output, authenticated: signedIn, ...(update ? { update } : {}) };
    };

    const stopAll = async () => {
      for (const { stop } of active.values()) stop();
      // Shutdown cannot depend on an unref'd grace timer surviving the server.
      await Promise.all([...children.values()].map(({ kill }) => kill()));
    };
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          // set per turn with set_model before the prompt
          sessionModelSwitch: "in-session",
          // integrations mount through the OpenMausBot extension
          agentsMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          customMcp: true,
          browserMcp: true,
          // host control asks through the extension's confirm card
          localComputerMcp: true,
          images: true,
          nativeImageInput: true,
          effortLevels: EFFORT_LEVELS,
          queueing: true,
          strictResume: true,
          // omp compacts the session file in place (`compaction.*` in its
          // own config) and announces it with auto_compaction_* events.
          selfCompaction: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const entry = active.get(threadId);
          const answer = entry?.pending.get(requestId);
          if (!entry || !answer) return "unavailable";
          entry.pending.delete(requestId);
          answer({ behavior: decision.behavior, message: decision.message });
          emit({
            ...base(threadId, entry.turnId),
            requestId,
            type: "request.resolved",
            behavior: decision.behavior,
            source: "user",
          });
          return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
        },
        steer: async (threadId, text) => {
          const entry = active.get(threadId);
          return entry ? await entry.steer(text) : "refused";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll,
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        disposed = true;
        await stopAll();
        listeners.clear();
      },
    };
  },
};
