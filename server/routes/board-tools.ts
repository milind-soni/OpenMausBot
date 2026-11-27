// The Team Board's bot tools (board_add, board_list, board_update), inside index.ts's /api/internal/ block, after the
// capability bearer is checked: the bot and its thread are the capability's, never a body field. On a Team Cloud with
// the board on only; anywhere else they answer 404 like an unknown path.
//   POST /api/internal/board/add      new room threads, each an item, needs given by keys of the same call
//   POST /api/internal/board/list     the items of the rooms the bot is in
//   POST /api/internal/board/update   the bot settles, asks about, sets aside, hands back or labels an item
// Security: a bot sees and adds items only in rooms it is a member of; which moves it may make is the state machine's
// (server/board/state.ts): only the bot holding an item may settle, ask about or set it aside.
import { z } from "zod";

import { BOARD_LIMITS, type BoardItem, type BoardItemState } from "../../shared/board.ts";
import type { Board } from "../board/host.ts";
import { boardLabels, boardTitle, BoardError, isOpen } from "../board/state.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const BOARD_TOOL_PATH = "/api/internal/board";

export interface BoardRoom {
  id: string;
  name: string;
  memberIds: readonly string[];
}

export interface BoardToolDeps {
  board: Pick<Board, "list" | "get" | "create" | "patch" | "move">;
  /** A Team Cloud with `features.teamBoard` on. */
  on(): boolean;
  requireActive(): void;
  botId(): string;
  threadId(): string;
  readBody(): Promise<unknown>;
  botName(botId: string): string | undefined;
  /** The rooms (not bot-to-bot chats) this bot is a member of. */
  rooms(botId: string): readonly BoardRoom[];
  /** The room whose thread this is, or null. */
  roomOf(threadId: string): BoardRoom | null;
  /** Opens a room thread without making it the room's current one, with `text` as the bot's first line there. */
  openThread(groupId: string, title: string, text: string, botId: string): string;
  /** Posts the question as the bot's line in the thread and reaches the person's inbox; `person` is the asked person's key. */
  ask(botId: string, threadId: string, question: string, to: { name?: string; key?: string }): { ok: boolean; text: string; person?: string };
  /** The result an item gets when its bot sets it aside once too often. */
  tooManyLaters(threadId: string): string;
  /** A minute; tests shorten it. */
  minuteMs?: number;
  now?: () => number;
}

const STATES: readonly BoardItemState[] = ["waiting", "ready", "working", "needs_person", "done", "failed", "cancelled"];
const ADD_EXAMPLE = 'Example: {"items":[{"key":"draft","title":"Draft the post","brief":"Write 200 words for Friday."},{"key":"review","title":"Review the post","needs":["draft"]}]}';
const UPDATE_EXAMPLE = 'Example: {"move":"done","text":"Posted at https://…"} or {"move":"later","minutes":5,"text":"See whether CI passed"}.';
const LIST_MAX = 60;

