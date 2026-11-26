// Opt-in external read-only CLI approval reviewer delegation (e.g. `codex exec --model codex-auto-review`)
// for engines that do not ship a native Auto-review classifier.
// Disabled by default: enable via config.json (`externalApprovalReviewer: { enabled: true }`) or `OMB_EXTERNAL_APPROVAL_REVIEWER=1`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isOutboundTool } from "../shared/outbound.ts";
import type { Message } from "./store.ts";

export const externalApprovalReviewerStoredShape = {
  externalApprovalReviewer: z.object({
    enabled: z.boolean().optional(),
    command: z.string().trim().max(300).optional(),
    model: z.string().trim().max(200).optional(),
    policyPath: z.string().trim().max(500).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    maxReviewsPerTurn: z.number().int().min(1).max(500).optional(),
  }).optional().catch(undefined),
};

export interface ExternalApprovalReviewerConfig {
  externalApprovalReviewer?: {
    enabled?: boolean;
    command?: string;
    model?: string;
    policyPath?: string;
    timeoutMs?: number;
    maxReviewsPerTurn?: number;
  };
}

export interface EffectiveExternalReviewerConfig {
  enabled: boolean;
  command: string;
  model: string;
  policyPath?: string;
  timeoutMs: number;
  maxReviewsPerTurn: number;
}

const DEFAULT_COMMAND = "codex";
const DEFAULT_MODEL = "codex-auto-review";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_REVIEWS_PER_TURN = 150;
const MAX_CONCURRENT = 2;
const MAX_TOTAL_EVENTS_PER_TURN = 350;
const MAX_CONSECUTIVE_IDENTICAL = 5;
const MAX_SAME_READONLY_PER_TURN = 40;
const MAX_SAME_ACTION_PER_TURN = 20;
const SAFE_CACHE_TTL_MS = 5 * 60_000;
const TURN_STATE_TTL_MS = 30 * 60_000;
const MAX_TURN_STATES = 200;

const SHORT_CONTINUATION_RE = /^(?:please\s*)?(?:just\s+|go\s+ahead(?:\s+and)?\s+)?(?:continue|proceed|go|ok|okay|yes|done|resume|retry|carry\s+on|next)(?:\s+please)?[\s.!?,]*$/i;

const FALLBACK_POLICY = [
  "Default to conservative fail-closed review.",
  "Approve only clearly bounded, reversible, low-risk local actions directly serving the user's current request inside the authorized workspace.",
  "Reject or escalate (ask) any credential access, external data exfiltration, destructive command, payment, public posting, or unauthorized outbound send.",
].join("\n");

const STATIC_REVIEW_PREAMBLE = [
  "You are an automated security reviewer evaluating a pending tool/permission action.",
  "Evaluate strictly against the policy below and output ONLY one single-line valid JSON object:",
  '{"decision":"approve"|"ask"|"deny","risk":"low"|"medium"|"high","reason":"short reason <=120 chars"}',
  "Rules:",
  "- Output approve ONLY if decision is approve and risk is low or medium.",
  "- If uncertain, high risk, credential access/exfiltration, outbound messaging, or outside authorized scope, output ask or deny.",
].join("\n");

export function externalApprovalReviewerConfig(
  cfg: ExternalApprovalReviewerConfig,
  env: Record<string, string | undefined> = process.env,
): EffectiveExternalReviewerConfig {
  const envFlag = env.OMB_EXTERNAL_APPROVAL_REVIEWER?.trim();
  const enabled = envFlag === "0" ? false : envFlag === "1" ? true : cfg.externalApprovalReviewer?.enabled === true;
  const command = env.OMB_EXTERNAL_REVIEWER_CMD?.trim() || cfg.externalApprovalReviewer?.command || DEFAULT_COMMAND;
  const model = env.OMB_EXTERNAL_REVIEWER_MODEL?.trim() || cfg.externalApprovalReviewer?.model || DEFAULT_MODEL;
  const policyPath = env.OMB_EXTERNAL_REVIEWER_POLICY_PATH?.trim() || cfg.externalApprovalReviewer?.policyPath;
  const timeoutMs = cfg.externalApprovalReviewer?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxReviewsPerTurn = cfg.externalApprovalReviewer?.maxReviewsPerTurn ?? DEFAULT_MAX_REVIEWS_PER_TURN;
  return { enabled, command, model, ...(policyPath ? { policyPath } : {}), timeoutMs, maxReviewsPerTurn };
}

