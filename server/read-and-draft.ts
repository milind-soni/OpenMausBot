// Security invariant: a read-and-draft routine run is unattended and its prompt carries untrusted mail and invite text
// beside the person's private data, so it gets no way to act outside or to persist anything. Everything is allow-only:
// - the engine runs at Ask, and the server answers every request in the run itself: each is refused, never a card;
// - of OpenMausBot's own routes it may reach only conversation reads, the paging of its own long results, the engine's
//   hooks and the connected-apps relay;
// - through the relay it may only read Gmail and Google Calendar, and write a draft replying in one of the threads its
//   checks handed it, to that thread's sender, once;
// - what those reads return reaches it only as records;
// - no browser, computer, phone or other tools are mounted, and nothing it says is captured into memory.
import { connectorCallsIn, isReadOnlyTool, KNOWN_READ_SLUGS } from "../shared/outbound.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { ProviderAdapter } from "./contracts.ts";
import type { DecisionRow } from "./decision-log.ts";
import { recordsText } from "./records-block.ts";
import type { RoutineRun } from "./routines.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
type Adapter = Pick<ProviderAdapter, "respondToRequest" | "interruptTurn">;
type Say = (message: { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean } }) => unknown;
type Bot = { id: string; name: string; modelSelection: { instanceId: string } };

/** The system prompt a read-and-draft run keeps: who the person is, where its files are, its connected apps and what a
 * routine run is. No memory, recent work, team notes, skills or tool guides: less to leak, and a smaller turn. */
export const READ_AND_DRAFT_PARTS: ReadonlySet<string> = new Set(["user-profile", "files", "composio", "routine-execution", "automation-reply", "webhook"]);
/** The integrations a read-and-draft run keeps: OpenMausBot's own tools (fenced by route), the connected apps (fenced
 * by call) and the engine's hooks. */
export const READ_AND_DRAFT_TOOLS: ReadonlySet<string> = new Set(["agents", "composio", "hooks"]);

export const READ_AND_DRAFT_REFUSAL = "This routine reads and drafts only: OpenMausBot refused this. Do not try another way.";
const RULE = "read-and-draft";

/** OpenMausBot's own routes a read-and-draft run may reach. */
const ROUTES: ReadonlySet<string> = new Set([
  "GET /api/internal/session-search",
  "GET /api/internal/session-read",
  "GET /api/internal/tool-result",
  "POST /api/internal/tool-result",
  "POST /api/internal/hook",
  "POST /api/internal/connectors/mcp",
]);

/** Composio's meta tools that only describe tools; connecting an account waits for a person, so it is not here. */
const DISCOVERY: ReadonlySet<string> = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
/** A read verb does not make a tool safe here: a read on another app can take a URL and carry the run's text to it. */
const READ_APPS = ["GMAIL_", "GOOGLECALENDAR_"] as const;
export const DRAFT_TOOL = "GMAIL_CREATE_EMAIL_DRAFT";
/** Fields of a draft that would add someone the reply is not to. */
const OTHER_RECIPIENTS = ["cc", "bcc", "extra_recipients", "recipients"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const mayRead = (slug: string): boolean => READ_APPS.some((app) => slug.startsWith(app)) && (KNOWN_READ_SLUGS.has(slug) || isReadOnlyTool(slug));

export interface ReadAndDraftDeps {
  /** The routine run this conversation belongs to, if any. */
  runFor(threadId: string): RoutineRun | null;
  adapter(instanceId: string): Adapter | undefined;
  stale(event: RequestOpened): boolean;
  decide(row: Omit<DecisionRow, "at">): void;
  release(threadId: string): void;
  /** The run holding these checked items may draft a reply in this thread, to this address. */
  mayDraft(checkKey: string, threadId: string, to: string | undefined): boolean;
  drafted(checkKey: string, threadId: string): void;
}

export interface DraftReply { threadId: string; to?: string }

/** The reply a draft call writes, or null when it is not a reply in one thread to one person. */
export function draftReply(args: unknown): DraftReply | null {
  if (!isRecord(args) || typeof args.thread_id !== "string" || !args.thread_id) return null;
  if (OTHER_RECIPIENTS.some((name) => args[name] !== undefined && args[name] !== null && !(Array.isArray(args[name]) && (args[name] as unknown[]).length === 0) && args[name] !== "")) return null;
  const to = args.recipient_email;
  if (to !== undefined && typeof to !== "string") return null;
  return { threadId: args.thread_id, ...(typeof to === "string" ? { to } : {}) };
}

/** The first app tool of a relay frame a read-and-draft run may not run, or null when it only reads, drafts as allowed or
 * describes tools. Initialize, list and notification frames carry no tool. */
export function refusedConnectorCall(frame: unknown, draft: (reply: DraftReply) => boolean): string | null {
  if (!isRecord(frame) || frame.method !== "tools/call") return null;
  const call = isRecord(frame.params) ? frame.params : {};
  if (typeof call.name !== "string" || !call.name) return "tools/call";
  if (DISCOVERY.has(call.name)) return null;
  const calls = connectorCallsIn(call.name, call.arguments);
  if (!calls.length) return call.name;
  for (const one of calls) {
    if (mayRead(one.slug)) continue;
    const reply = one.slug === DRAFT_TOOL ? draftReply(one.arguments) : null;
    if (!reply || !draft(reply)) return one.slug;
  }
  return null;
}

/** A relay answer's text, each part as records, so what Gmail or Calendar said never reads as instructions. */
export function recordsAnswer(bytes: Uint8Array, contentType: string): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const wrapFrame = (raw: string): string => {
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return raw; }
    const content = isRecord(frame) && isRecord(frame.result) && Array.isArray(frame.result.content) ? frame.result.content : null;
    if (!content) return raw;
    for (const part of content) if (isRecord(part) && typeof part.text === "string") part.text = recordsText("a connected app (Gmail or Google Calendar)", part.text);
    return JSON.stringify(frame);
  };
  const wrapped = contentType.includes("text/event-stream")
    ? text.split("\n").map((line) => (line.startsWith("data: ") ? `data: ${wrapFrame(line.slice(6))}` : line)).join("\n")
    : wrapFrame(text);
  return new TextEncoder().encode(wrapped);
}

