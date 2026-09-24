// Box agent driver — the purest form of the idea: the turn runs ON the
// bot's own cloud computer (boat.dev), not on this machine. Uses the
// Box substrate's native agent facility:
//   POST /boxes/{id}/prompt   {provider: codex|claude-code, model, prompt}
//   GET  /boxes/{id}/prompts/{promptId}    run status
//   GET  /boxes/{id}/events                work events (polled)
//   POST /boxes/{id}/interrupt             stop running work
// The agent has the box's full desktop (Chrome, shell, disk) — the server
// separately polls screenshots so the chat shows the bot's screen live.
//
// The event payload shapes are tolerated liberally and teed verbatim to
// the native log — the same protocol-drift armor as every other driver.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import {
  OMB_ASK_TOOL,
  answerWithoutPreamble,
  askQuestionSummary,
  capAnswerEcho,
  parseOmbAskQuestions,
  questionChoices,
  stripOmbAskBlock,
} from "../../shared/ask-question.ts";

const DRIVER_KIND = "boxAgent";
// overridable so tests and a dev backend can be pointed at instead of the live provider
const BOX_API = process.env.OMB_BOX_API || "https://ascii.dev/api/box/v1";

const MODELS = {
  default: "claude-fable-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5 · on the box" },
    { id: "sonnet", label: "Claude Sonnet · on the box" },
    { id: "gpt-5.4", label: "GPT-5.4 (Codex) · on the box" },
  ],
};

/** The ask contract appended to every prompt. The box harness cannot pause
 * mid-run, so a question rides the run's final output as a fenced block and
 * OMB parses it at settle — the turn-held transport. */
const ASK_PROTOCOL = [
  "",
  "## Asking the person a question",
  "When a decision belongs to the person, end your reply with a fenced block exactly like this:",
  "",
  "```omb-ask",
  '{"questions":[{"question":"Ship the release now?","header":"Release","options":[{"label":"Ship now"},{"label":"Wait for the QA signoff"}]}]}',
  "```",
  "",
  "The block must be the last thing in your reply. You may ask up to 6 questions at once, each with up to 12 options; the person can always answer in their own words. Their answers arrive on your next prompt as `Q:`/`A:` lines — never invent them.",
].join("\n");

/** Any fence whose info string names the ask protocol, even when its body
 * does not parse: the marker for "the model tried to ask and failed". */
const ASK_FENCE_ANY = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*omb-ask\b/;

/** The box runs every harness boat.dev ships (claude-code, codex, pi, opencode,
 * prime-agent, kimi). Which one a model id belongs to comes from the public
 * catalog, `GET /api/provider-models` at the API root: an object keyed by
 * harness, each with its `models`. A bot that arrives here from another engine
 * carries that engine's model id, so this is what lets it keep its model. */
let catalog: Record<string, { models?: Array<{ id?: string }> }> | null = null;
async function loadCatalog(): Promise<void> {
  const root = BOX_API.replace(/\/api\/box\/v1\/?$/, "");
  catalog = await fetch(`${root}/api/provider-models`, { signal: AbortSignal.timeout(15_000) })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null) as typeof catalog;
}
const providerFor = (model: string): { provider: string; model: string } => {
  const slash = model.indexOf("/");
  if (slash > 0 && catalog?.[model.slice(0, slash)]) return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
  for (const [provider, harness] of Object.entries(catalog ?? {})) {
    if (harness.models?.some((m) => m?.id === model)) return { provider, model };
  }
  return { provider: model.startsWith("gpt") ? "codex" : "claude-code", model };
};

export interface BoxAgentConfig {
  pollMs: number;
  /** How long a held omb-ask waits for the person before resolving as a
   * timeout. Overridable so tests can exercise the path without faking the
   * clock (a leaked fake timer poisons every later test in the file). */
  askTimeoutMs?: number;
}

function decodeConfig(raw: unknown): BoxAgentConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    pollMs: typeof o.pollMs === "number" ? o.pollMs : 2500,
    ...(typeof o.askTimeoutMs === "number" ? { askTimeoutMs: o.askTimeoutMs } : {}),
  };
}

