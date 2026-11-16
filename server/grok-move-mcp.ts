// Moving from Grok Bot over a connector: the MCP a Bot in Grok Bot talks to. Grok Bot calls it from its own cloud
// computer, so every message here is untrusted internet input, and holding the link's key is all a caller has.
// Security: a caller can add exports and read a count, never read an export back. An export is kept as the importer
// reads it: refused whole when it holds credential-looking fields, token-shaped text redacted, anything the importer
// does not read dropped. Nothing is written to disk, and nothing is imported until the person chooses to.
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
  };
}

// The names and the `document` input are fixed: the published MausBot bot in Grok Bot calls them.
const tools = (app = productName()) => [
  {
    name: "move_status",
    description: `Check the link to ${app}: whether it works, how many Bots have arrived so far, and when it stops working. Call this first.`,
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
    return refused(`Nothing was saved: this link has taken all it can hold. Tell the person to import what has arrived in ${productName()}, then to make a new link there for the rest.`);
  }
  const app = productName();
  return said(`Arrived in ${app}. ${bots.map(received).join(" ")} The person can now import ${bots.length === 1 ? "it" : "them"} in ${app}, under Settings → Import & export.`);
}

function moveStatus(link: MoveLink): ToolResult {
  const names = new Set(link.inbox.arrivals.flatMap((arrival) => arrival.botNames).map((name) => name.toLowerCase()));
  const app = productName();
  return said(`Connected to ${app}. ${plural(names.size, "Bot")} received so far. This link works until ${new Date(link.expiresAt).toISOString()}, while ${app} stays open. Send each Bot with send_export, one Bot per call.`);
}

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});

export interface MoveLink { inbox: MoveInbox; expiresAt: number }
/** An HTTP answer: `body` is JSON, and no body means an empty reply. */
export interface MoveMcpAnswer { status: number; body?: unknown }

export const moveRpcError = (id: string | number | null, code: number, message: string, status = 200): MoveMcpAnswer =>
  ({ status, body: { jsonrpc: "2.0", id, error: { code, message } } });

/** One parsed JSON message of MCP over Streamable HTTP: one JSON answer per request, no session and no stream. */
export function moveMcp(message: unknown, link: MoveLink, now = Date.now()): MoveMcpAnswer {
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
      serverInfo: { name: productName(), version: "1.0.0" },
      instructions: `Moves Bots to ${productName()}. Call move_status, then send_export once per Bot.`,
    });
  }
  if (method === "ping") return result({});
  if (method === "tools/list") return result({ tools: tools() });
  if (method === "tools/call") {
    if (params?.name === "move_status") return result(moveStatus(link));
    if (params?.name === "send_export") return result(sendExport(params.arguments, link.inbox, now));
    return moveRpcError(id, -32602, "Unknown tool. The tools are move_status and send_export.");
  }
  return moveRpcError(id, -32601, "Method not found");
}