export function createReadAndDraft(deps: ReadAndDraftDeps) {
  const runOf = (threadId: string): RoutineRun | null => {
    const run = deps.runFor(threadId);
    return run?.access === "read-and-draft" && run.threadId === threadId ? run : null;
  };
  /** This conversation is a read-and-draft run's own, finished or not. */
  const confines = (threadId: string): boolean => runOf(threadId) !== null;
  const refuse = (bot: Pick<Bot, "id" | "name">, threadId: string, tool: string): true => {
    deps.decide({ threadId, botId: bot.id, botName: bot.name, tool, decision: "auto-denied", source: "routine", rule: RULE });
    return true;
  };

  /** True when the request is in a read-and-draft run and was refused here, before any grant or card. */
  function answers(event: RequestOpened, asker: Bot, say: Say): boolean {
    if (!confines(event.threadId)) return false;
    const adapter = deps.adapter(event.providerInstanceId ?? asker.modelSelection.instanceId);
    say({ role: "bot", kind: "activity", tool: { name: `Refused (reads and drafts only): ${event.summary.slice(0, 120)}`, ok: false } });
    deps.decide({ threadId: event.threadId, requestId: event.requestId, botId: asker.id, botName: asker.name, tool: event.tool, summary: event.summary, decision: "auto-denied", source: "routine", rule: RULE });
    const decision = { behavior: event.requestType === "question" ? "answer" as const : "deny" as const, message: READ_AND_DRAFT_REFUSAL };
    void (async () => {
      try {
        if (event.requestId === undefined || !adapter) throw new Error("no request to answer");
        if (await adapter.respondToRequest(event.threadId, event.requestId, decision) === "unavailable") throw new Error("nobody took the answer");
      } catch {
        if (event.turnId && !deps.stale(event)) await adapter?.interruptTurn(event.threadId, event.turnId).catch(() => {});
      }
      if (!deps.stale(event)) deps.release(event.threadId);
    })().catch(() => console.error("[read-and-draft] Could not refuse a request."));
    return true;
  }

  function refusesRoute(bot: Pick<Bot, "id" | "name">, threadId: string, method: string, path: string): boolean {
    const route = `${method} ${path}`;
    return !ROUTES.has(route) && confines(threadId) && refuse(bot, threadId, route);
  }

  /** True when the frame was refused; an allowed draft is counted, so a retry of the run never writes it twice. */
  function refusesConnectorCall(bot: Pick<Bot, "id" | "name">, threadId: string, frame: unknown): boolean {
    const run = runOf(threadId);
    if (!run) return false;
    const drafts: DraftReply[] = [];
    const refused = refusedConnectorCall(frame, (reply) => {
      const ok = run.checkKey !== undefined && deps.mayDraft(run.checkKey, reply.threadId, reply.to) && !drafts.some((one) => one.threadId === reply.threadId);
      if (ok) drafts.push(reply);
      return ok;
    });
    if (refused !== null) return refuse(bot, threadId, refused);
    for (const reply of drafts) deps.drafted(run.checkKey!, reply.threadId);
    return false;
  }

  return { confines, answers, refusesRoute, refusesConnectorCall };
}

export type ReadAndDraft = ReturnType<typeof createReadAndDraft>;
