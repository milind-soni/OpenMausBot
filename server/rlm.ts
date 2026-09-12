// Recursive Language Model (RLM) harness — the reasoning engine behind the
// Vision driver's `rlm:*` models (Zhang et al., "Recursive Language Models",
// arXiv 2512.24601). The root model never reads the whole conversation: the
// transcript lives in sandbox variables (`env`, `env_messages`), and the
// model works step by step — inspecting slices with code, handing focused
// sub-questions to a cheaper helper model via `llm(...)`, and ending the
// turn through `final("...")`. The final answer is extracted programmatically
// from that call (or from the sandbox's captured `final()`), never parsed out
// of prose, so a small model cannot skip the work by asserting a result.
//
// Threat model, stated honestly: `node:vm` is an isolation boundary against
// accidents, not against hostile code. The sandbox has no require, process,
// fs, network, eval, or WebAssembly, and only the variables listed below —
// the code we run is written by the model we already trust with the chat.
//
// Deliberate cap: sub-calls are plain focused completions, not nested RLM
// loops. One level of recursion (root → sub) captures the paper's wins at
// small-model scale (chunked exploration, decomposition, programmatic final)
// without multiplying latency and cost through deeper stacks.
import vm from "node:vm";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./drivers/retry.ts";

// ── limits ──────────────────────────────────────────────────────────────
export const RLM_MAX_STEPS = 24;
export const RLM_MAX_LLM_CALLS = 16;
export const RLM_STEP_TIMEOUT_MS = 2_000;
export const RLM_TURN_TIMEOUT_MS = 240_000;
export const RLM_MAX_LLM_ROUNDS = 5;
export const RLM_MAX_LLM_REPLY_CHARS = 8_000;
export const RLM_MAX_OUTPUT_CHARS = 2_000;
export const RLM_MAX_OUTPUT_LINES = 40;

/** Placeholder an uncached `llm()` call returns until the batch resolves. */
const LLM_PENDING = "[llm pending]";
const UNSET = Symbol("rlm-unset");

export interface Usage {
  input: number;
  output: number;
}

export interface RlmChatRequest {
  /** "root" drives the sandbox loop; "sub" answers one focused question. */
  kind: "root" | "sub";
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
}

export interface RlmChatResult {
  text: string;
  usage: Usage;
}

export type RlmChat = (request: RlmChatRequest) => Promise<RlmChatResult>;

export type RlmEngineEvent =
  | { kind: "reasoning"; delta: string }
  | { kind: "tool"; title: string; detail: string }
  | { kind: "retry"; attempt: number; delayMs: number; reason: string }
  | { kind: "usage"; usage: Usage };

export interface RlmTurnInput {
  /** The bot's system prompt (persona); harness instructions are appended. */
  system?: string;
  /** Settled conversation turns, oldest first — sandbox data, never sent verbatim. */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** The user's latest message. */
  prompt: string;
  signal?: AbortSignal;
  /** Test hook: override the step cap (defaults to RLM_MAX_STEPS). */
  maxSteps?: number;
  /** Test hook: override the per-step sandbox timeout. */
  stepTimeoutMs?: number;
}

export interface RlmTurnResult {
  text: string;
  usage: Usage;
  steps: number;
  subcalls: number;
}

// ── prompt fragments ────────────────────────────────────────────────────
export const RLM_SUB_INSTRUCTIONS =
  "[SUB-REASONER] You answer one focused sub-question for a parent reasoning process. " +
  "You cannot see the full conversation and you cannot run code. Answer concisely and " +
  "factually; state assumptions if the question is ambiguous. Reply with the answer only.";

