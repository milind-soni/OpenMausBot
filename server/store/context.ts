// The shared persistence context handed to every store slice function.
// The Store facade (server/store.ts) builds one instance whose members
// dispatch through the live Store object at call time, so runtime overrides
// and test spies on Store methods observe internal cross-calls exactly as
// they did when Store was a single class.
import type {
  BotActivity, BotProject as BotProjectRecord, GroupTask as GroupTaskRecord,
  TaskClosedBy, TaskOpenedBy,
} from "../../shared/wire.ts";
import type { ModelSelection } from "../contracts.ts";
import type { BotProfilePatch } from "../bot-profile.ts";
import type {
  BotRecord, GroupRecord, Message, StoreChange, TaskPatch, TaskRecord,
} from "./records.ts";

/** Messages form a tree (forks appear when a message is edited); the
 * visible conversation is the path from the root to activeLeafId. */
export interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

/** State plus the persistence primitives and cross-slice operations the
 * slice modules in this directory are allowed to use. Everything a slice
 * needs from the rest of the store goes through here. */
export interface StoreContext {
  bots: BotRecord[];
  groups: GroupRecord[];
  threads: Map<string, ThreadState>;
  legacyActivities: Map<string, BotActivity>;
  defaultSelection(): ModelSelection;

  saveBots(bots?: BotRecord[]): void;
  saveGroups(): void;
  rememberSections(names: (string | undefined)[]): void;
  emit(change: StoreChange): void;

  messagesFor(threadId: string): Message[];
  messagesTail(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; activeLeafId: string | null };
  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
  dismissOnboardingCard(threadId: string): Message | null;
  activePath(threadId: string): Message[];

  group(id: string): GroupRecord | undefined;
  activeGroupTask(groupId: string): GroupTaskRecord | undefined;
  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined;

  bot(id: string): BotRecord | null;
  createBot(
    profile?: Partial<
      Pick<
        BotRecord,
        "name" | "title" | "description" | "soul" | "color" | "mascotExpression" | "mascotBody" | "modelSelection" | "section"
      >
    >,
    opts?: { seedMessages?: boolean },
  ): BotRecord;
  patchBotProfile(id: string, patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>): BotRecord | null;

  activeTask(botId: string): TaskRecord | undefined;
  taskByThread(botId: string, threadId: string): TaskRecord | undefined;
  tasks(botId: string): TaskRecord[];
  project(botId: string, projectId: string): BotProjectRecord | undefined;
  projectBotForTask(botId: string, threadId: string): BotRecord | null;
  patchTask(botId: string, threadId: string, patch: TaskPatch): TaskRecord | null;
  createTask(botId: string, title?: string, activate?: boolean, projectId?: string, openedBy?: TaskOpenedBy): TaskRecord | null;
  renameTask(botId: string, threadId: string, title: string): TaskRecord | null;
  setTaskOpenedBy(botId: string, threadId: string, openedBy: TaskOpenedBy): TaskRecord | null;
  setTaskClosedBy(botId: string, threadId: string, closedBy: TaskClosedBy | null): TaskRecord | null;
}
