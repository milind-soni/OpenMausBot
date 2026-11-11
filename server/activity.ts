import { join } from "node:path";

import { AGENTS_ACTION_TOOLS, agentsCallMember } from "../shared/agents-tool-names.ts";
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
  LINKEDIN: "LinkedIn",
  YOUTUBE: "YouTube",
  TWITTER: "X",
  WHATSAPP: "WhatsApp",
  ONEDRIVE: "OneDrive",
};

const BUILTIN_LABELS: Record<string, readonly [key: string, label: string]> = {
  Bash: ["activity.tool.ranCommand", "Ran a command"],
  Read: ["activity.tool.readFile", "Read a file"],
  Edit: ["activity.tool.editedFile", "Edited a file"],
  MultiEdit: ["activity.tool.editedFiles", "Edited files"],
  Write: ["activity.tool.wroteFile", "Wrote a file"],
  Glob: ["activity.tool.searchedFiles", "Searched files"],
  Grep: ["activity.tool.searchedFiles", "Searched files"],
  LS: ["activity.tool.listedFolder", "Listed a folder"],
  WebSearch: ["activity.tool.searchedWeb", "Searched the web"],
  WebFetch: ["activity.tool.fetchedPage", "Fetched a page"],
  Skill: ["activity.tool.usedSkill", "Used a skill"],
  Task: ["activity.tool.ranSubagent", "Ran a subagent"],
  Agent: ["activity.tool.ranSubagent", "Ran a subagent"],
  AskUserQuestion: ["activity.tool.askedQuestion", "Asked you a question"],
  TodoWrite: ["activity.tool.updatedTasks", "Updated its task list"],
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

export function toolkitName(slug: string): string {
  return TOOLKIT_NAMES[slug] ?? slug[0] + slug.slice(1).toLowerCase();
}

/** Composio names its tools TOOLKIT_ACTION_WORDS, all upper case. */
const COMPOSIO_TOOL = /^([A-Z][A-Z0-9]+)_([A-Z0-9_]+)$/;

type Described = { app: string | null; label: string; labelKey?: string; appKey?: string };

const APP_KEYS: Record<string, string> = { Team: "activity.app.team", Computer: "activity.app.computer", Research: "activity.app.research" };

/** The agents server's X and research tools read as their own app. */
const RESEARCH_TOOL_LABELS: Record<string, Described> = {
  x_search: { app: "X", label: "Searched X", labelKey: "activity.tool.searchedX" },
  x_user_posts: { app: "X", label: "Read X posts", labelKey: "activity.tool.readXPosts" },
  x_post: { app: "X", label: "Read an X post", labelKey: "activity.tool.readXPost" },
  x_profile: { app: "X", label: "Looked up an X profile", labelKey: "activity.tool.lookedUpXProfile" },
  research_search: { app: "Research", appKey: "activity.app.research", label: "Searched research tools", labelKey: "activity.tool.searchedResearch" },
  research_endpoint: { app: "Research", appKey: "activity.app.research", label: "Read a research tool", labelKey: "activity.tool.readResearchTool" },
};

const TEAM_ACTION_KEYS: Record<string, string> = {
  cancel_wait: "activity.tool.team.cancelWait",
  delete_trigger: "activity.tool.team.deleteTrigger",
  list_waits: "activity.tool.team.listWaits",
  wait_until: "activity.tool.team.waitUntil",
  add_mcp_server: "activity.tool.team.addMcpServer",
  ask_bot: "activity.tool.team.askBot",
  assignment_status: "activity.tool.team.assignmentStatus",
  attach_file: "activity.tool.team.attachFile",
  close_thread: "activity.tool.team.closeThread",
  coordinate_bots: "activity.tool.team.coordinateBots",
  create_bot: "activity.tool.team.createBot",
  create_room: "activity.tool.team.createRoom",
  create_trigger: "activity.tool.team.createTrigger",
  decide: "activity.tool.team.decide",
  delegate_bot: "activity.tool.team.delegateBot",
  extract: "activity.tool.team.extract",
  fill_login: "activity.tool.team.fillLogin",
  find_tool: "activity.tool.team.findTool",
  generate_image: "activity.tool.team.generateImage",
  list_bots: "activity.tool.team.listBots",
  list_room_targets: "activity.tool.team.listRoomTargets",
  list_rooms: "activity.tool.team.listRooms",
  list_shared_computers: "activity.tool.team.listSharedComputers",
  list_team_library: "activity.tool.team.listTeamLibrary",
  list_models: "activity.tool.team.listModels",
  list_team_setup: "activity.tool.team.listTeamSetup",
  list_threads: "activity.tool.team.listThreads",
  list_trigger_events: "activity.tool.team.listTriggerEvents",
  list_triggers: "activity.tool.team.listTriggers",
  manage_room: "activity.tool.team.manageRoom",
  manage_trigger: "activity.tool.team.manageTrigger",
  mcp_server: "activity.tool.team.mcpServer",
  memory_log: "activity.tool.team.memoryLog",
  memory_update: "activity.tool.team.memoryUpdate",
  message_person: "activity.tool.team.messagePerson",
  post_to_room: "activity.tool.team.postToRoom",
  propose_bot_deletion: "activity.tool.team.proposeBotDeletion",
  propose_model: "activity.tool.team.proposeModel",
  propose_profile: "activity.tool.team.proposeProfile",
  propose_team_memory: "activity.tool.team.proposeTeamMemory",
  propose_team_setup: "activity.tool.team.proposeTeamSetup",
  publish_page: "activity.tool.team.publishPage",
  raise_escalation: "activity.tool.team.raiseEscalation",
  report_bug: "activity.tool.team.reportBug",
  request_credential: "activity.tool.team.requestCredential",
  request_sign_in: "activity.tool.team.requestSignIn",
  retry_thread: "activity.tool.team.retryThread",
  select_computer: "activity.tool.team.selectComputer",
  send: "activity.tool.team.send",
  send_voice_note: "activity.tool.team.sendVoiceNote",
  session_read: "activity.tool.team.sessionRead",
  session_search: "activity.tool.team.sessionSearch",
  shared_computer: "activity.tool.team.sharedComputer",
  show_html: "activity.tool.team.showHtml",
  show_widget: "activity.tool.team.showWidget",
  skill_manage: "activity.tool.team.skillManage",
  skills_list: "activity.tool.team.skillsList",
  start_thread: "activity.tool.team.startThread",
  burst: "activity.tool.team.burst",
  tool_result_read: "activity.tool.team.toolResultRead",
  unpublish_page: "activity.tool.team.unpublishPage",
  update_html: "activity.tool.team.updateHtml",
  update_widget: "activity.tool.team.updateWidget",
  usage_limits: "activity.tool.team.usageLimits",
  use_tool: "activity.tool.team.useTool",
  vm_exec: "activity.tool.team.vmExec",
};

const COMPUTER_ACTION_KEYS: Record<string, string> = {
  click: "activity.tool.computer.click",
  computer_exec: "activity.tool.computer.computerExec",
  drag: "activity.tool.computer.drag",
  exec: "activity.tool.computer.exec",
  get_screen_size: "activity.tool.computer.getScreenSize",
  key_press: "activity.tool.computer.keyPress",
  move: "activity.tool.computer.move",
  open_url: "activity.tool.computer.openUrl",
  screenshot: "activity.tool.computer.screenshot",
  scroll: "activity.tool.computer.scroll",
  type_text: "activity.tool.computer.typeText",
  wait_for: "activity.tool.computer.waitFor",
};


/** treg's catalog ids name their platform and what they return (`apollo.people.search`): a research call reads as the
 * kind of thing it looked up, never the vendor. */
const RESEARCH_CATEGORIES: ReadonlyArray<[RegExp, string, string]> = [
  [/^(?:x|twitter|tweets?)$/, "Searched X", "activity.tool.searchedX"],
  [/^(?:people|persons?|contacts?|emails?|employees?|leads?|prospects?)$/, "Looked up people", "activity.tool.lookedUpPeople"],
  [/^(?:compan(?:y|ies)|organi[sz]ations?|orgs?|firmographics?|business(?:es)?)$/, "Looked up companies", "activity.tool.lookedUpCompanies"],
  [/^(?:funding|investors?|investments?|rounds?)$/, "Looked up funding", "activity.tool.lookedUpFunding"],
  [/^news$/, "Read the news", "activity.tool.readNews"],
  [/^(?:linkedin|instagram|tiktok|youtube|reddit|facebook|threads|social)$/, "Looked up social data", "activity.tool.lookedUpSocial"],
  [/^trends?$/, "Looked up trends", "activity.tool.lookedUpTrends"],
  [/^(?:serp|google|bing|web)$/, "Searched the web", "activity.tool.searchedWeb"],
  [/^(?:seo|backlinks?|keywords?|domains?|rankings?)$/, "Looked up SEO data", "activity.tool.lookedUpSeo"],
  [/^(?:images?|video|voice|tts|speech|generate|generation)$/, "Generated media", "activity.tool.generatedMedia"],
];

/** A call's own arguments from its recorded input, which may be a JSON preview. */
function callArguments(input: unknown): unknown {
  let args = input;
  if (typeof input === "string") {
    try { args = JSON.parse(input); } catch { args = undefined; }
  }
  // A bridged call (use_tool) carries the tool's own arguments under `arguments`.
  return args && typeof args === "object" && "arguments" in args ? (args as { arguments?: unknown }).arguments : args;
}

function researchCallLabel(input: unknown): { label: string; labelKey: string } {
  const own = callArguments(input);
  const id = own && typeof own === "object" && typeof (own as { id?: unknown }).id === "string" ? (own as { id: string }).id : "";
  const words = id.toLowerCase().split(/[._@-]+/).slice(1);
  for (const [pattern, label, labelKey] of RESEARCH_CATEGORIES) if (words.some((word) => pattern.test(word))) return { label, labelKey };
  return { label: "Ran a research call", labelKey: "activity.tool.ranResearchCall" };
}

const ownApp = (app: string): Pick<Described, "app" | "appKey"> => ({ app, ...(Object.hasOwn(APP_KEYS, app) ? { appKey: APP_KEYS[app] } : {}) });

const ownAction = (app: string, action: string, keys: Record<string, string>): Described =>
  ({ ...ownApp(app), label: humanize(action), ...(Object.hasOwn(keys, action) ? { labelKey: keys[action] } : {}) });

export function describeTool(name: string, input?: unknown): { app: string | null; label: string } {
  const { app, label } = describedTool(name, input);
  return { app, label };
}

export function describedTool(name: string, input?: unknown): Described {
  if (Object.hasOwn(BUILTIN_LABELS, name)) return { app: null, label: BUILTIN_LABELS[name]![1], labelKey: BUILTIN_LABELS[name]![0] };

  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const action = rest.join("__");
    if (server === "composio") return describeTool(action);
    if (server === "computer") return ownAction("Computer", action, COMPUTER_ACTION_KEYS);
    if (server === "agents") {
      if (action === "research_call") {
        const call = researchCallLabel(input);
        return { ...ownApp(call.label === "Searched X" ? "X" : "Research"), ...call };
      }
      const member = (AGENTS_ACTION_TOOLS[action]?.members.length ?? 0) > 1 ? agentsCallMember(action, callArguments(input)) : action;
      return Object.hasOwn(RESEARCH_TOOL_LABELS, member) ? RESEARCH_TOOL_LABELS[member]! : ownAction("Team", member, TEAM_ACTION_KEYS);
    }
    if (server === "email") return { app: "Email", appKey: "activity.app.email", label: humanize(action.replace(/^EMAIL_/, "")) };
    if (server === "device") return { app: "Phone", label: humanize(action.replace(/^PHONE_/, "")) };
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
  const { app, label, labelKey, appKey } = describedTool(base.tool, input ?? base.summary);
  return { ...base, app, label, ...(labelKey ? { labelKey } : {}), ...(appKey ? { appKey } : {}) };
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
    const summary = group.find((row) => row.summary);
    folded.push(
      describeRow({
        at: opened.at,
        threadId: opened.threadId,
        requestId: opened.requestId,
        tool: latest.tool ?? opened.tool ?? "unknown",
        ...(summary ? { summary: summary.summary, summaryCode: summary.summaryCode, summaryParams: summary.summaryParams } : {}),
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
          ...(event.step ? { summary: event.step.detail ?? event.step.target } : {}),
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
      if (decision.summary) Object.assign(best, { summary: decision.summary, summaryCode: decision.summaryCode, summaryParams: decision.summaryParams });
      if (decision.requestId) best.requestId = decision.requestId;
    } else {
      rows.push(decision);
    }
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows.slice(0, Math.max(1, limit));
}
