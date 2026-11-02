import type { ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { WAIT_HOURS, WAIT_KINDS, type WaitKind } from "../../shared/waits.ts";
import type { Surface } from "../../shared/wire.ts";
import type { json as sendJson } from "../harness/http.ts";
import { expandHome } from "../wait-probes.ts";
import { WAIT_WAKE_MS, waitList, type NewWaitCondition, type WaitManager } from "../waits.ts";
import { PASS } from "./table.ts";

const WAITS = "/api/internal/waits";
const CANCEL = "/api/internal/waits/cancel";

export const WAIT_MESSAGES = {
  notYours: "This conversation is not yours.",
  room: "Waits are made in a one-to-one chat with the person, not in a room.",
  notPerson: "Only the person can set up or stop a wait, in their own chat with you; work handed to you by a bot, a routine or an outside event cannot.",
  serverHost: "File and program waits look at the computer MausBot runs on, and here that is a server, not the computer you work on. Use url_contains, url_missing or bot_idle.",
  guest: "File and program waits are only for the owner of this computer. Use url_contains, url_missing or bot_idle.",
  guestFollowUp: "Guests can be told when something happens, but can't set a follow-up. Make the wait without follow_up.",
  otherComputer: "You work on another computer this turn (a private desktop or a cloud desktop), and file and program waits look at the one MausBot runs on. Use url_contains, url_missing or bot_idle.",
  noPeer: "No bot you can reach goes by that name. Use a name or id from list_bots.",
  self: "You cannot wait for yourself to finish. Tell the person yourself when you are done.",
  noWait: "None of your waits in this chat has that id. Use list_waits.",
  none: "You are not waiting for anything in this chat.",
  noneToCancel: "You are not waiting for anything in this chat, so there is nothing to cancel.",
} as const;

export interface WaitRequest {
  label: string; kind: WaitKind; url?: string; text?: string; path?: string; process?: string; bot?: string; followUp?: string; hours: number;
}

const FIELD_KINDS = {
  url: ["url_contains", "url_missing"],
  text: ["url_contains", "url_missing"],
  path: ["file_exists", "file_missing", "file_changed"],
  process: ["process_running", "process_gone"],
  bot: ["bot_idle"],
} as const satisfies Record<string, readonly WaitKind[]>;
type WaitField = keyof typeof FIELD_KINDS;
const FIELDS = Object.keys(FIELD_KINDS) as WaitField[];

/**
 * `\\host\share` or `//host/share`, with either slash, mixed or percent-encoded (`%5C`, `%2F`, `%255C`): a network path.
 * Windows would sign in to that host to check it, sending it the person's password hash.
 */
export function isNetworkPath(path: string): boolean {
  let plain = path.trim();
  for (let round = 0; round < 4 && /%(?:25|5c|2f)/i.test(plain); round++) {
    plain = plain.replace(/%(25|5c|2f)/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return /^[\\/]{2}/.test(plain);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const absent = (value: unknown) => value === undefined || value === null;
const joinWords = (words: readonly string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);
const iso = (ms: number) => new Date(ms).toISOString();

export function parseWaitRequest(body: unknown, home: string): { ok: true; request: WaitRequest } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false, error }) as const;
  if (!isRecord(body)) return fail("Send a JSON object.");
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 120) return fail("label: the person's words for what you wait for, up to 120 characters.");
  if (/\p{Cc}/u.test(label)) return fail("label must be a single line of plain text.");
  const kind = WAIT_KINDS.find((candidate) => candidate === body.kind);
  if (!kind) return fail(`kind is one of: ${WAIT_KINDS.join(", ")}.`);

  const needed = FIELDS.filter((field) => (FIELD_KINDS[field] as readonly WaitKind[]).includes(kind));
  if (needed.some((field) => absent(body[field]))) return fail(`${kind} needs ${needed.join(" and ")}.`);
  const stray = FIELDS.find((field) => !needed.includes(field) && !absent(body[field]));
  if (stray) return fail(`${stray} applies only to ${joinWords(FIELD_KINDS[stray])}.`);

  const request: WaitRequest = { label, kind, hours: WAIT_HOURS.default };
  const size = (field: WaitField | "follow_up", max: number, trim = false) => {
    const raw = body[field];
    const value = typeof raw === "string" ? (trim ? raw.trim() : raw) : "";
    return value.length >= 1 && value.length <= max && value.trim() ? value : null;
  };
  const lengthError = (field: string, max: number) => fail(`${field} must be 1 to ${max} characters.`);

  if (needed.includes("url")) {
    const raw = body.url;
    let parsed: URL | null = null;
    try { parsed = typeof raw === "string" && raw.length <= 2048 ? new URL(raw) : null; } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return fail("url must be an http or https address.");
    if (parsed.username || parsed.password) return fail("Put no sign-in details in the address.");
    request.url = parsed.href;
    const text = size("text", 500);
    if (text === null) return lengthError("text", 500);
    request.text = text;
  }
  if (needed.includes("path")) {
    const raw = body.path;
    if (typeof raw === "string" && isNetworkPath(raw)) return fail("path must be on this computer: a network path (\\\\server\\share or //server/share) is never checked.");
    const path = typeof raw === "string" && raw.length >= 1 && raw.length <= 1024 ? expandHome(raw, home) : "";
    if (!path || !isAbsolute(path)) return fail("path must be a full path or start with ~.");
    request.path = path;
  }
  if (needed.includes("process")) {
    const process = size("process", 256);
    if (process === null) return lengthError("process", 256);
    request.process = process;
  }
  if (needed.includes("bot")) {
    const bot = size("bot", 128, true);
    if (bot === null) return lengthError("bot", 128);
    request.bot = bot;
  }
  if (!absent(body.follow_up)) {
    const followUp = size("follow_up", 2000, true);
    if (followUp === null) return lengthError("follow_up", 2000);
    request.followUp = followUp;
  }
  if (!absent(body.hours)) {
    const hours = body.hours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > WAIT_HOURS.max) return fail(`hours is a whole number from 1 to ${WAIT_HOURS.max}.`);
    request.hours = hours;
  }
  return { ok: true, request };
}

