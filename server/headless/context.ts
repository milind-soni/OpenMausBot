import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { flag, oneOf, parseDuration, usageError, type Flags } from "./args.ts";
import type { HeadlessClient } from "./client.ts";
import type { HeadlessIo, Output } from "./output.ts";

export interface VerbContext {
  verb: string;
  flags: Flags;
  positionals: string[];
  env: NodeJS.ProcessEnv;
  io: HeadlessIo;
  output: Output;
  client(): Promise<HeadlessClient>;
  signal: AbortSignal;
  defaultWaitMs: number;
}

export interface VerbOutcome {
  result: unknown;
  exitCode: number;
  human: string[];
  printed?: true;
}

export interface Target {
  type: "bot" | "channel";
  id: string;
  name?: string;
  taskId?: string;
}

type Fleet = { bots?: Array<Record<string, any>>; groups?: Array<Record<string, any>> };

const owns = (record: Record<string, any>, threadId: string) =>
  record.threadId === threadId || (Array.isArray(record.tasks) && record.tasks.some((task: { threadId?: string }) => task.threadId === threadId));

export async function resolveTarget(ctx: VerbContext, positional: string | undefined,
  allow: "bot" | "channel" | "any" = "any"): Promise<Target> {
  const bot = flag(ctx.flags, "bot")?.trim();
  const channel = flag(ctx.flags, "channel")?.trim();
  const thread = flag(ctx.flags, "thread")?.trim();
  const named = [bot, channel, thread, positional?.trim()].filter(Boolean);
  const what = allow === "bot" ? "a bot" : allow === "channel" ? "a room" : "a bot or room";
  if (named.length !== 1) {
    throw usageError(named.length ? `name exactly one ${what.slice(2)}` : `${what} is required`,
      `openmausbot ${ctx.verb} NAME, or --bot ID${allow === "bot" ? "" : ", --channel ID"} or --thread ID`);
  }
  const task = flag(ctx.flags, "task")?.trim();
  const withTask = (target: Target): Target => {
    if (allow !== "any" && target.type !== allow) throw usageError(`${ctx.verb} needs ${what}; that is ${target.type === "bot" ? "a bot" : "a room"}`);
    return task && !target.taskId ? { ...target, taskId: task } : target;
  };
  if (bot) return withTask({ type: "bot", id: bot });
  if (channel) return withTask({ type: "channel", id: channel });
  const fleet = await (await ctx.client()).json<Fleet>("/api/bots?messages=0");
  const bots = fleet.bots ?? [];
  const rooms = (fleet.groups ?? []).filter((group) => !group.dm);
  if (thread) {
    const owner = bots.find((candidate) => owns(candidate, thread));
    const room = owner ? undefined : rooms.find((candidate) => owns(candidate, thread));
    if (!owner && !room) throw usageError(`no conversation with id ${thread}`, "run openmausbot bots or openmausbot channels");
    return withTask(owner ? { type: "bot", id: owner.id, name: owner.name, taskId: thread } : { type: "channel", id: room!.id, name: room!.name, taskId: thread });
  }
  const wanted = positional!.trim();
  const byId = bots.find((candidate) => candidate.id === wanted) ?? rooms.find((candidate) => candidate.id === wanted);
  if (byId) return withTask({ type: bots.includes(byId) ? "bot" : "channel", id: byId.id, name: byId.name });
  const key = wanted.toLowerCase();
  const matches = [
    ...(allow !== "channel" ? bots.filter((candidate) => String(candidate.name).trim().toLowerCase() === key).map((record) => ({ record, type: "bot" as const })) : []),
    ...(allow !== "bot" ? rooms.filter((candidate) => String(candidate.name).trim().toLowerCase() === key).map((record) => ({ record, type: "channel" as const })) : []),
  ];
  if (matches.length === 0) {
    throw usageError(`no ${allow === "channel" ? "room" : allow === "bot" ? "bot" : "bot or room"} named "${wanted}"`, "run openmausbot bots or openmausbot channels for the names");
  }
  if (matches.length > 1) {
    throw usageError(`"${wanted}" names ${matches.length} ${allow === "any" ? "bots or rooms" : `${what.slice(2)}s`}: ${matches
      .map(({ record, type }) => `${record.name} (${type === "bot" ? "bot" : "room"}, id ${record.id})`).join("; ")}`, "use --bot ID or --channel ID");
  }
  const [{ record, type }] = matches as [typeof matches[number]];
  return withTask({ type, id: record.id, name: record.name });
}

export async function conversationFor(client: HeadlessClient, target: Target, task: string, title = "Headless run"): Promise<string> {
  if (task === "new") return (await client.tool("create_task", { target_type: target.type, target_id: target.id, title })).task.taskId;
  if (task !== "current") return task;
  const fleet = await client.json<Fleet>("/api/bots?messages=0");
  const owner = (target.type === "bot" ? fleet.bots : fleet.groups)?.find((record) => record.id === target.id);
  if (!owner) throw usageError(`no ${target.type === "bot" ? "bot" : "room"} with id ${target.id}`);
  return owner.threadId;
}

/** --title, else the message's first line. */
export const conversationTitle = (ctx: VerbContext, text: string): string =>
  (flag(ctx.flags, "title") ?? text.split("\n")[0]!).trim().slice(0, 80) || "Headless run";

export async function readMessage(ctx: VerbContext, positional: string | undefined): Promise<string> {
  const text = flag(ctx.flags, "text");
  const file = flag(ctx.flags, "message-file");
  const sources = [positional !== undefined, text !== undefined, file !== undefined].filter(Boolean).length;
  if (sources !== 1) {
    throw usageError(sources ? "give the message one way: TEXT, --text TEXT, --message-file FILE or -" : "a message is required",
      `openmausbot ${ctx.verb} TARGET "what to do", or --message-file FILE, or - to read it from stdin`);
  }
  let message: string;
  if (file !== undefined) {
    try {
      message = readFileSync(file, "utf8");
    } catch (error) {
      throw usageError(`--message-file ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
  } else if (positional === "-") {
    message = await ctx.io.readStdin();
  } else {
    message = (text ?? positional)!;
  }
  if (!message.trim()) throw usageError("the message is empty");
  return message.trim();
}

/** A send id this command makes up, so a retried send is never a second message. */
export const newSendId = () => `cli-${randomBytes(12).toString("base64url")}`;

export const waitPolicy = (ctx: VerbContext) => ({
  onInput: oneOf(flag(ctx.flags, "on-input"), "--on-input", ["exit", "wait", "stop"] as const, "exit"),
  onTimeout: oneOf(flag(ctx.flags, "on-timeout"), "--on-timeout", ["leave", "stop"] as const, "leave"),
  strict: ctx.flags.strict === true,
  timeoutMs: flag(ctx.flags, "timeout") ? parseDuration(flag(ctx.flags, "timeout")!, "--timeout") : ctx.defaultWaitMs,
});
