// The Team Board as the server runs it: the items, their routes, and a `board.item` frame for every change.
import type { ResolvedSender } from "../../shared/wire.ts";
import type { BoardItemFrame } from "../../shared/board.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBoardRoutes, type BoardPerson } from "../routes/board.ts";
import type { Store } from "../store.ts";
import { createBoard } from "./host.ts";

export interface TeamBoardDeps {
  dataDir: string;
  /** A Team Cloud. */
  team: boolean;
  /** `features.teamBoard`, read on every request. */
  enabled(): boolean;
  store: Pick<Store, "group" | "groupTaskByThread" | "createGroupTask" | "appendMessage" | "bot">;
  visible(auth: RequestAuth): VisibleSet;
  person(auth: RequestAuth): BoardPerson | null;
  sender(auth: RequestAuth): ResolvedSender | undefined;
  /** Notes who opened a thread, as a person's own new thread does. */
  opened(auth: RequestAuth, threadId: string): void;
  roomRefusal(groupId: string): string | null;
  broadcast(payload: Record<string, unknown>): void;
}

export function createTeamBoard(deps: TeamBoardDeps) {
  const { store } = deps;
  const board = createBoard({
    dataDir: deps.dataDir,
    alive: (groupId, threadId) => Boolean(store.groupTaskByThread(groupId, threadId)),
    roomBots: (groupId) => {
      const room = store.group(groupId);
      return room && !room.dm ? room.memberIds : null;
    },
  });
  board.onChange((change) => deps.broadcast({ kind: "board.item", ...change } satisfies BoardItemFrame));
  const routes = createBoardRoutes({
    board,
    on: () => deps.team && deps.enabled(),
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
  return { board, routes };
}

export type TeamBoard = ReturnType<typeof createTeamBoard>;