export function rlmRootInstructions(): string {
  return [
    "[REASONING HARNESS — recursive language model]",
    "The conversation is NOT included in your prompt. It is data in your code sandbox:",
    "- env: the whole conversation as one text block",
    "- env_messages: array of {role, text} objects, oldest first",
    "- prompt: the user's latest message",
    "Reply with exactly ONE of:",
    '1. A fenced ```repl code block with a little JavaScript. It runs in a sandbox holding the variables above plus llm(question), final(answer), print(...), console, JSON, Math. Whatever it prints or evaluates is returned to you as the next message. One block per reply.',
    '2. final("<your complete answer for the user>") — in plain text or from inside the code block. That ends the turn; the extracted string is delivered verbatim as the reply.',
    "Rules:",
    `- At most ${RLM_MAX_STEPS} sandbox steps and ${RLM_MAX_LLM_CALLS} llm() calls this turn — budget them.`,
    "- Never guess what env contains: print or slice it first, then reason over what you saw.",
    "- llm(question) takes a literal string and returns a short helper-model answer; use it to summarize chunks or judge sub-questions. Do not nest llm() calls.",
    "- Steps are stateless queries: recompute what you need each step (declare with var if you want a value visible in later steps).",
    "- If a step errors, read the error, fix the code, continue.",
    "Begin by inspecting env, then answer prompt.",
  ].join("\n");
}

export function rlmRootSystem(system: string | undefined): string {
  const base = system?.trim() ? `${system.trim()}\n\n` : "";
  return base + rlmRootInstructions();
}

export function rlmSubSystem(system: string | undefined): string {
  const base = system?.trim() ? `${system.trim()}\n\n` : "";
  return base + RLM_SUB_INSTRUCTIONS;
}

// ── final-answer extraction ─────────────────────────────────────────────
/** Find `final(...)` in a model reply and evaluate its argument in a barren
 * sandbox, so `final(JSON.stringify(x))` and template builds work while a
 * reference to a sandbox variable cannot escape. Returns the captured string
 * plus the prose before the call. */
export function extractFinal(text: string): { value: string; rest: string } | null {
  const marker = text.match(/final\s*\(/);
  if (!marker || marker.index === undefined) return null;
  const open = text.indexOf("(", marker.index);
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;      for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        const arg = text.slice(open + 1, i);
        let captured: unknown = UNSET;
        const sandbox: Record<string, unknown> = {
          JSON,
          Math,
          final: (value: unknown) => {
            captured = value;
            return value;
          },
        };
        let evaluated: unknown;
        try {
          evaluated = vm.runInNewContext(arg, sandbox, { timeout: 500, displayErrors: true });
        } catch {
          return null;
        }
        // `final("literal")` parses as an expression whose value IS the
        // answer; `final(built_up_value)` reaches us through the captured
        // call. Prefer the captured argument, fall back to the value.
        const value = typeof captured === "string" && captured !== (UNSET as unknown)
          ? captured
          : captured !== UNSET
            ? fmtValue(captured)
            : typeof evaluated === "string"
              ? evaluated
              : fmtValue(evaluated);
        if (!value.trim() || value === "undefined") return null;
        return { value: value.trim(), rest: text.slice(0, marker.index).trim() };
      }
    }
  }
  return null;
}

// ── reply parsing ───────────────────────────────────────────────────────
const FENCE = /```([a-zA-Z0-9]*)\r?\n([\s\S]*?)```/;
const REPL_LANGS = new Set(["", "repl", "js", "javascript", "node"]);

/** Split a root reply into pre-fence prose (narration → reasoning stream)
 * and the first acceptable fenced code block. Other languages don't count. */
export function extractReplCode(text: string): { prose: string; code: string | null } {
  const match = text.match(FENCE);
  if (!match || match.index === undefined) return { prose: text.trim(), code: null };
  if (!REPL_LANGS.has((match[1] ?? "").toLowerCase())) return { prose: text.trim(), code: null };
  return { prose: text.slice(0, match.index).trim(), code: match[2]!.trim() };
}

