// The Grok Bot connector: the MCP a Bot in Grok Bot talks to. Grok Bot calls it from its own cloud computer, so every
// message here is untrusted internet input, and holding the link's key is all a caller has.
// Security: a caller can add exports, pages and files and read counts, never read any of them back. An export is kept
// as the importer reads it: refused whole when it holds credential-looking fields, token-shaped text redacted, anything
// the importer does not read dropped. A page or file named like a credential store, or holding a credential's shape, is
// refused. Nothing is written to disk, and nothing is imported until the person chooses to.
// A caller can also hand the main bot a task and read that task back, and no other: the task reaches the bot as an
// outside event, never as the person, and the names and one-line jobs of the bots are all it learns of this place.
import { z } from "zod";

import { JSX_PAGE_MODULES } from "../shared/app-frame/jsx-page.ts";
import { APP_LIMITS, oneLine } from "../shared/app.ts";
import { GROK_EXPORT_FORMAT, GrokImportError, grokExportDocument, parseGrokExport, type GrokBot } from "../shared/grok-import.ts";
import type { LinkManifest, LinkToolResult } from "../shared/grok-link.ts";
import { holdsCredential } from "../shared/redact.ts";
import { skillFilePathProblem, skillFileText, type SkillFileRefusal } from "../shared/skill-files.ts";
import { productName } from "./brand.ts";
import { compileJsxPage } from "./jsx-compile.ts";

export const MOVE_MAX_DOCUMENTS = 100;
export const MOVE_MAX_BYTES = 16 * 1024 * 1024;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SPLIT = "Split the Bot into several documents with the same bot name, each complete and valid on its own and holding the part the others do not, and send each one with send_export.";

export const MOVE_MAX_ASSETS = 10 * MOVE_MAX_DOCUMENTS;
export const MOVE_MAX_ASSET_BYTES = 4 * MOVE_MAX_BYTES;
export const MOVE_PAGE_MAX_BYTES = 1024 * 1024;
export const MOVE_FILE_MAX_BYTES = 3 * 1024 * 1024;
const BOT_NAME_MAX = 200;

export interface MoveArrival { seq: number; at: number; text: string; botNames: string[] }

/** One page or file of a Bot. `bot` is the Bot's name as its export gives it. */
export type MoveAsset = { seq: number; at: number; bot: string } & (
  | { kind: "page"; title: string; page: string; source?: string }
  | { kind: "file"; path: string; data: Buffer }
);
type Unnumbered<Asset> = Asset extends unknown ? Omit<Asset, "seq"> : never;
type NewAsset = Unnumbered<MoveAsset>;

export function grokPageSlug(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "page";
}

const sameBot = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const assetKey = (asset: NewAsset) => `${asset.kind}\n${asset.bot.toLowerCase()}\n${asset.kind === "page" ? grokPageSlug(asset.title) : asset.path}`;
const assetBytes = (asset: NewAsset) => (asset.kind === "page" ? Buffer.byteLength(asset.page) + Buffer.byteLength(asset.source ?? "") : asset.data.byteLength);

/** What one link has taken in. `seq` numbers its arrivals; the caller owns the counter so numbers never repeat across links. */
export interface MoveInbox {
  readonly arrivals: readonly MoveArrival[];
  readonly assets: readonly MoveAsset[];
  /** False when the link has taken all it may hold. */
  add(text: string, botNames: string[], at: number): boolean;
  /** A page sent again under the same title, or a file under the same path, takes the earlier one's place. False when
   * the link has taken all the pages and files it may hold. */
  addAsset(asset: NewAsset): boolean;
  /** The person imported every export up to `seq`: it is let go, and its room is free again. */
  take(seq: number): void;
  /** These pages and files were imported: they are let go. */
  drop(seqs: readonly number[]): void;
}

export function createMoveInbox(seq: () => number): MoveInbox {
  const arrivals: MoveArrival[] = [];
  const assets: MoveAsset[] = [];
  let bytes = 0;
  return {
    arrivals,
    assets,
    add(text, botNames, at) {
      const size = Buffer.byteLength(text);
      if (arrivals.length >= MOVE_MAX_DOCUMENTS || bytes + size > MOVE_MAX_BYTES) return false;
      bytes += size;
      arrivals.push({ seq: seq(), at, text, botNames });
      return true;
    },
    addAsset(asset) {
      const key = assetKey(asset);
      const others = assets.filter((held) => assetKey(held) !== key);
      const held = others.reduce((total, other) => total + assetBytes(other), 0);
      if (others.length >= MOVE_MAX_ASSETS || held + assetBytes(asset) > MOVE_MAX_ASSET_BYTES) return false;
      assets.splice(0, assets.length, ...others, { ...asset, seq: seq() } as MoveAsset);
      return true;
    },
    take(through) {
      const kept = arrivals.filter((arrival) => arrival.seq > through);
      arrivals.splice(0, arrivals.length, ...kept);
      bytes = kept.reduce((total, arrival) => total + Buffer.byteLength(arrival.text), 0);
    },
    drop(seqs) {
      assets.splice(0, assets.length, ...assets.filter((asset) => !seqs.includes(asset.seq)));
    },
  };
}