export function waitSourceRefusal(turn: {
  owned: boolean; room: boolean; depth: number; handedOff: boolean; routineRun: boolean; outsideDriven: boolean; personStarted: boolean; guest: boolean;
}): string | null {
  if (!turn.owned) return WAIT_MESSAGES.notYours;
  if (turn.room) return WAIT_MESSAGES.room;
  if (turn.depth > 0 || turn.handedOff || turn.routineRun || turn.outsideDriven || !(turn.personStarted || turn.guest)) return WAIT_MESSAGES.notPerson;
  return null;
}

export function hostWaitRefusal(turn: { cloudHome: boolean; hosted: boolean; guest: boolean; place: Surface | null }): string | null {
  if (turn.cloudHome || turn.hosted) return WAIT_MESSAGES.serverHost;
  if (turn.guest) return WAIT_MESSAGES.guest;
  if (turn.place === "vm" || turn.place === "cloud") return WAIT_MESSAGES.otherComputer;
  return null;
}

export function findWaitPeer(
  peers: readonly { id: string; name: string; hidden?: boolean }[],
  selfId: string,
  nameOrId: string,
): { id: string; name: string } | "self" | null {
  const wanted = nameOrId.toLowerCase();
  const match = peers.find((peer) => !peer.hidden && (peer.id === nameOrId || peer.name.toLowerCase() === wanted));
  if (!match) return null;
  return match.id === selfId ? "self" : { id: match.id, name: match.name };
}

export interface WaitRouteContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
  sourceRefusal: () => string | null;
  hostRefusal: () => string | null;
  /** A Cloud guest's turn: its follow-up would run later as the owner's, so a guest's wait only tells. */
  guest: () => boolean;
  peer: (nameOrId: string) => { id: string; name: string } | "self" | null;
  /** Why no bot here has that name: where it lives among the person's other places, or that bots work as one place. */
  elsewhere?: (name: string) => { where: string } | { hint: string } | null;
}

