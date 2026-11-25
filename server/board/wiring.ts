// The Team Board as the server runs it: the items, their routes, a `board.item` frame for every change, the dispatcher
// that hands ready items to free bots, the bots' three tools, and a person's answer taking an item back to work.
import type { ResolvedSender } from "../../shared/wire.ts";
import { BOARD_LIMITS, type BoardItem, type BoardItemFrame } from "../../shared/board.ts";
import { resolveMentions } from "../../shared/room-mentions.ts";
import { queuedChannelSends } from "../channel-queue.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBoardRoutes, type BoardPerson } from "../routes/board.ts";
import { createBoardToolRoutes } from "../routes/board-tools.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { Store } from "../store.ts";
import { createBoardDispatcher, type BoardBrief } from "./dispatcher.ts";
import { createBoard } from "./host.ts";

/** Brief text of the item's first line the bot is handed; the whole thread is in its context anyway. */
const BRIEF_TEXT_MAX = 2_000;

export interface TeamBoardDeps {
  dataDir: string;
  /** A Team Cloud. */
  team: boolean;
  /** `features.teamBoard`, read on every request. */
  enabled(): boolean;
  store: Pick<Store, "group" | "groups" | "groupByThread" | "groupTaskByThread" | "createGroupTask" | "patchGroupTask" | "appendMessage" | "messagesFor" | "bot" | "onChange">;
  visible(auth: RequestAuth): VisibleSet;
  person(auth: RequestAuth): BoardPerson | null;
  sender(auth: RequestAuth): ResolvedSender | undefined;
  /** Notes who opened a thread, as a person's own new thread does. */
  opened(auth: RequestAuth, threadId: string): void;
  roomRefusal(groupId: string): string | null;
  broadcast(payload: Record<string, unknown>): void;
  /** The bot may start a room turn in this thread now: not hidden, held, paused or busy anywhere. */
  botFree(botId: string, groupId: string, threadId: string): boolean;
  threadWorking(groupId: string, threadId: string): boolean;
  /** A spend or usage cap that refuses unattended work for this bot now, and when it lifts. */
  capped(botId: string): { resetsAt: number } | null;
  modelReady(botId: string): boolean;
  /** startGroupTurn with this text, a non-person trigger and the bot as the one mentioned. */
  startTurn(groupId: string, threadId: string, botId: string, text: string, sender: ResolvedSender): void;
  /** Reaches the person's inbox with a bot's question (team-messages.ts `ask`). */
  askPerson(botId: string, threadId: string, to: { name?: string; key?: string }, question: string, title: string): { status: number; text: string; person?: string };
  /** A card in this thread waits on a person (person-waits.ts), which owns the thread's waiting state while it does. */
  cardWaiting(threadId: string): boolean;
  /** Multiplies the dispatcher's waits and a later's minute; only tests set it (OMB_BOARD_TIME_SCALE, up to 1,000). */
  timeScale?: number;
}

