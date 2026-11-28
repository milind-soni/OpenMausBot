// The Team Board's routes, for every member and admin of a Team Cloud (docs/team-board.md).
// Anywhere else none of them exists: they answer 404 like any unknown path.
//   GET    /api/board[?groupId=]          the items the caller can see, oldest first
//   POST   /api/board/items               a new item, on a new room thread or on one the room has
//   PATCH  /api/board/items/:threadId     a move (cancel, reopen, release, done) and changed fields
//   DELETE /api/board/items/:threadId     the item only; its thread stays
// Security: an item is shown, changed or removed only for someone who can see its room thread, and anything that writes
// needs what writing in the room needs (chat on every bot of it); an item they cannot see answers as a missing one.
import { atLeast } from "../../shared/bot-access.ts";
import { BOARD_LIMITS, type BoardListResponse, type BoardPersonMove } from "../../shared/board.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { Board } from "../board/host.ts";
import { BoardError, type BoardMove } from "../board/state.ts";
import { refusalFor } from "../host/bot-access-gate.ts";
import { messageTextRefusal } from "../message-text.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const BOARD_PATH = "/api/board";
const ITEM = /^\/api\/board\/items\/([\w-]+)$/;

export interface BoardPerson {
  /** The person key. */
  person: string;
  name: string;
}

export interface BoardRouteDeps {
  board: Board;
  /** A Team Cloud. */
  on(): boolean;
  /** The signed-in person; null for a session that is no one. */
  person(auth: RequestAuth): BoardPerson | null;
  visible(auth: RequestAuth): Pick<VisibleSet, "member" | "group" | "thread" | "level">;
  room(groupId: string): { dm: boolean; memberIds: readonly string[] } | null;
  botName(botId: string): string | undefined;
  /** Why the room takes no new thread now, or null. */
  roomRefusal(groupId: string): string | null;
  /** Opens a room thread without making it the room's current one and writes `text` as the person's first line in it,
   * starting no turn. Returns the new thread's id. */
  openThread(auth: RequestAuth, groupId: string, title: string, text: string): string;
}

const MOVES: Record<BoardPersonMove, (result: string | undefined) => BoardMove> = {
  cancel: (result) => ({ move: "cancel", result }),
  reopen: () => ({ move: "reopen" }),
  release: () => ({ move: "release" }),
  done: (result) => ({ move: "done", result }),
};

const record = (body: unknown): Record<string, unknown> | null => body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;

export function createBoardRoutes(deps: BoardRouteDeps): RouteHandler {
  /** Why this person may not write in the room: a bot of it they may only view. */
  const writeRefusal = (visible: ReturnType<BoardRouteDeps["visible"]>, memberIds: readonly string[]): string | null => {
    if (!visible.member) return null;
    for (const botId of memberIds) {
      const level = visible.level(botId);
      if (level !== "none" && !atLeast(level, "chat")) return refusalFor(deps.botName(botId) ?? "this bot", "chat").error;
    }
    return null;
  };

  return async (ctx: RouteContext) => {
    const { req, res, url, path, method, auth, json, readBody } = ctx;
    if (path !== BOARD_PATH && !path.startsWith(`${BOARD_PATH}/`)) return PASS;
    if (!deps.on()) return PASS;
    const person = deps.person(auth);
    if (!person) { req.resume(); return json(res, 403, { error: "Sign in to the team to use its board.", code: "forbidden" }); }
    const visible = deps.visible(auth);
    const seen = (groupId: string, threadId: string) => visible.group(groupId) && visible.thread(threadId);
    try {
      if (path === BOARD_PATH && method === "GET") {
        const groupId = url.searchParams.get("groupId") || undefined;
        return json(res, 200, { items: deps.board.list({ groupId }).filter((item) => seen(item.groupId, item.threadId)), you: person.person } satisfies BoardListResponse);
      }
      if (path === `${BOARD_PATH}/items` && method === "POST") {
        const body = record(await readBody(req));
        if (!body) return json(res, 400, { error: "Send a JSON object.", code: "board_bad_input" });
        const groupId = typeof body.groupId === "string" ? body.groupId : "";
        const room = groupId ? deps.room(groupId) : null;
        if (!room || room.dm || !visible.group(groupId)) return json(res, 404, { error: "No such room.", code: "board_not_found" });
        const threadId = body.threadId === undefined ? undefined : typeof body.threadId === "string" ? body.threadId : "";
        if (threadId !== undefined && !visible.thread(threadId)) return json(res, 404, { error: "No such thread in that room.", code: "board_not_found" });
        const refused = writeRefusal(visible, room.memberIds) ?? (threadId ? null : deps.roomRefusal(groupId));
        if (refused) return json(res, 403, { error: refused, code: "forbidden" });
        const text = body.text;
        const textProblem = messageTextRefusal(text);
        if (textProblem || (typeof text === "string" && text.length > BOARD_LIMITS.textMax)) {
          return json(res, 400, { error: textProblem ?? `The first line is at most ${BOARD_LIMITS.textMax} characters.`, code: "board_bad_input" });
        }
        const item = deps.board.create({
          groupId, title: body.title, needs: body.needs, labels: body.labels, forBotId: body.forBotId, threadId,
          createdBy: { kind: "person", id: person.person, name: person.name },
        }, (title) => deps.openThread(auth, groupId, title, typeof text === "string" && text.trim() ? text.trim() : title));
        return json(res, 201, { item });
      }
      const m = ITEM.exec(path);
      if (!m || (method !== "PATCH" && method !== "DELETE")) { req.resume(); return json(res, 404, { error: "not found" }); }
      const current = deps.board.get(m[1]!);
      if (!current || !seen(current.groupId, current.threadId)) { req.resume(); return json(res, 404, { error: "No board item on that thread.", code: "board_not_found" }); }
      const refused = writeRefusal(visible, deps.room(current.groupId)?.memberIds ?? []);
      if (refused) { req.resume(); return json(res, 403, { error: refused, code: "forbidden" }); }
      if (method === "DELETE") {
        req.resume();
        deps.board.remove(current.threadId);
        return json(res, 200, { ok: true });
      }
      const body = record(await readBody(req));
      if (!body) return json(res, 400, { error: "Send a JSON object.", code: "board_bad_input" });
      const move = body.move;
      if (move !== undefined && !(typeof move === "string" && Object.hasOwn(MOVES, move))) {
        return json(res, 400, { error: "move is one of cancel, reopen, release or done.", code: "board_bad_input" });
      }
      if (body.result !== undefined && typeof body.result !== "string") return json(res, 400, { error: "result must be text.", code: "board_bad_input" });
      const result = body.result as string | undefined;
      const moving = move ? MOVES[move as BoardPersonMove](result) : undefined;
      const item = deps.board.patch(current.threadId, {
        ...(moving ? { move: moving } : {}),
        title: body.title, labels: body.labels, needs: body.needs, forBotId: body.forBotId,
        ...(moving && "result" in moving ? {} : { result: body.result }),
      }, { kind: "person", person: person.person });
      return json(res, 200, { item });
    } catch (error) {
      if (error instanceof BoardError) return json(res, error.status, { error: error.message, code: error.code });
      throw error;
    }
  };
}