export const moveAssetsFor = (inbox: MoveInbox, bot: string): MoveAsset[] => inbox.assets.filter((asset) => sameBot(asset.bot, bot));

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
    description: `Check the link to ${app}: whether it works, how many Bots, pages and files have arrived so far, and which bots ${app} has, by name and job. Call this first.`,
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
    name: "send_page",
    description: `Send one of a Bot's pages (a canvas or a document) to ${app}, after that Bot's send_export. Your pages are in your user store: a canvas is /cursor/stores/user/canvases/<id>/source.canvas.tsx beside canvas.json, which has its title and, as \`contributors\`, the ids of the Bots that made it; a document is /cursor/stores/user/documents/<id>/source.md. Send every page of every Bot you move, one page per call, to the Bot whose id is in \`contributors\`. \`bot\` is that Bot's name exactly as in its send_export document. \`title\` is the page's title. \`page\` is the page rewritten by you as one ${app} page file, because ${app} cannot run grok/canvas: one React component file with \`export default\` of the page's component, styled with Tailwind classes, with every value the page shows written inline in the file, as your canvas has it. It may import only ${JSX_PAGE_MODULES.join(", ")}. \`mausbot\` gives Chart (\`<Chart option={...} height={320} />\`, an ECharts option), useTheme (returns "light" or "dark"), send, open and setContext. It cannot fetch, and it must not import grok/canvas: write each Page, Section, Text, Metrics, Columns, table and chart as plain elements and Chart. Keep the same content, numbers and order. Rewrite a document as a page that shows its text. \`source\` is the original file (the tsx or the markdown) as it is, kept beside the page. Never include passwords, API keys or tokens: a page that has one is refused. A page that does not compile is refused with the line: fix it and send it again. A page sent again under the same title replaces the earlier one.`,
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "The Bot's name, exactly as in its send_export document." },
        title: { type: "string", description: "The page's title." },
        page: { type: "string", description: `The ${app} page file: one React component file with a default export, at most 1 MB.` },
        source: { type: "string", description: "The original Grok Bot source, tsx or markdown, at most 1 MB." },
      },
      required: ["bot", "title", "page"],
    },
  },
  {
    name: "send_file",
    description: `Send one of a Bot's files to ${app}, after that Bot's send_export and its pages. A Bot's files are on its computer under /workspace and in its own store, /cursor/stores/store-<id>. Send the files the Bot made or needs for its work, one file per call. \`bot\` is the Bot's name exactly as in its send_export document. \`path\` is where the file goes in the bot's folder in ${app}: relative, with forward slashes, like reports/2026/summary.md (the path under /workspace or under the store). Send exactly one of \`text\` (a text file's content) and \`base64\` (any other file's bytes, base64-encoded). A file over 3 MB is refused: leave it out and tell the person which file it was. Hidden files and folders, package and cache folders, and files named like a key or password store (.env, *.pem, id_rsa, credentials) are refused: never send those. A file sent again under the same path replaces the earlier one.`,
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "The Bot's name, exactly as in its send_export document." },
        path: { type: "string", description: "The file's relative path, with forward slashes." },
        text: { type: "string", description: "The content of a text file." },
        base64: { type: "string", description: "The bytes of any other file, base64-encoded." },
      },
      required: ["bot", "path"],
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

type ToolResult = LinkToolResult;
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
  return said(`Arrived in ${app}. ${bots.map(received).join(" ")} The person can now import ${bots.length === 1 ? "it" : "them"} in ${app}, under Settings → Import & export.`);
}

const NOTHING_SAVED = "Nothing was saved: ";
const input = (args: unknown) => (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
const forBot = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, BOT_NAME_MAX) : "");
const NAME_THE_BOT = `${NOTHING_SAVED}say which Bot it belongs to as \`bot\`, with the Bot's name exactly as in its send_export document.`;
const full = () => refused(`${NOTHING_SAVED}this link has taken all the pages and files it can hold. Tell the person to import what has arrived in ${productName()}, then send the rest.`);
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

