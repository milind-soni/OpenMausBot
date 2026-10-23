// Cursor Agent (`cursor-agent acp`) on the Cursor subscription (`cursor-agent login`, CURSOR_API_KEY or
// CURSOR_AUTH_TOKEN). Per cursor.com/docs/cli/acp it advertises `cursor_login` and takes `--force` /
// `--model` as global flags before `acp`.
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { titleCaseModelId } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { AcpQuestionRequest } from "./question-requests.ts";
import {
  capAnswerEcho, formatQuestionAnswers, MAX_QUESTIONS, parseChoices, parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById,
  repeatsQuestionText,
} from "../../../shared/ask-question.ts";

/** Cursor keeps two model namespaces: `cursor-agent models` and `--model` use flat slugs (`auto`,
 * `gpt-5.3-codex`), while the ACP session advertises parameterised ids (`default[]`,
 * `grok-4.7[context=256k,reasoning_effort=high,fast=true]`) and set_model accepts only those (-32602
 * otherwise). `auto` is `default[]`. Null when nothing matches. */
export function resolveCursorAcpModelId(
  available: Array<{ modelId?: string; name?: string }>,
  wanted: string,
): string | null {
  return matchCursorAcpModel(available, wanted)?.modelId ?? null;
}

const EFFORT_SLUG = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;

function cursorAcpParams(id: string): Map<string, string> {
  const params = new Map<string, string>();
  const body = /\[(.*)\]\s*$/.exec(id)?.[1] ?? "";
  for (const pair of body.split(",")) {
    const [key, value] = pair.split("=").map((part) => part?.trim().toLowerCase());
    if (key && value !== undefined) params.set(key, value);
  }
  return params;
}

/** `exact` is false when an effort slug settled for another variant: the session advertises one per base. */
export function matchCursorAcpModel(
  available: Array<{ modelId?: string; name?: string }>,
  wanted: string,
): { modelId: string; exact: boolean } | null {
  const want = wanted.trim().toLowerCase();
  if (!want) return null;
  const ids = available.filter((m) => typeof m?.modelId === "string" && m.modelId);
  if (!ids.length) return null;
  const base = (id: string) => id.split("[")[0].trim().toLowerCase();
  const found = (modelId: string, exact = true) => ({ modelId, exact });

  const exact = ids.find((m) => m.modelId!.toLowerCase() === want);
  if (exact) return found(exact.modelId!);

  // A plain slug means Standard (fast=false); a `-fast` slug is the fast=true variant of its base.
  const isFast = (id: string) => cursorAcpParams(id).get("fast") === "true";
  const sameBase = ids.filter((m) => base(m.modelId!) === want);
  const byBase = sameBase.find((m) => !isFast(m.modelId!)) ?? sameBase[0];
  if (byBase) return found(byBase.modelId!);

  const fastSlug = want.endsWith("-fast");
  const stem = fastSlug ? want.slice(0, -"-fast".length) : want;
  if (fastSlug) {
    const fast = ids.find((m) => base(m.modelId!) === stem && isFast(m.modelId!));
    if (fast) return found(fast.modelId!);
  }

  // `cursor-agent models` puts effort in the slug (`grok-4.7-high-fast`); the session names it a
  // parameter (`reasoning_effort=high`, or `effort=`/`reasoning=` on other bases).
  const effortSlug = EFFORT_SLUG.exec(stem);
  if (effortSlug) {
    const [, effortBase, effort] = effortSlug;
    const effortOf = (id: string) => {
      const params = cursorAcpParams(id);
      return params.get("reasoning_effort") ?? params.get("effort") ?? params.get("reasoning");
    };
    const variants = ids.filter((m) => base(m.modelId!) === effortBase && (!fastSlug || isFast(m.modelId!)));
    const sameEffort = variants.find((m) => effortOf(m.modelId!) === effort && isFast(m.modelId!) === fastSlug);
    if (sameEffort) return found(sameEffort.modelId!);
    const closest = variants.find((m) => isFast(m.modelId!) === fastSlug) ?? variants[0];
    if (closest) return found(closest.modelId!, false);
  }

  const byName = ids.find((m) => (m.name ?? "").trim().toLowerCase() === want);
  if (byName) return found(byName.modelId!);

  if (want === "auto" || want === "default") {
    const dflt = ids.find((m) => base(m.modelId!) === "default");
    if (dflt) return found(dflt.modelId!);
  }
  return null;
}

