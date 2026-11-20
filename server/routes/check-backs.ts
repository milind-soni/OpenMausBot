import { z } from "zod";

import type { RequestAuth } from "../request-auth.ts";
import { parseWhen, validZone, wallClockLabel, WHEN_HELP } from "../host/check-back-time.ts";
import { checkBackList, CONDITION_MAX, NOTE_MAX, type CheckBacks } from "../host/check-backs.ts";
import type { WorkOrigin } from "../peer-provenance.ts";
import { refusalText } from "../user-errors.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const CHECK_BACK_MESSAGES = {
  notYours: "This conversation is not yours.",
  room: "A check-back is set in a one-to-one chat, not in a room. Tell the person you can do it from your own chat with them.",
  notPerson: "A check-back needs the person's own request behind this turn; work handed on by a bot, a routine or an outside event can't set one. Finish in this turn.",
  guest: "Only the owner of this Cloud can have a bot check back later. Finish in this turn.",
} as const;

const bodySchema = z.object({
  when: z.string().max(200).optional(),
  note: z.string().max(NOTE_MAX * 2).optional(),
  if: z.string().max(CONDITION_MAX * 2).optional(),
  cancel: z.string().max(200).optional(),
}).strict();

export interface CheckBackTurnFacts {
  owned: boolean; room: boolean; depth: number; handedOff: boolean; routineRun: boolean; outsideDriven: boolean; personStarted: boolean; guest: boolean;
}

/** Who may set or cancel a check-back: a turn the person's own request started in their one-to-one chat, or a check-back's
 * own turn, which keeps that request's origin. */
export function checkBackRefusal(turn: CheckBackTurnFacts): string | null {
  if (!turn.owned) return CHECK_BACK_MESSAGES.notYours;
  if (turn.room) return CHECK_BACK_MESSAGES.room;
  if (turn.guest) return CHECK_BACK_MESSAGES.guest;
  if (turn.depth > 0 || turn.handedOff || turn.routineRun || turn.outsideDriven || !turn.personStarted) return CHECK_BACK_MESSAGES.notPerson;
  return null;
}

export interface CheckBackToolDeps {
  checkBacks: Pick<CheckBacks, "create" | "list" | "cancel">;
  requireActive(): void;
  botId(): string;
  threadId(): string;
  refusal(): string | null;
  /** The person's zone, for a day and a time without an offset. */
  zone(): string;
  /** The origin of the request this turn works for, from the harness's records. */
  origin(): WorkOrigin;
  readBody(): Promise<unknown>;
  now?: () => number;
}

/** The check_back tool: set one (when + note), cancel one (cancel: id or "all"), or list them (neither). */
export function createCheckBackToolRoutes(deps: CheckBackToolDeps): RouteHandler {
  const now = deps.now ?? Date.now;
  return async ({ res, path, method, json }) => {
    if (path !== "/api/internal/check-backs") return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    deps.requireActive();
    const parsed = bodySchema.safeParse(await deps.readBody());
    if (!parsed.success) return json(res, 400, { error: `check_back takes when and note (and optionally if), or cancel. ${WHEN_HELP}` });
    const body = parsed.data, botId = deps.botId(), threadId = deps.threadId();
    const pending = () => deps.checkBacks.list(botId, threadId);
    const listed = () => {
      const here = pending();
      return here.length ? `Check-backs waiting in this conversation:\n${checkBackList(here)}` : "No check-backs are waiting in this conversation.";
    };
    if (body.when === undefined && body.note === undefined && body.cancel === undefined) return json(res, 200, { text: listed() });
    const refused = deps.refusal();
    if (refused) return json(res, 403, { error: refused });
    if (body.cancel !== undefined) {
      const ids = body.cancel.trim() === "all" ? pending().map((record) => record.id) : [body.cancel.trim()];
      const mine = new Set(pending().map((record) => record.id));
      const stopped = ids.filter((one) => mine.has(one) && deps.checkBacks.cancel(one));
      if (!stopped.length) return json(res, 404, { error: `No check-back here has that id. ${listed()}` });
      return json(res, 200, { text: `Cancelled ${stopped.length === 1 ? "it" : `${stopped.length} check-backs`}. ${listed()}` });
    }
    const note = body.note?.replace(/\s+/g, " ").trim() ?? "";
    if (!note || !body.when?.trim()) return json(res, 400, { error: `check_back needs both when and note. ${WHEN_HELP}` });
    const zone = validZone(deps.zone()) ? deps.zone() : "UTC";
    const at = now();
    const when = parseWhen(body.when, at, zone);
    if (!when.ok) return json(res, 400, { error: when.error });
    const condition = body.if?.replace(/\s+/g, " ").trim();
    const created = deps.checkBacks.create({ botId, threadId, note, ...(condition ? { condition } : {}), dueAt: when.at, zone, origin: deps.origin() });
    if (!created.ok) return json(res, 409, { error: created.error });
    const label = wallClockLabel(when.at, zone);
    return json(res, 201, {
      text: `You will be woken here at ${label} (${zone}; ${new Date(when.at).toISOString()}), check-back id ${created.record.id}. A quiet line in this chat shows it, with Cancel. Tell the person in one short sentence and end your turn; do not wait or poll. ${zone === deps.zone() ? "" : "The person's zone could not be read, so UTC was used. "}`.trim(),
    });
  };
}

export interface CheckBackRoutesDeps {
  checkBacks: Pick<CheckBacks, "get" | "cancel">;
  sees(auth: RequestAuth, threadId: string): boolean;
  /** Why this person may not act on the line; the same rule as answering a card in that chat. */
  refusal(auth: RequestAuth, threadId: string, messageId: string): string | null;
}

/** The line's Cancel. Only a person's press reaches it: no bot tool calls this route. */
export function createCheckBackRoutes(deps: CheckBackRoutesDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const match = /^\/api\/check-backs\/([\w-]+)\/cancel$/.exec(path);
    if (!match) return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const record = deps.checkBacks.get(match[1]!);
    if (!record || !deps.sees(auth, record.threadId)) return json(res, 404, { error: "That check-back already ran or was cancelled." });
    const refused = deps.refusal(auth, record.threadId, record.lineMessageId ?? record.id);
    if (refused) return json(res, 403, refusalText(refused));
    if (!deps.checkBacks.cancel(record.id)) return json(res, 409, { error: "That check-back already started." });
    return json(res, 200, { ok: true });
  };
}
