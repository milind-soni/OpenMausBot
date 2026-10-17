import { join } from "node:path";

import { bridgedCallName } from "./agents-bridge-names.ts";
import { readDecisions, type DecisionKind, type DecisionRow } from "./decision-log.ts";
import { isRuntimeEvent, readRecentLines } from "./thread-events.ts";

import type { ActivityOutcome, ActivityRow } from "../shared/activity.ts";

export type { ActivityOutcome, ActivityRow };

/** Composio toolkit slugs whose display name is not just a capitalised word. */
const TOOLKIT_NAMES: Record<string, string> = {
  GMAIL: "Gmail",
  GITHUB: "GitHub",
  GOOGLESHEETS: "Google Sheets",
  GOOGLECALENDAR: "Google Calendar",
  GOOGLEDRIVE: "Google Drive",
  GOOGLEDOCS: "Google Docs",
  HUBSPOT: "HubSpot",
  HIGHLEVEL: "HighLevel",
  LINKEDIN: "LinkedIn",
  YOUTUBE: "YouTube",
  TWITTER: "X",
  WHATSAPP: "WhatsApp",
  ONEDRIVE: "OneDrive",
};

const BUILTIN_LABELS: Record<string, string> = {
  Bash: "Ran a command",
  Read: "Read a file",
  Edit: "Edited a file",
  MultiEdit: "Edited files",
  Write: "Wrote a file",
  Glob: "Searched files",
  Grep: "Searched files",
  LS: "Listed a folder",
  WebSearch: "Searched the web",
  WebFetch: "Fetched a page",
  Skill: "Used a skill",
  Task: "Ran a subagent",
  Agent: "Ran a subagent",
  AskUserQuestion: "Asked you a question",
  TodoWrite: "Updated its task list",
};

function humanize(raw: string): string {
  const spaced = raw
    .replace(/_+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : raw;
}

function toolkitName(slug: string): string {
  return TOOLKIT_NAMES[slug] ?? slug[0] + slug.slice(1).toLowerCase();
}

/** Composio names its tools TOOLKIT_ACTION_WORDS, all upper case. */
const COMPOSIO_TOOL = /^([A-Z][A-Z0-9]+)_([A-Z0-9_]+)$/;

/** The agents server's X and research tools read as their own app. */
const RESEARCH_TOOL_LABELS: Record<string, { app: string; label: string }> = {
  x_search: { app: "X", label: "Searched X" },
  x_user_posts: { app: "X", label: "Read X posts" },
  x_post: { app: "X", label: "Read an X post" },
  x_profile: { app: "X", label: "Looked up an X profile" },
  research_search: { app: "Research", label: "Searched research tools" },
  research_endpoint: { app: "Research", label: "Read a research tool" },
};

/** treg's catalog ids name their platform and what they return (`apollo.people.search`): a research call reads as the
 * kind of thing it looked up, never the vendor. */
const RESEARCH_CATEGORIES: ReadonlyArray<[RegExp, string]> = [
  [/^(?:x|twitter|tweets?)$/, "Searched X"],
  [/^(?:people|persons?|contacts?|emails?|employees?|leads?|prospects?)$/, "Looked up people"],
  [/^(?:compan(?:y|ies)|organi[sz]ations?|orgs?|firmographics?|business(?:es)?)$/, "Looked up companies"],
  [/^(?:funding|investors?|investments?|rounds?)$/, "Looked up funding"],
  [/^news$/, "Read the news"],
  [/^(?:linkedin|instagram|tiktok|youtube|reddit|facebook|threads|social)$/, "Looked up social data"],
  [/^trends?$/, "Looked up trends"],
  [/^(?:serp|google|bing|web)$/, "Searched the web"],
  [/^(?:seo|backlinks?|keywords?|domains?|rankings?)$/, "Looked up SEO data"],
  [/^(?:images?|video|voice|tts|speech|generate|generation)$/, "Generated media"],
];

function researchCallLabel(input: unknown): string {
  let args = input;
  if (typeof input === "string") {
    try { args = JSON.parse(input); } catch { args = undefined; }
  }
  // A bridged call (use_tool) carries the tool's own arguments under `arguments`.
  const own = args && typeof args === "object" && "arguments" in args ? (args as { arguments?: unknown }).arguments : args;
  const id = own && typeof own === "object" && typeof (own as { id?: unknown }).id === "string" ? (own as { id: string }).id : "";
  const words = id.toLowerCase().split(/[._@-]+/).slice(1);
  for (const [pattern, label] of RESEARCH_CATEGORIES) if (words.some((word) => pattern.test(word))) return label;
  return "Ran a research call";
}

export function describeTool(name: string, input?: unknown): { app: string | null; label: string } {
  const builtin = BUILTIN_LABELS[name];
  if (builtin) return { app: null, label: builtin };

  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const action = rest.join("__");
    if (server === "composio") return describeTool(action);
    if (server === "computer") return { app: "Computer", label: humanize(action) };
    if (server === "agents") {
      if (action === "research_call") {
        const label = researchCallLabel(input);
        return { app: label === "Searched X" ? "X" : "Research", label };
      }
      return Object.hasOwn(RESEARCH_TOOL_LABELS, action) ? RESEARCH_TOOL_LABELS[action]! : { app: "Team", label: humanize(action) };
    }
    if (server === "highlevel") return { app: "HighLevel", label: humanize(action.replace(/^HIGHLEVEL_/, "")) };
    if (server.startsWith("claude_ai_")) {
      return { app: server.slice("claude_ai_".length).replace(/_/g, " "), label: humanize(action) };
    }
    return { app: humanize(server), label: humanize(action) };
  }

  const composio = COMPOSIO_TOOL.exec(name);
  if (composio) return { app: toolkitName(composio[1]), label: humanize(composio[2]) };

  return { app: null, label: humanize(name) };
}