interface TurnReviewState {
  createdAt: number;
  updatedAt: number;
  modelCalls: number;
  totalEvents: number;
  lastSig: string | null;
  consecutiveIdentical: number;
  actionCounts: Map<string, number>;
  safeCache: Map<string, { at: number; result: ExternalReviewVerdict }>;
}

export interface ExternalReviewInput {
  threadId?: string;
  turnGeneration?: string | number;
  botName?: string;
  tool?: string;
  summary?: string;
  command?: string;
  cwd?: string;
  approvalScope?: string;
  rawInput?: unknown;
  computerMode?: string;
  customMcpServers?: string[];
  connectedApps?: string[];
  threadMessages?: ReadonlyArray<Pick<Message, "role" | "kind" | "text" | "digest" | "attachments"> & { progressUpdate?: boolean }>;
  initialPrompt?: string;
  recentMessages?: Array<{ role?: string; text?: string }>;
  config?: Partial<EffectiveExternalReviewerConfig>;
  retryDelayMs?: number;
}

export interface ExternalReviewVerdict {
  approve: boolean;
  decision: "approve" | "ask" | "deny";
  risk: "low" | "medium" | "high";
  reason: string;
  model: string;
  elapsedMs: number;
  cached?: boolean;
}

export type ReviewerRunner = (prompt: string, config: EffectiveExternalReviewerConfig) => Promise<{
  code: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}>;

let activeCount = 0;
const waitQueue: Array<() => void> = [];
const turnStates = new Map<string, TurnReviewState>();
let cachedPolicy: { path: string; mtimeMs: number; text: string } | null = null;

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) { activeCount += 1; return Promise.resolve(); }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) next(); else activeCount = Math.max(0, activeCount - 1);
}

export function _resetExternalReviewerState(): void {
  turnStates.clear();
  cachedPolicy = null;
}

const GENERIC_SUMMARY_MCP = /^Run\s+(mcp_[A-Za-z0-9_.:-]+)\b/i;

export function extractEffectiveToolName(input: Pick<ExternalReviewInput, "tool" | "summary">): string {
  const tool = String(input.tool ?? "").trim();
  if (tool && tool.toLowerCase() !== "other") return tool;
  const match = GENERIC_SUMMARY_MCP.exec(String(input.summary ?? "").trim());
  return match?.[1] ?? tool;
}

export function isShortContinuation(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 24 && SHORT_CONTINUATION_RE.test(t);
}

