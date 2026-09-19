// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
//
// The implementation lives in the ./store/ slices (records, context,
// migrations, messages, groups, bots, tasks); this module is the facade
// every importer already targets. Store keeps its exact public surface.
// Its constructor loads bots.json/groups.json, runs the numbered startup
// migration pipeline, and builds the shared StoreContext that slice
// functions receive — every cross-call through that context dispatches
// through the live Store instance, so overrides installed on Store
// methods observe internal calls exactly as before.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { ensureSections, readSections, changeEmptySection } from "./section-context.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import type { BotProfilePatch } from "./bot-profile.ts";
import type { TeamSetupRequest, TeamSetupResult } from "../shared/team-setup.ts";
import type { GroupGoalRunCardData } from "../shared/group-goal-run.ts";
import type { HandedState } from "./delta-context.ts";
import type {
  BotActivity, GroupDefaultResponder, GroupTask as GroupTaskRecord, TaskClosedBy,
  TaskOpenedBy, TaskUsage, BotProject as BotProjectRecord,
} from "../shared/wire.ts";
// Re-exported under their historical names so server-side importers keep working.
export type {
  BotActivity, ConnectorCardData, GroupDefaultResponder, OptionCardData,
  SecretRequestCardData, Surface, TaskClosedBy, TaskOpenedBy, TaskUsage,
} from "../shared/wire.ts";
export type { GroupTask as GroupTaskRecord, BotProject as BotProjectRecord } from "../shared/wire.ts";
export type { InstalledPlaybook, InstalledPackageMetadata, MausColor, MausExpression } from "../shared/wire.ts";
export * from "./store/records.ts";
import type {
  BotRecord, GroupRecord, Message, StoreChange, TaskPatch, TaskRecord,
} from "./store/records.ts";
import { sectionKey } from "./store/records.ts";
import type { StoreContext, ThreadState } from "./store/context.ts";
import { migrateBots, migrateGroups, type MigrationDeps } from "./store/migrations.ts";
import * as groupOps from "./store/groups.ts";
import * as messageOps from "./store/messages.ts";
import * as botOps from "./store/bots.ts";
import * as taskOps from "./store/tasks.ts";

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  private threads = new Map<string, ThreadState>();
  private defaultSelection: () => ModelSelection;
  private listeners = new Set<(change: StoreChange) => void>();
  /** A broken team registry must not prevent loading independent chat data. */
  private registeringInitialSections = true;
  /** Room turns and old callers have their own activity slot. Clearing
   * that slot must not clear a concurrently running independent task. */
  private legacyActivities = new Map<string, BotActivity>();
  private internals: StoreContext;

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
    // Live array accessors for the shared context. Object-literal getters
    // cannot capture the class instance, so they delegate to these
    // closures; slices that replace a roster array write through to this
    // Store's fields, exactly as the pre-split class did.
    const live = {
      bots: () => this.bots,
      setBots: (bots: BotRecord[]) => { this.bots = bots; },
      groups: () => this.groups,
      setGroups: (groups: GroupRecord[]) => { this.groups = groups; },
    };
    this.internals = {
      get bots() { return live.bots(); },
      set bots(next) { live.setBots(next); },
      get groups() { return live.groups(); },
      set groups(next) { live.setGroups(next); },
      threads: this.threads,
      legacyActivities: this.legacyActivities,
      defaultSelection: () => this.defaultSelection(),
      saveBots: (bots) => this.saveBots(bots),
      saveGroups: () => this.saveGroups(),
      rememberSections: (names) => this.rememberSections(names),
      emit: (change) => this.emit(change),
      messagesFor: (threadId) => this.messagesFor(threadId),
      messagesTail: (threadId, limit) => this.messagesTail(threadId, limit),
      appendMessage: (threadId, message) => this.appendMessage(threadId, message),
      patchMessage: (threadId, messageId, patch) => this.patchMessage(threadId, messageId, patch),
      dismissOnboardingCard: (threadId) => this.dismissOnboardingCard(threadId),
      activePath: (threadId) => this.activePath(threadId),
      group: (id) => this.group(id),
      activeGroupTask: (groupId) => this.activeGroupTask(groupId),
      groupTaskByThread: (groupId, threadId) => this.groupTaskByThread(groupId, threadId),
      bot: (id) => this.bot(id),
      createBot: (profile, opts) => this.createBot(profile, opts),
      patchBotProfile: (id, patch) => this.patchBotProfile(id, patch),
      activeTask: (botId) => this.activeTask(botId),
      taskByThread: (botId, threadId) => this.taskByThread(botId, threadId),
      tasks: (botId) => this.tasks(botId),
      project: (botId, projectId) => this.project(botId, projectId),
      projectBotForTask: (botId, threadId) => this.projectBotForTask(botId, threadId),
      patchTask: (botId, threadId, patch) => this.patchTask(botId, threadId, patch),
      createTask: (botId, title, activate, projectId, openedBy) => this.createTask(botId, title, activate, projectId, openedBy),
      renameTask: (botId, threadId, title) => this.renameTask(botId, threadId, title),
      setTaskOpenedBy: (botId, threadId, openedBy) => this.setTaskOpenedBy(botId, threadId, openedBy),
      setTaskClosedBy: (botId, threadId, closedBy) => this.setTaskClosedBy(botId, threadId, closedBy),
    };
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch {
      this.bots = [];
    }
    try {
      this.groups = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
    } catch {
      this.groups = [];
    }
    this.rememberSections([...this.bots, ...this.groups].map((record) => record.section));
    // Startup migrations, one independently deletable step per legacy
    // cohort (busy never survives a restart — no turn does either; rooms
    // saved before default responders existed adopt their first member as
    // lead; bots saved before tasks existed adopt their one thread as
    // their first task). Transcript-derived titles come in through deps;
    // only records are touched here. Save in the historical order:
    // groups.json before bots.json, each only when a write is needed.
    const deps: MigrationDeps = {
      firstUserLine: (threadId) => messageOps.firstUserLine(this.internals, threadId),
    };
    const botsMigration = migrateBots(this.bots, deps);
    const groupsMigration = migrateGroups(this.groups, deps);
    if (groupsMigration.changed) this.saveGroups();
    if (botsMigration.changed) this.saveBots();
    // Search reads SQLite directly, so migrate every known legacy transcript
    // at startup rather than waiting until the user happens to open it. Only
    // pending JSON files are touched; already-migrated threads stay lazy.
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
      ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
    ]);
    messageOps.migrateLegacyTranscripts(knownThreads);
    this.registeringInitialSections = false;
  }

  private saveBots(bots: BotRecord[] = this.bots) {
    this.rememberSections([...this.bots, ...bots].map((bot) => bot.section));
    writeFileAtomic(BOTS_FILE, JSON.stringify(bots.map(({ busy: _busy, activity: _activity, ...bot }) => ({
      ...bot,
      tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, turnStartedAt: _taskTurnStarted, ...task }) => task),
    })), null, 2));
  }

  private saveGroups() {
    this.rememberSections(this.groups.map((group) => group.section));
    writeFileAtomic(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => g), null, 2));
  }

  get sections(): string[] { return readSections(); }

  private rememberSections(names: (string | undefined)[]) {
    try {
      if (ensureSections(names)) this.emit({ type: "sections" });
    } catch (error) {
      if (!this.registeringInitialSections) throw error;
      console.warn(`[teams] Startup could not register team names; saved teams and shared instructions were left unchanged: ${(error as Error).message}`);
    }
  }

  /** Empty-only changes cannot merge teams or silently change anybody's access. */
  changeEmptySection(name: string, nextName: string | null): string | undefined {
    if (!this.sections.includes(name)) return "No such team";
    if ([...this.bots, ...this.groups].some((record) => sectionKey(record.section) === name)) {
      return "Move all bots (including archived bots) and group chats out of this team first";
    }
    if (nextName !== null && nextName !== name && this.sections.includes(nextName)) {
      return "A team with that name already exists";
    }
    if (nextName === name) return undefined;
    const revoked = this.bots.filter((bot) => bot.managedSections?.some((section) => sectionKey(section) === name));
    if (revoked.length) {
      const grants = new Map(revoked.map((bot) => [bot.id, bot.managedSections!.filter((section) => sectionKey(section) !== name)]));
      // Revoke durably before freeing the name. If the registry write then
      // fails, authority stays narrowed; recreating a name can never revive
      // its old grants. Update existing objects so in-flight checks see it.
      this.saveBots(this.bots.map((bot) => grants.has(bot.id) ? { ...bot, managedSections: grants.get(bot.id)! } : bot));
      for (const bot of revoked) bot.managedSections = grants.get(bot.id)!;
      for (const bot of revoked) this.emit({ type: "bot", botId: bot.id });
    }
    changeEmptySection(name, nextName);
    this.emit({ type: "sections" });
    return undefined;
  }

  /** Subscribe to every write. Listeners run after the write and after
   * save; a throwing listener never breaks the write. */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange) {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(change);
      } catch (error) {
        console.error("store: change listener threw", error);
      }
    }
  }

  // ── groups ────────────────────────────────────────────────────────────
  group(id: string): GroupRecord | undefined {
    return groupOps.group(this.internals, id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return groupOps.groupByThread(this.internals, threadId);
  }

  createGroup(
    name: string,
    memberIds: string[],
    dm = false,
    section?: string,
    setup?: {
      bulletin?: string;
      defaultResponder?: GroupDefaultResponder;
      completed?: boolean;
    },
  ): GroupRecord {
    return groupOps.createGroup(this.internals, name, memberIds, dm, section, setup);
  }

  /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
  dmGroup(a: string, b: string): GroupRecord | undefined {
    return groupOps.dmGroup(this.internals, a, b);
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt">>): GroupRecord | null {
    return groupOps.patchGroup(this.internals, id, patch);
  }

  deleteGroup(id: string): boolean {
    return groupOps.deleteGroup(this.internals, id);
  }

  /** A process restart cannot preserve an in-flight room orchestrator. Close
   * every durable working receipt before clients load it, including manual
   * goals that do not have a RoutineRun record to reconcile separately. */
  reconcileInterruptedGroupGoals(
    resolve?: (
      runId: string,
      threadId: string,
    ) => {
      status: Exclude<GroupGoalRunCardData["status"], "working">;
      detail: string;
      finishedAt: number;
    } | null,
    fallbackDetail = "OpenMausBot restarted before this goal finished.",
    fallbackFinishedAt = Date.now(),
  ): number {
    return groupOps.reconcileInterruptedGroupGoals(this.internals, resolve, fallbackDetail, fallbackFinishedAt);
  }

  // ── channel tasks ────────────────────────────────────────────────────
  groupTasks(groupId: string): GroupTaskRecord[] {
    return groupOps.groupTasks(this.internals, groupId);
  }

  activeGroupTask(groupId: string): GroupTaskRecord | undefined {
    return groupOps.activeGroupTask(this.internals, groupId);
  }

  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined {
    return groupOps.groupTaskByThread(this.internals, groupId, threadId);
  }

  createGroupTask(groupId: string, title?: string, activate = true): GroupTaskRecord | null {
    return groupOps.createGroupTask(this.internals, groupId, title, activate);
  }

  switchGroupTask(groupId: string, threadId: string): GroupRecord | null {
    return groupOps.switchGroupTask(this.internals, groupId, threadId);
  }

  renameGroupTask(groupId: string, threadId: string, title: string): GroupTaskRecord | null {
    return groupOps.renameGroupTask(this.internals, groupId, threadId, title);
  }

  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string) {
    return groupOps.titleGroupTaskFromFirstMessage(this.internals, groupId, text, threadId);
  }

  /** Swap a machine-made first-message channel title for a generated one,
   * once; see store/groups.ts for the snippet-equality contract. */
  retitleGroupTask(groupId: string, threadId: string, machineTitle: string, title: string): GroupTaskRecord | null {
    return groupOps.retitleGroupTask(this.internals, groupId, threadId, machineTitle, title);
  }

  deleteGroupTask(groupId: string, threadId: string): GroupRecord | null {
    return groupOps.deleteGroupTask(this.internals, groupId, threadId);
  }

  /** The folder a room's member turns run in. Pins on the first turn that
   * dispatches, from the room's `cwd` at that moment. Pinned, not read
   * live, for the same reason tasks pin (see pinTaskCwd): engines key
   * their sessions and files to the folder a thread starts in, and a room
   * lives on ONE thread forever — so changing the room's folder applies to
   * future rooms, never under a room that already started working
   * somewhere. Returns the pinned value: a path, or null = each member's
   * own default. */
  pinGroupCwd(groupId: string, threadId?: string): string | null {
    return groupOps.pinGroupCwd(this.internals, groupId, threadId);
  }

  // ── message tree ──────────────────────────────────────────────────────
  /** Toggle an emoji reaction on a message ("user" or a member botId). */
  toggleReaction(threadId: string, messageId: string, emoji: string, by: string): Message | null {
    return messageOps.toggleReaction(this.internals, threadId, messageId, emoji, by);
  }

  messagesFor(threadId: string): Message[] {
    return messageOps.messagesFor(this.internals, threadId);
  }

  /** A bounded page of a thread's newest messages, for callers that only
   * need a display page — the startup/reconnect hydrate and a fresh
   * scrollback view. */
  messagesTail(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; activeLeafId: string | null } {
    return messageOps.messagesTail(this.internals, threadId, limit);
  }

  /** Used only with newly allocated import threads. No live actions are
   * replayed: the importer supplies inert text and freshly remapped IDs. */
  importTranscript(threadId: string, messages: Message[], activeLeafId: string | null): void {
    return messageOps.importTranscript(this.internals, threadId, messages, activeLeafId);
  }

  activeLeaf(threadId: string): string | null {
    return messageOps.activeLeaf(this.internals, threadId);
  }

  /** The visible conversation: root → activeLeafId. */
  activePath(threadId: string): Message[] {
    return messageOps.activePath(this.internals, threadId);
  }

  /** Mark the last assistant text on the active branch as this turn's final
   * visible answer. If a provider ends after commentary without emitting a
   * separate answer, that commentary remains visible as the safe fallback. */
  markTerminalAssistantMessage(threadId: string, turnId: string): Message | null {
    return messageOps.markTerminalAssistantMessage(this.internals, threadId, turnId);
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    return messageOps.appendMessage(this.internals, threadId, message);
  }

  /** Insert a message into the active chain directly after `anchorId` — the
   * home for turn artifacts that finish AFTER the world moved on. */
  insertMessageAfter(threadId: string, anchorId: string | undefined, message: Omit<Message, "id" | "at">): Message {
    return messageOps.insertMessageAfter(this.internals, threadId, anchorId, message);
  }

  /** Hide the first-run quiz on this thread, if it is still open. */
  dismissOnboardingCard(threadId: string): Message | null {
    return messageOps.dismissOnboardingCard(this.internals, threadId);
  }

  /** Fork the conversation: a new user message that replaces `sourceId`
   * (same parent, new text) and becomes the active leaf. */
  branchMessage(threadId: string, sourceId: string, text: string): Message | null {
    return messageOps.branchMessage(this.internals, threadId, sourceId, text);
  }

  /** Point the visible conversation at the branch containing `messageId`,
   * descending to that branch's most recently active leaf. */
  setActiveLeaf(threadId: string, messageId: string): string | null {
    return messageOps.setActiveLeaf(this.internals, threadId, messageId);
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    return messageOps.patchMessage(this.internals, threadId, messageId, patch);
  }

  // ── bots ──────────────────────────────────────────────────────────────
  bot(id: string) {
    return botOps.bot(this.internals, id);
  }

  botByThread(threadId: string) {
    return botOps.botByThread(this.internals, threadId);
  }

  createBot(
    profile: Partial<
      Pick<
        BotRecord,
        "name" | "title" | "description" | "soul" | "color" | "mascotExpression" | "mascotBody" | "modelSelection" | "section"
      >
    > = {},
    opts: {
      /** false = no greeting/onboarding seed. Imported bots must not open
       * with a first-person greeting the user never asked for. */
      seedMessages?: boolean;
    } = {},
  ): BotRecord {
    return botOps.createBot(this.internals, profile, opts);
  }

  /** All setup fields and the Chief's receipt commit before publishing any
   * mutation. Model defaults never rewrite saved thread selections. */
  applyTeamSetup(request: TeamSetupRequest): TeamSetupResult {
    return botOps.applyTeamSetup(this.internals, request);
  }

  deleteBot(id: string, setupRequest?: TeamSetupRequest): boolean {
    return botOps.deleteBot(this.internals, id, setupRequest);
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    return botOps.patchBot(this.internals, id, patch);
  }

  /** Voice ids belong to one provider's catalog. Changing the workspace
   * provider invalidates every per-agent selection as one durable mutation,
   * before clients are told to pick replacement voices. */
  clearVoiceSelections(): BotRecord[] {
    return botOps.clearVoiceSelections(this.internals);
  }

  /** Commit a validated profile change before publishing its fields. Unlike
   * runtime revocation, a failed user edit must leave the old profile intact. */
  patchBotProfile(id: string, patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>): BotRecord | null {
    return botOps.patchBotProfile(this.internals, id, patch);
  }

  /** Convenience for a soul-only change. The record is canonical; a failed
   * mirror write is reported in logs and can be retried by discarding drift. */
  setSoul(id: string, soul: string): BotRecord | null {
    return botOps.setSoul(this.internals, id, soul);
  }

  /** File visible bots into one sidebar section as a single durable write.
   * A Chief collision is refused rather than silently removing somebody's
   * coordinator role. */
  setBotsSection(
    botIds: string[],
    section: string,
  ): { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" } {
    return botOps.setBotsSection(this.internals, botIds, section);
  }

  /** Elect one Chief of Staff in its section (or clear one section) as one persisted change.
   * The changed records are returned so the server can update every open
   * window, including the bot that just handed the role over. */
  setChiefOfStaff(id: string | null, section?: string | null): BotRecord[] | null {
    return botOps.setChiefOfStaff(this.internals, id, section);
  }

  // ── tasks, projects, activity ─────────────────────────────────────────
  /** Legacy bot/room activity occupies its own slot; direct conversations
   * use setTaskActivity so settling one thread cannot clear another. */
  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    return taskOps.setActivity(this.internals, botId, activity);
  }

  setTaskActivity(botId: string, threadId: string, activity: BotActivity): BotRecord | null {
    return taskOps.setTaskActivity(this.internals, botId, threadId, activity);
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string) {
    return taskOps.setResumeCursor(this.internals, botId, instanceId, cursor, threadId);
  }

  /** Record which instance just took a turn on this task. Called at
   * dispatch, not at cursor time — transcript-replay engines never
   * produce a cursor, and they still count as having run last. */
  markTaskDispatched(botId: string, threadId: string, instanceId: string) {
    return taskOps.markTaskDispatched(this.internals, botId, threadId, instanceId);
  }

  setHandedMessages(botId: string, threadId: string, instanceId: string, state: HandedState) {
    const task = this.taskByThread(botId, threadId);
    if (!task || JSON.stringify(task.handedMessages?.[instanceId]) === JSON.stringify(state)) return;
    // Other instances keep a record only while it still describes their session.
    const live = Object.entries(task.handedMessages ?? {})
      .filter(([id, record]) => id !== instanceId && record.session !== undefined && record.session === task.resumeCursors[id]);
    task.handedMessages = { ...Object.fromEntries(live), [instanceId]: state };
    this.saveBots();
  }

  /** Bank one settled turn onto its task. Called once per turn.completed;
   * the running per-driver token indicator is deliberately not used here
   * because its meaning differs by driver. */
  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; context?: { tokens?: number; window?: number } },
  ): TaskUsage | null {
    return taskOps.addTaskUsage(this.internals, botId, threadId, turn);
  }

  /** The folder a task's turn runs in. Pins on first call from the bot's
   * current folder — unless the task already has a session (a thread from
   * before folders existed), which pins to the default so the folder can't
   * move under it. Returns the pinned value: a path, or null for default. */
  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean } = {}): string | null {
    return taskOps.pinTaskCwd(this.internals, botId, threadId, fallbackCwd, opts);
  }

  project(botId: string, projectId: string): BotProjectRecord | undefined {
    return taskOps.project(this.internals, botId, projectId);
  }

  createProject(botId: string, name: string, emoji?: string | null): BotProjectRecord | null {
    return taskOps.createProject(this.internals, botId, name, emoji);
  }

  patchProject(botId: string, projectId: string, patch: { name?: string; emoji?: string | null }): BotProjectRecord | null {
    return taskOps.patchProject(this.internals, botId, projectId, patch);
  }

  /** The stored array is the sidebar order; only a full owned permutation is valid. */
  reorderProjects(botId: string, projectIds: string[]): BotProjectRecord[] | null {
    return taskOps.reorderProjects(this.internals, botId, projectIds);
  }

  /** Removing an organizational label never removes its conversations. */
  deleteProject(botId: string, projectId: string): BotRecord | null {
    return taskOps.deleteProject(this.internals, botId, projectId);
  }

  tasks(botId: string): TaskRecord[] {
    return taskOps.tasks(this.internals, botId);
  }

  activeTask(botId: string): TaskRecord | undefined {
    return taskOps.activeTask(this.internals, botId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return taskOps.taskByThread(this.internals, botId, threadId);
  }

  /** A turn gets an independent snapshot without changing the selected task
   * or mutating the bot's defaults while another turn is running. */
  projectBotForTask(botId: string, threadId: string): BotRecord | null {
    return taskOps.projectBotForTask(this.internals, botId, threadId);
  }

  patchTask(botId: string, threadId: string, patch: TaskPatch): TaskRecord | null {
    return taskOps.patchTask(this.internals, botId, threadId, patch);
  }

  /** Model/provider changes are one configuration transaction: never publish
   * a new provider before its confirmed approval downgrade, or change the
   * default while leaving the selected thread behind after a write failure. */
  switchTaskModel(botId: string, threadId: string, selection: ModelSelection,
    updateBotDefault: boolean, resetApprovalToAsk: boolean, taskPatch: TaskPatch = {}): TaskRecord | null {
    return taskOps.switchTaskModel(this.internals, botId, threadId, selection, updateBotDefault, resetApprovalToAsk, taskPatch);
  }

  /** A fresh context on the same bot: new thread, new session, same
   * persona/tools/computer. Becomes the active task. */
  createTask(botId: string, title?: string, activate = true, projectId?: string, openedBy?: TaskOpenedBy): TaskRecord | null {
    return taskOps.createTask(this.internals, botId, title, activate, projectId, openedBy);
  }

  /** Attach (or complete) the opener record after the thread exists — the
   * handoff id is only known once the thread it targets has an id, so a
   * peer-opened thread is created first and stamped second. Never reachable
   * from the HTTP task PATCH: openedBy is not a TASK_PATCH_FIELD. */
  setTaskOpenedBy(botId: string, threadId: string, openedBy: TaskOpenedBy): TaskRecord | null {
    return taskOps.setTaskOpenedBy(this.internals, botId, threadId, openedBy);
  }

  /** Stamp or clear the closer record. `null` reopens: the next turn in a
   * closed thread calls this so the row comes back to the sidebar. Never
   * reachable from the HTTP task PATCH: closedBy is not a TASK_PATCH_FIELD. */
  setTaskClosedBy(botId: string, threadId: string, closedBy: TaskClosedBy | null): TaskRecord | null {
    return taskOps.setTaskClosedBy(this.internals, botId, threadId, closedBy);
  }

  /** Where a bot-to-bot send outside a room lands: the PAIR CONVERSATION
   * for (sender, recipient) — the recipient's task stamped `openedBy` this
   * sender with kind "pair". Scope is global for those two bots; adoption
   * and concurrency rules are documented on the slice. */
  resolvePairConversation(
    sender: Pick<BotRecord, "id" | "name">,
    recipientId: string,
    options: { label?: string; working: (threadId: string) => boolean },
  ): { task: TaskRecord; created: boolean } | null {
    return taskOps.resolvePairConversation(this.internals, sender, recipientId, options);
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    return taskOps.switchTask(this.internals, botId, threadId);
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    return taskOps.renameTask(this.internals, botId, threadId, title);
  }

  /** Name a task after its first message, once. */
  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string) {
    return taskOps.titleTaskFromFirstMessage(this.internals, botId, text, threadId);
  }

  /** Swap a machine-made first-message title for a generated one, once;
   * see store/tasks.ts for the snippet-equality contract. */
  retitleTask(botId: string, threadId: string, machineTitle: string, title: string): TaskRecord | null {
    return taskOps.retitleTask(this.internals, botId, threadId, machineTitle, title);
  }

  /** Delete a task and its transcript, retaining generated project files.
   * When no visible tasks remain, replace it with a fresh conversation. */
  deleteTask(botId: string, threadId: string): BotRecord | null {
    return taskOps.deleteTask(this.internals, botId, threadId);
  }

  /** First-run seed: one bot so the app never opens empty — it gets a
   * random friendly name like every other bot. */
  seedIfEmpty() {
    return botOps.seedIfEmpty(this.internals);
  }
}