const DECISION_SCAN = 20_000;
const EVENTS_PER_THREAD = 2_000;
/** A verdict is written as the request opens and the run follows, occasionally a clock skew's worth earlier. */
const MATCH_BEFORE_MS = 5_000;
const MATCH_AFTER_MS = 30_000;

const OUTCOME_OF_DECISION: Record<DecisionKind, ActivityOutcome> = {
  "auto-approved": "allowed",
  "auto-denied": "denied",
  "user-approved": "allowed",
  "review-would-approve": "allowed",
  "user-denied": "denied",
  // A person reverted a change that had applied on its own.
  "user-undone": "denied",
  "review-would-deny": "denied",
  "card-shown": "waiting",
};

function describeRow(base: Omit<ActivityRow, "app" | "label">, input?: unknown): ActivityRow {
  const { app, label } = describeTool(base.tool, input ?? base.summary);
  return { ...base, app, label };
}

/** The decision log writes a row when a card is shown and another when it is answered; the receipt wants the answer. */
function foldDecisions(rows: DecisionRow[]): ActivityRow[] {
  const byRequest = new Map<string, DecisionRow[]>();
  rows.forEach((row, index) => {
    const key = row.requestId ?? `row:${index}`;
    const group = byRequest.get(key);
    if (group) group.push(row);
    else byRequest.set(key, [row]);
  });
  const folded: ActivityRow[] = [];
  for (const group of byRequest.values()) {
    const opened = group[0];
    const latest = group[group.length - 1];
    const summary = group.find((row) => row.summary)?.summary;
    folded.push(
      describeRow({
        at: opened.at,
        threadId: opened.threadId,
        requestId: opened.requestId,
        tool: latest.tool ?? opened.tool ?? "unknown",
        ...(summary ? { summary } : {}),
        outcome: OUTCOME_OF_DECISION[latest.decision],
      }),
    );
  }
  return folded;
}

function readToolRuns(eventsDir: string, threadId: string): ActivityRow[] {
  const { lines } = readRecentLines(join(eventsDir, `${threadId}.ndjson`), EVENTS_PER_THREAD, isRuntimeEvent);
  const runs = new Map<string, ActivityRow>();
  for (const event of lines) {
    if (event.type === "item.started" && event.itemType === "tool") {
      const key = JSON.stringify([event.turnId ?? "", event.itemId ?? event.eventId]);
      runs.set(
        key,
        describeRow({
          at: event.createdAt,
          threadId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          // A bridged call reads as the tool it ran, only where the title itself names the agents server.
          tool: bridgedCallName(event.title ?? "unknown", event.input, { serverNamed: true }),
          outcome: "running",
        }, event.input),
      );
    } else if (event.type === "item.completed" && event.itemType === "tool" && event.itemId) {
      const run = runs.get(JSON.stringify([event.turnId ?? "", event.itemId]));
      if (run) run.outcome = event.ok ? "ran" : "failed";
    }
  }
  return [...runs.values()];
}

export function readBotActivity(input: {
  dataDir: string;
  eventsDir: string;
  botId: string;
  threadIds: string[];
  limit: number;
}): ActivityRow[] {
  const { dataDir, eventsDir, botId, threadIds, limit } = input;

  const runs = threadIds.flatMap((threadId) => readToolRuns(eventsDir, threadId));
  const decisions = foldDecisions(readDecisions(dataDir, DECISION_SCAN).filter((row) => row.botId === botId));

  const matched = new Set<ActivityRow>();
  const rows: ActivityRow[] = [...runs];
  for (const decision of decisions) {
    if (decision.outcome !== "allowed") {
      rows.push(decision);
      continue;
    }
    const askedAt = Date.parse(decision.at);
    let best: ActivityRow | null = null;
    for (const run of runs) {
      if (matched.has(run) || run.threadId !== decision.threadId || run.tool !== decision.tool) continue;
      const delta = Date.parse(run.at) - askedAt;
      if (delta < -MATCH_BEFORE_MS || delta > MATCH_AFTER_MS) continue;
      if (!best || Math.abs(delta) < Math.abs(Date.parse(best.at) - askedAt)) best = run;
    }
    if (best) {
      matched.add(best);
      if (decision.summary) best.summary = decision.summary;
      if (decision.requestId) best.requestId = decision.requestId;
    } else {
      rows.push(decision);
    }
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows.slice(0, Math.max(1, limit));
}