function sendPage(args: unknown, inbox: MoveInbox, now: number): ToolResult {
  const { bot: named, title: titled, page: sent, source } = input(args);
  const bot = forBot(named);
  const title = typeof titled === "string" ? oneLine(titled).slice(0, APP_LIMITS.title) : "";
  const page = typeof sent === "string" ? sent.trim() : "";
  if (!bot) return refused(NAME_THE_BOT);
  if (!title) return refused(`${NOTHING_SAVED}give the page's title as \`title\`.`);
  if (!page) return refused(`${NOTHING_SAVED}send the page as \`page\`: one React component file with a default export.`);
  if (source !== undefined && source !== null && typeof source !== "string") return refused(`${NOTHING_SAVED}\`source\` is the original file's text, or left out.`);
  if (Buffer.byteLength(page) > MOVE_PAGE_MAX_BYTES) return refused(`${NOTHING_SAVED}\`page\` is larger than ${megabytes(MOVE_PAGE_MAX_BYTES)}. Show less data in it, or split it into several pages with their own titles.`);
  if (source && Buffer.byteLength(source) > MOVE_PAGE_MAX_BYTES) return refused(`${NOTHING_SAVED}\`source\` is larger than ${megabytes(MOVE_PAGE_MAX_BYTES)}. Send the page again without \`source\`.`);
  if (holdsCredential(page) || holdsCredential(source ?? "")) return refused(`${NOTHING_SAVED}the page has a key or password in it. Take it out and send the page again.`);
  if (!/\bexport\s+default\b/.test(page)) return refused(`${NOTHING_SAVED}\`page\` needs \`export default\` of the page's component.`);
  const compiled = compileJsxPage(page);
  if (!compiled.ok) return refused(`${NOTHING_SAVED}${compiled.error.replace(/^jsx: /, "`page`: ")}`);
  if (!inbox.addAsset({ kind: "page", at: now, bot, title, page, ...(source ? { source } : {}) })) return full();
  const app = productName();
  return said(`Arrived in ${app}: the page "${title}" for ${bot}. The person imports it in ${app}, under Settings → Import & export, and it opens in ${bot}'s Library.`);
}

