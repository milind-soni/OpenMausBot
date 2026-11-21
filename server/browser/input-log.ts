/**
 * Why a person's input to a bot's browser, or a bot's own page action, did not reach the page: one log line each and a
 * count since the server started, for a bug report. Security: a line carries a reason code, the tool or action kind, the
 * engine, the transport and the browser session's id; never page content, typed text, a selector or an address.
 */
export type InputEngine = "agent-browser" | "chrome";
export type InputTransport = "v1" | "v2" | "tools";

/** Refusals the server answers a person's action with. */
export const PERSON_REASONS = [
  "session_changed", "view_gone", "invalid_action", "held_elsewhere", "restart_needed", "not_controlling", "take_refused",
  "too_many_pending", "stream_not_connected", "too_many_keys", "unconfirmed", "browser_restarted", "slow", "page_refused",
  "action_failed", "busy", "not_handled", "other",
] as const;
export type PersonReason = typeof PERSON_REASONS[number];

/** Input the app dropped before sending it, as its view reports them. */
export const CLIENT_REASONS = ["stale_after_wait", "queue_full", "queue_halted", "send_failed", "take_failed", "not_connected", "held_elsewhere"] as const;
export type ClientReason = typeof CLIENT_REASONS[number];

export const BOT_REASONS = [
  "person_holds_control", "browser_stuck", "call_lost", "browser_closing", "browser_busy", "no_room", "target_not_found",
  "target_not_actionable", "timed_out", "typed_not_landed", "engine_error", "threw",
] as const;
export type BotReason = typeof BOT_REASONS[number];

/** The page actions a bot's failure is logged for. */
const PAGE_ACTIONS = new Set(["click", "dblclick", "fill", "type", "press", "check", "uncheck", "select", "hover", "upload"]);
const ACTION_KINDS = new Set(["mouse", "wheel", "key", "text", "take", "release", "input_mouse", "input_keyboard", "input_batch", "select_choose", "dialog", "navigate", "back", "forward", "reload", "tab-new", "tab-select", "tab-close", "restart"]);
const QUIET_MS = 5_000;
const MAX_SESSIONS = 200;
const SESSION = /^[\w.:-]{1,128}$/;

export interface InputEvent {
  who: "person" | "app" | "bot";
  reason: PersonReason | ClientReason | BotReason;
  /** A person's action kind or a bot's tool, from a fixed list; anything else is "other". */
  what: string;
  engine: InputEngine;
  transport: InputTransport;
  session: string;
  count?: number;
}

/** A bot tool's name without the engine's prefix when it is a page action, else null. */
export function pageAction(tool: unknown): string | null {
  const name = typeof tool === "string" ? tool.replace(/^agent_browser_/, "") : "";
  return PAGE_ACTIONS.has(name) ? name : null;
}

export function actionKind(type: unknown): string {
  return typeof type === "string" && ACTION_KINDS.has(type) ? type : "other";
}

const BOT_TEXT: Array<[RegExp, BotReason]> = [
  [/paused while a person controls/i, "person_holds_control"],
  [/browser engine is stuck|press restart/i, "browser_stuck"],
  [/did not (?:answer|run)|may still be running|timed out; restart/i, "call_lost"],
  [/browser is closing/i, "browser_closing"],
  [/browsers are already open|no room/i, "no_room"],
  [/busy with another|still busy|still running|another (?:thread|conversation)/i, "browser_busy"],
  [/not found|no element matches|could not locate|unknown ref|no such element|does not exist|stale/i, "target_not_found"],
  [/not visible|hidden|disabled|not (?:interactable|editable|enabled|clickable)|outside (?:of )?the viewport|covered|intercepts|obscured|cannot be (?:filled|typed|checked)|not an? (?:input|checkbox|select)/i, "target_not_actionable"],
  [/timed? ?out|timeout/i, "timed_out"],
];

/** The reason code for a bot's failed call; the text itself is never kept. */
export function botReason(text: string): BotReason {
  return BOT_TEXT.find(([pattern]) => pattern.test(text))?.[1] ?? "engine_error";
}

/** A person's lost input is a warning, which a bug report's recent log keeps; a bot's failed action is routine and is not. */
const printByWho = (line: string, who: InputEvent["who"]) => (who === "bot" ? console.info(line) : console.warn(line));

export function createBrowserInputLog(print: (line: string, who: InputEvent["who"]) => void = printByWho, now: () => number = Date.now) {
  const counts = new Map<string, { count: number; lastAt: number }>();
  const quiet = new Map<string, { until: number; held: number }>();

  function record(event: InputEvent): void {
    const what = event.who === "bot" ? pageAction(event.what) ?? "other" : event.who === "person" ? actionKind(event.what) : "input";
    const session = SESSION.test(event.session) ? event.session : "unknown";
    const times = Math.max(1, Math.min(Math.round(event.count ?? 1) || 1, 10_000));
    const key = `${event.who} ${event.reason} ${what} ${event.engine} ${event.transport}`;
    const row = counts.get(key) ?? { count: 0, lastAt: 0 };
    row.count += times;
    row.lastAt = now();
    counts.set(key, row);
    // A burst of the same refusal for one browser is one line, then one more carrying how many followed.
    const burst = `${key} ${session}`;
    const state = quiet.get(burst);
    if (state && now() < state.until) { state.held += times; return; }
    if (quiet.size >= MAX_SESSIONS) quiet.delete(quiet.keys().next().value!);
    quiet.delete(burst);
    quiet.set(burst, { until: now() + QUIET_MS, held: 0 });
    const repeats = times + (state?.held ?? 0);
    print(`browser input: ${event.who} ${what} dropped reason=${event.reason} engine=${event.engine} transport=${event.transport} session=${session}${repeats > 1 ? ` times=${repeats}` : ""}`, event.who);
  }

  return {
    record,
    /** What an app's view says it dropped before sending: only known reasons and whole counts are taken. */
    fromApp(value: unknown, context: Pick<InputEvent, "engine" | "transport" | "session">): void {
      if (!value || typeof value !== "object") return;
      for (const reason of CLIENT_REASONS) {
        const count = (value as Record<string, unknown>)[reason];
        if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) record({ who: "app", reason, what: "input", count, ...context });
      }
    },
    /** One line per kind of drop, most recent first. */
    lines(): string[] {
      return [...counts].sort(([, a], [, b]) => b.lastAt - a.lastAt).map(([key, row]) => `${key}: ${row.count}; last ${new Date(row.lastAt).toISOString()}`);
    },
    clear: () => { counts.clear(); quiet.clear(); },
  };
}

export type BrowserInputLog = ReturnType<typeof createBrowserInputLog>;

export const browserInputLog = createBrowserInputLog();
