// The Grok Bot connector: the MCP a Bot in Grok Bot talks to. Grok Bot calls it from its own cloud computer, so every
// message here is untrusted internet input, and holding the link's key is all a caller has.
// Security: a caller can add exports and read a count, never read an export back. An export is kept as the importer
// reads it: refused whole when it holds credential-looking fields, token-shaped text redacted, anything the importer
// does not read dropped. Nothing is written to disk, and nothing is imported until the person chooses to.
// A caller can also hand the main bot a task and read that task back, and no other: the task reaches the bot as an
// outside event, never as the person, and the names and one-line jobs of the bots are all it learns of this place.
import { z } from "zod";

import { GROK_EXPORT_FORMAT, GrokImportError, grokExportDocument, parseGrokExport, type GrokBot } from "../shared/grok-import.ts";
import { productName } from "./brand.ts";

export const MOVE_MAX_DOCUMENTS = 100;
export const MOVE_MAX_BYTES = 16 * 1024 * 1024;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SPLIT = "Split the Bot into several documents with the same bot name, each complete and valid on its own and holding the part the others do not, and send each one with send_export.";

export interface MoveArrival { seq: number; at: number; text: string; botNames: string[] }

/** What one link has taken in. `seq` numbers its arrivals; the caller owns the counter so numbers never repeat across links. */
export interface MoveInbox {
  readonly arrivals: readonly MoveArrival[];
  /** False when the link has taken all it may hold. */
  add(text: string, botNames: string[], at: number): boolean;
  /** The person imported everything up to `seq`: it is let go, and its room is free again. */
  take(seq: number): void;
}

export function createMoveInbox(seq: () => number): MoveInbox {
  const arrivals: MoveArrival[] = [];
  let bytes = 0;
  return {
    arrivals,
    add(text, botNames, at) {
      const size = Buffer.byteLength(text);
      if (arrivals.length >= MOVE_MAX_DOCUMENTS || bytes + size > MOVE_MAX_BYTES) return false;
      bytes += size;
      arrivals.push({ seq: seq(), at, text, botNames });
      return true;
    },
    take(through) {
      const kept = arrivals.filter((arrival) => arrival.seq > through);
      arrivals.splice(0, arrivals.length, ...kept);
      bytes = kept.reduce((total, arrival) => total + Buffer.byteLength(arrival.text), 0);
    },
  };
}

export const HANDOFF_TASK_MAX = 8_000;
export const HANDOFF_CONTEXT_MAX = 16_000;
export const HANDOFFS_PER_HOUR = 30;
export const HANDOFF_WAIT_MAX_SECONDS = 25;
const HOUR_MS = 60 * 60 * 1000;
const RESULT_MAX = 4_000;
const ROSTER_MAX = 30;
const TO_BOT_MAX = 100;

export type HandoffState = "working" | "needs_you" | "done" | "failed" | "stopped";

/** One handed-off task, as the link that handed it off may know it. */
export interface HandoffStatus {
  title: string;
  state: HandoffState;
  /** The main bot first, then each teammate it handed work to. */
  on: string[];
  /** `needs_you`: what is asked of the person. `failed`: why. */
  detail?: string;
  /** The main bot's latest reply. */
  result?: string;
}

export interface HandoffAsk { task: string; toBot?: string; context?: string }

/** A refusal whose message the caller reads as it is. */
export class HandoffRefused extends Error {}

export interface MoveHost {
  bots(): Array<{ name: string; job?: string }>;
  /** Starts the task on the main bot. Throws HandoffRefused, with the fix, when it cannot. */
  handOff(ask: HandoffAsk): Promise<{ taskId: string; bot: string; title: string }>;
  /** Null for a task that is not there. With `waitMs`, a task being worked on is held until it changes or the wait ends. */
  status(taskId: string, waitMs: number): Promise<HandoffStatus | null>;
}

export const NO_MOVE_HOST: MoveHost = {
  bots: () => [],
  handOff: async () => { throw new HandoffRefused(`${productName()} cannot take tasks right now. Tell the person to open ${productName()} and try again.`); },
  status: async () => null,
};

/** One link: what it took in, the tasks it handed off (the only ones it may read) and when, for the hourly cap. */
export interface MoveLink { inbox: MoveInbox; host: MoveHost; tasks: Set<string>; handoffs: number[] }