export function redactSecretsOnly(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<REDACTED_PRIVATE_KEY>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<REDACTED_JWT>")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<REDACTED>")
    .replace(/\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|apikey_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abposr]-[A-Za-z0-9-]{16,})/g, "<REDACTED_KEY>")
    .replace(/((?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)\s*[=:]\s*["']?)([^\s"',;]{6,})/gi, "$1<REDACTED>");
}

export function redactText(value: unknown, maxLen = 1500): string {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  if (!text) return "";
  text = redactSecretsOnly(text);
  return text.length > maxLen ? `${text.slice(0, maxLen)}...[truncated]` : text;
}

export function redactTextHeadTail(value: unknown, maxLen = 1500): string {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  if (!text) return "";
  text = redactSecretsOnly(text);
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.65);
  const tailLen = Math.floor(maxLen * 0.35);
  const omitted = Math.max(0, text.length - headLen - tailLen);
  return `${text.slice(0, headLen)}\n...[truncated ${omitted} chars]...\n${text.slice(-tailLen)}`;
}

const PRIORITY_KEYS = [
  "Path", "path", "Overwrite", "Append", "pid", "wid", "window_id", "app", "toolSummary",
  "command", "CommandLine", "cwd", "url", "tool_slug", "queries", "tools",
  "recipient_email", "to", "subject", "action", "key",
];
const PRESERVE_KEYS = new Set(PRIORITY_KEYS);

function compactValue(val: unknown, keyName = "", depth = 0): unknown {
  if (val === undefined || val === null) return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (depth <= 2 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try { return compactValue(JSON.parse(trimmed) as unknown, keyName, depth + 1); } catch {}
    }
    if (PRESERVE_KEYS.has(keyName) && val.length <= 1200) return val;
    if (val.length > 1800) {
      const omitted = val.length - 2300;
      return `${val.slice(0, 1400)}\n...[truncated ${omitted} chars]...\n${val.slice(-900)}`;
    }
    return val;
  }
  if (Array.isArray(val)) {
    if (val.length > 20) {
      return [
        ...val.slice(0, 10).map((item) => compactValue(item, "", depth + 1)),
        `...[omitted ${val.length - 15} items]...`,
        ...val.slice(-5).map((item) => compactValue(item, "", depth + 1)),
      ];
    }
    return val.map((item) => compactValue(item, "", depth + 1));
  }
  if (typeof val === "object") {
    if (depth >= 5) return "[nested-object]";
    const out: Record<string, unknown> = {};
    const entries = Object.entries(val as Record<string, unknown>);
    entries.sort(([a], [b]) => {
      const ia = PRIORITY_KEYS.indexOf(a);
      const ib = PRIORITY_KEYS.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });
    for (const [k, v] of entries) {
      if (v !== undefined) out[k] = compactValue(v, k, depth + 1);
    }
    return out;
  }
  return val;
}

export function compactRawInput(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return "";
  let compacted: string;
  try { compacted = JSON.stringify(compactValue(rawInput)); } catch { compacted = String(rawInput); }
  if (!compacted) return "";
  compacted = redactSecretsOnly(compacted);
  return compacted.length > 4500 ? `${compacted.slice(0, 2600)}...[truncated ${compacted.length - 4300} chars]...${compacted.slice(-1700)}` : compacted;
}

function extractMessageText(m: Pick<Message, "text" | "attachments">): string {
  const parts: string[] = [];
  if (typeof m.text === "string" && m.text.trim()) parts.push(m.text.trim());
  for (const a of m.attachments ?? []) {
    if (a.kind === "audio" && typeof a.text === "string" && a.text.trim()) parts.push(a.text.trim());
  }
  return parts.join("\n").trim();
}

export function buildReviewContextFromMessages(
  messages: ReadonlyArray<Pick<Message, "role" | "kind" | "text" | "digest" | "attachments"> & { progressUpdate?: boolean }> = [],
): { initialPrompt: string; recentMessages: Array<{ role: string; text: string }> } {
  const filtered = messages.filter((m) => m && !m.progressUpdate);
  const userTexts: string[] = [];
  for (const m of filtered) {
    if (m.role === "user" && (m.kind === undefined || m.kind === "text")) {
      const t = extractMessageText(m);
      if (t) userTexts.push(t);
    }
  }
  let originIdx = -1;
  let originGoal = "";
  for (let i = 0; i < userTexts.length; i += 1) {
    const t = userTexts[i]!;
    if (t.length >= 12 && !isShortContinuation(t)) { originIdx = i; originGoal = t; break; }
  }
  if (!originGoal && userTexts.length > 0) { originIdx = 0; originGoal = userTexts[0]!; }

  const substantiveUpdates: string[] = [];
  const seen = new Set(originGoal ? [originGoal] : []);
  for (let i = Math.max(0, originIdx + 1); i < userTexts.length; i += 1) {
    const t = userTexts[i]!;
    if (t.length >= 6 && !isShortContinuation(t) && !seen.has(t)) { seen.add(t); substantiveUpdates.push(t); }
  }
  const last5 = substantiveUpdates.slice(-5);
  const latestUser = userTexts.at(-1) ?? "";
  const parts: string[] = [];
  if (originGoal) parts.push(`[Thread Goal]\n${redactTextHeadTail(originGoal, 3600)}`);
  if (last5.length > 0) parts.push(`[User Instructions / Authorizations]\n${last5.map((u) => `- ${redactText(u, 450)}`).join("\n")}`);
  if (latestUser && latestUser !== originGoal && latestUser !== last5.at(-1)) parts.push(`[Latest User Turn]\n${redactText(latestUser, 450)}`);

  const recentMessages = filtered
    .filter((m) => m.kind === "text" || m.kind === "digest" || (m.kind === undefined && (typeof m.text === "string" || Array.isArray(m.attachments))))
    .slice(-4)
    .map((m) => ({ role: String(m.role ?? "unknown"), text: (extractMessageText(m) || m.digest?.reply || "").trim().slice(0, 350) }))
    .filter((m) => m.text.length > 0);
  return { initialPrompt: parts.join("\n\n"), recentMessages };
}