// ── formatting helpers ──────────────────────────────────────────────────
function fmtValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[function ${(value as { name?: string }).name || "anonymous"}]`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function fmtError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
const abortError = () => Object.assign(new Error("interrupted"), { name: "AbortError" });

// ── the turn loop ───────────────────────────────────────────────────────
const addUsage = (a: Usage, b: Usage | null): Usage =>
  b ? { input: a.input + b.input, output: a.output + b.output } : a;

/** One RLM turn: the root loop described at the top of this file. */
export async function runRlmTurn(input: RlmTurnInput, handlers: { emit: (event: RlmEngineEvent) => void; chat: RlmChat }): Promise<RlmTurnResult> {
  const maxSteps = input.maxSteps ?? RLM_MAX_STEPS;
  const signal = input.signal;
  const startedAt = Date.now();
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  const checkWallClock = () => {
    if (Date.now() - startedAt > RLM_TURN_TIMEOUT_MS) {
      throw new Error(`RLM turn exceeded the ${RLM_TURN_TIMEOUT_MS / 1000}s wall-clock limit`);
    }
  };

  let usage: Usage = { input: 0, output: 0 };
  let subcalls = 0;

  const rootSystem = rlmRootSystem(input.system);
  const subSystem = rlmSubSystem(input.system);
  const subPrompt = (question: string) =>
    `${input.prompt}\n\n---\nSub-question from the parent reasoner: ${question}`;

  const subCall = async (question: string): Promise<string> => {
    const result = await handlers.chat({
      kind: "sub",
      system: subSystem,
      messages: [{ role: "user", content: subPrompt(question) }],
      signal,
    });
    usage = addUsage(usage, result.usage);
    subcalls++;
    return truncate(result.text.trim() || "(empty answer)", RLM_MAX_LLM_REPLY_CHARS);
  };

  const rootCall = async (messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<string> => {
    let attempt = 0;
    for (;;) {
      try {
        const result = await handlers.chat({ kind: "root", system: rootSystem, messages, signal });
        usage = addUsage(usage, result.usage);
        return result.text;
      } catch (value) {
        const error = asError(value);
        if (signal?.aborted) throw abortError();
        const verdict = classifyError(error);
        if (verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1) {
          const delayMs = computeBackoff(attempt++);
          handlers.emit({ kind: "retry", attempt, delayMs, reason: verdict.reason });
          const outcome = await interruptibleDelay(delayMs, signal).promise;
          if (outcome === "elapsed") continue;
          throw abortError();
        }
        throw error;
      }
    }
  };

  // Sandbox state that persists across steps (the model's declared globals).
  const persistent: Record<string, unknown> = {};
  const reserved = new Set(["env", "env_messages", "prompt", "console", "print", "final", "llm"]);
  const llmCache = new Map<string, string>();

  const makeLlm = (pending: string[]) => (question: unknown): string => {
    if (typeof question !== "string" || !question.trim()) {
      throw new Error("llm() needs a non-empty string question");
    }
    if (llmCache.size + pending.length >= RLM_MAX_LLM_CALLS) {
      throw new Error(`llm() limit reached (${RLM_MAX_LLM_CALLS} calls per turn)`);
    }
    const cached = llmCache.get(question);
    if (cached !== undefined) return cached;
    if (!pending.includes(question)) pending.push(question);
    return LLM_PENDING;
  };

  /** Run one sandbox step. Pending llm() calls are collected; the caller
   * resolves them and re-runs the same code (the cache then makes the calls
   * return real answers synchronously). Re-runs reuse `persistent`, so a
   * re-executed declaration re-applies — the model's step code is expected
   * to be stateless queries, which the instructions demand. */
  const stepTimeoutMs = input.stepTimeoutMs ?? RLM_STEP_TIMEOUT_MS;
  const runCode = (code: string): { output: string; pending: string[]; finalValue: unknown } => {
    const out: string[] = [];
    const pending: string[] = [];
    let captured: unknown = UNSET;
    const sandbox = Object.assign(Object.create(null), persistent);
    sandbox.env = envText;
    sandbox.env_messages = envMessages;
    sandbox.prompt = input.prompt;
    sandbox.console = {
      log: (...args: unknown[]) => {
        if (out.length < RLM_MAX_OUTPUT_LINES) out.push(args.map((arg) => fmtValue(arg)).join(" "));
      },
    };
    sandbox.print = (...args: unknown[]) => {
      sandbox.console.log(...args);
    };
    sandbox.final = (value: unknown) => {
      captured = value;
      return value;
    };
    sandbox.llm = makeLlm(pending);

    let result: unknown;
    try {
      const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      result = vm.runInContext(code, context, { timeout: stepTimeoutMs, displayErrors: true });
    } catch (err) {
      return { output: `[error] ${truncate(fmtError(err), 500)}`, pending: [], finalValue: UNSET };
    }

    for (const key of Object.keys(sandbox)) {
      if (!reserved.has(key)) persistent[key] = sandbox[key];
    }
    const parts = [...out];
    const repr = fmtValue(result);
    if (repr !== "undefined" && repr !== "null") parts.push(repr);
    const output = parts.join("\n");
    return {
      output: truncate(output, RLM_MAX_OUTPUT_CHARS) || "(no output — a statement produces no value; use print/console.log or a trailing expression)",
      pending,
      finalValue: captured,
    };
  };

  const envMessages = (input.transcript ?? []).map((message) => ({ role: message.role, text: message.text }));
  const envText = envMessages.map((message) => `[${message.role}] ${message.text}`).join("\n\n");

  const finish = (text: string, steps: number): RlmTurnResult => {
    handlers.emit({ kind: "usage", usage });
    return { text, usage, steps, subcalls };
  };

  const rootThread: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: input.prompt }];

  for (let step = 1; step <= maxSteps; step++) {
    throwIfAborted();
    checkWallClock();

    const reply = await rootCall(rootThread);
    throwIfAborted(); // the abort may have landed while the response was in flight
    const { prose, code } = extractReplCode(reply);
    if (prose) handlers.emit({ kind: "reasoning", delta: prose });

    if (code) {
      handlers.emit({ kind: "tool", title: `repl · step ${step}`, detail: truncate(code.split("\n")[0] ?? code, 200) });
      let run = runCode(code);
      for (let round = 1; run.pending.length > 0 && round < RLM_MAX_LLM_ROUNDS; round++) {
        handlers.emit({
          kind: "tool",
          title: `llm · ${run.pending.length} call${run.pending.length === 1 ? "" : "s"}`,
          detail: truncate(run.pending.join(" | "), 200),
        });
        await Promise.all(run.pending.map(async (question) => {
          try {
            llmCache.set(question, await subCall(question));
          } catch (err) {
            llmCache.set(question, `[llm error] ${fmtError(err)}`);
          }
        }));
        run = runCode(code);
      }
      if (run.pending.length > 0) run = { ...run, output: `${run.output}\n[llm] ${run.pending.length} sub-call(s) left unresolved this step (limit)` };
      if (run.finalValue !== UNSET) {
        const value = typeof run.finalValue === "string" ? run.finalValue : fmtValue(run.finalValue);
        if (value.trim() && value !== "undefined") return finish(value.trim(), step);
      }
      rootThread.push({ role: "assistant", content: reply }, { role: "user", content: `[sandbox output]\n${run.output}` });
    } else {
      const textFinal = extractFinal(reply);
      if (textFinal) {
        if (textFinal.rest) handlers.emit({ kind: "reasoning", delta: textFinal.rest });
        return finish(textFinal.value, step);
      }
      rootThread.push(
        { role: "assistant", content: reply },
        { role: "user", content: '[harness] Your reply contained neither final(...) nor a ```repl code block. Either call final("<answer>") or continue exploring with a code block.' },
      );
    }
  }

  // Step cap: one last chance with an explicit nudge, then the best effort
  // degrades to whatever the model produced — never a silent truncation.
  throwIfAborted();
  checkWallClock();
  const nudge = `[harness] Step limit (${maxSteps}) reached. Reply now with final("<your best complete answer based on what you learned>").`;
  const lastReply = await rootCall([...rootThread, { role: "user", content: nudge }]);
  const forced = extractFinal(lastReply) ?? { value: extractReplCode(lastReply).prose || lastReply.trim(), rest: "" };
  return finish(forced.value || "(no answer produced)", maxSteps);
}