export const createMoveLink = (seq: () => number, host: MoveHost = NO_MOVE_HOST): MoveLink =>
  ({ inbox: createMoveInbox(seq), host, tasks: new Set(), handoffs: [] });

// The names and inputs are fixed: the published MausBot bot in Grok Bot calls them. The descriptions are all that bot
// knows of this place.
const tools = (app = productName()) => [
  {
    name: "move_status",
    description: `Check the link to ${app}: whether it works, how many Bots have arrived so far, and which bots ${app} has, by name and job. Call this first.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_export",
    description: `Send one Bot's setup to ${app}. \`document\` is a ${GROK_EXPORT_FORMAT} document: {"format": "${GROK_EXPORT_FORMAT}", "version": 1, "bots": [{name, title, instructions, memories, user_facts, skills, routines, apps}]}. Send one Bot per call, with every skill and routine in full. Never include passwords, API keys, tokens or cookies: a document that has them is refused. A document over 4 MB is refused: split it into several documents with the same bot name. The person sees what arrived in ${app} and chooses what to import; nothing changes where the Bot came from.`,
    inputSchema: {
      type: "object",
      properties: { document: { type: "object", description: `The ${GROK_EXPORT_FORMAT} document.` } },
      required: ["document"],
    },
  },
  {
    name: "hand_off_task",
    description: `Hand a task to ${app}. Use it when the person asks ${app}, or one of ${app}'s bots by name, to do something. \`task\` says what to do, in full and in plain words: ${app} has not seen this conversation. \`context\` is any background the task needs. \`to_bot\` is the bot the person named, if they named one (move_status lists them). The task goes to ${app}'s main bot, which does it or hands it to the right bot. This returns a task_id at once and does not wait for the work: read the result with task_status. ${app} asks the person directly, in ${app}, when it needs an approval or an answer; you cannot approve anything for them. Never include passwords, API keys or tokens.`,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: `What to do, at most ${HANDOFF_TASK_MAX.toLocaleString("en-US")} characters.` },
        to_bot: { type: "string", description: `The name of the ${app} bot the person asked for, if any.` },
        context: { type: "string", description: `Background the task needs, at most ${HANDOFF_CONTEXT_MAX.toLocaleString("en-US")} characters.` },
      },
      required: ["task"],
    },
  },
  {
    name: "task_status",
    description: `Read a task you handed off with hand_off_task: whether ${app} is working on it, needs the person, is done, failed or was stopped, which bots are on it, and the result once it is done. \`wait_seconds\` (0 to ${HANDOFF_WAIT_MAX_SECONDS}) holds the answer until the task changes, so call it again while the task is being worked on. When the task needs the person, tell them to answer in ${app}.`,
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id hand_off_task returned." },
        wait_seconds: { type: "number", description: `How long to wait for a change, 0 to ${HANDOFF_WAIT_MAX_SECONDS}.` },
      },
      required: ["task_id"],
    },
  },
];

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };
const said = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const refused = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function refusal(error: GrokImportError): string {
  switch (error.code) {
    case "credentials":
      return `Nothing was saved: the document has passwords or keys in these fields: ${error.keys.join(", ")}. Take those fields out and send it again.`;
    case "tooLarge":
      return `Nothing was saved: the document is larger than 4 MB. ${SPLIT}`;
    case "cutOff":
      return `Nothing was saved: the document is cut off. Send it again whole. If it is too long, do this: ${SPLIT}`;
    case "newerVersion":
      return `Nothing was saved: ${productName()} reads version 1 of ${GROK_EXPORT_FORMAT}. Send the document with "version": 1.`;
    case "notExport":
    case "unusable":
      return `Nothing was saved: that is not a ${GROK_EXPORT_FORMAT} document. Send {"format": "${GROK_EXPORT_FORMAT}", "version": 1, "bots": [{"name": ..., "instructions": ..., "memories": [...], "skills": [...], "routines": [...]}]} as \`document\`, with a name for each Bot.`;
  }
}