const READ_ONLY_MCP_TOOLS = /(?:^|[:._])(?:get_window_state|list_windows|list_apps|get_screen_size|get_desktop_state|get_cursor_position|get_accessibility_tree|get_config|get_session|check_permissions|list_bots|list_models|trigger_info|get_guide|list_threads|list_routines|list_groups|get_thread|list_sessions|get_recording_state|health_report|COMPOSIO_SEARCH_TOOLS|read|view|list|ls|glob|grep|search|find)$/i;
const FORBIDDEN_CMD_PATTERNS = /(?:>|>>|\||&&|\|\||;|`|\$\(|\b(?:rm|mv|cp|chmod|chown|chgrp|ln|mkdir|rmdir|touch|truncate|dd|mkfs|tee|sed\s+-i|perl\s+-i|python\d*\s+-c|node\s+-e|bash\s+-c|sh\s+-c|curl|wget|ssh|scp|rsync|nc|ncat|socat|git\s+(?:push|commit|reset|checkout|clean|rebase|merge|cherry-pick)|npm\s+(?:install|publish|exec|run)|pip\d*\s+install|sudo|su|kill|pkill|systemctl|service|shutdown|reboot|useradd|usermod|passwd)\b|\.env\b|auth\.json|credentials|token|secret|private[_-]?key|\.ssh\b)/i;
const ALLOWED_READONLY_CMDS = /^(?:ls|cat|head|tail|wc|stat|pwd|find|rg|grep|egrep|fgrep|git\s+(?:status|diff|log|show|branch)|ps|df|free|uname|date|echo|realpath|which|file|du)(?:\s|$)/;

export function isStrictReadOnlyCacheable(input: Pick<ExternalReviewInput, "tool" | "summary" | "approvalScope" | "command">): boolean {
  const tool = extractEffectiveToolName(input);
  const scope = String(input.approvalScope ?? "").trim();
  const command = String(input.command ?? "").replace(/\s+/g, " ").trim();
  if (scope === "local-computer" && !READ_ONLY_MCP_TOOLS.test(tool)) return false;
  if (command) return !FORBIDDEN_CMD_PATTERNS.test(command) && ALLOWED_READONLY_CMDS.test(command);
  return READ_ONLY_MCP_TOOLS.test(tool);
}

function loadPolicyText(policyPath?: string): string {
  if (!policyPath) return FALLBACK_POLICY;
  try {
    const st = statSync(policyPath);
    if (cachedPolicy && cachedPolicy.path === policyPath && cachedPolicy.mtimeMs === st.mtimeMs) return cachedPolicy.text;
    const text = readFileSync(policyPath, "utf8").trim() || FALLBACK_POLICY;
    cachedPolicy = { path: policyPath, mtimeMs: st.mtimeMs, text };
    return text;
  } catch {
    return FALLBACK_POLICY;
  }
}

function buildReviewPrompt(input: ExternalReviewInput, policyText: string): string {
  let rawInitial = input.initialPrompt ?? "";
  let rawRecent = Array.isArray(input.recentMessages) ? input.recentMessages : [];
  if (Array.isArray(input.threadMessages) && input.threadMessages.length > 0) {
    const ctx = buildReviewContextFromMessages(input.threadMessages);
    if (ctx.initialPrompt) rawInitial = ctx.initialPrompt;
    if (ctx.recentMessages.length > 0) rawRecent = ctx.recentMessages;
  }
  const initialPrompt = redactTextHeadTail(rawInitial, 4800);
  const recent = rawRecent.slice(-4).map((m) => `- ${m.role ?? "unknown"}: ${redactText(m.text ?? "", 350)}`).filter((line) => !line.endsWith(": ")).join("\n");
  const apps = [...new Set((input.connectedApps ?? []).map((a) => String(a).trim()).filter(Boolean))].sort();
  const servers = [...new Set((input.customMcpServers ?? []).map((s) => String(s).trim()).filter(Boolean))].sort();

  const runtimeFacts = [
    "",
    "=== RUNTIME FACTS ===",
    "- `mcp_agents_*` is OpenMausBot's built-in local coordination/memory bridge.",
  ];
  if (String(input.computerMode ?? "").trim() === "vm") {
    runtimeFacts.push("- `mcp_computer_*` operates the bot's isolated virtual-machine desktop rather than the user's host machine.");
  }
  if (apps.length > 0) runtimeFacts.push(`- Enabled connected apps for this bot: ${apps.join(", ")}.`);
  if (servers.length > 0) runtimeFacts.push(`- Configured MCP servers for this bot: ${servers.join(", ")}.`);

  const payload = {
    botName: redactText(input.botName ?? "", 80),
    tool: redactText(extractEffectiveToolName(input), 120),
    approvalScope: redactText(input.approvalScope ?? "", 80),
    cwd: redactText(input.cwd ?? "", 300),
    command: redactText(input.command ?? "", 1200),
    summary: redactText(input.summary ?? "", 400),
    rawInput: compactRawInput(input.rawInput),
  };

  return [
    STATIC_REVIEW_PREAMBLE,
    "",
    "=== POLICY ===",
    policyText,
    ...runtimeFacts,
    "",
    "=== INITIAL USER REQUEST ===",
    initialPrompt || "(none)",
    "",
    "=== RECENT CONTEXT ===",
    recent || "(none)",
    "",
    "=== PENDING ACTION ===",
    JSON.stringify(payload),
  ].join("\n");
}

function parseReviewerOutput(stdoutText: string): { ok: true; decision: "approve" | "ask" | "deny"; risk: "low" | "medium" | "high"; reason: string } | { ok: false; reason: string } {
  let lastAgentText = "";
  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      if (obj?.type === "item.completed" && obj?.item?.type === "agent_message" && typeof obj.item.text === "string") {
        lastAgentText = obj.item.text.trim();
      }
    } catch {}
  }
  if (!lastAgentText) return { ok: false, reason: "empty reviewer output" };
  const stripped = lastAgentText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(stripped) as { decision?: unknown; risk?: unknown; reason?: unknown };
    const decision = typeof parsed?.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
    const risk = typeof parsed?.risk === "string" ? parsed.risk.trim().toLowerCase() : "";
    const reason = typeof parsed?.reason === "string" ? parsed.reason.trim().slice(0, 120) : "";
    if ((decision !== "approve" && decision !== "ask" && decision !== "deny") || (risk !== "low" && risk !== "medium" && risk !== "high")) {
      return { ok: false, reason: "invalid decision/risk fields" };
    }
    return { ok: true, decision, risk, reason: reason || decision };
  } catch {
    return { ok: false, reason: "invalid JSON from reviewer" };
  }
}

const defaultRunner: ReviewerRunner = async (prompt, config) => {
  const workDir = mkdtempSync(join(tmpdir(), "omb-ext-review-"));
  const args = [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "read-only",
    "--cd", workDir, "--model", config.model,
    "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "multi_agent", "-",
  ];
  try {
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const child = spawn(config.command, args, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
      const finish = (res: { code: number; timedOut: boolean; stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve(res);
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
        killTimer.unref?.();
      }, config.timeoutMs);
      timeoutTimer.unref?.();
      child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 200_000) stderr += chunk.toString("utf8"); });
      child.on("error", (err) => finish({ code: -1, timedOut, stdout, stderr: err.message }));
      child.on("close", (code) => finish({ code: typeof code === "number" ? code : -1, timedOut, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(prompt, "utf8");
    });
  } finally {
    if (existsSync(workDir)) try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
};

function pruneTurnStates(now: number): void {
  for (const [k, v] of turnStates) if (now - v.updatedAt > TURN_STATE_TTL_MS) turnStates.delete(k);
  while (turnStates.size > MAX_TURN_STATES) {
    const oldest = turnStates.keys().next().value;
    if (oldest === undefined) break;
    turnStates.delete(oldest);
  }
}

function getTurnState(input: ExternalReviewInput, now: number): TurnReviewState | null {
  const threadId = String(input.threadId ?? "").trim();
  if (!threadId) return null;
  pruneTurnStates(now);
  const key = `${threadId}:${input.turnGeneration ?? 0}`;
  let st = turnStates.get(key);
  if (!st) {
    st = { createdAt: now, updatedAt: now, modelCalls: 0, totalEvents: 0, lastSig: null, consecutiveIdentical: 0, actionCounts: new Map(), safeCache: new Map() };
    turnStates.set(key, st);
  } else st.updatedAt = now;
  return st;
}

function buildActionSignature(input: ExternalReviewInput): string {
  const normCmd = String(input.command ?? "").replace(/\s+/g, " ").trim();
  const rawInputSig = !normCmd && input.rawInput !== undefined && input.rawInput !== null
    ? (() => { try { return JSON.stringify(input.rawInput); } catch { return String(input.rawInput); } })().replace(/\s+/g, " ").trim().slice(0, 2000)
    : "";
  return createHash("sha256").update(JSON.stringify([
    extractEffectiveToolName(input),
    String(input.approvalScope ?? ""),
    String(input.cwd ?? ""),
    normCmd,
    normCmd ? "" : String(input.summary ?? "").replace(/\s+/g, " ").trim(),
    rawInputSig,
  ])).digest("hex").slice(0, 24);
}

export async function evaluateExternalApprovalReview(
  input: ExternalReviewInput,
  runner: ReviewerRunner = defaultRunner,
): Promise<ExternalReviewVerdict> {
  const startMs = Date.now();
  const config: EffectiveExternalReviewerConfig = {
    enabled: true,
    command: input.config?.command || DEFAULT_COMMAND,
    model: input.config?.model || DEFAULT_MODEL,
    ...(input.config?.policyPath ? { policyPath: input.config.policyPath } : {}),
    timeoutMs: input.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxReviewsPerTurn: input.config?.maxReviewsPerTurn ?? DEFAULT_MAX_REVIEWS_PER_TURN,
  };

  const effectiveTool = extractEffectiveToolName(input);
  if (isOutboundTool(effectiveTool)) {
    return { approve: false, decision: "ask", risk: "high", reason: "outbound action requires human approval", model: config.model, elapsedMs: 0 };
  }

  const st = getTurnState(input, startMs);
  const sig = buildActionSignature(input);
  const cacheable = isStrictReadOnlyCacheable(input);

  if (st) {
    st.totalEvents += 1;
    const nextCount = (st.actionCounts.get(sig) ?? 0) + 1;
    st.actionCounts.set(sig, nextCount);
    st.consecutiveIdentical = st.lastSig === sig ? st.consecutiveIdentical + 1 : 1;
    st.lastSig = sig;
    if (st.totalEvents > MAX_TOTAL_EVENTS_PER_TURN) {
      return { approve: false, decision: "ask", risk: "medium", reason: `turn action limit (${MAX_TOTAL_EVENTS_PER_TURN}) reached`, model: config.model, elapsedMs: 0 };
    }
    if (st.consecutiveIdentical >= MAX_CONSECUTIVE_IDENTICAL) {
      return { approve: false, decision: "ask", risk: "medium", reason: `consecutive identical action loop (${st.consecutiveIdentical}x)`, model: config.model, elapsedMs: 0 };
    }
    const maxSame = cacheable ? MAX_SAME_READONLY_PER_TURN : MAX_SAME_ACTION_PER_TURN;
    if (nextCount > maxSame) {
      return { approve: false, decision: "ask", risk: "medium", reason: `repeated action limit (${maxSame}x) reached`, model: config.model, elapsedMs: 0 };
    }
    if (cacheable) {
      const cached = st.safeCache.get(sig);
      if (cached && startMs - cached.at < SAFE_CACHE_TTL_MS) return { ...cached.result, cached: true, elapsedMs: 0 };
    }
    st.modelCalls += 1;
    if (st.modelCalls > config.maxReviewsPerTurn) {
      return { approve: false, decision: "ask", risk: "medium", reason: `turn review budget (${config.maxReviewsPerTurn}) reached`, model: config.model, elapsedMs: 0 };
    }
  }

  await acquireSlot();
  try {
    const prompt = buildReviewPrompt(input, loadPolicyText(config.policyPath));
    const runOnce = async (): Promise<{ transient: boolean; verdict: ExternalReviewVerdict }> => {
      const res = await runner(prompt, config);
      const elapsedMs = Date.now() - startMs;
      if (res.timedOut) return { transient: true, verdict: { approve: false, decision: "ask", risk: "high", reason: "external reviewer timed out", model: config.model, elapsedMs } };
      if (res.code !== 0) return { transient: true, verdict: { approve: false, decision: "ask", risk: "high", reason: `external reviewer exited ${res.code}`, model: config.model, elapsedMs } };
      const parsed = parseReviewerOutput(res.stdout);
      if (!parsed.ok) return { transient: true, verdict: { approve: false, decision: "ask", risk: "high", reason: `external reviewer ${parsed.reason}`, model: config.model, elapsedMs } };
      const approve = parsed.decision === "approve" && (parsed.risk === "low" || parsed.risk === "medium");
      return { transient: false, verdict: { approve, decision: parsed.decision, risk: parsed.risk, reason: parsed.reason, model: config.model, elapsedMs } };
    };
    let attempt = await runOnce();
    if (attempt.transient) {
      const delayMs = input.retryDelayMs ?? 1_000;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      attempt = await runOnce();
    }
    if (st && cacheable && attempt.verdict.approve && attempt.verdict.risk === "low") {
      st.safeCache.set(sig, { at: Date.now(), result: attempt.verdict });
    }
    return attempt.verdict;
  } catch (err) {
    return {
      approve: false, decision: "ask", risk: "high",
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      model: config.model, elapsedMs: Date.now() - startMs,
    };
  } finally {
    releaseSlot();
  }
}

const pendingReviews = new Set<string>();

export function dispatchExternalApprovalReview(params: {
  key: string;
  input: ExternalReviewInput;
  config: EffectiveExternalReviewerConfig;
  isCurrent(): boolean;
  onApprove(verdict: ExternalReviewVerdict): Promise<void>;
  onHold(heldReason: string): void;
}): boolean {
  if (pendingReviews.has(params.key)) return true;
  pendingReviews.add(params.key);
  void (async () => {
    try {
      const res = await evaluateExternalApprovalReview({ ...params.input, config: params.config });
      if (!params.isCurrent()) return;
      if (res.approve) await params.onApprove(res);
      else params.onHold(`External Auto-review (${res.risk}): ${res.reason}`);
    } catch (err) {
      if (!params.isCurrent()) return;
      params.onHold(`External Auto-review error: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
    } finally {
      pendingReviews.delete(params.key);
    }
  })();
  return true;
}