export function createTeamBoard(deps: TeamBoardDeps) {
  const { store } = deps;
  const on = () => deps.team && deps.enabled();
  const scale = deps.timeScale && deps.timeScale > 0 && deps.timeScale <= 1_000 ? deps.timeScale : 1;
  const memberBots = (groupId: string) => {
    const room = store.group(groupId);
    return room && !room.dm ? room.memberIds : null;
  };
  const board = createBoard({
    dataDir: deps.dataDir,
    alive: (groupId, threadId) => Boolean(store.groupTaskByThread(groupId, threadId)),
    roomBots: memberBots,
  });
  board.onChange((change) => deps.broadcast({ kind: "board.item", ...change } satisfies BoardItemFrame));
  const line = (threadId: string, key: Parameters<typeof serverLine>[1], params?: Record<string, string | number>) => serverLine(conversationLanguage(threadId), key, params);
  const botName = (botId: string) => store.bot(botId)?.name ?? botId;

  /** The bot's first line for an item: its title, its thread's first line, what its needs came to, and how to finish. */
  function brief(given: BoardBrief): string {
    const { item, botId } = given;
    if (given.kind === "wake") return line(item.threadId, "server.board.wake", { bot: botName(botId), title: item.title, note: given.note });
    const first = store.messagesFor(item.threadId).find((message) => message.kind === "text" && message.text?.trim())?.text?.trim() ?? item.title;
    const text = first.length > BRIEF_TEXT_MAX ? `${first.slice(0, BRIEF_TEXT_MAX - 1)}…` : first;
    const needs = item.needs.map((id) => board.get(id)).filter((need): need is BoardItem => Boolean(need))
      .map((need) => `- ${need.title}: ${need.result ?? need.state}`);
    const body = line(item.threadId, "server.board.brief", { bot: botName(botId), title: item.title, text });
    return needs.length ? `${body}\n\n${line(item.threadId, "server.board.briefNeeds", { results: needs.join("\n") })}` : body;
  }

  const dispatcher = createBoardDispatcher({
    board, on, timeScale: scale,
    roomBots: memberBots,
    botFree: deps.botFree,
    // A person's line queued behind a running turn starts the next one there: the thread is still at work.
    threadWorking: (groupId, threadId) => deps.threadWorking(groupId, threadId) || queuedChannelSends(threadId) > 0,
    capped: deps.capped,
    modelReady: deps.modelReady,
    brief,
    start: (item, botId, text) => deps.startTurn(item.groupId, item.threadId, botId, text, { name: line(item.threadId, "server.board.sender") }),
    stoppedResult: (item) => line(item.threadId, "server.board.stopped", { count: BOARD_LIMITS.triesMax }),
  });

  /** A needs_person item shows on its room thread as waiting on a person, as an open card does. */
  function showWaiting(item: BoardItem | null, groupId: string, threadId: string): void {
    const task = store.groupTaskByThread(groupId, threadId);
    if (!task) return;
    const waiting = item?.state === "needs_person";
    if (waiting && task.activity !== "waiting-on-you") store.patchGroupTask(groupId, threadId, { activity: "waiting-on-you" });
    else if (!waiting && task.activity === "waiting-on-you" && !deps.cardWaiting(threadId)) store.patchGroupTask(groupId, threadId, { activity: null });
  }
  board.onChange((change) => showWaiting(change.item, change.groupId, change.threadId));

  store.onChange((change) => {
    if (!on()) return;
    // A bot freed somewhere may take a ready item.
    if (change.type === "bot") { dispatcher.poke(); return; }
    // A person's answer from their inbox lands in the room thread as the asking bot's relay line and starts no turn.
    if (change.type !== "message") return;
    const message = change.message;
    if (message.role !== "bot" || message.kind !== "text" || !message.relay || (message.relay.kind !== "reply" && message.relay.kind !== "assistant")) return;
    const item = board.get(change.threadId);
    if (item?.state === "needs_person" && item.holder?.botId === message.from?.botId) dispatcher.answered(change.threadId, message.text ?? "");
  });

  /** `text` addressed to the bot holding the thread's item, unless it already names that bot. */
  function addressedTo(groupId: string, threadId: string, text: string, states: readonly BoardItem["state"][]): { text: string; botId: string } | null {
    if (!on()) return null;
    const item = board.get(threadId);
    const bot = item?.holder ? store.bot(item.holder.botId) : null;
    if (!item || item.groupId !== groupId || !states.includes(item.state) || !bot || bot.hidden || !memberBots(groupId)?.includes(bot.id)) return null;
    const named = resolveMentions(text, [bot]).bots.length > 0;
    return { text: named ? text : `@${bot.name} ${text}`, botId: bot.id };
  }

  const routes = createBoardRoutes({
    board, on,
    person: deps.person,
    visible: deps.visible,
    room: (groupId) => {
      const room = store.group(groupId);
      return room ? { dm: room.dm === true, memberIds: room.memberIds } : null;
    },
    botName: (botId) => store.bot(botId)?.name,
    roomRefusal: deps.roomRefusal,
    openThread: (auth, groupId, title, text) => {
      const task = store.createGroupTask(groupId, title, false);
      if (!task) throw new Error(`could not open a thread in room ${groupId}`);
      deps.opened(auth, task.threadId);
      const sender = deps.sender(auth);
      store.appendMessage(task.threadId, { role: "user", kind: "text", text, ...(sender ? { sender } : {}) });
      return task.threadId;
    },
  });

  return {
    board, routes, dispatcher,
    /** The bots' tools, for one internal request: its capability's bot and thread. */
    toolRoutes: (turn: { requireActive(): void; botId(): string; threadId(): string; readBody(): Promise<unknown> }) => createBoardToolRoutes({
      ...turn, board, on, minuteMs: 60_000 * scale,
      botName: (botId) => store.bot(botId)?.name,
      rooms: (botId) => store.groups.filter((room) => !room.dm && room.memberIds.includes(botId)).map((room) => ({ id: room.id, name: room.name, memberIds: room.memberIds })),
      roomOf: (threadId) => {
        const room = store.groupByThread(threadId);
        return room && !room.dm && store.groupTaskByThread(room.id, threadId) ? { id: room.id, name: room.name, memberIds: room.memberIds } : null;
      },
      openThread: (groupId, title, text, botId) => {
        const task = store.createGroupTask(groupId, title, false);
        if (!task) throw new Error(`could not open a thread in room ${groupId}`);
        const bot = store.bot(botId);
        store.appendMessage(task.threadId, { role: "bot", kind: "text", text, ...(bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}) });
        return task.threadId;
      },
      ask: (botId, threadId, question, to) => {
        const bot = store.bot(botId);
        const item = board.get(threadId);
        if (bot) store.appendMessage(threadId, { role: "bot", kind: "text", text: question, from: { botId: bot.id, name: bot.name, color: bot.color } });
        if (!to.name && !to.key) return { ok: false, text: "Nobody made this item to ask, so the question waits in this thread for anyone who sees it." };
        const asked = deps.askPerson(botId, threadId, to, question, line(threadId, "server.board.askTitle", { bot: bot?.name ?? botId, title: item?.title ?? "" }));
        return { ok: asked.status === 200, text: asked.text, ...(asked.person ? { person: asked.person } : {}) };
      },
      tooManyLaters: (threadId) => line(threadId, "server.board.tooManyLaters", { count: BOARD_LIMITS.latersMax }),
    }),
    /** A person's chat line in a room thread whose item waits on a person: addressed to the bot that asked, with the move
     * that takes the item back to work once the line is sent. Null for every other line. */
    reply(groupId: string, threadId: string, text: string): { text: string; botId: string; resume(): void } | null {
      const addressed = addressedTo(groupId, threadId, text, ["needs_person"]);
      return addressed ? { ...addressed, resume: () => { dispatcher.personReplied(threadId); } } : null;
    },
    /** What a resent line may have been saved as: addressed to the item's bot. */
    addressed(groupId: string, threadId: string, text: string): string | null {
      return addressedTo(groupId, threadId, text, ["needs_person", "working"])?.text ?? null;
    },
    start(): void {
      dispatcher.start();
      // A restart cleared every room thread's waiting state (person-waits.ts boot): items that still wait show it again.
      for (const item of board.list({ state: "needs_person" })) showWaiting(item, item.groupId, item.threadId);
    },
    stop(): void { dispatcher.stop(); },
    get isTicking(): boolean { return dispatcher.isTicking; },
    nextDueAt: () => dispatcher.nextDueAt(),
    poke: () => dispatcher.poke(),
  };
}

export type TeamBoard = ReturnType<typeof createTeamBoard>;