const asList = (value: unknown) => typeof value === "string" ? [value] : value;
const addSchema = z.object({
  room: z.string().max(200).optional(),
  items: z.array(z.object({
    key: z.coerce.string().trim().min(1).max(40),
    title: z.string(),
    brief: z.string().max(BOARD_LIMITS.textMax).optional(),
    needs: z.preprocess(asList, z.array(z.string().max(200)).max(BOARD_LIMITS.needsMax)).optional(),
    labels: z.record(z.string(), z.unknown()).optional(),
    for: z.string().max(200).optional(),
  }).strict()).min(1).max(BOARD_LIMITS.itemsPerCall),
}).strict();
const listSchema = z.object({ room: z.string().max(200).optional(), state: z.string().max(40).optional() }).strict();
const updateSchema = z.object({
  item: z.string().max(200).optional(),
  move: z.string().max(20).optional(),
  text: z.string().max(BOARD_LIMITS.resultMax).optional(),
  person: z.string().max(254).optional(),
  minutes: z.coerce.number().optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
}).strict();

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function createBoardToolRoutes(deps: BoardToolDeps): RouteHandler {
  const now = deps.now ?? Date.now;
  const minuteMs = deps.minuteMs ?? 60_000;

  /** A room of this bot by id or name; the room of its thread when none is named. */
  function roomFor(botId: string, threadId: string, raw: string | undefined): BoardRoom | string {
    const mine = deps.rooms(botId);
    if (!raw?.trim()) return deps.roomOf(threadId) ?? `This is not a room thread: name the room. Your rooms: ${mine.map((room) => room.name).join(", ") || "none"}.`;
    const wanted = raw.trim().replace(/^#/, "").toLowerCase();
    const hits = mine.filter((room) => room.id === raw.trim() || room.name.toLowerCase() === wanted);
    if (hits.length === 1) return hits[0]!;
    return hits.length ? `More than one of your rooms is called "${raw}": use its id (${hits.map((room) => room.id).join(", ")}).`
      : `You are not in a room called "${raw}". Your rooms: ${mine.map((room) => `${room.name} (${room.id})`).join(", ") || "none"}.`;
  }

  function line(item: BoardItem): string {
    const parts = [`${item.threadId} [${item.state}] ${oneLine(item.title, 120)}`];
    if (item.holder) parts.push(`by ${deps.botName(item.holder.botId) ?? item.holder.botId}`);
    if (item.forBotId) parts.push(`for ${deps.botName(item.forBotId) ?? item.forBotId}`);
    if (item.needs.length) parts.push(`needs ${item.needs.join(",")}`);
    const labels = Object.entries(item.labels).map(([key, value]) => `${key}=${value}`).join(",");
    if (labels) parts.push(`labels ${labels}`);
    if (item.question) parts.push(`asked: ${oneLine(item.question.text, 160)}`);
    if (item.result) parts.push(`result: ${oneLine(item.result, 200)}`);
    return `- ${parts.join(" · ")}`;
  }

  function add(botId: string, threadId: string, body: z.infer<typeof addSchema>): { status: number; text: string } {
    const room = roomFor(botId, threadId, body.room);
    if (typeof room === "string") return { status: 404, text: room };
    if (!room.memberIds.includes(botId)) return { status: 403, text: "You can add items only in a room you are in." };
    const existing = deps.board.list({ groupId: room.id });
    if (existing.filter((item) => isOpen(item.state)).length + body.items.length > BOARD_LIMITS.openPerRoom) {
      return { status: 409, text: `${room.name} would have more than ${BOARD_LIMITS.openPerRoom} open items. Finish or cancel some first.` };
    }
    // Everything is checked before the first thread opens: a bad entry leaves no thread behind.
    const keys = new Set<string>();
    const planned: Array<{ key: string; title: string; brief: string; needKeys: string[]; needIds: string[]; labels: Record<string, string>; forBotId?: string }> = [];
    try {
      for (const entry of body.items) {
        if (keys.has(entry.key)) return { status: 400, text: `The key "${entry.key}" is used twice. Give each item its own key. ${ADD_EXAMPLE}` };
        keys.add(entry.key);
        const title = boardTitle(entry.title);
        const labels = boardLabels(entry.labels);
        let forBotId: string | undefined;
        if (entry.for?.trim()) {
          const wanted = entry.for.trim().replace(/^@/, "").toLowerCase();
          const named = room.memberIds.filter((id) => id === entry.for || deps.botName(id)?.toLowerCase() === wanted);
          if (named.length !== 1) return { status: 400, text: named.length ? `More than one bot in ${room.name} is called "${entry.for}".` : `No bot called "${entry.for}" is in ${room.name}. Its bots: ${room.memberIds.map((id) => deps.botName(id) ?? id).join(", ")}.` };
          forBotId = named[0];
        }
        planned.push({ key: entry.key, title, brief: entry.brief?.trim() || title, needKeys: [], needIds: [], labels, ...(forBotId ? { forBotId } : {}) });
      }
      for (const [index, entry] of body.items.entries()) {
        for (const need of entry.needs ?? []) {
          if (keys.has(need)) planned[index]!.needKeys.push(need);
          else if (existing.some((item) => item.threadId === need)) planned[index]!.needIds.push(need);
          else return { status: 400, text: `"${need}" in the needs of "${entry.key}" is neither a key of this call nor an item of ${room.name}. ${ADD_EXAMPLE}` };
        }
      }
    } catch (error) {
      if (error instanceof BoardError) return { status: error.status, text: `${error.message} ${ADD_EXAMPLE}` };
      throw error;
    }
    // The keys' needs as a graph of their own: no loop, and each item is made after what it needs.
    const order: typeof planned = [];
    const placed = new Set<string>();
    while (order.length < planned.length) {
      const ready = planned.filter((entry) => !placed.has(entry.key) && entry.needKeys.every((key) => placed.has(key)));
      if (!ready.length) return { status: 409, text: "Those needs would make items wait for each other forever. Remove the loop." };
      for (const entry of ready) { order.push(entry); placed.add(entry.key); }
    }
    const made = new Map<string, BoardItem>();
    const creator = { kind: "bot" as const, id: botId, name: deps.botName(botId) ?? "Bot" };
    for (const entry of order) {
      const needs = [...entry.needIds, ...entry.needKeys.map((key) => made.get(key)!.threadId)];
      try {
        const item = deps.board.create({ groupId: room.id, title: entry.title, needs, labels: entry.labels, ...(entry.forBotId ? { forBotId: entry.forBotId } : {}), createdBy: creator },
          (title) => deps.openThread(room.id, title, entry.brief, botId));
        made.set(entry.key, item);
      } catch (error) {
        const done = [...made.entries()].map(([key, item]) => `${key} → ${item.threadId}`).join(", ");
        const why = error instanceof BoardError ? error.message : "The item could not be saved.";
        return { status: error instanceof BoardError ? error.status : 500, text: `${why}${done ? ` Already added: ${done}.` : ""}` };
      }
    }
    const lines = body.items.map((entry) => { const item = made.get(entry.key)!; return `- ${entry.key} → ${item.threadId} [${item.state}] ${item.title}`; });
    return { status: 201, text: `Added to ${room.name}; the server gives each ready item to a free bot of the room:\n${lines.join("\n")}` };
  }

  function list(botId: string, threadId: string, body: z.infer<typeof listSchema>): { status: number; text: string } {
    if (body.state !== undefined && !STATES.includes(body.state as BoardItemState)) return { status: 400, text: `state is one of ${STATES.join(", ")}.` };
    let rooms = deps.rooms(botId);
    if (body.room?.trim()) {
      const room = roomFor(botId, threadId, body.room);
      if (typeof room === "string") return { status: 404, text: room };
      rooms = [room];
    }
    const names = new Map(rooms.map((room) => [room.id, room.name]));
    const items = deps.board.list(body.state ? { state: body.state as BoardItemState } : {}).filter((item) => names.has(item.groupId));
    if (!items.length) return { status: 200, text: "No items." };
    const shown = items.slice(-LIST_MAX);
    const byRoom = new Map<string, string[]>();
    for (const item of shown) byRoom.set(item.groupId, [...(byRoom.get(item.groupId) ?? []), line(item)]);
    const text = [...byRoom].map(([groupId, lines]) => `${names.get(groupId)} (${groupId}):\n${lines.join("\n")}`).join("\n");
    return { status: 200, text: items.length > shown.length ? `The newest ${shown.length} of ${items.length}:\n${text}` : text };
  }

  function update(botId: string, threadId: string, body: z.infer<typeof updateSchema>): { status: number; text: string } {
    const itemId = body.item?.trim() || threadId;
    const item = deps.board.get(itemId);
    if (!item || !deps.rooms(botId).some((room) => room.id === item.groupId)) {
      return { status: 404, text: body.item ? "No item of your rooms has that id; board_list shows them." : "This thread is not a board item: pass item (its thread id from board_list)." };
    }
    const move = body.move?.trim().toLowerCase();
    const text = body.text?.trim() ?? "";
    if (move === undefined && body.labels === undefined) return { status: 400, text: `Say a move (done, failed, ask, later or release) or labels. ${UPDATE_EXAMPLE}` };
    const actor = { kind: "bot" as const, botId };
    if (move === "ask") {
      if (!text) return { status: 400, text: 'ask needs text: the question. Example: {"move":"ask","text":"Which client is this for?","person":"Mira"}' };
      if (item.state !== "working" || item.holder?.botId !== botId) return { status: 409, text: `This item is ${item.state.replace("_", " ")} and not yours to ask about now.` };
      const to = body.person?.trim() ? { name: body.person.trim() } : item.createdBy.kind === "person" ? { key: item.createdBy.id } : {};
      const reached = deps.ask(botId, item.threadId, text, to);
      deps.board.patch(item.threadId, { move: { move: "ask", question: text, ...(reached.person ? { person: reached.person } : {}) }, ...(body.labels !== undefined ? { labels: body.labels } : {}) }, actor);
      return { status: 200, text: `${reached.text} The item waits on a person; end your turn now. When they answer in this thread you are started again here.` };
    }
    if (move === "later") {
      const minutes = Math.round(body.minutes ?? NaN);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > BOARD_LIMITS.laterMinutesMax) return { status: 400, text: `later needs minutes from 1 to ${BOARD_LIMITS.laterMinutesMax}. ${UPDATE_EXAMPLE}` };
      if (!text) return { status: 400, text: `later needs text: what to look at then. ${UPDATE_EXAMPLE}` };
      if ((item.laterCount ?? 0) >= BOARD_LIMITS.latersMax && item.holder?.botId === botId && item.state === "working") {
        deps.board.move(item.threadId, { move: "failed", result: deps.tooManyLaters(item.threadId) }, actor);
        return { status: 409, text: `This item was set aside ${BOARD_LIMITS.latersMax} times, the most it may be, so it is now failed. Say so in one line and stop.` };
      }
      const at = now() + minutes * minuteMs;
      deps.board.patch(item.threadId, { move: { move: "later", at, note: text }, ...(body.labels !== undefined ? { labels: body.labels } : {}) }, actor);
      return { status: 200, text: `Set aside until ${new Date(at).toISOString()}. End your turn now; do not wait or poll. You are started again here then with your note.` };
    }
    const moves: Record<string, () => Parameters<Board["patch"]>[1]["move"]> = {
      done: () => ({ move: "done", ...(text ? { result: text } : {}) }),
      failed: () => ({ move: "failed", ...(text ? { result: text } : {}) }),
      release: () => ({ move: "release" }),
    };
    if (move !== undefined && !Object.hasOwn(moves, move)) return { status: 400, text: `move is one of done, failed, ask, later or release. ${UPDATE_EXAMPLE}` };
    const changed = deps.board.patch(item.threadId, { ...(move ? { move: moves[move]!() } : {}), ...(body.labels !== undefined ? { labels: body.labels } : {}) }, actor);
    const after: Record<string, string> = {
      done: "Marked done; items waiting on it are ready now. End your turn with a short summary.",
      failed: "Marked failed. End your turn with one line on why.",
      release: "Handed back; another free bot of the room may take it. End your turn.",
    };
    return { status: 200, text: move ? after[move]! : `Labels set: ${Object.entries(changed.labels).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}.` };
  }

  return async ({ res, path, method, json }) => {
    if (path !== BOARD_TOOL_PATH && !path.startsWith(`${BOARD_TOOL_PATH}/`)) return PASS;
    if (!deps.on()) return json(res, 404, { error: "The board is off here. Ask an Owner or Admin to turn on Board in Settings → Features." });
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    deps.requireActive();
    const botId = deps.botId(), threadId = deps.threadId();
    const raw = await deps.readBody();
    try {
      let answer: { status: number; text: string };
      if (path === `${BOARD_TOOL_PATH}/add`) {
        const parsed = addSchema.safeParse(raw);
        if (!parsed.success) return json(res, 400, { error: `board_add takes items: 1 to ${BOARD_LIMITS.itemsPerCall} of {key, title, brief?, needs?, labels?, for?}, and room?. ${ADD_EXAMPLE}` });
        answer = add(botId, threadId, parsed.data);
      } else if (path === `${BOARD_TOOL_PATH}/list`) {
        const parsed = listSchema.safeParse(raw ?? {});
        if (!parsed.success) return json(res, 400, { error: `board_list takes room? and state? (${STATES.join(", ")}).` });
        answer = list(botId, threadId, parsed.data);
      } else if (path === `${BOARD_TOOL_PATH}/update`) {
        const parsed = updateSchema.safeParse(raw);
        if (!parsed.success) return json(res, 400, { error: `board_update takes item?, move, text, person?, minutes?, labels?. ${UPDATE_EXAMPLE}` });
        answer = update(botId, threadId, parsed.data);
      } else return json(res, 404, { error: "not found" });
      return json(res, answer.status, answer.status < 300 ? { text: answer.text } : { error: answer.text });
    } catch (error) {
      if (error instanceof BoardError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
