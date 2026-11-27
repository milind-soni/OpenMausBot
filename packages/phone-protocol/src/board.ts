// The Team Board (docs/team-board.md): work items on a Team Cloud's room threads, one item per thread, keyed by that
// thread. A person sees an item exactly when they can see its room thread.

/** Where an item is. `waiting`: some item it needs is not done yet. `ready`: a bot may take it. `working`: a bot holds it
 * and runs a turn on it. `needs_person`: its bot asked a person and waits for the reply. The last three are settled. */
export type BoardItemState = "waiting" | "ready" | "working" | "needs_person" | "done" | "failed" | "cancelled";

export const BOARD_OPEN_STATES: readonly BoardItemState[] = ["waiting", "ready", "working", "needs_person"];
export const BOARD_SETTLED_STATES: readonly BoardItemState[] = ["done", "failed", "cancelled"];

export interface BoardItemHolder {
  botId: string;
  /** When the bot took it, or last went back to it after a person's reply; epoch ms. */
  since: number;
}

export interface BoardItemQuestion {
  text: string;
  askedAt: number;
  /** The person key of whoever was asked; absent when anyone who sees the room may answer. */
  person?: string;
  /** That person's name when they were asked, for showing whom the item waits on. */
  name?: string;
}

/** Its bot set the item aside to look again at `at` (board_update later): the item stays `working` and keeps its holder,
 * and the server starts that bot again then with `note`. */
export interface BoardItemLater {
  at: number;
  note: string;
}

export interface BoardItemCreator {
  kind: "person" | "bot";
  /** A person key or a bot id. */
  id: string;
  name: string;
}

export interface BoardItem {
  /** The room thread the work happens in; the item's id. */
  threadId: string;
  groupId: string;
  title: string;
  state: BoardItemState;
  /** Thread ids of items in the same room that must be `done` before this one is ready. */
  needs: string[];
  labels: Record<string, string>;
  /** Only this bot may take it; otherwise any member bot of the room. */
  forBotId?: string;
  /** Set while `working` or `needs_person`. */
  holder?: BoardItemHolder;
  /** Times a bot took it since it was made or last reopened. */
  attempts: number;
  question?: BoardItemQuestion;
  /** Set while its bot waits to look again. */
  later?: BoardItemLater;
  /** Times its bot set it aside to look again since it was made or last reopened. */
  laterCount?: number;
  /** What came of it, set when it is settled. */
  result?: string;
  createdBy: BoardItemCreator;
  createdAt: number;
  updatedAt: number;
}

export const BOARD_LIMITS = {
  titleMax: 120,
  /** The first line of a new item's thread. */
  textMax: 20_000,
  needsMax: 10,
  labelsMax: 12,
  labelKeyMax: 32,
  labelValueMax: 80,
  resultMax: 2_000,
  questionMax: 2_000,
  /** Items not yet settled in one room. */
  openPerRoom: 200,
  /** Items one bot call may add. */
  itemsPerCall: 15,
  /** board_update later: minutes ahead, and times per item. */
  laterMinutesMax: 1_440,
  latersMax: 20,
  /** Dispatches before a turn that ends without settling the item fails it. */
  triesMax: 3,
} as const;

/** A label key: lowercase letters, digits, `_` and `-`. */
export const BOARD_LABEL_KEY = /^[a-z0-9_-]{1,32}$/;

/** What a person may do to an item: `cancel` an open one, `reopen` a settled one, `release` one waiting on a person back
 * to ready, or mark it `done` themselves. */
export type BoardPersonMove = "cancel" | "reopen" | "release" | "done";

/** POST /api/board/items. Without `threadId` a new room thread is opened whose first line is `text`, the caller's;
 * with it, that existing thread of the room becomes the item. */
export interface BoardItemCreateBody {
  groupId: string;
  title: string;
  text?: string;
  needs?: string[];
  labels?: Record<string, string>;
  forBotId?: string;
  threadId?: string;
}

/** PATCH /api/board/items/:threadId. `labels` replaces the whole map; `forBotId: null` lets any member bot take it. */
export interface BoardItemPatchBody {
  move?: BoardPersonMove;
  title?: string;
  labels?: Record<string, string>;
  needs?: string[];
  forBotId?: string | null;
  result?: string;
}

/** GET /api/board (`?groupId=` for one room): the items the caller can see, oldest first. */
export interface BoardListResponse {
  items: BoardItem[];
  /** The caller's person key, as an item's `question.person` names whoever was asked. */
  you?: string;
}

export interface BoardItemResponse {
  item: BoardItem;
}

/** An item was made or changed (`item`), or removed (`item: null`; its thread stays). Sent only to people who can see
 * the room thread. */
export interface BoardItemFrame {
  kind: "board.item";
  groupId: string;
  threadId: string;
  item: BoardItem | null;
}