/** What MausBot can use of one Bot, and what it cannot: a skill or routine without its text creates nothing. */
function received(bot: GrokBot): string {
  const skills = bot.skills.filter((skill) => skill.instructions).length;
  const routines = bot.routines.filter((routine) => routine.instruction).length;
  const left = [
    skills < bot.skills.length ? `${plural(bot.skills.length - skills, "skill")} without instructions` : "",
    routines < bot.routines.length ? `${plural(bot.routines.length - routines, "routine")} without an instruction` : "",
  ].filter(Boolean);
  return `${bot.name}: ${plural(skills, "skill")}, ${plural(routines, "routine")}, ${plural(bot.memories.length + bot.userFacts.length, "memory", "memories")}.`
    + (left.length ? ` Left out: ${left.join(" and ")}. Send those again with their full text if the Bot has it.` : "");
}

function sendExport(args: unknown, inbox: MoveInbox, now: number): ToolResult {
  const document = (args as { document?: unknown } | null | undefined)?.document;
  // A model often sends an object argument as JSON text; the parser reads both.
  const text = typeof document === "string" ? document : document && typeof document === "object" ? JSON.stringify(document) : "";
  if (!text) return refused(`Nothing was saved: send the ${GROK_EXPORT_FORMAT} document as \`document\`.`);
  let bots: GrokBot[];
  try {
    bots = parseGrokExport(text);
  } catch (error) {
    if (error instanceof GrokImportError) return refused(refusal(error));
    throw error;
  }
  if (!inbox.add(JSON.stringify(grokExportDocument(bots)), bots.map((bot) => bot.name), now)) {
    return refused(`Nothing was saved: this link has taken all it can hold. Tell the person to import what has arrived in ${productName()}, then send the rest.`);
  }
  const app = productName();
  return said(`Arrived in ${app}. ${bots.map(received).join(" ")} The person can now import ${bots.length === 1 ? "it" : "them"} in ${app}, under Settings → Import.`);
}

function moveStatus(link: MoveLink): ToolResult {
  const names = new Set(link.inbox.arrivals.flatMap((arrival) => arrival.botNames).map((name) => name.toLowerCase()));
  const app = productName();
  const bots = link.host.bots();
  const roster = bots.slice(0, ROSTER_MAX).map((bot) => (bot.job ? `${bot.name} (${bot.job})` : bot.name)).join("; ");
  return said(`Connected to ${app}. ${plural(names.size, "Bot")} received so far. This link works while ${app} stays open, until the person turns it off. To move a Bot, send it with send_export, one Bot per call. To have ${app} do something, call hand_off_task.`
    + (roster ? ` ${app}'s bots: ${roster}${bots.length > ROSTER_MAX ? `; and ${bots.length - ROSTER_MAX} more` : ""}.` : ""));
}

const words = (value: unknown): string => (typeof value === "string" ? value : "");
const over = (field: string, max: number, fix: string) => `Nothing was handed off: \`${field}\` is longer than ${max.toLocaleString("en-US")} characters. ${fix}`;

async function handOffTask(args: unknown, link: MoveLink, now: number): Promise<ToolResult> {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const task = words(input.task).trim();
  const context = words(input.context).trim();
  const toBot = words(input.to_bot).replace(/\s+/g, " ").trim().slice(0, TO_BOT_MAX);
  if (!task) return refused("Nothing was handed off: say what to do as `task`, in plain words.");
  if (task.length > HANDOFF_TASK_MAX) return refused(over("task", HANDOFF_TASK_MAX, "Say what to do in fewer words and put the background in `context`."));
  if (context.length > HANDOFF_CONTEXT_MAX) return refused(over("context", HANDOFF_CONTEXT_MAX, "Send only the background the task needs."));
  link.handoffs = link.handoffs.filter((at) => at > now - HOUR_MS);
  if (link.handoffs.length >= HANDOFFS_PER_HOUR) {
    return refused(`Nothing was handed off: this link has handed off ${HANDOFFS_PER_HOUR} tasks in the last hour. Try again after ${new Date(link.handoffs[0]! + HOUR_MS).toISOString()}.`);
  }
  // Counted before the task starts, so tasks sent at once cannot pass the cap together.
  link.handoffs.push(now);
  const app = productName();
  try {
    const made = await link.host.handOff({ task, ...(toBot ? { toBot } : {}), ...(context ? { context } : {}) });
    link.tasks.add(made.taskId);
    return said(`Handed to ${made.bot} in ${app} as "${made.title}". task_id: ${made.taskId}. Read the result with task_status and this task_id. ${app} asks the person directly, in ${app}, if it needs an approval or an answer.`);
  } catch (error) {
    link.handoffs.splice(link.handoffs.lastIndexOf(now), 1);
    if (error instanceof HandoffRefused) return refused(`Nothing was handed off: ${error.message}`);
    throw error;
  }
}