export const STATIC_CURSOR_MODELS: ModelCatalog = {
  default: "auto",
  options: [
    { id: "auto", label: "Auto" },
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
    { id: "gpt-5.3-codex", label: "Codex 5.3" },
    { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._:+-]*$/i;
const EXEC_TIMEOUT_MS = 8_000;

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function firstJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // CLIs sometimes print a banner before the payload.
  }
  const start = trimmed.search(/[{[]/);
  if (start < 0) return null;
  for (let end = trimmed.length; end > start + 1; end--) {
    const slice = trimmed.slice(start, end).trim();
    if (!slice.endsWith("}") && !slice.endsWith("]")) continue;
    try {
      return JSON.parse(slice);
    } catch {}
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function labelFor(id: string, explicit?: string): string {
  const trimmed = explicit?.trim();
  return trimmed || titleCaseModelId(id, /[-_./]+/);
}

function pushModel(
  options: ModelCatalog["options"],
  seen: Set<string>,
  id: string,
  label?: string,
  custom = false,
): void {
  if (!SLUG.test(id) || seen.has(id)) return;
  seen.add(id);
  options.push({ id, label: labelFor(id, label), ...(custom ? { custom: true as const } : {}) });
}

export function decodeCursorModelCatalog(payload: unknown): ModelCatalog | null {
  const records: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.models)
      ? (asRecord(payload)!.models as unknown[])
      : Array.isArray(asRecord(payload)?.data)
        ? (asRecord(payload)!.data as unknown[])
        : Array.isArray(asRecord(payload)?.modelIds)
          ? (asRecord(payload)!.modelIds as unknown[])
          : [];
  if (!records.length) return null;

  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const row of records) {
    if (typeof row === "string") {
      pushModel(options, seen, row);
      continue;
    }
    const rec = asRecord(row);
    if (!rec) continue;
    const id = rec.id ?? rec.modelId ?? rec.slug ?? rec.name;
    if (typeof id !== "string") continue;
    const label =
      (typeof rec.label === "string" && rec.label) ||
      (typeof rec.displayName === "string" && rec.displayName) ||
      (typeof rec.name === "string" && rec.name !== id ? rec.name : undefined);
    pushModel(options, seen, id, label || undefined);
  }
  if (!options.length) return null;

  const defaultId =
    (typeof asRecord(payload)?.default === "string" && seen.has(asRecord(payload)!.default as string)
      ? (asRecord(payload)!.default as string)
      : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);

  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  return { default: defaultId, options: merged };
}

function stripModelMarkers(label: string): { label: string; isDefault: boolean; isCurrent: boolean } {
  let cleaned = label.trim();
  let isDefault = false;
  let isCurrent = false;
  const defaultMatch = cleaned.match(/\s*\(default\)\s*$/i);
  if (defaultMatch) {
    isDefault = true;
    cleaned = cleaned.slice(0, defaultMatch.index).trim();
  }
  const currentMatch = cleaned.match(/\s*\(current\)\s*$/i);
  if (currentMatch) {
    isCurrent = true;
    cleaned = cleaned.slice(0, currentMatch.index).trim();
  }
  return { label: cleaned, isDefault, isCurrent };
}

/** Plain `cursor-agent models` text: one slug per line, optional `id - label`, `(default)` / `(current)` markers. */
export function decodeCursorModelText(text: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let markedDefault: string | undefined;
  let markedCurrent: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^available\s+models?\b/i.test(line) || /^models?\b/i.test(line)) continue;
    const stripped = line.replace(/^[\s*•-]+\s*/, "");
    const parts = stripped.split(/\s+[—–|:]\s+|\s+-\s+|\s{2,}/);
    const id = (parts[0] ?? "").trim();
    const rawLabel = parts.slice(1).join(" ").trim();
    const { label, isDefault, isCurrent } = stripModelMarkers(rawLabel);
    pushModel(options, seen, id, label || undefined);
    if (isDefault) markedDefault = id;
    if (isCurrent) markedCurrent = id;
  }
  if (!options.length) return null;
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  const defaultId =
    (markedDefault && seen.has(markedDefault) ? markedDefault : undefined) ??
    (markedCurrent && seen.has(markedCurrent) ? markedCurrent : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);
  return { default: defaultId, options: merged };
}

function truthyAuthFlag(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "authenticated", "logged_in", "logged-in", "yes"].includes(normalized)) return true;
    if (["false", "unauthenticated", "logged_out", "logged-out", "no"].includes(normalized)) return false;
  }
  return null;
}

