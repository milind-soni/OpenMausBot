// A bot's activity log: what it did, in plain words, with the outcome.
//
// Nothing here is captured for the log's sake. Two records already on disk
// between them know everything a receipt needs: the per-thread runtime
// events (harness/bus.ts) say what ran and whether it finished, and the
// fleet-wide decision log (decision-log.ts) says what was asked, with which
// arguments, and who allowed it. This module reads both back and folds
// them into one row per thing that happened.
//
// Connector calls never pass through the harness — an agent CLI talks to
// Composio's MCP endpoint directly — which is exactly why this reads the
// logs instead of tapping a proxy that does not exist.
import { join } from "node:path";

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
  LINKEDIN: "LinkedIn",
  YOUTUBE: "YouTube",
  TWITTER: "X",
  WHATSAPP: "WhatsApp",
  ONEDRIVE: "OneDrive",
};

/** The agent's own built-in tools, phrased as what they did. */
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

/** "save_issue" → "Save issue", "TaskUpdate" → "Task update",
 * "CREATE_AN_ISSUE" → "Create an issue". */
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

/** Turn a raw tool name into the app it touched and the action, in words. */
export function describeTool(name: string): { app: string | null; label: string } {
  const builtin = BUILTIN_LABELS[name];
  if (builtin) return { app: null, label: builtin };

  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const action = rest.join("__");
    if (server === "composio") return describeTool(action);
    if (server === "computer") return { app: "Computer", label: humanize(action) };
    if (server === "agents") return { app: "Team", label: humanize(action) };
    if (server.startsWith("claude_ai_")) {
      return { app: server.slice("claude_ai_".length).replace(/_/g, " "), label: humanize(action) };
    }
    return { app: humanize(server), label: humanize(action) };
  }

  const composio = COMPOSIO_TOOL.exec(name);
  if (composio) return { app: toolkitName(composio[1]), label: humanize(composio[2]) };

  return { app: null, label: humanize(name) };
}

/** How many decision rows to read back before filtering to one bot. The
 * file is rotation-capped, so this is a ceiling on parse work, not a
 * window that quietly drops history. */
const DECISION_SCAN = 20_000;
/** Runtime events read per thread, newest first; the reader tail-walks. */
const EVENTS_PER_THREAD = 2_000;
/** An approval is folded into the tool run it unblocked when the run
 * started inside this window around the decision. A verdict is written
 * as the request opens; the run follows it, occasionally by a clock skew's
 * worth in the other direction. */
const MATCH_BEFORE_MS = 5_000;
const MATCH_AFTER_MS = 30_000;

const OUTCOME_OF_DECISION: Record<DecisionKind, ActivityOutcome> = {
  "auto-approved": "allowed",
  "auto-denied": "denied",
  "user-approved": "allowed",
  "review-would-approve": "allowed",
  "user-denied": "denied",
  "review-would-deny": "denied",
  "card-shown": "waiting",
};

function describeRow(base: Omit<ActivityRow, "app" | "label">): ActivityRow {
  const { app, label } = describeTool(base.tool);
  return { ...base, app, label };
}

/** One row per request: the decision log writes a row when a card is shown
 * and another when it is answered, and the receipt wants the answer. */
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
      const key = event.itemId ?? event.eventId;
      runs.set(
        key,
        describeRow({
          at: event.createdAt,
          threadId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          tool: event.title ?? "unknown",
          outcome: "running",
        }),
      );
    } else if (event.type === "item.completed" && event.itemType === "tool" && event.itemId) {
      const run = runs.get(event.itemId);
      if (run) run.outcome = event.ok ? "ran" : "failed";
    }
  }
  return [...runs.values()];
}

/** The bot's activity, newest first: every tool run in the threads named,
 * and every decision the broker logged for the bot, with an approval folded
 * into the run it unblocked wherever the two can be matched. */
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