const FILE_REFUSALS: Partial<Record<SkillFileRefusal, string>> = {
  hidden: "is hidden or in a hidden folder",
  generated: "is in a package or cache folder",
  deep: "is more than six folders deep: send it with a shorter path",
  secret_name: "is named like a key or password file",
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function sendFile(args: unknown, inbox: MoveInbox, now: number): ToolResult {
  const { bot: named, path: at, text, base64 } = input(args);
  const bot = forBot(named);
  const path = typeof at === "string" ? at.trim().replace(/^(?:\.\/)+/, "") : "";
  if (!bot) return refused(NAME_THE_BOT);
  const problem = skillFilePathProblem(path);
  if (problem) {
    return refused(`${NOTHING_SAVED}${path ? `${path} ${FILE_REFUSALS[problem] ?? "is not a path a folder can hold"}` : "give the file's path as `path`"}. \`path\` is relative, with forward slashes, like reports/summary.md. Leave this file out if it cannot be sent another way.`);
  }
  const given = [text, base64].filter((value) => value !== undefined && value !== null);
  if (given.length !== 1 || typeof given[0] !== "string") return refused(`${NOTHING_SAVED}send exactly one of \`text\` (a text file's content) and \`base64\` (any other file's bytes).`);
  const tooLarge = () => refused(`${NOTHING_SAVED}${path} is larger than ${megabytes(MOVE_FILE_MAX_BYTES)}. Leave it out, and tell the person this file did not move.`);
  let data: Buffer;
  if (typeof text === "string") {
    data = Buffer.from(text);
  } else {
    const encoded = (base64 as string).replace(/\s+/g, "");
    if (encoded.length > Math.ceil(MOVE_FILE_MAX_BYTES / 3) * 4) return tooLarge();
    if (!BASE64.test(encoded) || encoded.length % 4 === 1) return refused(`${NOTHING_SAVED}\`base64\` is not base64. Encode the file's bytes as standard base64 and send it again.`);
    data = Buffer.from(encoded, "base64");
  }
  if (data.byteLength > MOVE_FILE_MAX_BYTES) return tooLarge();
  if (holdsCredential(skillFileText(data) ?? "")) return refused(`${NOTHING_SAVED}${path} has a key or password in it. Leave it out, or take the key out and send it again.`);
  if (!inbox.addAsset({ kind: "file", at: now, bot, path, data })) return full();
  return said(`Arrived in ${productName()}: ${path} for ${bot}.`);
}

function moveStatus(link: MoveLink): ToolResult {
  const names = new Set(link.inbox.arrivals.flatMap((arrival) => arrival.botNames).map((name) => name.toLowerCase()));
  const app = productName();
  const bots = link.host.bots();
  const roster = bots.slice(0, ROSTER_MAX).map((bot) => (bot.job ? `${bot.name} (${bot.job})` : bot.name)).join("; ");
  const pages = link.inbox.assets.filter((asset) => asset.kind === "page").length;
  return said(`Connected to ${app}. ${plural(names.size, "Bot")}, ${plural(pages, "page")} and ${plural(link.inbox.assets.length - pages, "file")} received so far and waiting for the person to import. This link stays on until the person turns it off, and its address never changes. To move a Bot, send it in this order: its setup with send_export, one Bot per call; then each of its pages with send_page; then each of its files with send_file. To have ${app} do something, call hand_off_task.`
    + (roster ? ` ${app}'s bots: ${roster}${bots.length > ROSTER_MAX ? `; and ${bots.length - ROSTER_MAX} more` : ""}.` : ""));
}

const words = (value: unknown): string => (typeof value === "string" ? value : "");
const over = (field: string, max: number, fix: string) => `Nothing was handed off: \`${field}\` is longer than ${max.toLocaleString("en-US")} characters. ${fix}`;

async function handOffTask(args: unknown, link: MoveLink, now: number): Promise<ToolResult> {
  const asked = input(args);
  const task = words(asked.task).trim();
  const context = words(asked.context).trim();
  const toBot = words(asked.to_bot).replace(/\s+/g, " ").trim().slice(0, TO_BOT_MAX);
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
  const asked = input(args);
  const taskId = words(asked.task_id).trim();
  const wait = typeof asked.wait_seconds === "number" && Number.isFinite(asked.wait_seconds) ? Math.min(Math.max(asked.wait_seconds, 0), HANDOFF_WAIT_MAX_SECONDS) : 0;
  // A task another link handed off, or one that was never there, reads the same.
  const status = link.tasks.has(taskId) ? await link.host.status(taskId, Math.round(wait * 1000)) : null;
  if (!status) return refused("No task with that task_id was handed off through this link. Use the task_id hand_off_task returned.");
  return said(statusText(status));
}

const initializeResult = (app = productName()) => ({
  protocolVersion: PROTOCOL_VERSIONS[0],
  capabilities: { tools: {} },
  serverInfo: { name: app, version: "1.2.0" },
  instructions: `Connects Grok Bot to ${app}. Call move_status first. To move a Bot, call send_export once per Bot, then send_page once per page it made, then send_file once per file it needs. To have ${app} do something, call hand_off_task, then task_status for the result. The work runs in ${app} on the person's computer: when a tool says ${app} isn't open, ask the person to open it, then call the tool again.`,
});

/** What the hosted address answers without this app: the handshake and tool list as moveMcp gives them, and the two
 * answers to a tool call this app never gave. */
export function moveManifest(app = productName()): LinkManifest {
  return {
    versions: PROTOCOL_VERSIONS,
    initialize: initializeResult(app),
    tools: { tools: tools(app) },
    offline: refused(`${app} isn't open on the person's computer, so nothing was done. Ask the person to open ${app}, then call this tool again. The link still works: nothing needs adding again.`),
    late: refused(`${app} didn't answer in time. If this was hand_off_task, the task may have started: check in ${app} before handing it off again. Otherwise call the tool again.`),
  };
}

/** The answer to a tool call that came while as many as the link runs at once were still running. */
export const moveBusy = (id: string | number | null): MoveMcpAnswer =>
  ({ status: 200, body: { jsonrpc: "2.0", id, result: refused(`${productName()} is still working on earlier calls from this link. Wait a few seconds, then call this tool again.`) } });

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
    return result({ ...initializeResult(), protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0] });
  }
  if (method === "ping") return result({});
  if (method === "tools/list") return result({ tools: tools() });
  if (method === "tools/call") {
    if (params?.name === "move_status") return result(moveStatus(link));
    if (params?.name === "send_export") return result(sendExport(params.arguments, link.inbox, now));
    if (params?.name === "send_page") return result(sendPage(params.arguments, link.inbox, now));
    if (params?.name === "send_file") return result(sendFile(params.arguments, link.inbox, now));
    if (params?.name === "hand_off_task") return result(await handOffTask(params.arguments, link, now));
    if (params?.name === "task_status") return result(await taskStatus(params.arguments, link));
    return moveRpcError(id, -32602, "Unknown tool. The tools are move_status, send_export, send_page, send_file, hand_off_task and task_status.");
  }
  return moveRpcError(id, -32601, "Method not found");
}