export function decodeCursorAuthStatus(payload: unknown): boolean | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const auth = asRecord(rec.auth);
  const candidates = [
    rec.isAuthenticated,
    rec.authenticated,
    rec.loggedIn,
    rec.logged_in,
    auth?.isAuthenticated,
    auth?.authenticated,
    rec.status,
    auth?.status,
  ];
  for (const candidate of candidates) {
    const flag = truthyAuthFlag(candidate);
    if (flag !== null) return flag;
  }
  return null;
}

export function decodeCursorAuthText(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|logged out/.test(normalized)) return false;
  if (/login successful|logged in|signed in|authenticated/.test(normalized)) return true;
  return null;
}

function execText(
  run: typeof execCli,
  cli: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<string | null> {
  return new Promise((resolve) => {
    run(cli, args, { timeout: EXEC_TIMEOUT_MS, env: env as NodeJS.ProcessEnv }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout ?? ""));
    });
  });
}

export async function probeCursorAuth(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<boolean> {
  if (nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN)) return true;
  for (const args of [["status", "--format", "json"], ["status"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const decoded = decodeCursorAuthStatus(firstJsonValue(stdout)) ?? decodeCursorAuthText(stdout);
    if (decoded !== null) return decoded;
  }
  return false;
}

export async function fetchCursorModels(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<ModelCatalog> {
  // Live CLI prints plain text (`slug - Label`); `--format json` is not supported yet.
  for (const args of [["models"], ["--list-models"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const fromText = decodeCursorModelText(stdout);
    if (fromText) return fromText;
    const fromJson = decodeCursorModelCatalog(firstJsonValue(stdout));
    if (fromJson) return fromJson;
  }
  return STATIC_CURSOR_MODELS;
}

export function classifyCursorError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (
    code === -32000 ||
    /unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required/.test(
      blob,
    )
  ) {
    return "invalid_credentials";
  }
  if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
    return "inactive_subscription";
  }
  return undefined;
}

/** Cursor's AskQuestion blocks on `cursor/ask_question` (cursor.com/docs/cli/acp; cursor-agent 2026.10.01, no sessionId).
 * Cursor answers by option id only, so a reply with any own words goes back whole as `skipped` with the answers as the
 * reason, which Cursor hands the model verbatim: a typed answer is never forced onto an option. */
export const CURSOR_ASK_QUESTION: AcpQuestionRequest = {
  cancelled: { outcome: { outcome: "cancelled" } },
  parse(params) {
    const raw = (params as { questions?: unknown } | null)?.questions;
    if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) return null;
    const parsed = parseProtocolAskQuestions(raw.map((entry) =>
      entry && typeof entry === "object"
        ? { id: entry.id, question: entry.prompt, options: entry.options, multiSelect: entry.allowMultiple === true }
        : entry));
    if (!parsed || repeatsQuestionText(parsed)) return null;
    const rawOptions = new Map<string, unknown[]>(raw.flatMap((entry) =>
      entry && typeof entry.id === "string" && Array.isArray(entry.options) ? [[entry.id, entry.options]] : []));
    // Card labels are trimmed and capped: never guess when two options normalize alike.
    const optionId = (questionId: string, label: string): string | null => {
      const matches = (rawOptions.get(questionId) ?? []).filter((option) => parseChoices([option], 1)?.[0] === label);
      const id = matches.length === 1 ? (matches[0] as { id?: unknown }).id : null;
      return typeof id === "string" ? id : null;
    };
    const questions = parsed.map(({ question }) => question);
    return {
      questions,
      answered(message) {
        const byId = questionAnswersById(message, parsed);
        const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
        let ownWords = false;
        for (const { id, question } of parsed) {
          const reply = byId[id];
          if (reply === undefined) continue;
          const { labels, other } = pickedOptionLabels(reply, question);
          const selectedOptionIds = labels.map((label) => optionId(id, label));
          if (other !== undefined || selectedOptionIds.some((selected) => selected === null)) ownWords = true;
          else answers.push({ questionId: id, selectedOptionIds: selectedOptionIds as string[] });
        }
        if (ownWords) {
          const reason = formatQuestionAnswers(questions, parsed.map(({ id }) => byId[id] ? [byId[id]] : []));
          return { outcome: { outcome: "skipped", reason: capAnswerEcho(reason) } };
        }
        return answers.length ? { outcome: { outcome: "answered", answers } } : null;
      },
    };
  },
};

async function setCursorFast(
  request: (method: string, params: unknown) => Promise<unknown>,
  sessionId: string,
  fast: boolean,
): Promise<void> {
  let reply: { configOptions?: Array<{ id?: unknown; currentValue?: unknown }> } | undefined;
  try {
    reply = (await request("session/set_config_option", { sessionId, configId: "fast", value: String(fast) })) as typeof reply;
  } catch (e) {
    // -32602: the chosen model has no Fast variant, so there is nothing to switch.
    if ((e as { code?: unknown }).code !== -32602) throw e;
    return;
  }
  // Cursor can acknowledge the switch yet keep its default Fast variant, so only the echoed value counts.
  const confirmed = reply?.configOptions?.find((option) => option?.id === "fast")?.currentValue;
  if (confirmed !== String(fast)) {
    throw new Error(
      `Cursor did not confirm Fast ${fast ? "on" : "off"} (fast is ${confirmed === undefined ? "unreported" : JSON.stringify(confirmed)}), ` +
        "so the turn was not sent. Check that `cursor-agent` is current.",
    );
  }
}

const support = (run: typeof execCli): AcpSupport => ({
  driverKind: "cursorAgent",
  questionRequests: { "cursor/ask_question": CURSOR_ASK_QUESTION },
  displayName: "Cursor",
  models: STATIC_CURSOR_MODELS,
  // Other coding agents can install a generic `agent` shim; `cursor-agent` is unambiguous.
  defaultCli: "cursor-agent",
  nativeSource: "cursor.acp",
  loginNote: "Cursor CLI is not signed in — run `cursor-agent login` in a terminal, or set CURSOR_API_KEY",

  install: {
    command: {
      darwin: "curl https://cursor.com/install -fsS | bash",
      linux: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    docsUrl: "https://cursor.com/docs/cli/installation",
    signInCommand: "cursor-agent login",
  },

  // Global flags precede `acp`; `--force` is the documented auto-approve switch.
  spawnArgs: (config, turn) => [
    ...(config.fullAuto ? ["--force"] : turn.approvalMode === "auto" ? ["--auto-review"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "acp",
  ],
  credentialEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],

  resolveModels: (environment, config) => fetchCursorModels(config.cli || "cursor-agent", environment, run),

  // A key in the env already authenticates the session, and Cursor's cursor_login handler would then
  // delete the saved login and open a browser once the token expired, so it is not sent.
  pickAuthMethod: (methods, env) =>
    nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN) ? null
      : methods.some((m) => m.id === "cursor_login") ? "cursor_login" : null,
  authFailure: "continue",
  isAuthenticated: (env, config) => probeCursorAuth(config.cli || "cursor-agent", env, run),
  classifyError: classifyCursorError,

  // Without parameterizedModelPicker Cursor (CLI 2026.10.19) offers only `composer-2.5[fast=true]`, so a
  // `composer-2.5` bot bills as Fast; with it, Fast is a separate `fast` config option.
  clientCapabilitiesMeta: { parameterizedModelPicker: true },

  async configureSession({ request, sessionId, turn, sessionModels, currentModelId, configOptions, notice }) {
    if (!turn.model) return;
    const fastOption = configOptions.some((option) => option?.id === "fast");
    const wantsFast = /-fast$/i.test(turn.model);
    const wanted = fastOption && wantsFast ? turn.model.slice(0, -"-fast".length) : turn.model;
    const match = matchCursorAcpModel(sessionModels ?? [], wanted);
    const modelId = match?.modelId ?? wanted;
    try {
      await request("session/set_model", { sessionId, modelId });
      if (match && !match.exact) {
        notice(`Cursor offers ${modelId} rather than ${turn.model} in this session, so this conversation uses ${modelId}.`);
      }
    } catch (e) {
      const err = e as Error & { code?: unknown };
        // -32601: no set_model, so the argv pin holds. -32602: not in this namespace; current CLIs
        // ignore argv `--model` in ACP, so the session keeps its starting model.
      if (err.code === -32601) return;
      if (err.code === -32602) {
        const current = sessionModels?.find((m) => m.modelId === currentModelId);
        const running = current?.name ?? currentModelId;
        notice(
          `Cursor did not accept ${turn.model} in this session, so it runs ${running ?? "its default model"}. ` +
            "Choose another model for this bot to stop seeing this.",
        );
        return;
      }
      throw new Error(
        `Cursor rejected model "${turn.model}" (sent as "${modelId}") via session/set_model: ${err.message}. ` +
          `Check that \`cursor-agent\` is current and that this account can use that model.`,
      );
    }
    if (fastOption) await setCursorFast(request, sessionId, wantsFast);
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});

export function createCursorAgentDriver(run: typeof execCli = execCli) {
  return createAcpDriver(support(run));
}

export const CursorAgentDriver = createCursorAgentDriver();