function statusText(status: HandoffStatus): string {
  const app = productName();
  const on = status.on.length ? ` On it: ${status.on.join(", ")}.` : "";
  const result = status.result?.trim() ? `\n\nResult:\n${status.result.trim().slice(0, RESULT_MAX)}` : "";
  switch (status.state) {
    case "working":
      return `"${status.title}" is being worked on.${on} Call task_status again; wait_seconds up to ${HANDOFF_WAIT_MAX_SECONDS} holds the answer until something changes.`;
    case "needs_you":
      return `"${status.title}" is waiting for the person.${status.detail ? ` ${app} asks: ${status.detail}` : ""} Only the person can answer, and they answer in ${app}: tell them to open ${app}. Then call task_status again.${on}`;
    case "done":
      return `"${status.title}" is done.${on}${result || `\n\n${app} gave no reply text. The person can read the work in ${app}.`}`;
    case "failed":
      return `"${status.title}" failed${status.detail ? `: ${status.detail}` : "."}${on} The person can open it in ${app}, or you can hand it off again.${result}`;
    case "stopped":
      return `"${status.title}" was stopped in ${app}.${on}${result}`;
  }
}

async function taskStatus(args: unknown, link: MoveLink): Promise<ToolResult> {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const taskId = words(input.task_id).trim();
  const wait = typeof input.wait_seconds === "number" && Number.isFinite(input.wait_seconds) ? Math.min(Math.max(input.wait_seconds, 0), HANDOFF_WAIT_MAX_SECONDS) : 0;
  // A task another link handed off, or one that was never there, reads the same.
  const status = link.tasks.has(taskId) ? await link.host.status(taskId, Math.round(wait * 1000)) : null;
  if (!status) return refused("No task with that task_id was handed off through this link. Use the task_id hand_off_task returned.");
  return said(statusText(status));
}

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** An HTTP answer: `body` is JSON, and no body means an empty reply. */
export interface MoveMcpAnswer { status: number; body?: unknown }

export const moveRpcError = (id: string | number | null, code: number, message: string, status = 200): MoveMcpAnswer =>
  ({ status, body: { jsonrpc: "2.0", id, error: { code, message } } });

/** One parsed JSON message of MCP over Streamable HTTP: one JSON answer per request, no session and no stream. */
export async function moveMcp(message: unknown, link: MoveLink, now = Date.now()): Promise<MoveMcpAnswer> {
  const parsed = rpcSchema.safeParse(message);
  // A response, a batch, or anything else that is not one request: nothing to answer.
  if (!parsed.success) return moveRpcError(null, -32600, "Send one JSON-RPC 2.0 request", 400);
  const { id, method, params } = parsed.data;
  if (id === undefined) return { status: 202 };
  const result = (value: unknown): MoveMcpAnswer => ({ status: 200, body: { jsonrpc: "2.0", id, result: value } });
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return result({
      protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: productName(), version: "1.1.0" },
      instructions: `Connects Grok Bot to ${productName()}. Call move_status first. To move a Bot, call send_export once per Bot. To have ${productName()} do something, call hand_off_task, then task_status for the result.`,
    });
  }
  if (method === "ping") return result({});
  if (method === "tools/list") return result({ tools: tools() });
  if (method === "tools/call") {
    if (params?.name === "move_status") return result(moveStatus(link));
    if (params?.name === "send_export") return result(sendExport(params.arguments, link.inbox, now));
    if (params?.name === "hand_off_task") return result(await handOffTask(params.arguments, link, now));
    if (params?.name === "task_status") return result(await taskStatus(params.arguments, link));
    return moveRpcError(id, -32602, "Unknown tool. The tools are move_status, send_export, hand_off_task and task_status.");
  }
  return moveRpcError(id, -32601, "Method not found");
}