export const BoxAgentDriver: ProviderDriver<BoxAgentConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Computer", supportsMultipleInstances: false },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<BoxAgentConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const token = input.environment.BOX_TOKEN ?? process.env.BOX_TOKEN ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { cancel: () => void; turnId: string; boxId: string }>();
    /** One open ask per thread: the turn-held transport's pending card. The
     * thread is busy for exactly as long as the ask is open, so a second
     * block can never race the first. */
    const heldAsks = new Map<string, {
      requestId: string;
      settle: (reply: string | null, source: "user" | "timeout" | "system") => void;
    }>();
    /** Threads whose last run ended with an unparseable omb-ask fence: the
     * next prompt carries the correction so the ask is never lost silently. */
    const malformedAsks = new Set<string>();

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const api = async (path: string, opts: RequestInit = {}) => {
      const res = await fetch(`${BOX_API}${path}`, {
        ...opts,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...opts.headers },
        signal: (opts as any).signal ?? AbortSignal.timeout(30_000),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.code ?? body?.error ?? `box HTTP ${res.status}`);
      }
      return body;
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      const computer = turn.integrations?.computer;
      const boxId = computer && (!computer.kind || computer.kind === "box") ? computer.boxId : undefined;
      if (!token) throw new Error('box not configured — add {"box":{"token":"…"}} to ~/.openmausbot/config.json');
      if (!boxId) {
        throw new Error("this bot has no computer yet — open the Computer panel and provision one");
      }
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const model = turn.model || MODELS.default;

      const correction = malformedAsks.delete(threadId)
        ? "Your previous omb-ask block was malformed or empty, so the person never saw it. Ask again with a valid fenced omb-ask JSON block, or ask in plain words."
        : "";
      const prompt = [
        turn.system,
        "You are working on the assigned cloud computer — use its desktop, Chrome, and shell within the access described above.",
        ASK_PROTOCOL,
        ...(correction ? [correction] : []),
        "",
        turn.text,
      ]
        .filter((s) => s !== undefined)
        .join("\n");

      const postPrompt = async (promptText: string): Promise<string | null> => {
        if (!catalog) await loadCatalog();
        const started: any = await api(`/boxes/${boxId}/prompt`, {
          method: "POST",
          body: JSON.stringify({ ...providerFor(model), prompt: promptText }),
        });
        appendNative(threadId, { dir: "out", source: "box.prompt", msg: { model, prompt: promptText, response: started } });
        // real shape (2026-08): {type:"prompt.queued", promptId, promptRun:{id,…},
        // id:<box id>} — never fall back to the bare id, it's the box's
        return started?.promptRun?.id ?? started?.prompt?.id ?? started?.promptId ?? null;
      };
      const promptId = await postPrompt(prompt);

      let cancelled = false;
      active.set(threadId, {
        turnId,
        boxId,
        cancel: () => {
          cancelled = true;
          heldAsks.get(threadId)?.settle(null, "system");
          void api(`/boxes/${boxId}/interrupt`, { method: "POST" }).catch(() => {});
        },
      });
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: promptId, model });

      // poll events + run status until the prompt settles — and, when the
      // run ends on an omb-ask block, until the person answers it: the OMB
      // turn is the unit the whole server already understands (busy thread,
      // waiting-on-you, routines waiting), so it stays open across the ask
      // and the continuation prompt continues it rather than starting a
      // driver-initiated turn nobody accounts for.
      (async () => {
        // Event ids seen this TURN. The events stream is the whole
        // conversation, so a continuation run must not re-ingest history;
        // `taskId` normally filters it, but ids survive even shape drift.
        const seen = new Set<string>();
        let lastText = "";
        let pendingText = "";
        /** Why the box could not answer (login expired, model refused, …). */
        let problem: string | null = null;
        /** Emit unflushed deltas as assistant_text and reset pendingText.
         * The omb-ask block is protocol, not prose: it streamed raw (the
         * card is its readable form), and the settled message shows the
         * words around it, never the JSON. */
        const flushAssistantText = () => {
          const text = stripOmbAskBlock(pendingText);
          pendingText = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };
        /** Stream a full-text snapshot as a delta and accumulate it for flush. */
        const ingest = (text: string) => {
          const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
          lastText = text;
          if (!delta) return;
          pendingText += delta;
          emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
        };

        /** The run has settled: flush its prose, then hold the OMB turn open
         * on an omb-ask block (if any) until the person answers or the ask
         * times out. An answer chains the continuation run under this same
         * turn; a deny or timeout ends it. */
        const finishRun = async (ok: boolean, stopReason: string | null): Promise<{ ok: boolean; stopReason: string | null }> => {
          flushAssistantText();
          // An interrupt that lands between ask text streaming and settle
          // finds no heldAsks entry to settle; without this check the run
          // would register a fresh ask for a dead turn and hold stop pending
          // for the ask timeout.
          if (cancelled) {
            return { ok: false, stopReason: "interrupted" };
          }
          // A remotely interrupted or failed run must stay stopped, even
          // if its partial output already contains a complete question.
          if (!ok) return { ok, stopReason };
          const questions = parseOmbAskQuestions(lastText);
          if (!questions) {
            // A fence that did not parse is a question the person never saw.
            // Say so on the next prompt instead of losing it silently. (An
            // over-cap block does not land here: the parser caps it at six
            // questions and still shows the card.)
            if (ASK_FENCE_ANY.test(lastText)) malformedAsks.add(threadId);
            return { ok: ok && !cancelled, stopReason: cancelled ? "interrupted" : stopReason };
          }
          const requestId = newId();
          let settleHeld!: (reply: string | null, source: "user" | "timeout" | "system") => void;
          const held = new Promise<[string | null, "user" | "timeout" | "system"]>((resolve) => {
            const timer = setTimeout(() => settleHeld(null, "timeout"), config.askTimeoutMs ?? 15 * 60_000);
            timer.unref?.();
            settleHeld = (reply, source) => {
              heldAsks.delete(threadId);
              clearTimeout(timer);
              resolve([reply, source]);
            };
          });
          // register before emitting — an answer can race the emit
          heldAsks.set(threadId, { requestId, settle: settleHeld });
          const choices = questionChoices(questions);
          emit({
            ...base(threadId, turnId),
            requestId,
            type: "request.opened",
            requestType: "question",
            tool: OMB_ASK_TOOL,
            summary: askQuestionSummary(questions),
            questions,
            ...(choices?.length ? { choices } : {}),
            origin: "output",
          });
          const [reply, source] = await held;
          emit({ ...base(threadId, turnId), requestId, type: "request.resolved", behavior: reply !== null ? "answer" : "deny", source });
          if (reply === null || cancelled) {
            return { ok: ok && !cancelled, stopReason: cancelled ? "interrupted" : stopReason };
          }
          // The turn is still open, so this prompt continues it: same turnId,
          // same accounting, and the answer reaches the box the way the ask
          // contract promised — Q:/A: blocks, capped for echo.
          const continuation = [
            capAnswerEcho(answerWithoutPreamble(reply)),
            "",
            "The person answered the omb-ask questions above (Q:/A:). Continue the task with their answers; end with another omb-ask block only if you truly need more.",
          ].join("\n");
          const nextPromptId = await postPrompt(continuation);
          // Stop can land while the continuation POST is in flight: the
          // interrupt inside cancel() then hits a box with no active run,
          // and the continuation would start after it. Interrupt the run
          // that just started before ending the turn.
          if (cancelled) {
            void api(`/boxes/${boxId}/interrupt`, { method: "POST" }).catch(() => {});
            return { ok: false, stopReason: "interrupted" };
          }
          return await settleRun(nextPromptId);
        };

        /** Poll one box run to its settle. */
        const settleRun = async (runPromptId: string | null): Promise<{ ok: boolean; stopReason: string | null }> => {
          const startedAt = Date.now(); // one 30-min ceiling per box run, ask chains included
          lastText = "";
          pendingText = "";
          problem = null;
          for (;;) {
            if (cancelled) break;
            await new Promise((r) => setTimeout(r, config.pollMs));
            const events: any = await api(`/boxes/${boxId}/events`).catch(() => null);
            const list: any[] = events?.events ?? events?.items ?? [];
            for (const ev of list) {
              // The stream is the whole conversation from its start; `taskId`
              // names the prompt run an event belongs to. Earlier turns are
              // history, not this answer.
              if (runPromptId && ev.taskId && String(ev.taskId) !== runPromptId) continue;
              const id = String(ev.id ?? ev.eventId ?? JSON.stringify(ev).slice(0, 120));
              if (seen.has(id)) continue;
              seen.add(id);
              appendNative(threadId, { dir: "in", source: "box.events", msg: ev });
              const kind = String(ev.type ?? ev.kind ?? "");
              // "response" events carry the agent's text at data.content —
              // the FULL text so far, not a chunk. Clients accumulate
              // deltas, so forward only the growth; a drifted (non-prefix)
              // event re-sends whole and the settled message replaces the
              // stream anyway.
              const text = ev.text ?? ev.message ?? ev.data?.text ?? ev.data?.content ?? null;
              if (/assistant|message|output|response/i.test(kind) && typeof text === "string" && text.trim()) {
                ingest(text);
              } else if (/usage_limit|error|fail/i.test(kind)) {
                const why = ev.data?.summary ?? ev.data?.message ?? ev.data?.error ?? ev.message;
                if (typeof why === "string" && why.trim()) problem = why.trim();
              } else if (/tool|command|exec|browse/i.test(kind)) {
                flushAssistantText();
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId: id,
                  title: String(ev.title ?? ev.command ?? kind).slice(0, 80),
                });
              }
              // shape-drift backstop: without a promptId the status poll
              // below can never see a terminal state, so settle off the
              // events themselves instead of hanging to the 30-min ceiling
              if (!runPromptId && /complete|finish|done|success|fail|error/i.test(kind)) {
                const failed = /fail|error/i.test(kind);
                return await finishRun(!failed, failed ? kind : null);
              }
            }
            if (runPromptId) {
              const status: any = await api(`/boxes/${boxId}/prompts/${runPromptId}`).catch(() => null);
              appendNative(threadId, { dir: "in", source: "box.prompt.status", msg: status });
              // real shape (2026-08): {promptRun:{status:"finished",…}} —
              // flat fallbacks kept for drift
              const run: any = status?.promptRun ?? status?.prompt ?? status ?? {};
              const state = String(run?.status ?? "");
              if (/completed|succeeded|done|finished/i.test(state)) {
                const result = run?.result ?? run?.output ?? lastText;
                if (typeof result === "string" && result.trim() && result !== lastText) {
                  ingest(result);
                }
                if (!pendingText.trim() && !lastText.trim()) {
                  // a run that ends with nothing said and a recorded problem
                  // (login expired, …) is a failure the person must see
                  if (problem) throw new Error(problem);
                  pendingText = "(finished)";
                }
                return await finishRun(true, null);
              }
              if (/failed|error|cancelled|interrupted/i.test(state)) {
                const runError = [run?.error, run?.failureReason, run?.message].find((v) => typeof v === "string" && v.trim());
                if (problem || runError || /failed|error/i.test(state)) throw new Error(problem ?? runError ?? `the box run ${state}`);
                return await finishRun(false, state);
              }
            }
            if (Date.now() - startedAt > 30 * 60_000) {
              throw new Error("box run exceeded 30 minutes — interrupted");
            }
          }
          // cancelled
          return await finishRun(false, "interrupted");
        };

        try {
          const outcome = await settleRun(promptId);
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: outcome.ok, stopReason: outcome.stopReason, cost: null });
        } catch (e) {
          flushAssistantText();
          heldAsks.delete(threadId);
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!token) {
        return { state: "unavailable", reason: 'no Box token — add {"box":{"token":"…"}} to ~/.openmausbot/config.json' };
      }
      try {
        await api("/me");
        return { state: "available", authenticated: true, version: null };
      } catch (e) {
        return { state: "unavailable", reason: `box API unreachable: ${(e as Error).message}` };
      }
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.cancel(),
        respondToRequest: async (threadId, requestId, decision) => {
          const held = heldAsks.get(threadId);
          if (!held || held.requestId !== requestId) return "unavailable" as const; // settled, timed out, or restarted away
          const reply = decision.message?.trim();
          if (decision.behavior === "answer" && reply) {
            held.settle(decision.message!, "user");
            return "answered" as const;
          }
          if (decision.behavior === "deny") {
            held.settle(null, "user");
            return "rejected" as const;
          }
          // "allow" is not an answer to a question, and blank text is not either
          return "unavailable" as const;
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { cancel } of active.values()) cancel();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { cancel } of active.values()) cancel();
        listeners.clear();
      },
    };
  },
};