/** `sleeps`: the home is a personal My Cloud, whose plan sleeps when idle; a Team Cloud never sleeps. */
export function createWaitRoutes(deps: { waits: Pick<WaitManager, "create" | "list" | "cancel">; home?: () => string; cloudHome?: boolean; sleeps?: boolean }) {
  const home = deps.home ?? homedir;
  return async (ctx: WaitRouteContext): Promise<typeof PASS | void> => {
    const { res, json } = ctx;
    const here = () => deps.waits.list(ctx.botId).filter((wait) => wait.threadId === ctx.threadId);
    if (ctx.method === "GET" && ctx.path === WAITS) {
      if (ctx.sourceRefusal() === WAIT_MESSAGES.notYours) return void json(res, 403, { error: WAIT_MESSAGES.notYours });
      const mine = here();
      return void json(res, 200, { text: mine.length ? waitList(mine) : WAIT_MESSAGES.none });
    }
    if (ctx.method !== "POST" || (ctx.path !== WAITS && ctx.path !== CANCEL)) return PASS;

    const refusal = ctx.sourceRefusal();
    if (refusal) return void json(res, 403, { error: refusal });
    const body = await ctx.readBody();

    if (ctx.path === CANCEL) {
      if (!here().length) return void json(res, 404, { error: WAIT_MESSAGES.noneToCancel });
      const id = isRecord(body) ? body.id : undefined;
      if (typeof id !== "string" || !id) return void json(res, 400, { error: "id: the wait id from list_waits." });
      const stopped = here().some((wait) => wait.id === id) ? deps.waits.cancel(id, ctx.botId) : null;
      if (!stopped) return void json(res, 404, { error: WAIT_MESSAGES.noWait });
      return void json(res, 200, { text: `Stopped waiting for ${stopped.label}.` });
    }

    const parsed = parseWaitRequest(body, home());
    if (!parsed.ok) return void json(res, 400, { error: parsed.error });
    const { request } = parsed;
    if (request.followUp && ctx.guest()) return void json(res, 403, { error: WAIT_MESSAGES.guestFollowUp });
    if (request.kind.startsWith("file_") || request.kind.startsWith("process_")) {
      const away = ctx.hostRefusal();
      if (away) return void json(res, 403, { error: away });
    }

    let condition: NewWaitCondition;
    if (request.kind === "bot_idle") {
      const peer = ctx.peer(request.bot!);
      if (peer === "self") return void json(res, 400, { error: WAIT_MESSAGES.self });
      if (!peer) {
        const away = ctx.elsewhere?.(request.bot!) ?? null;
        return void json(res, 400, { error: !away ? WAIT_MESSAGES.noPeer : "where" in away ? away.where : `${WAIT_MESSAGES.noPeer} ${away.hint}` });
      }
      condition = { kind: "bot_idle", botId: peer.id, botName: peer.name };
    } else if (request.kind === "url_contains" || request.kind === "url_missing") {
      condition = { kind: request.kind, url: request.url!, text: request.text! };
    } else if (request.kind === "process_running" || request.kind === "process_gone") {
      condition = { kind: request.kind, process: request.process! };
    } else {
      condition = { kind: request.kind, path: request.path! };
    }

    const result = await deps.waits.create({
      botId: ctx.botId,
      threadId: ctx.threadId,
      label: request.label,
      condition,
      ...(request.followUp ? { followUp: request.followUp } : {}),
      hours: request.hours,
    });
    if (result.state === "refused") return void json(res, result.status, { error: result.error });
    if (result.state === "already") return void json(res, 200, { text: result.text });
    const { wait, note } = result;
    const then = request.followUp ? `, and you will then do what you wrote in follow_up${deps.cloudHome ? " in a run that reports in its own results chat, not this one" : ""}` : "";
    const every = WAIT_WAKE_MS / 60_000;
    const sleeps = deps.sleeps ? ` While My Cloud sleeps it wakes to check every ${every} minutes, so the message can come up to ${every} minutes late: tell the person that too.` : "";
    const text = `Waiting for ${wait.label} (wait id ${wait.id}): plain checks, no AI, until ${iso(wait.expiresAt)}. When it happens a message lands in this chat${then}.${sleeps} Tell the person in one sentence; do not keep checking yourself.`;
    return void json(res, 201, { text: note ? `${text}\n\n${note}` : text });
  };
}
