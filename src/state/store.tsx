import { configStatusFromFrame, type ConfigStatusFrame } from "./config-frame";
export { configStatusFromFrame, type ConfigStatusFrame } from "./config-frame";
import { cloudAsleep, onCloudPower } from "../lib/cloud-power";
import { api, ApiError } from "./api";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { BotMovedTo, BotVisibility, CardAnswerer, CloudBackend, ConnectorToolGrant, EffortLevel, InstalledPackageMetadata, LiveCallState, ServerFrame, GroupThreadUsage, SteerQueueReason, WireGroup, WireTask, OptionCardData as WireOptionCard } from "../../shared/wire";
import { movesThreadToTop } from "../../shared/wire"; import type { DefaultBotFields } from "../../shared/default-bot";
import { reorderStable } from "../../shared/bot-order";
import { DATA_ROUTES, type DataSheet, type DataTable } from "../../shared/data-surface";
import type { NotificationLogEntry } from "../../shared/notification";
import { isNotificationFeedAction, reduceNotificationFeed, type NotificationFeedAction } from "./notification-feed";
import { bumpThreadUpdatedAt, mergeTaskStamps, rewindThreadUpdatedAt } from "./thread-stamps";
import { botOpensTo, openBot, openNotificationTarget, visibleNotificationThread } from "./thread-navigation";
import { patchGroupTask } from "./thread-edits";
import { savedStateAction, type SavedOwner, type SavedSnapshot } from "./saved-state";
export { awayFromMainThread, botOpensTo, openBot, openBotThread, openNotificationTarget, openThread, visibleNotificationThread, type ThreadTarget } from "./thread-navigation";
import type { TurnDigest } from "../../shared/digest";
import type { ToolScope } from "../../shared/tool-scope";
import type { ModelVariantOption, RuntimeEvent } from "../../shared/runtime-events";
import type { MausColor, MausMotion } from "@/lib/mascot";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { desktopCapabilitiesNow } from "@/lib/desktop";
import { sameModelSelection } from "../../shared/thread-model";
import type { BotBodyId } from "../../shared/bot-body";
import type { QuestionRequestCardData } from "../../shared/ask-question";
import type { ProfileRequestCardData } from "../../shared/profile-request";
import type { ModelRequestCardData } from "../../shared/model-request";
import type { RoutineRequestCardData } from "../../shared/routine-request";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import type { PlaceRow } from "../../shared/place-view";
import {
  reviewedSkillSha256,
  skillRequestBehavior,
  type SkillRequestCardData,
} from "../../shared/skill-request";
import type { Routine, RoutineInput, RoutineRun, RoutineRunStatusFilter } from "@/lib/routines";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "@/lib/webhooks";
import { duplicateBotProfile, restrictedCopyRequest } from "@/lib/bot-duplicate";
import { botShowsUnread } from "@/lib/bot-unread";
import { firstUnreadMessageId, threadOpensUnread, threadReadCursor } from "@/lib/unread-divider";
import type { ComputerStart } from "@/lib/computer-start";
import { parseComputerHelp } from "@/lib/computer-control";
import { answerResponse, dismissResponse } from "@/lib/card-answer";
import { currentCall } from "@/lib/call";
import { readLastConversation, rememberConversation } from "@/lib/last-conversation";
import { readLastBotSection, rememberBotSection } from "@/lib/last-bot-section";
import { showNotification } from "@/lib/notify";
import { useShowThreads } from "@/lib/thread-preferences";
import { speaker } from "@/lib/tts";
import { roleProfilePatch, type BotRole } from "@/lib/bot-roles";
import { t } from "@/lib/i18n";
import { createBotPatchQueue, type BotUpdatePatch } from "./bot-patch-queue";
import { useChatErrorClear } from "./chat-error";
import { openLiveEvents, publishLiveFrame, publishMissedFrames } from "@/lib/live-events";
import { trimRoutineRuns } from "./routine-runs";
import { reconcileSnapshotQueues, rememberConsumedQueueId, replaceBotQueues } from "./queue-receipts";

export type { MausColor } from "@/lib/mascot";
export type { RoutineRunCardData } from "../../shared/routine-run";

export interface OptionCardData extends Pick<WireOptionCard, "fixedOptions" | "webhookRequest" | "appTriggerRequest"> {
  title: string;
  subtitle: string;
  options: string[];
  requestType?: "permission" | "question";
  optionHints?: Record<string, string>;
  multiSelect?: boolean;
  answered?: string;
  answeredText?: string;
  answeredBy?: CardAnswerer;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  expired?: boolean;
  heldCode?: string;
  allowKey?: string;
  allowSession?: boolean;
  commandAllowlist?: { command: string; cwd: string; providerInstanceId: string };
  approvalScope?: "local-computer";
  autoApplied?: boolean;
  undone?: boolean;
  routineRequest?: RoutineRequestCardData;
  skillRequest?: SkillRequestCardData;
  outboundRequest?: { tool: string; app: string | null; calls?: Array<{ app: string | null; label: string }> };
  teamMemoryRequest?: { section: string; entryId: string; kind: string; revision?: string };
  profileRequest?: ProfileRequestCardData;
  modelRequest?: ModelRequestCardData;
  teamSetupRequest?: import("../../shared/team-setup").TeamSetupRequest;
  questionRequest?: QuestionRequestCardData;
}

export interface ConnectorCardData {
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  alias?: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
  stopped?: boolean;
}

export interface SecretRequestCardData {
  target: import("../../shared/credential-request").CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
  superseded?: boolean;
  resumed?: boolean;
  error?: string;
  stopped?: boolean;
}

 export type ComputerControlState = { held: boolean; helpReason: string | null; help?: import("../../shared/wire").ComputerHelpRef | null };

export interface Message extends Pick<import("../../shared/wire").WireMessage, "widget" | "app" | "fromApp" | "pointed" | "routedBy" | "quickModel" | "automation" | "publishedPage" | "sender" | "helperIntro"> {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "signin" | "routine.run" | "goal.run" | "digest" | "compaction" | "call" | "widget" | "app";
  text?: string;
  digest?: TurnDigest;
  compaction?: import("../../shared/wire").WireMessage["compaction"];
  attachments?: import("../../shared/wire").WireMessage["attachments"];
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  signIn?: import("../../shared/wire").SignInRequestCardData;
  routineRun?: RoutineRunCardData;
  goalRun?: GroupGoalRunCardData;
  call?: import("../../shared/wire").LiveCallRecord;
  channelMode?: "chat" | "goal";
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean; claudeUpdate?: boolean; place?: PlaceRow; limitResetsAt?: number; summary?: string; input?: string; output?: string ; itemId?: string; outputPath?: string; fullResult?: boolean };
  steered?: boolean;
  via?: "api" | "call";
  callId?: string;
  requestMessageId?: string;
  turnId?: string;
  turnTerminal?: boolean;
  turnCompletedAt?: number;
  optimisticThreadOrderAt?: number;
  hasImage?: boolean;
  png?: string;
  mime?: string;
  at: number;
  parentId?: string | null;
  replyToId?: string;
  sendId?: string;
  from?: { botId: string; name: string; color: MausColor };
  peerAsk?: { botId: string; name: string; unattended?: boolean };
  roomRequest?: { id: string; phase: "request" | "result" };
  reactions?: import("../../shared/wire").WireMessage["reactions"];
  reaction?: string;
  comm?: { groupId: string; threadId?: string; withBotId: string; withName: string; withColor: MausColor };
  threadRef?: { botId: string; threadId: string; title: string };
  dataResult?: import("../../shared/wire").WireMessage["dataResult"];
  queued?: boolean;
  queueId?: string;
}

export type GroupDefaultResponder = import("../../shared/wire").GroupDefaultResponder;

export interface Group extends Pick<WireGroup, "memberContext" | "queue"> {
  usage?: GroupThreadUsage | null;
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  description?: string;
  unread: boolean;
  lastReadMessageId?: string;
  createdAt: number;
  dm?: boolean;
  busyBotId?: string | null;
  turnStartedAt?: number | null;
  working?: boolean;
  cwd?: string;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  section?: string;
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  turnTimeoutMinutes?: number | null;
  holds?: Record<string, import("../../shared/wire").RoomHold>;
  heldMessages?: Record<string, import("../../shared/wire").RoomHeldMessage[]>;
  tasks?: GroupTask[];
  messages: Message[];
  hasMore?: boolean;
}

 export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  pinned?: boolean;
  updatedAt?: number;
  turnTimeoutMinutes?: number;
  lastThreadOrderAt?: number;
  working?: boolean;
  busyBotId?: string | null;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
  variant?: string;
}

export interface Task extends Pick<WireTask, "private"> {
  waitingForTeammates?: boolean;
  threadId: string;
  routineRunId?: string;
  projectId?: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
  link?: string;
  updatedAt?: number;
  lastThreadOrderAt?: number;
  usage?: TaskUsage;
  cacheKeepWarm?: import("../../shared/wire").CacheKeepWarmStatus;
  cwd?: string | null;
  modelSelection?: ModelSelection;
  followsBotModel?: boolean;
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  activity?: Bot["activity"];
  busy?: boolean;
  turnStartedAt?: number;
  unread?: boolean;
  lastReadMessageId?: string;
  pinnedMessageId?: string;
  surface?: "cloud" | "vm" | "local" | "browser";
  surfaceAuto?: true;
  openedBy?: ThreadOpener;
  closedBy?: ThreadCloser;
  archivedAt?: number;
  snoozedUntil?: number;
}

 export interface ThreadOpener {
  botId: string;
  name: string;
  delegationId?: string;
  at: number;
}

 export interface ThreadCloser {
  botId: string;
  name: string;
  at: number;
}

export interface TaskUsage {
  input: number;
  output: number;
  cachedInput?: number;
  costUsd: number | null;
  turns: number;
  lastTurn?: { input: number; output: number; cachedInput?: number; costUsd: number | null };
  context?: { tokens: number; window?: number };
}

export interface Bot extends DefaultBotFields {
  toolScope?: ToolScope;
  waitingForTeammates?: boolean;
  id: string;
  threadId: string;
  mainThreadId?: string;
  tasks?: Task[];
  projects?: BotProject[];
  name: string;
  title: string;
  description: string; movedTo?: BotMovedTo;
  soul?: string;
  soulDrift?: boolean;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  mascotBody?: BotBodyId | null;
  avatarUrl?: string | null;
  avatarCrop?: BotAvatarCrop;
  avatarZoom?: number;
  avatarFocusX?: number;
  avatarFocusY?: number;
  unread: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead" | "parked.computer";
  turnStartedAt?: number | null;
  modelSelection: ModelSelection;
  computer?: "cloud" | "vm" | "local" | "browser" | "off";
  cloudBackend?: CloudBackend;
  autoStartVps?: boolean;
  vpsAlias?: string;
  cwd?: string;
  autoApprove?: boolean;
  approvalMode?: ApprovalMode;
  alwaysAllow?: string[];
  speakReplies?: boolean;
  replyStyle?: import("../../shared/wire").WireBot["replyStyle"];
  voice?: string;
  voiceNotes?: boolean; xResearch?: boolean;
  memoryEnabled?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  section?: string;
  pinnedMessageId?: string;
  chiefOfStaff?: boolean;
  managedSections?: string[];
  approvePeerComms?: boolean;
  peers?: string[];
  composio?: boolean;
  connectorTools?: Record<string, ConnectorToolGrant>;
  connectorScopes?: { apps: Record<string, "read" | "write"> };
  outbound?: { policy: "ask" | "allow"; dailyCap: number };
  fallback?: Array<{ instanceId: string; model: string }>;
  browser?: boolean;
  recordBrowserSteps?: boolean;
  memoryUpkeep?: boolean;
  cacheKeepWarm?: boolean | null;
  helperModel?: boolean;
  mcpServers?: string[] | null;
  browserProfile?: string | null;
  visibility?: BotVisibility;
  installedPackage?: InstalledPackageMetadata;
  messages: Message[];
  hasMore?: boolean;
  awaitingThreadSnapshot?: boolean;
  switchingTo?: string;
  activeLeafId?: string | null;
}

export interface BotProject {
  id: string;
  name: string;
  emoji?: string;
}

export type ProjectUpdatePatch = { name?: string; emoji?: string | null };

 export function threadApprovalModes(bot: Pick<Bot, "approvalMode" | "autoApprove" | "tasks">): ApprovalMode[] {
  return (bot.tasks ?? []).map((task) => approvalModeFor({
    approvalMode: task.approvalMode ?? (task.autoApprove === undefined ? bot.approvalMode : undefined),
    autoApprove: task.autoApprove ?? bot.autoApprove,
  }));
}

 export function currentTaskBot(bot: Bot, threadId = bot.threadId): Bot {
  const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
  if (!task) return bot;
  return {
    ...bot,
    threadId,
    modelSelection: task.modelSelection ?? bot.modelSelection,
    approvalMode: task.approvalMode ?? (task.autoApprove === undefined ? bot.approvalMode : undefined),
    autoApprove: task.autoApprove ?? bot.autoApprove,
    alwaysAllow: task.alwaysAllow ?? bot.alwaysAllow,
    activity: task.activity ?? bot.activity,
    busy: task.busy ?? (task.activity ? task.activity === "working" || task.activity === "waiting-on-you" : bot.busy),
    unread: task.unread ?? bot.unread,
    pinnedMessageId: task.pinnedMessageId,
    turnStartedAt: task.turnStartedAt ?? null,
    waitingForTeammates: task.waitingForTeammates ?? false,
  };
}

export type TaskUpdatePatch = Partial<Pick<Task, "modelSelection" | "approvalMode" | "autoApprove" | "pinnedMessageId">> & {
  acknowledgeLocalAuto?: boolean;
  updateBotDefault?: boolean;
  resetApprovalToAsk?: boolean;
  projectId?: string | null;
  archivedAt?: number | null;
  snoozedUntil?: number | null;
  surface?: Task["surface"] | null;
  pinned?: boolean;
  link?: string | null;
};

function taskPatchFields(patch: TaskUpdatePatch): Partial<Task> {
  const { acknowledgeLocalAuto: _localAck, updateBotDefault: _modelDefault, resetApprovalToAsk, projectId, archivedAt, snoozedUntil, surface, pinned, link, ...fields } = patch;
  return { ...fields, ...(resetApprovalToAsk ? { approvalMode: "ask", autoApprove: false, alwaysAllow: [] } : {}),
    ...(projectId === undefined ? {} : { projectId: projectId ?? undefined }),
    ...(archivedAt === undefined ? {} : { archivedAt: archivedAt ?? undefined }),
    ...(snoozedUntil === undefined ? {} : { snoozedUntil: snoozedUntil ?? undefined }),
    ...(surface === undefined ? {} : { surface: surface ?? undefined, surfaceAuto: undefined }),
    ...(pinned === undefined ? {} : { pinned: pinned ? true : undefined }),
    ...(link === undefined ? {} : { link: link ?? undefined }) };
}

function openedUnreadDivider(state: AppState, threadId: string, unread: boolean, messages: readonly Message[], lastReadMessageId?: string): AppState["unreadDivider"] {
  if (!unread) return state.unreadDivider?.threadId === threadId ? state.unreadDivider : null;
  const messageId = firstUnreadMessageId(messages, lastReadMessageId);
  return messageId ? { threadId, messageId } : null;
}

 export function visibleMessages(bot: Pick<Bot, "messages" | "activeLeafId">): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

import type { BrowserEngineSummary, BrowserProfile, ConfigStatus, ManagedPolicySummary } from "./config-status";
export type { BrowserEngineSummary, BrowserProfile, ConfigStatus, ManagedPolicySummary };



 export interface EngineInstall {
  platform?: "darwin" | "win32" | "linux";
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
  managed?: { label: string; downloadBytes: number };
  server?: { package: string };
  settings?: "connections";
}

 export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  icon?: import("../../shared/provider-icon").ProviderIcon;
  readOnly?: boolean;
  trialCredit?: "active" | "used_up" | "ended";
  managed?: { organizationId: string; organizationName: string };
  policy?: { organizationName: string; reason: string };
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    chatgptPlan?: boolean;
    authenticationUnavailableReason?: string;
    account?: { email?: string; organization?: string; method?: "login" | "api-key" };
    version?: string | null;
    update?: {
      title: string;
      message: string;
      command: string;
    };
    billing?: "metered" | "subscription";
    warning?: {
      title: string;
      message: string;
    };
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean; provider?: string; variants?: ModelVariantOption[] }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    /** the engine can mount the native HighLevel tools (a connected app without Composio) */
    highlevelMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    approvalReviewEffortLevels?: readonly EffortLevel[];
    modelVariants?: boolean;
    queueing?: boolean;
    localComputerMcp?: boolean;
    approvalReview?: boolean;
    backgroundText?: boolean;
  };
  access?: "subscription" | "custom" | "api";
  authentication?: { method: "device-code" | "paste-code" | "browser" | "browser-pkce"; signOut?: boolean };
  install?: EngineInstall;
  cli?: string;
  cliDefault?: string;
  cliCandidates?: string[];
  claudeAccount?: { configDir: string; signInCommand: string; signInShell: "powershell" | "sh"; isDefault: boolean };
  freeUpSpace?: boolean;
}

export type AppSettingsSection =
  | "general"
  | "desktopWorkspaces"
  | "organization"
  | "cloudAccount"
  | "appearance"
  | "experimental"
  | "connections"
  | "decisionModel"
  | "approvalReview"
  | "engines"
  | "companion"
  | "remote"
  | "computer"
  | "logins"
  | "usage"
  | "people"
  | "activity"
  | "backups"
  | "workspaces"
  | "skills" | "import";

export type BotSettingsSection =
  | "overview"
  | "identity"
  | "slack"
  | "soul"
  | "skills"
  | "memory"
  | "routines"
  | "access"
  | "model"
  | "permissions"
  | "voice"
  | "visibility"
  | "history"
  | "usage";

export interface ModelVariantSession {
  instanceId: string;
  model: string;
  turnId: string;
  startedAt: string;
  acceptingUpdates: boolean;
  variants?: { options: ModelVariantOption[]; currentValue?: string };
}

export interface AppState {
  bots: Bot[];
  groups: Group[];
  sections?: string[];
  instances: InstanceInfo[];
  modelVariantSessions: Record<string, ModelVariantSession>;
  config: ConfigStatus | null;
  liveCall: LiveCallState | null;
  liveCallVersion: number;
  liveCallLookupSeq: number;
  selectedId: string;
  activeView: "chat" | "team-map" | "routines" | "files";
  /** Folders a finished move left on this computer, for Files to offer sharing. */
  filesSuggest: string[] | null;
  routines: Routine[];
  routineRuns: RoutineRun[];
  routinesLoadState: "loading" | "ready" | "error";
  routinesFocus: { section?: "schedule" | "logs"; view?: "calendar" | "list"; botId?: string; routineId?: string; runStatus?: RoutineRunStatusFilter; nonce: number };
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  pluginsSurface: "apps" | "mcp";
  newBotOpen: boolean;
  botCreationPending: boolean;
  computerOpen: boolean;
  inspectorOpen: boolean;
  activityOpen: boolean;
  /** Cross-bot, so a bot switch leaves it open; pinned, opening another side panel leaves it open too. */
  notificationsOpen: boolean;
  notificationsPinned: boolean;
  notifications: NotificationLogEntry[];
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  appSettingsCloudLink: number;
  appSettingsPhonePairing: number;
  shortcutsOpen: boolean;
  cloudAdd: { source: import("@/lib/cloud-plan").CloudSource; signIn?: true } | null;
  cloudHowTo: boolean;
  welcomeOpen: boolean;
  tourOpen: boolean;
  botSettingsSection: BotSettingsSection;
  botSettingsExpandAccordion: boolean;
  botSettingsSectionStored: boolean;
  botSettingsExpandRemembered: boolean;
  computerStarts: Record<string, ComputerStart>;
  deletingBots: Record<string, true>;
  computerControl: Record<string, ComputerControlState>;
  dataSheets: Record<string, DataSheet>;
  dataTables: Record<string, DataTable[]>;
  dataResultFocus: { botId: string; id: string; requestId: number; consumed: boolean } | null;
  signInFocus: { botId: string; messageId: string; url: string; site: string; place: import("../../shared/wire").Surface; requestId: number; consumed: boolean } | null;
  dataView: import("@/lib/composer-attachments").DataViewContext | null;
  focusMessage: { threadId: string; messageId: string; matchText?: string; nonce: number; consumed: boolean } | null;
  unreadDivider: { threadId: string; messageId: string } | null;
  connected: boolean;
  hydrated?: true;
  error: string | null;
  notice: { kind: "thread-gone" | "bot-gone" | "steer-images" | "note"; botName: string | null; text?: string } | null;
  revealThread: { threadId: string; nonce: number } | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
  pendingQueued: Record<string, Array<{ queueId: string; text: string; reason?: SteerQueueReason }>>;
  consumedQueueIds: Record<string, true>;
  backgroundThreadEvents: Record<string, Array<Extract<Action, { type: "messageAdded" | "messagePatched" | "threadActive" | "optimisticMessageRemoved" }>>>;
  loadingOlder: Record<string, true>;
  transcriptGeneration: Record<string, number>;
}

export type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

export type Action =
  | {
      type: "hydrate";
      bots: Bot[];
      groups: Group[];
      sections?: string[];
      computerControl: Record<string, ComputerControlState>;
      botQueuedMessages?: AppState["pendingQueued"];
      resumeId?: string;
    }
  | { type: "botQueues"; queues: AppState["pendingQueued"] }
  | { type: "sections"; sections: string[] }
  | { type: "botsOrdered"; botIds: string[] }
  | { type: "sectionDeleted"; section: string; sections: string[] }
  | { type: "showRoutines"; section?: "schedule" | "logs"; view?: "calendar" | "list"; botId?: string; routineId?: string; runStatus?: RoutineRunStatusFilter }
  | { type: "showTeamMap" }
  | { type: "showFiles"; suggest?: string[] }
  | { type: "showChat" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinesLoadFailed" }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | NotificationFeedAction
  | { type: "toggleNotifications"; open?: boolean }
  | { type: "toggleNotificationsPinned"; pinned?: boolean }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string; onStarted?: (run: RoutineRun) => void; onError?: (error: unknown) => void; onSettled?: () => void }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "markRoutineRunSeen"; runId: string }
  | { type: "markAllRoutineRunsSeen" }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string; section?: string }
  | {
      type: "sendGroup";
      groupId: string;
      text: string;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      mode?: "chat" | "goal";
      onError?: () => void;
    }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "description" | "memberIds" | "defaultResponder" | "pinnedMessageId" | "section">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "newGroupTask"; groupId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "renameGroupTask"; groupId: string; threadId: string; title: string }
  | { type: "pinGroupTask"; groupId: string; threadId: string; pinned: boolean; title: string }
  | { type: "setConversationTurnLimit"; groupId: string; threadId: string; minutes: number | null; dm: boolean }
  | { type: "deleteGroupTask"; groupId: string; threadId: string }
  | { type: "interruptGroup"; groupId: string; threadId?: string; onError?: () => void }
  | { type: "setGroupHold"; groupId: string; botId: string; held: boolean }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "liveCall"; call: LiveCallState | null }
  | { type: "liveCallLookup"; call: LiveCallState | null; since: number; seq: number }
  | { type: "profileSaved"; profile: Partial<NonNullable<ConfigStatus["profile"]>> }
  | { type: "select"; id: string }
  | {
      type: "send";
      botId: string;
      text: string;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      dataContext?: import("../../shared/data-context").DataContext; pointed?: import("../../shared/app-frame/point").PointedElement[];
      onError?: () => void;
    }
  | { type: "pendingQueued"; threadId: string; queueId: string; text: string; reason?: SteerQueueReason }
  | { type: "consumePendingQueued"; threadId: string; queueId: string }
  | { type: "cancelQueued"; botId: string; queueId: string; threadId?: string; onCancelled?: () => void }
  | { type: "steerQueued"; botId: string; queueId: string; threadId?: string; onError?: () => void; onSettled?: () => void }
  | { type: "cancelGroupQueued"; groupId: string; threadId: string; queueId: string; onCancelled?: () => void }
  | { type: "steerGroupQueued"; groupId: string; queueId: string; threadId?: string; onError?: () => void; onSettled?: () => void }
  | { type: "editMessage"; botId: string; messageId: string; text: string; threadId?: string; sendId?: string }
  | { type: "switchBranch"; botId: string; messageId: string; threadId?: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "loadOlderMessages"; threadId: string }
  | { type: "olderMessages"; threadId: string; generation: number; messages: Message[]; hasMore: boolean }
  | { type: "answerCard"; botId: string; messageId: string; answer: string; threadId?: string; groupId?: string }
  | { type: "dismissCard"; botId: string; messageId: string; threadId?: string; groupId?: string }
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      reviewedSha256?: string;
      alwaysAllow?: { botId: string; key: string };
      always?: boolean;
      rememberCommand?: boolean;
      onError?: (message: string) => void;
    }
  | { type: "newTask"; botId: string; projectId?: string; cwd?: string; onCreated?: () => void; onError?: (message: string) => void }
  | { type: "switchTask"; botId: string; threadId: string; whole?: true }
  | { type: "switchTaskFailed"; botId: string; threadId: string }
  | { type: "taskSwitched"; bot: Bot }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "regenerateTaskTitle"; botId: string; threadId: string; onSettled?: (ok: boolean) => void }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot"; role?: BotRole; visibility?: BotVisibility; section?: string; preserveSelection?: boolean; onCreated?: (bot: Bot) => void; onError?: (message: string) => void }
  | { type: "botCreationPending"; on: boolean }
  | { type: "updateTask"; botId: string; threadId: string; patch: TaskUpdatePatch }
  | { type: "refreshTaskPermissions"; botId: string; threadId: string; acknowledgeLocalAuto?: boolean }
  | { type: "followBotModel"; botId: string; onSettled?: (result: { busy: number }) => void }
  | { type: "createProject"; botId: string; name: string; emoji?: string | null; onCreated?: (project: BotProject) => void; onError?: (message: string) => void }
  | { type: "updateProject"; botId: string; projectId: string; patch: ProjectUpdatePatch; onSaved?: () => void; onError?: (message: string) => void }
  | { type: "deleteProject"; botId: string; projectId: string; onDeleted?: () => void; onError?: (message: string) => void }
  | { type: "reorderProjects"; botId: string; projectIds: string[]; onSaved?: () => void; onError?: (message: string) => void }
  | { type: "botAdded"; bot: Bot; preserveSelection?: boolean }
  | { type: "deleteBot"; botId: string }
  | { type: "botDeletionPending"; botId: string; on: boolean }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "optimisticMessageRemoved"; threadId: string; sendId: string; restoreLeafId?: string | null }
  | { type: "computerStart"; botId: string; start: ComputerStart | null }
  | ({ type: "computerControl"; botId: string } & ComputerControlState)
  | { type: "dataSheet"; sheet: DataSheet; tables?: DataTable[] }
  | { type: "dataView"; view: AppState["dataView"] }
  | { type: "loadDataSheet"; botId: string; onError?: (message: string) => void }
  | { type: "modelVariantRuntime"; event: RuntimeEvent }
  | { type: "setModel"; botId: string; selection: ModelSelection; threadId?: string; updateBotDefault?: boolean; resetApprovalToAsk?: boolean }
  | { type: "interrupt"; botId: string; threadId?: string; onError?: () => void }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "notice"; notice: AppState["notice"] }
  | { type: "revealThread"; threadId: string }
  | { type: "toggleSettings"; open?: boolean; section?: BotSettingsSection; botId?: string }
  | { type: "togglePlugins"; open?: boolean; surface?: "apps" | "mcp" }
  | { type: "toggleNewBot"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean; botId?: string }
  | { type: "openDataResult"; botId: string; cardId: string }
  | { type: "dataResultFocusConsumed"; requestId: number }
  | { type: "openSignIn"; botId: string; messageId: string; url: string; site: string; place: import("../../shared/wire").Surface }
  | { type: "signInFocusConsumed"; requestId: number }
  | { type: "toggleInspector"; open?: boolean }
  | { type: "toggleActivity"; open?: boolean }
  | { type: "focusMessage"; threadId: string; messageId: string; matchText?: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | { type: "unreadDividerDone"; threadId: string }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection; cloudLink?: boolean; phonePairing?: boolean }
  | { type: "toggleShortcuts"; open?: boolean }
  | { type: "openCloudAdd"; source: import("@/lib/cloud-plan").CloudSource; signIn?: true }
  | { type: "closeCloudAdd" }
  | { type: "cloudHowTo"; open: boolean }
  | { type: "toggleWelcome"; open?: boolean }
  | { type: "toggleTour"; open?: boolean }
  | {
      type: "updateBot";
      botId: string;
      patch: BotUpdatePatch;
    };

 function reconcileModelVariantSessions(state: AppState): AppState {
  const sessions = Object.entries(state.modelVariantSessions);
  const kept = sessions.filter(([threadId, session]) => {
    const owner = state.bots.find((bot) => bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId));
    if (!owner) return false;
    const selection = currentTaskBot(owner, threadId).modelSelection;
    return selection.instanceId === session.instanceId && selection.model === session.model;
  });
  return kept.length === sessions.length ? state : { ...state, modelVariantSessions: Object.fromEntries(kept) };
}

export function pinBotThreadAction(action: Action, bots: Bot[]): Action {
  if (!("botId" in action) || ("threadId" in action && action.threadId) ||
      !["send", "interrupt", "editMessage", "switchBranch", "answerCard", "dismissCard", "cancelQueued", "steerQueued"].includes(action.type)) return action;
  const botId = action.botId;
  const threadId = bots.find((bot) => bot.id === botId)?.threadId;
  return { ...action, threadId } as Action;
}

function bumpTranscriptGeneration(state: AppState, threadId: string | undefined | null): AppState {
  if (!threadId) return state;
  return {
    ...state,
    transcriptGeneration: {
      ...state.transcriptGeneration,
      [threadId]: (state.transcriptGeneration[threadId] ?? 0) + 1,
    },
  };
}

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function withPatchedCard(messages: Message[], messageId: string, patch: Partial<OptionCardData>): Message[] {
  return messages.map((m) => (m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m));
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({ ...b, messages: withPatchedCard(b.messages, messageId, patch) }));
}

function patchGroupCard(state: AppState, groupId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === groupId ? { ...g, messages: withPatchedCard(g.messages, messageId, patch) } : g,
    ),
  };
}

 function openOnboardingCard(bot: Bot): Message | undefined {
  return bot.messages.find(
    (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
  );
}

function dismissOnboardingCard(state: AppState, botId: string): AppState {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const quiz = bot ? openOnboardingCard(bot) : undefined;
  return quiz ? patchCard(state, botId, quiz.id, { dismissed: true }) : state;
}

const optimisticMessageId = (sendId: string): string => `optimistic-${sendId}`;

function optimisticUserMessage(
  text: string,
  sendId: string,
  replyToId?: string,
  parentId?: string | null,
  channelMode?: "chat" | "goal",
): Message {
  return {
    id: optimisticMessageId(sendId),
    role: "user",
    kind: "text",
    text,
    at: Date.now(),
    parentId: parentId ?? null,
    replyToId,
    sendId,
    channelMode,
  };
}

 export const CLOUD_LINK_SETTINGS = { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } as const satisfies Action;

export function reducer(state: AppState, action: Action): AppState {
  if (action.type === "messageAdded" || action.type === "messagePatched" || action.type === "threadActive" || action.type === "optimisticMessageRemoved") {
    const owner = state.bots.find((bot) => (bot.threadId !== action.threadId || bot.awaitingThreadSnapshot) && bot.tasks?.some((task) => task.threadId === action.threadId));
    if (owner) {
      const frames = [...(state.backgroundThreadEvents[action.threadId] ?? []), action].slice(-256);
      const buffered = { ...state, backgroundThreadEvents: { ...state.backgroundThreadEvents, [action.threadId]: frames } };
      return (action.type === "messageAdded" || action.type === "messagePatched") && movesThreadToTop(action.message)
        ? bumpThreadUpdatedAt(buffered, action.threadId, action.message.at, true, action.message.turnCompletedAt ?? action.message.at)
        : action.type === "messageAdded" ? bumpThreadUpdatedAt(buffered, action.threadId, action.message.at) : buffered;
    }
  }
  if (isNotificationFeedAction(action)) return { ...state, notifications: reduceNotificationFeed(state.notifications, action) };
  switch (action.type) {
    case "hydrate": {
      const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
      const resume = action.resumeId;
      const resumed =
        resume && (action.bots.some((b) => b.id === resume && !b.hidden) || action.groups.some((g) => g.id === resume)) ? resume : "";
      const selectedId = state.selectedId && known(state.selectedId) ? state.selectedId : resumed || (action.bots[0]?.id ?? "");
      const hydrated = {
        ...state,
        bots: action.bots.map((bot) => {
          const previous = state.bots.find((candidate) => candidate.id === bot.id);
          return previous ? { ...bot, tasks: mergeTaskStamps(previous.tasks, bot.tasks) } : bot;
        }),
        groups: action.groups.map((group) => {
          const previous = state.groups.find((candidate) => candidate.id === group.id);
          const merged = previous ? { ...group, tasks: mergeTaskStamps(previous.tasks, group.tasks) } : group;
          // The wire carries an explicitly-cleared description as null; client state keeps it absent.
          if (merged.description === null) merged.description = undefined;
          return merged;
        }),
        sections: action.sections ?? [],
        computerControl: action.computerControl,
        selectedId,
        hydrated: true as const,
        backgroundThreadEvents: {},
        loadingOlder: {},
        transcriptGeneration: {},
        modelVariantSessions: {},
      };
      return reconcileSnapshotQueues(
        action.botQueuedMessages ? replaceBotQueues(hydrated, action.botQueuedMessages) : hydrated,
        [...action.bots, ...action.groups],
      );
    }
    case "loadOlderMessages":
      return state.loadingOlder[action.threadId]
        ? state
        : { ...state, loadingOlder: { ...state.loadingOlder, [action.threadId]: true } };
    case "olderMessages": {
      const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
      if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) {
        return { ...state, loadingOlder };
      }
      const prepend = <T extends { messages: Message[]; threadId: string; hasMore?: boolean }>(owner: T): T => {
        const held = new Set(owner.messages.map((message) => message.id));
        return {
          ...owner,
          messages: [...action.messages.filter((message) => !held.has(message.id)), ...owner.messages],
          hasMore: action.hasMore,
        };
      };
      return {
        ...state,
        loadingOlder,
        bots: state.bots.map((bot) => (bot.threadId === action.threadId ? prepend(bot) : bot)),
        groups: state.groups.map((group) => (group.threadId === action.threadId ? prepend(group) : group)),
      };
    }
    case "sectionDeleted":
      return {
        ...state, sections: action.sections,
        bots: state.bots.map(bot => bot.section === action.section ? { ...bot, section: undefined } : bot),
        groups: state.groups.map(group => group.section === action.section ? { ...group, section: undefined } : group),
      };
    case "sections":
      return { ...state, sections: action.sections };
    case "botsOrdered": {
      // The server's fleet order (PUT /api/bots/order): a stable partial reorder, so the sidebar shows what a phone just did.
      const bots = reorderStable(state.bots, action.botIds);
      return bots.every((bot, index) => bot === state.bots[index]) ? state : { ...state, bots };
    }
    case "botQueues":
      return reconcileSnapshotQueues(replaceBotQueues(state, action.queues), [...state.bots, ...state.groups]);
    case "showRoutines":
      return {
        ...state,
        activeView: "routines",
        routinesFocus: { section: action.section, view: action.view, botId: action.botId, routineId: action.routineId, runStatus: action.runStatus, nonce: state.routinesFocus.nonce + 1 },
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        activityOpen: false,
        notificationsOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "showChat":
      return state.activeView === "chat" ? state : { ...state, activeView: "chat" };
    case "showTeamMap":
    case "showFiles":
      return {
        ...state,
        activeView: action.type === "showFiles" ? "files" : "team-map",
        filesSuggest: action.type === "showFiles" && action.suggest?.length ? action.suggest : null,
        settingsOpen: false, computerOpen: false, inspectorOpen: false, activityOpen: false, appSettingsOpen: false, pluginsOpen: false,
      };
    case "routinesHydrated":
      return { ...state, routines: action.routines, routineRuns: trimRoutineRuns(action.runs), routinesLoadState: "ready" };
    case "routinesLoadFailed":
      return { ...state, routinesLoadState: "error" };
    case "routinePatched": {
      const existing = state.routines.find((routine) => routine.id === action.routine.id);
      // A PATCH's answer and the server's broadcast of it can arrive in either order: never step back to an older edit.
      if (existing && existing.updatedAt > action.routine.updatedAt) return state;
      return {
        ...state,
        routines: existing
          ? state.routines.map((routine) => (routine.id === action.routine.id ? action.routine : routine))
          : [action.routine, ...state.routines],
      };
    }
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "routineRunPatched": {
      const exists = state.routineRuns.some((run) => run.id === action.run.id);
      const runs = exists
        ? state.routineRuns.map((run) => (run.id === action.run.id ? action.run : run))
        : [action.run, ...state.routineRuns];
      return {
        ...state,
        routineRuns: trimRoutineRuns(runs),
      };
    }
    case "webhooksHydrated":
      return { ...state, webhooks: action.webhooks, webhookAttempts: action.attempts, webhookIngress: action.ingress };
    case "webhookPatched": {
      const exists = state.webhooks.some((webhook) => webhook.id === action.webhook.id);
      return {
        ...state,
        webhooks: exists
          ? state.webhooks.map((webhook) => (webhook.id === action.webhook.id ? action.webhook : webhook))
          : [action.webhook, ...state.webhooks],
      };
    }
    case "webhookDeleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((webhook) => webhook.id !== action.webhookId),
        webhookAttempts: state.webhookAttempts.filter((attempt) => attempt.webhookId !== action.webhookId),
      };
    case "webhookAttempted": {
      const attempts = state.webhookAttempts.some((attempt) => attempt.id === action.attempt.id)
        ? state.webhookAttempts.map((attempt) => attempt.id === action.attempt.id ? action.attempt : attempt)
        : [...state.webhookAttempts, action.attempt];
      return { ...state, webhookAttempts: attempts.slice(-2_000) };
    }
    case "groupPatched": {
      const fenced = action.group.messages ? bumpTranscriptGeneration(state, action.group.threadId) : state;
      const exists = fenced.groups.some((g) => g.id === action.group.id);
      const groups = exists
        ? fenced.groups.map((g) => (g.id === action.group.id ? {
            ...g, ...action.group,
            section: typeof action.group.threadId === "string" || Object.hasOwn(action.group, "section") ? action.group.section : g.section,
            description: Object.hasOwn(action.group, "description")
              ? (action.group.description ?? undefined)
              : g.description,
            tasks: action.group.tasks ? mergeTaskStamps(g.tasks, action.group.tasks) : g.tasks,
            turnTimeoutMinutes: Object.hasOwn(action.group, "turnTimeoutMinutes")
              ? (action.group.turnTimeoutMinutes ?? undefined)
              : g.turnTimeoutMinutes,
            messages: action.group.messages ?? g.messages,
            hasMore: action.group.messages ? Boolean(action.group.hasMore) : g.hasMore,
          } : g))
        : [{ ...(action.group.description === null ? { ...action.group, description: undefined } : action.group) as Group, messages: action.group.messages ?? [] }, ...fenced.groups];
      return { ...fenced, groups };
    }
    case "groupDeleted": {
      const groups = state.groups.filter((g) => g.id !== action.groupId);
      const selectedId = state.selectedId === action.groupId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, groups, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return { ...state, config: action.config };
    case "liveCall":
      return { ...state, liveCall: action.call, liveCallVersion: state.liveCallVersion + 1 };
    case "liveCallLookup":
      return action.since === state.liveCallVersion && action.seq > state.liveCallLookupSeq
        ? { ...state, liveCall: action.call, liveCallLookupSeq: action.seq }
        : state;
    case "profileSaved":
      return state.config ? {
        ...state,
        config: { ...state.config, profile: { name: "", email: "", ...state.config.profile, ...action.profile } },
      } : state;
    case "select": {
      const room = state.groups.find((g) => g.id === action.id);
      if (room) {
        return {
          ...state,
          unreadDivider: openedUnreadDivider(state, room.threadId, room.unread, room.messages, room.lastReadMessageId),
          activeView: "chat",
          selectedId: action.id,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
        };
      }
      const opened = state.bots.find((b) => b.id === action.id);
      return updateBot(
        withMascotMotion(
          {
            ...state,
            unreadDivider: opened
              ? openedUnreadDivider(state, opened.threadId, threadOpensUnread(opened), visibleMessages(opened), threadReadCursor(opened))
              : state.unreadDivider,
            activeView: "chat",
            selectedId: action.id,
          },
          action.id,
          "switch",
        ),
        action.id,
        (b) => ({ ...b, unread: Boolean(b.tasks?.some((task) => task.threadId !== b.threadId && task.unread)), tasks: b.tasks?.map((task) => task.threadId === b.threadId ? { ...task, unread: false } : task) }),
      );
    }
    case "answerCard": {
      if (action.groupId) return patchGroupCard(state, action.groupId, action.messageId, { answered: action.answer });
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      const card = bot?.messages.find((message) => message.id === action.messageId)?.card;
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, {
          answered: action.answer,
          ...(card?.requestId ? {} : { dismissed: true }),
        }),
        action.botId,
        "working",
      );
    }
    case "dismissCard":
      if (action.groupId) return patchGroupCard(state, action.groupId, action.messageId, { dismissed: true });
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "decideRequest":
      return state;
    case "botAdded":
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots.filter((bot) => bot.id !== action.bot.id)],
        ...(action.preserveSelection ? {} : { activeView: "chat" as const, selectedId: action.bot.id }),
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      const { [action.botId]: _deleted, ...deletingBots } = state.deletingBots;
      return reconcileModelVariantSessions({ ...state, bots, selectedId, deletingBots });
    }
    case "botDeletionPending": {
      if (action.on) {
        if (state.deletingBots[action.botId]) return state;
        return { ...state, deletingBots: { ...state.deletingBots, [action.botId]: true } };
      }
      if (!state.deletingBots[action.botId]) return state;
      const { [action.botId]: _settled, ...deletingBots } = state.deletingBots;
      return { ...state, deletingBots };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      if (!before) {
        const added = {
          ...state,
          bots: [{ ...action.bot, messages: action.bot.messages ?? [] }, ...state.bots],
        };
        return reconcileSnapshotQueues(added, [action.bot]);
      }
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const motioned = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      const animated = action.bot.busy === false && before?.busy && motioned.computerStarts[action.bot.id]
        ? reducer(motioned, { type: "computerStart", botId: action.bot.id, start: null }) : motioned;
      const next = action.bot.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.bot.id || (b.section?.trim() || "") !== (action.bot.section?.trim() || "")
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const switchedThread =
        typeof action.bot.threadId === "string" && action.bot.threadId !== before.threadId &&
        !action.bot.tasks?.some((task) => task.threadId === before.threadId);
      let switching = next;
      if (switchedThread) {
        const { [action.bot.threadId]: _stale, ...otherThreadEvents } = next.backgroundThreadEvents;
        switching = { ...next, backgroundThreadEvents: otherThreadEvents };
      }
      if ((switchedThread || (before.awaitingThreadSnapshot && action.bot.threadId === before.threadId)) &&
          Array.isArray(action.bot.messages)) {
        // The slim deletion broadcast can beat the full snapshot; later duplicate snapshots must not overwrite newer messages.
        return reducer(switching, { type: "taskSwitched", bot: { ...before, ...action.bot, computer: action.bot.computer, section: action.bot.section, toolScope: action.bot.toolScope, managedSections: action.bot.managedSections, messages: action.bot.messages, browserProfile: action.bot.browserProfile, vpsAlias: action.bot.vpsAlias } });
      }
      const patched = updateBot(switching, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        threadId: switchedThread ? action.bot.threadId : b.threadId,
        activeLeafId: switchedThread ? null : b.activeLeafId,
        awaitingThreadSnapshot: switchedThread || b.awaitingThreadSnapshot,
        browserProfile: action.bot.browserProfile,
        computer: action.bot.computer,
        toolScope: action.bot.toolScope,
        section: action.bot.section, managedSections: action.bot.managedSections,
        vpsAlias: action.bot.vpsAlias,
        tasks: action.bot.tasks ? mergeTaskStamps(b.tasks, action.bot.tasks) : b.tasks,
        messages: switchedThread ? [] : b.messages,
        hasMore: switchedThread ? undefined : b.hasMore,
      }));
      return reconcileModelVariantSessions(patched);
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId || g.tasks?.some((task) => task.threadId === action.threadId));
        if (!group) return state;
        if (group.threadId === action.threadId && group.messages.some((m) => m.id === action.message.id)) return state;
        const stamped = bumpThreadUpdatedAt(state, action.threadId, action.message.at, movesThreadToTop(action.message), action.message.turnCompletedAt ?? action.message.at);
        if (group.threadId !== action.threadId) return stamped;
        const optimisticIndex = action.message.sendId
          ? group.messages.findIndex(
              (message) => message.id === optimisticMessageId(action.message.sendId!),
            )
          : -1;
        return {
          ...stamped,
          groups: stamped.groups.map((g) =>
            g.id === group.id
              ? {
                  ...g,
                  messages: optimisticIndex >= 0
                    ? g.messages.map((message, index) =>
                        index === optimisticIndex ? action.message : message
                      )
                    : [...g.messages, action.message],
                }
              : g,
          ),
        };
      }
      if (bot.messages.some((message) => message.id === action.message.id)) return state;
      const stamped = bumpThreadUpdatedAt(state, action.threadId, action.message.at, movesThreadToTop(action.message), action.message.turnCompletedAt ?? action.message.at);
      const optimisticId = action.message.sendId
        ? optimisticMessageId(action.message.sendId)
        : null;
      const optimisticIndex = optimisticId
        ? bot.messages.findIndex((message) => message.id === optimisticId)
        : -1;
      if (optimisticIndex >= 0) {
        return updateBot(stamped, bot.id, (current) => ({
          ...current,
          messages: current.messages.map((message, index) =>
            index === optimisticIndex ? action.message : message
          ),
          activeLeafId: current.activeLeafId === optimisticId
            ? action.message.id
            : current.activeLeafId,
        }));
      }
      const next = updateBot(stamped, bot.id, (b) => {
        const adoptsLeaf = (action.message.parentId ?? null) === (b.activeLeafId ?? null);
        return { ...b, messages: [...b.messages, action.message], activeLeafId: adoptsLeaf ? action.message.id : b.activeLeafId };
      });
      const motion =
        action.message.role === "user" && action.message.kind === "text" && Boolean(action.message.queueId)
          ? "working"
          : action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      return animated;
    }
    case "optimisticMessageRemoved": {
      const id = optimisticMessageId(action.sendId);
      const remove = (messages: Message[], optimistic: Message) => messages
        .filter((message) => message.id !== id)
        .map((message) => message.optimisticThreadOrderAt === optimistic.at
          ? { ...message, optimisticThreadOrderAt: optimistic.optimisticThreadOrderAt }
          : message);
      const bot = state.bots.find((candidate) => candidate.threadId === action.threadId);
      if (bot) {
        const optimistic = bot.messages.find((message) => message.id === id);
        if (!optimistic) return state;
        const cleared = updateBot(state, bot.id, (current) => ({
          ...current,
          messages: remove(current.messages, optimistic),
          activeLeafId: current.activeLeafId === id
            ? (action.restoreLeafId !== undefined ? action.restoreLeafId : (optimistic.parentId ?? null))
            : current.activeLeafId,
        }));
        const task = bot.tasks?.find((candidate) => candidate.threadId === action.threadId);
        const kept = cleared.bots.find((candidate) => candidate.id === bot.id)?.messages ?? [];
        return rewindThreadUpdatedAt(cleared, action.threadId, kept, task?.createdAt ?? 0, bot.hasMore ? optimistic.optimisticThreadOrderAt : undefined);
      }
      const group = state.groups.find((candidate) => candidate.threadId === action.threadId);
      const optimistic = group?.messages.find((message) => message.id === id);
      if (!group || !optimistic) return state;
      const cleared = {
        ...state,
        groups: state.groups.map((candidate) => candidate.id === group.id
          ? { ...candidate, messages: remove(candidate.messages, optimistic) }
          : candidate),
      };
      const task = group.tasks?.find((candidate) => candidate.threadId === action.threadId);
      const kept = cleared.groups.find((candidate) => candidate.id === group.id)?.messages ?? [];
      return rewindThreadUpdatedAt(cleared, action.threadId, kept, task?.createdAt ?? group.createdAt, group.hasMore ? optimistic.optimisticThreadOrderAt : undefined);
    }
    case "messagePatched": {
      const stamped = movesThreadToTop(action.message) ? bumpThreadUpdatedAt(state, action.threadId, action.message.at, true, action.message.turnCompletedAt ?? action.message.at) : state;
      const bot = stamped.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = stamped.groups.find((g) => g.threadId === action.threadId);
        if (!group) return stamped;
        return {
          ...stamped,
          groups: stamped.groups.map((g) =>
            g.id === group.id
              ? { ...g, messages: g.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : g,
          ),
        };
      }
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(stamped, bot.id, motion) : stamped;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "computerStart": {
      const { [action.botId]: _ended, ...others } = state.computerStarts;
      return {
        ...(action.start ? withMascotMotion(state, action.botId, "launch") : state),
        computerStarts: action.start ? { ...others, [action.botId]: action.start } : others,
      };
    }
    case "computerControl":
      return {
        ...state,
        computerControl: {
          ...state.computerControl,
          [action.botId]: { held: action.held, helpReason: action.helpReason, help: action.help ?? null },
        },
      };
    case "modelVariantRuntime": {
      const event = action.event;
      if (!event.turnId) return state;
      const owner = state.bots.find((bot) => bot.threadId === event.threadId || bot.tasks?.some((task) => task.threadId === event.threadId));
      if (!owner) return state;
      const selection = currentTaskBot(owner, event.threadId).modelSelection;
      if (selection.instanceId !== event.providerInstanceId ||
          !state.instances.find((instance) => instance.instanceId === selection.instanceId)?.capabilities?.modelVariants) return state;
      const previous = state.modelVariantSessions[event.threadId];
      if (event.type === "turn.started") {
        if (previous && (previous.turnId === event.turnId || Date.parse(previous.startedAt) > Date.parse(event.createdAt))) return state;
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: {
          instanceId: selection.instanceId, model: selection.model, turnId: event.turnId, startedAt: event.createdAt, acceptingUpdates: true,
        } } };
      }
      if (!previous?.acceptingUpdates || previous.turnId !== event.turnId || previous.instanceId !== selection.instanceId || previous.model !== selection.model) return state;
      if (event.type === "session.model-variants" && event.model === selection.model) {
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: { ...previous, variants: event.variants } } };
      }
      if (event.type === "turn.completed") {
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: { ...previous, acceptingUpdates: false } } };
      }
      return state;
    }
    case "setModel":
      if (action.threadId) {
        const picked = reducer(state, { type: "updateTask", botId: action.botId, threadId: action.threadId,
          patch: { modelSelection: action.selection, resetApprovalToAsk: action.resetApprovalToAsk } });
        return updateBot(picked, action.botId, (bot) => ({ ...bot, tasks: bot.tasks?.map((task) => task.threadId !== action.threadId ? task
          : { ...task, followsBotModel: Boolean(action.updateBotDefault) || sameModelSelection(action.selection, bot.modelSelection) }) }));
      }
      return reconcileModelVariantSessions(updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection })));
    case "updateTask": {
      const patch = taskPatchFields(action.patch);
      return reconcileModelVariantSessions(updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? [{ threadId: bot.threadId, title: "New thread", createdAt: Date.now() }]).map((task) =>
          task.threadId === action.threadId ? { ...task, ...patch } : task),
      })));
    }
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    case "toggleSettings": {
      if (action.botId !== undefined && !state.bots.some((bot) => bot.id === action.botId && !bot.hidden)) return state;
      const selectedId = action.botId ?? state.selectedId;
      const open = action.open ?? (action.botId !== undefined || !state.settingsOpen);
      const freshOpen = open && !state.settingsOpen;
      const named = action.section !== undefined;
      return {
        ...state,
        selectedId,
        settingsOpen: open,
        activityOpen: open ? false : state.activityOpen,
        botSettingsSection: action.section ?? state.botSettingsSection,
        botSettingsExpandAccordion: open ? named || (freshOpen && state.botSettingsSectionStored) : false,
        botSettingsExpandRemembered: open ? !named && freshOpen && state.botSettingsSectionStored : false,
        botSettingsSectionStored: named || state.botSettingsSectionStored,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins": {
      const open = action.open ?? !state.pluginsOpen;
      return {
        ...state,
        pluginsOpen: open,
        pluginsSurface: action.surface ?? state.pluginsSurface,
        ...(open ? { settingsOpen: false, appSettingsOpen: false, newBotOpen: false, shortcutsOpen: false } : {}),
      };
    }
    case "botCreationPending":
      return { ...state, botCreationPending: action.on };
    case "toggleNewBot": {
      const open = action.open ?? !state.newBotOpen;
      return {
        ...state, newBotOpen: open,
        ...(open ? { settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false } : {}),
      };
    }
    case "notice":
      return { ...state, notice: action.notice };
    case "revealThread":
      return { ...state, revealThread: { threadId: action.threadId, nonce: (state.revealThread?.nonce ?? 0) + 1 } };
    case "focusMessage":
      return {
        ...state,
        focusMessage: {
          threadId: action.threadId,
          messageId: action.messageId,
          matchText: action.matchText,
          nonce: (state.focusMessage?.nonce ?? 0) + 1,
          consumed: false,
        },
      };
    case "focusMessageConsumed":
      if (!state.focusMessage || state.focusMessage.nonce !== action.nonce) return state;
      return { ...state, focusMessage: { ...state.focusMessage, consumed: true } };
    case "unreadDividerDone":
      return state.unreadDivider?.threadId === action.threadId ? { ...state, unreadDivider: null } : state;
    case "openDataResult": {
      if (!state.bots.some((bot) => bot.id === action.botId)) return state;
      const selected = reducer(reducer(state, { type: "select", id: action.botId }), { type: "toggleComputer", open: true });
      return { ...selected, dataResultFocus: { botId: action.botId, id: action.cardId, requestId: (state.dataResultFocus?.requestId ?? 0) + 1, consumed: false } };
    }
    case "dataResultFocusConsumed":
      return state.dataResultFocus?.requestId === action.requestId
        ? { ...state, dataResultFocus: { ...state.dataResultFocus, consumed: true } } : state;
    case "openSignIn": {
      if (!state.bots.some((bot) => bot.id === action.botId)) return state;
      const selected = reducer(reducer(state, { type: "select", id: action.botId }), { type: "toggleComputer", open: true });
      const { type: _, ...request } = action;
      return { ...selected, signInFocus: { ...request, requestId: (state.signInFocus?.requestId ?? 0) + 1, consumed: false } };
    }
    case "signInFocusConsumed":
      return state.signInFocus?.requestId === action.requestId
        ? { ...state, signInFocus: { ...state.signInFocus, consumed: true } } : state;
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state, selectedId: action.botId !== undefined && state.bots.some((bot) => bot.id === action.botId) ? action.botId : state.selectedId,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        activityOpen: open ? false : state.activityOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        notificationsOpen: open && !state.notificationsPinned ? false : state.notificationsOpen,
      };
    }
    case "toggleInspector": {
      const open = action.open ?? !state.inspectorOpen;
      return {
        ...state,
        inspectorOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        activityOpen: open ? false : state.activityOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        notificationsOpen: open && !state.notificationsPinned ? false : state.notificationsOpen,
      };
    }
    case "toggleActivity": {
      const open = action.open ?? !state.activityOpen;
      return {
        ...state,
        activityOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        notificationsOpen: open && !state.notificationsPinned ? false : state.notificationsOpen,
      };
    }
    case "toggleNotifications": {
      const open = action.open ?? !state.notificationsOpen;
      return {
        ...state,
        notificationsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        activityOpen: open ? false : state.activityOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleNotificationsPinned":
      return { ...state, notificationsPinned: action.pinned ?? !state.notificationsPinned };
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        activityOpen: open ? false : state.activityOpen,
        appSettingsSection: action.section ?? state.appSettingsSection,
        appSettingsCloudLink: action.cloudLink && open ? state.appSettingsCloudLink + 1 : 0,
        appSettingsPhonePairing: action.phonePairing && open ? state.appSettingsPhonePairing + 1 : 0,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
        notificationsOpen: open && !state.notificationsPinned ? false : state.notificationsOpen,
      };
    }
    case "toggleShortcuts": {
      const open = action.open ?? !state.shortcutsOpen;
      return {
        ...state,
        shortcutsOpen: open,
      };
    }
    case "openCloudAdd":
      return { ...state, cloudAdd: state.cloudAdd ?? { source: action.source, ...(action.signIn ? { signIn: true as const } : {}) }, cloudHowTo: false };
    case "closeCloudAdd":
      return state.cloudAdd ? { ...state, cloudAdd: null } : state;
    case "cloudHowTo":
      return state.cloudHowTo === action.open ? state : { ...state, cloudHowTo: action.open };
    case "toggleTour": {
      const open = action.open ?? !state.tourOpen;
      return { ...state, tourOpen: open, appSettingsOpen: open ? false : state.appSettingsOpen };
    }
    case "toggleWelcome": {
      const open = action.open ?? !state.welcomeOpen;
      return {
        ...state,
        welcomeOpen: open,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        shortcutsOpen: open ? false : state.shortcutsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const animated = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      const target = animated.bots.find((bot) => bot.id === action.botId);
      const chiefSection = (action.patch.section ?? target?.section)?.trim() || "";
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.botId || (b.section?.trim() || "") !== chiefSection
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const {
        acknowledgeLocalAuto: _localAck,
        applyToAllThreads: _allThreads,
        keepThreadModels: _keepThreadModels, threadId: _threadId,
        computer,
        connectorTools,
        connectorScopes,
        ...rest
      } = action.patch;
      const botPatch: Partial<Bot> = { ...rest };
      if (computer === null) botPatch.computer = undefined;
      else if (computer !== undefined) botPatch.computer = computer;
      if (connectorTools === null) botPatch.connectorTools = undefined;
      else if (connectorTools !== undefined) botPatch.connectorTools = connectorTools;
      if (connectorScopes === null) botPatch.connectorScopes = undefined;
      else if (connectorScopes !== undefined) botPatch.connectorScopes = connectorScopes;
      return updateBot(next, action.botId, (b) => ({ ...b, ...botPatch }));
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(bumpTranscriptGeneration(state, action.threadId), bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(bumpTranscriptGeneration(state, bot.threadId), action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    case "patchGroup":
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.patch } : g)),
      };
    case "pendingQueued": {
      if (state.consumedQueueIds[action.queueId]) {
        const consumedQueueIds = { ...state.consumedQueueIds };
        delete consumedQueueIds[action.queueId];
        return { ...state, consumedQueueIds };
      }
      const prev = state.pendingQueued[action.threadId] ?? [];
      if (prev.some((entry) => entry.queueId === action.queueId)) return state;
      return {
        ...state,
        pendingQueued: {
          ...state.pendingQueued,
          [action.threadId]: [...prev, { queueId: action.queueId, text: action.text, ...(action.reason ? { reason: action.reason } : {}) }],
        },
      };
    }
    case "consumePendingQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const at = prev.findIndex((entry) => entry.queueId === action.queueId);
      if (at < 0) {
        return {
          ...state,
          consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId),
        };
      }
      const rest = prev.filter((_, i) => i !== at);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued, consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId) };
    }
    case "cancelQueued": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      if (!bot) return state;
      const threadId = action.threadId ?? bot.threadId;
      const prev = state.pendingQueued[threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[threadId] = rest;
      else delete pendingQueued[threadId];
      return { ...state, pendingQueued, consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId) };
    }
    case "steerQueued":
      return state;
    case "cancelGroupQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      if (rest.length === prev.length) return state;
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
    case "send": {
      const animated = withMascotMotion(
        dismissOnboardingCard(state, action.botId),
        action.botId,
        "working",
      );
      if (!action.sendId) return animated;
      const bot = animated.bots.find((candidate) => candidate.id === action.botId);
      const threadId = action.threadId ?? bot?.threadId;
      if (!bot || threadId !== bot.threadId) return animated;
      if (bot.messages.some((message) => message.sendId === action.sendId)) return animated;
      const message = optimisticUserMessage(
        action.text,
        action.sendId,
        action.replyToId,
        bot.activeLeafId,
      );
      message.optimisticThreadOrderAt = bot.tasks?.find((task) => task.threadId === threadId)?.lastThreadOrderAt;
      return bumpThreadUpdatedAt(updateBot(animated, bot.id, (current) => ({
        ...current,
        messages: [...current.messages, message],
        activeLeafId: message.id,
      })), threadId, message.at, true);
    }
    case "editMessage": {
      const animated = withMascotMotion(state, action.botId, "working");
      if (!action.sendId) return animated;
      const bot = animated.bots.find((candidate) => candidate.id === action.botId);
      const threadId = action.threadId ?? bot?.threadId;
      if (!bot || threadId !== bot.threadId) return animated;
      if (bot.messages.some((message) => message.sendId === action.sendId)) return animated;
      const source = bot.messages.find((message) => message.id === action.messageId);
      if (!source || source.role !== "user" || source.kind !== "text") return animated;
      const message = optimisticUserMessage(
        action.text.trim(),
        action.sendId,
        source.replyToId,
        source.parentId ?? null,
      );
      message.optimisticThreadOrderAt = bot.tasks?.find((task) => task.threadId === threadId)?.lastThreadOrderAt;
      return bumpThreadUpdatedAt(updateBot(animated, bot.id, (current) => ({
        ...current,
        messages: [...current.messages, message],
        activeLeafId: message.id,
      })), threadId, message.at, true);
    }
    case "deleteTask":
    case "newGroupTask":
    case "switchGroupTask":
    case "deleteGroupTask":
    case "regenerateTaskTitle":
      return state;
    case "newTask":
      return action.cwd !== undefined ? state : { ...state, selectedId: action.botId, activeView: "chat" };
    case "switchTask": {
      const { [action.threadId]: _old, ...backgroundThreadEvents } = state.backgroundThreadEvents;
      return updateBot({ ...state, backgroundThreadEvents, selectedId: action.botId, activeView: "chat" }, action.botId,
        (bot) => ({ ...bot, switchingTo: action.threadId }));
    }
    case "switchTaskFailed":
      return updateBot(state, action.botId, (bot) => bot.switchingTo === action.threadId ? { ...bot, switchingTo: undefined } : bot);
    case "renameTask":
      return updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? []).map((task) =>
          task.threadId === action.threadId ? { ...task, title: action.title } : task,
        ),
      }));
    case "renameGroupTask":
      return patchGroupTask(state, action.groupId, action.threadId, { title: action.title });
    case "pinGroupTask":
      return patchGroupTask(state, action.groupId, action.threadId, { pinned: action.pinned ? true : undefined });
    case "setConversationTurnLimit":
      if (!action.dm) return patchGroupTask(state, action.groupId, action.threadId, { turnTimeoutMinutes: action.minutes ?? undefined });
      return { ...state, groups: state.groups.map((group) => group.id === action.groupId ? { ...group, turnTimeoutMinutes: action.minutes ?? undefined } : group) };
    case "taskSwitched": {
      let switched = updateBot(bumpTranscriptGeneration(state, action.bot.threadId), action.bot.id, (bot) => ({
        ...bot,
        ...action.bot,
        computer: action.bot.computer,
        toolScope: action.bot.toolScope, managedSections: action.bot.managedSections,
        vpsAlias: action.bot.vpsAlias,
        messages: action.bot.messages ?? [],
        hasMore: action.bot.hasMore,
        awaitingThreadSnapshot: false,
        switchingTo: undefined,
      }));
      for (const frame of state.backgroundThreadEvents[action.bot.threadId] ?? []) switched = reducer(switched, frame);
      const { [action.bot.threadId]: _settled, ...backgroundThreadEvents } = switched.backgroundThreadEvents;
      switched = { ...switched, backgroundThreadEvents };
      const opened = switched.bots.find((bot) => bot.id === action.bot.id);
      if (opened && opened.id === switched.selectedId) {
        switched = { ...switched, unreadDivider: openedUnreadDivider(switched, opened.threadId, threadOpensUnread(opened), visibleMessages(opened), threadReadCursor(opened)) };
        if (switched.activeView === "chat") switched = updateBot(switched, opened.id, (bot) => ({ ...bot,
          unread: Boolean(bot.tasks?.some((task) => task.threadId !== bot.threadId && task.unread)),
          tasks: bot.tasks?.map((task) => task.threadId === bot.threadId ? { ...task, unread: false } : task) }));
      }
      return reconcileModelVariantSessions(reconcileSnapshotQueues(switched, [action.bot]));
    }
    case "newBot":
    case "duplicateBot":
    case "createProject":
    case "updateProject":
    case "deleteProject":
    case "reorderProjects":
    case "interrupt":
    case "createGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "setGroupHold":
    case "steerGroupQueued":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "cancelRoutineRun":
    case "markRoutineRunSeen":
    case "markAllRoutineRunsSeen":
    case "refreshTaskPermissions":
    case "followBotModel":
    case "loadDataSheet":
      return state;
    case "dataSheet":
      return {
        ...state,
        dataSheets: { ...state.dataSheets, [action.sheet.botId]: action.sheet },
        ...(action.tables ? { dataTables: { ...state.dataTables, [action.sheet.botId]: action.tables } } : {}),
      };
    case "dataView":
      return { ...state, dataView: action.view };
    case "sendGroup": {
      if (!action.sendId) return state;
      const group = state.groups.find((candidate) => candidate.id === action.groupId);
      if (!group) return state;
      const threadId: string = action.threadId ?? group.threadId;
      if (threadId === group.threadId && group.messages.some((message) => message.sendId === action.sendId)) return state;
      const message = optimisticUserMessage(
        action.text,
        action.sendId,
        action.replyToId,
        null,
        action.mode ?? "chat",
      );
      message.optimisticThreadOrderAt = group.tasks?.find((task) => task.threadId === threadId)?.lastThreadOrderAt;
      const stamped = bumpThreadUpdatedAt(state, threadId, message.at, threadId === group.threadId);
      if (threadId !== group.threadId) return stamped;
      return {
        ...stamped,
        groups: stamped.groups.map((candidate) => candidate.id === group.id
          ? { ...candidate, messages: [...candidate.messages, message] }
          : candidate),
      };
    }
  }
}

  export function dataTablesFromResponse(body: unknown): DataTable[] {
  const tables = body && typeof body === "object" && "tables" in body ? (body as { tables: unknown }).tables : undefined;
  return Array.isArray(tables) ? (tables as DataTable[]).filter((table) => table && typeof table.name === "string") : [];
}

export function dataSheetFromResponse(body: unknown, botId: string): DataSheet {
  const candidate = body && typeof body === "object" && "sheet" in body ? (body as { sheet: unknown }).sheet : body;
  if (candidate && typeof candidate === "object" && Array.isArray((candidate as DataSheet).cards)) {
    const sheet = candidate as DataSheet;
    return { ...sheet, botId: sheet.botId || botId, sources: Array.isArray(sheet.sources) ? sheet.sources : [] };
  }
  return { version: 1, botId, cards: [], sources: [], updatedAt: new Date(0).toISOString() };
}

export const initialState: AppState = {
  modelVariantSessions: {},
  backgroundThreadEvents: {},
  loadingOlder: {},
  transcriptGeneration: {},
  bots: [],
  groups: [],
  sections: [],
  instances: [],
  config: null,
  liveCall: null,
  liveCallVersion: 0,
  liveCallLookupSeq: 0,
  selectedId: "",
  activeView: "chat",
  routines: [],
  routineRuns: [],
  routinesLoadState: "loading",
  routinesFocus: { nonce: 0 },
  filesSuggest: null,
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  settingsOpen: false,
  pluginsOpen: false,
  pluginsSurface: "apps",
  newBotOpen: false,
  botCreationPending: false,
  computerOpen: false,
  inspectorOpen: false,
  activityOpen: false,
  notificationsOpen: false,
  notificationsPinned: false,
  notifications: [],
  appSettingsOpen: false,
  appSettingsSection: "general",
  appSettingsCloudLink: 0,
  appSettingsPhonePairing: 0,
  shortcutsOpen: false,
  cloudAdd: null,
  cloudHowTo: false,
  welcomeOpen: false,
  tourOpen: false,
  botSettingsSection: "overview",
  botSettingsExpandAccordion: false,
  botSettingsSectionStored: false,
  botSettingsExpandRemembered: false,
  computerStarts: {},
  deletingBots: {},
  computerControl: {},
  dataSheets: {},
  dataTables: {},
  dataResultFocus: null,
  signInFocus: null,
  dataView: null,
  focusMessage: null,
  unreadDivider: null,
  connected: false,
  error: null,
  notice: null,
  revealThread: null,
  mascotMotion: null,
  pendingQueued: {},
  consumedQueueIds: {},
};

  export function liveCallFromFrame(frame: unknown): { call: LiveCallState | null } | null {
  if (!frame || typeof frame !== "object" || !Object.prototype.hasOwnProperty.call(frame, "call")) return null;
  const call: unknown = Reflect.get(frame, "call");
  if (call === null) return { call: null };
  if (!call || typeof call !== "object") return null;
  const record = call as Record<string, unknown>;
  if (typeof record.callId !== "string" || typeof record.botId !== "string" || typeof record.threadId !== "string" || typeof record.status !== "string") {
    return null;
  }
  return { call: call as LiveCallState };
}

let liveCallLookups = 0;
 export function nextLiveCallLookup(): number {
  liveCallLookups += 1;
  return liveCallLookups;
}

export { api, ApiError };

 export async function createBotWithRole(role?: BotRole, request: typeof api = api, visibility?: BotVisibility, section?: string): Promise<{ bot: Bot; profileError?: string }> {
  const restricted = visibility && visibility !== "everyone" ? { visibility } : {};
  const fields = { ...(role ? { name: role.name, title: role.title, description: role.description } : {}), ...restricted,
    ...(section !== undefined ? { section } : {}) };
  const { bot } = await request("/api/bots", {
    method: "POST",
    ...(Object.keys(fields).length ? { body: JSON.stringify(fields) } : {}),
  });
  if (!role) return { bot };
  try {
    const { bot: patched } = await request(`/api/bots/${bot.id}`, {
      method: "PATCH", body: JSON.stringify(roleProfilePatch(role)),
    });
    return { bot: { ...bot, ...patched, messages: bot.messages } };
  } catch (error) {
    return { bot, profileError: error instanceof Error ? error.message : String(error) };
  }
}

 export const MESSAGE_PAGE_SIZE = 200;


type TrustedApprovalBridge = {
  setMode(
    botId: string,
    mode: ApprovalMode,
    options?: { acknowledgeLocalAuto?: boolean; threadId?: string; threadOnly?: boolean; allThreads?: boolean; refreshPermissions?: boolean },
  ): Promise<BotAnnouncement>;
};

 export function desktopApprovalBridge(): TrustedApprovalBridge | undefined {
  if (typeof window === "undefined" || !window.ogb?.approvals) return undefined;
  return desktopCapabilitiesNow().host.packaged ? window.ogb.approvals : undefined;
}

 export async function persistTaskApproval(
  botId: string, threadId: string, patch: TaskUpdatePatch,
  bridge: TrustedApprovalBridge | undefined,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }> = api,
): Promise<BotAnnouncement> {
  const { approvalMode, autoApprove, acknowledgeLocalAuto, ...ordinary } = patch;
  const mode = approvalMode ?? (autoApprove === undefined ? undefined : autoApprove ? "auto" : "ask");
  if (mode === "custom" && !bridge) throw new Error("This approval change requires the packaged desktop app");
  if (mode && bridge) {
    if (Object.keys(ordinary).length) await request(`/api/bots/${botId}/tasks/${threadId}`, { method: "PATCH", body: JSON.stringify(ordinary) });
    return bridge.setMode(botId, mode, { threadId, threadOnly: true, acknowledgeLocalAuto: acknowledgeLocalAuto === true });
  }
  const result = await request(`/api/bots/${botId}/tasks/${threadId}`, { method: "PATCH", body: JSON.stringify({ ...ordinary, approvalMode, autoApprove, acknowledgeLocalAuto }) });
  return result.bot;
}

 export async function persistBotUpdate(
  botId: string,
  patch: BotUpdatePatch,
  signal: AbortSignal,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }> = api,
  trustedApprovals: TrustedApprovalBridge | undefined = desktopApprovalBridge(),
  currentBot?: BotAnnouncement,
): Promise<BotAnnouncement> {
  const {
    approvalMode,
    applyToAllThreads,
    ...ordinaryPatch
  } = patch;
  const leavesCustom = approvalMode !== undefined && approvalMode !== "custom" &&
    (approvalModeFor(currentBot ?? {}) === "custom" ||
      (applyToAllThreads === true && threadApprovalModes(currentBot ?? {}).includes("custom")));
  const viaBridge = approvalMode === "custom" || leavesCustom ||
    (approvalMode === "full" && trustedApprovals !== undefined);

  if (!viaBridge) {
    const result = await request(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(
        approvalMode === undefined ? ordinaryPatch : {
          ...ordinaryPatch,
          approvalMode,
          ...(applyToAllThreads ? { applyToAllThreads: true } : {}),
        },
      ),
      signal,
    });
    return result.bot;
  }

  if (!trustedApprovals || approvalMode === undefined) {
    throw new Error("This approval-level change requires the packaged desktop app");
  }

  const trustedOptions = {
    acknowledgeLocalAuto: ordinaryPatch.acknowledgeLocalAuto === true,
    ...(applyToAllThreads ? { allThreads: true } : {}),
  };

  const rejectCancelledTrustedGrant = async () => {
    if (!signal.aborted) return;
    if (approvalMode === "full" || approvalMode === "custom") {
      try {
        await trustedApprovals.setMode(botId, "ask", { acknowledgeLocalAuto: false, ...(applyToAllThreads ? { allThreads: true } : {}) });
      } catch (error) {
        throw new Error(
          `The cancelled ${approvalMode === "full" ? "Full access" : "Custom approval"} grant could not be revoked: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    throw new DOMException("The bot update was cancelled", "AbortError");
  };

  if (leavesCustom) {
    const modeBot = await trustedApprovals.setMode(botId, approvalMode, trustedOptions);
    await rejectCancelledTrustedGrant();
    if (Object.keys(ordinaryPatch).length === 0) return modeBot;
    const result = await request(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(ordinaryPatch),
      signal,
    });
    return result.bot;
  }

  if (Object.keys(ordinaryPatch).length > 0) {
    await request(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(ordinaryPatch),
      signal,
    });
  }
  if (signal.aborted) throw new DOMException("The bot update was cancelled", "AbortError");
  const modeBot = await trustedApprovals.setMode(botId, approvalMode, trustedOptions);
  await rejectCancelledTrustedGrant();
  return modeBot;
}

 const pendingBotDeletions = new Map<string, Promise<void>>();

export async function requestConfirmedBotDeletion<Answer>(
  botId: string,
  requestDelete: (botId: string) => Promise<Answer>,
  onConfirmed: (botId: string, answer: Answer) => void,
): Promise<void> {
  const existing = pendingBotDeletions.get(botId);
  if (existing) return existing;
  const deletion = (async () => {
    onConfirmed(botId, await requestDelete(botId));
  })();
  pendingBotDeletions.set(botId, deletion);
  try {
    await deletion;
  } finally {
    if (pendingBotDeletions.get(botId) === deletion) pendingBotDeletions.delete(botId);
  }
}

export interface PeripheralSnapshotLoad<Key extends string = string> {
  key: Key;
  load: () => Promise<void>;
}

function normalizeSnapshotFailure(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

 export async function loadSnapshotBoundary<Key extends string>(
  loadChat: () => Promise<void>,
  peripherals: readonly PeripheralSnapshotLoad<Key>[],
  onPeripheralFailure: (part: PeripheralSnapshotLoad<Key>, error: Error) => void,
): Promise<boolean> {
  const [chat, ...settledPeripherals] = await Promise.allSettled([
    loadChat(),
    ...peripherals.map((part) => part.load()),
  ]);
  settledPeripherals.forEach((result, index) => {
    if (result.status === "rejected") {
      onPeripheralFailure(peripherals[index]!, normalizeSnapshotFailure(result.reason));
    }
  });
  return chat.status === "fulfilled";
}

 export function runtimeFrameAction(event: RuntimeEvent): Action | null {
  return event.type === "turn.started" || event.type === "session.model-variants" || event.type === "turn.completed"
    ? { type: "modelVariantRuntime", event }
    : null;
}

export const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  flushBotPatches: (botId: string) => Promise<BotAnnouncement | null>;
  refreshInstances: (options?: { reportErrors?: boolean }) => Promise<void>;
  refreshModels: (instanceId: string) => Promise<void>;
} | null>(null);

 function restoreBotSettingsSection(state: AppState): AppState {
  const section = readLastBotSection();
  return section ? { ...state, botSettingsSection: section, botSettingsSectionStored: true } : state;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const taskWrites = useRef(new Map<string, { botId: string; updatesDefault: boolean; promise: Promise<BotAnnouncement>; execution: Promise<unknown>; patch: TaskUpdatePatch }>()).current;
  const withTaskWrites = (bot: BotAnnouncement): BotAnnouncement => ({
    ...bot,
    tasks: bot.tasks?.map((task) => ({ ...task, ...taskPatchFields(taskWrites.get(task.threadId)?.patch ?? {}) })),
  });
  const [state, rawDispatch] = useReducer(reducer, initialState, restoreBotSettingsSection);
  const stateRef = useRef(state);
  stateRef.current = state;
  const showThreads = useShowThreads();
  const showThreadsRef = useRef(showThreads);
  showThreadsRef.current = showThreads;
  const clearChatError = useCallback(() => {
    rawDispatch({ type: "error", message: null });
  }, []);
  useChatErrorClear(state.error, clearChatError);
  useEffect(() => {
    if (state.selectedId) rememberConversation(state.selectedId);
  }, [state.selectedId]);
  useEffect(() => {
    if (state.settingsOpen && state.botSettingsExpandAccordion) rememberBotSection(state.botSettingsSection);
  }, [state.settingsOpen, state.botSettingsExpandAccordion, state.botSettingsSection]);
  const botPatchQueue = useMemo(
    () =>
      createBotPatchQueue({
        send: (botId, patch, signal, currentBot) =>
          persistBotUpdate(botId, patch, signal, api, desktopApprovalBridge(), currentBot),
        reconcile: async (botId, signal) => {
          const result: { bots: BotAnnouncement[] } = await api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`, { signal });
          return result.bots.find((candidate) => candidate.id === botId) ?? null;
        },
        onAuthoritative: (bot, optimisticOverlay) => {
          rawDispatch({ type: "botPatched", bot: withTaskWrites({ ...bot, ...optimisticOverlay }) });
        },
        onError: (error) => {
          rawDispatch({ type: "error", message: error.message });
        },
      }),
    [],
  );

  useEffect(() => {
    botPatchQueue.revive();
    return () => botPatchQueue.dispose();
  }, [botPatchQueue]);

  const dispatch = useMemo(() => {
    const navigation = new Map<string, number>();
    let selectionRevision = 0;
    const olderPagesInFlight = new Set<string>();
    let creatingBot = false;
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
    };
    const showSavedState = (owner: SavedOwner) => (error: unknown) => {
      showError(error);
      void api<SavedSnapshot>("/api/bots?messages=0").then((snapshot) => {
        const saved = savedStateAction(owner, snapshot);
        if (saved?.type === "botPatched") rawDispatch({ ...saved, bot: withTaskWrites({ ...saved.bot, ...botPatchQueue.overlayFor(saved.bot.id) }) });
        else if (saved) rawDispatch(saved);
      }).catch(() => {});
    };
    const cardTarget = (action: { botId: string; messageId: string; groupId?: string }) => {
      const host = action.groupId
        ? stateRef.current.groups.find((g) => g.id === action.groupId)
        : stateRef.current.bots.find((b) => b.id === action.botId);
      return { host, card: host?.messages.find((m) => m.id === action.messageId)?.card, inRoom: !!action.groupId };
    };
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const waitForExecutionSettings = async (expectedBots: Bot[], threadId?: string) => {
      // Capture this send's task save before waiting on slower profile saves.
      const taskWrite = threadId ? taskWrites.get(threadId)?.execution : undefined;
      const defaultWrites = [...taskWrites.values()].filter((write) => write.updatesDefault && expectedBots.some((bot) => bot.id === write.botId));
      await Promise.all([taskWrite, ...defaultWrites.map((write) => write.execution), ...expectedBots.map(async (expected) => {
        const persisted = await botPatchQueue.flush(expected.id);
        if (!persisted) return;
        const expectedSelection = expected.modelSelection;
        if (
          approvalModeFor(persisted) !== approvalModeFor(expected) ||
          (persisted.memoryEnabled !== false) !== (expected.memoryEnabled !== false) ||
          persisted.modelSelection.instanceId !== expectedSelection.instanceId ||
          persisted.modelSelection.model !== expectedSelection.model ||
          persisted.modelSelection.effort !== expectedSelection.effort ||
          persisted.modelSelection.variant !== expectedSelection.variant
        ) {
          throw new Error("The approval level, memory setting, or model could not be saved, so this work was not started");
        }
      })]);
      if (threadId) await taskWrites.get(threadId)?.execution;
    };

    const persistTaskPatch = (botId: string, threadId: string, patch: TaskUpdatePatch) => {
      const previous = taskWrites.get(threadId);
      const defaults = patch.updateBotDefault || patch.approvalMode !== undefined
        ? [...taskWrites.values()].filter((write) => write.botId === botId) : [];
      const promise = Promise.all([previous?.promise, ...defaults.map((write) => write.promise)].map((save) => save?.catch(() => {})))
        .then(async () => {
          if (patch.resetApprovalToAsk && window.ogb?.approvals) {
            return window.ogb.approvals.setMode(botId, "ask", {
              threadId, modelSelection: patch.modelSelection, updateBotDefault: Boolean(patch.updateBotDefault),
            });
          }
          return persistTaskApproval(botId, threadId, patch, desktopApprovalBridge());
        });
      const execution = Promise.all([previous?.execution, promise]);
      void execution.catch(() => {});
      const pending = { botId, updatesDefault: Boolean(patch.updateBotDefault || previous?.updatesDefault), patch: { ...previous?.patch, ...patch }, promise, execution };
      taskWrites.set(threadId, pending);
      void pending.promise.then((bot) => {
        if (taskWrites.get(threadId) !== pending) return;
        taskWrites.delete(threadId);
        if (bot) rawDispatch({ type: "botPatched", bot: withTaskWrites(bot) });
      }).catch((error) => {
        showError(error);
        if (taskWrites.get(threadId) === pending) {
          pending.patch = {};
          void api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`).then(({ bots }) => {
            if (taskWrites.get(threadId) !== pending) return;
            const bot = bots.find((candidate: Bot) => candidate.id === botId);
            if (bot) {
              rawDispatch({ type: "botPatched", bot: withTaskWrites(bot) });
              taskWrites.delete(threadId);
            }
          }).catch(() => {});
        }
      });
    };

    const executionBotsForThread = (threadId: string): Bot[] => {
      const snapshot = stateRef.current;
      const botIds = new Set<string>();
      for (const bot of snapshot.bots) {
        if (bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId)) {
          botIds.add(bot.id);
        }
      }
      for (const group of snapshot.groups) {
        if (group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId)) {
          for (const memberId of group.memberIds) botIds.add(memberId);
        }
      }
      return snapshot.bots.filter((bot) => botIds.has(bot.id));
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      if (["select", "newTask", "switchTask", "newGroupTask", "switchGroupTask", "showChat", "showRoutines", "showTeamMap", "showFiles"].includes(action.type)) selectionRevision++;
      // Pin before any await or optimistic state change.
      action = pinBotThreadAction(action, stateRef.current.bots);
      if (action.type === "taskSwitched") action = { ...action, bot: withTaskWrites(action.bot) as Bot };
      if (action.type === "botPatched") action = { ...action, bot: withTaskWrites(action.bot) };
      if ((action.type === "send" || action.type === "sendGroup" || action.type === "editMessage") && !action.sendId) {
        action = { ...action, sendId: crypto.randomUUID() };
      }
      const botBeforeUpdate =
        action.type === "updateBot" || action.type === "setModel"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const botBeforeSend =
        action.type === "send"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const leafBeforeEdit =
        action.type === "editMessage"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)?.activeLeafId ?? null
          : null;
      const executionBotsBeforeAction = (() => {
        if (action.type === "editMessage" || action.type === "answerCard") {
          const bot = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
          return bot ? [bot] : [];
        }
        if (action.type === "decideRequest") {
          const bots = executionBotsForThread(action.threadId);
          if (!action.alwaysAllow || bots.some((bot) => bot.id === action.alwaysAllow?.botId)) {
            return bots;
          }
          const grantBot = stateRef.current.bots.find((bot) => bot.id === action.alwaysAllow?.botId);
          return grantBot ? [...bots, grantBot] : bots;
        }
        if (action.type === "sendGroup") {
          const memberIds = stateRef.current.groups.find((group) => group.id === action.groupId)?.memberIds ?? [];
          return stateRef.current.bots.filter((candidate) => memberIds.includes(candidate.id));
        }
        if (action.type === "runRoutine") {
          const routine = stateRef.current.routines.find((candidate) => candidate.id === action.routineId);
          if (!routine) return [];
          const ids = new Set([routine.botId]);
          if (routine.target === "room-goal" && routine.groupId) {
            const group = stateRef.current.groups.find((candidate) => candidate.id === routine.groupId);
            for (const memberId of group?.memberIds ?? []) ids.add(memberId);
          }
          return stateRef.current.bots.filter((candidate) => ids.has(candidate.id));
        }
        return [];
      })();
      const quizBeforeSend = (() => {
        if (action.type !== "send") return undefined;
        return botBeforeSend ? openOnboardingCard(botBeforeSend) : undefined;
      })();
      if (
        action.type !== "cancelQueued" &&
        action.type !== "cancelGroupQueued" &&
        action.type !== "deleteBot"
      ) rawDispatch(action);
      switch (action.type) {
        case "loadOlderMessages": {
          if (olderPagesInFlight.has(action.threadId)) break;
          olderPagesInFlight.add(action.threadId);
          const current = stateRef.current;
          const owner = [...current.bots, ...current.groups].find((candidate) => candidate.threadId === action.threadId);
          const before = owner?.messages[0]?.id;
          const generation = current.transcriptGeneration[action.threadId] ?? 0;
          if (!before) {
            olderPagesInFlight.delete(action.threadId);
            rawDispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: false });
            break;
          }
          api<{ messages: Message[]; hasMore?: boolean }>(
            `/api/threads/${action.threadId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`,
          )
            .finally(() => olderPagesInFlight.delete(action.threadId))
            .then((page) => rawDispatch({
              type: "olderMessages",
              threadId: action.threadId,
              generation,
              messages: page.messages ?? [],
              hasMore: Boolean(page.hasMore),
            }))
            .catch((error) => {
              rawDispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: true });
              showError(error);
            });
          break;
        }
        case "notice":
          if (action.notice) setTimeout(() => rawDispatch({ type: "notice", notice: null }), action.notice.kind === "note" ? 20_000 : 6000);
          break;
        case "createRoutine":
          api("/api/routines", { method: "POST", body: JSON.stringify(action.input) }).catch(showError);
          break;
        case "updateRoutine":
          api(`/api/routines/${action.routineId}`, { method: "PATCH", body: JSON.stringify(action.patch) })
            .then(({ routine }) => rawDispatch({ type: "routinePatched", routine }), showError);
          break;
        case "deleteRoutine":
          api(`/api/routines/${action.routineId}`, { method: "DELETE" }).catch(showError);
          break;
        case "runRoutine":
          void waitForExecutionSettings(executionBotsBeforeAction)
            .then(() => api(`/api/routines/${action.routineId}/run`, { method: "POST" }))
            .then(({ run }) => action.onStarted?.(run))
            .catch((error) => {
              if (action.onError) action.onError(error);
              else showError(error);
            })
            .finally(() => action.onSettled?.());
          break;
        case "cancelRoutineRun":
          api(`/api/routine-runs/${action.runId}/cancel`, { method: "POST" }).catch(showError);
          break;
        case "loadDataSheet":
          api(DATA_ROUTES.sheet(action.botId))
            .then((body) => rawDispatch({ type: "dataSheet", sheet: dataSheetFromResponse(body, action.botId), tables: dataTablesFromResponse(body) }))
            .catch((error) => (action.onError ?? showError)(error instanceof Error ? error.message : String(error)));
          break;
        case "markRoutineRunSeen":
          api(`/api/routine-runs/${action.runId}/seen`, { method: "POST" }).catch(showError);
          break;
        case "markAllRoutineRunsSeen":
          api("/api/routine-runs/seen-all", { method: "POST" }).catch(showError);
          break;
        case "cancelQueued":
          void api(`/api/bots/${action.botId}/queue/${action.queueId}`, { method: "DELETE", body: JSON.stringify({ threadId: action.threadId }) })
            .then(() => {
              rawDispatch(action);
              action.onCancelled?.();
            })
            .catch(showError);
          break;
        case "steerQueued":
          void api(`/api/bots/${action.botId}/queue/${action.queueId}/steer`, { method: "POST", body: JSON.stringify({ threadId: action.threadId }) })
            .then((body) => {
              if (body?.steered === true && Array.isArray(body.messages) && typeof body.threadId === "string") {
                for (const message of body.messages) {
                  rawDispatch({ type: "messageAdded", threadId: body.threadId, message });
                }
                for (const queueId of body.queueIds ?? []) {
                  rawDispatch({ type: "consumePendingQueued", threadId: body.threadId, queueId });
                }
              } else if (body?.queued === true && body.blockedBy === "images") {
                wrapped({ type: "notice", notice: { kind: "steer-images", botName: null } });
              }
              action.onSettled?.();
            })
            .catch((error) => {
              showError(error);
              action.onError?.();
            });
          break;
        case "cancelGroupQueued":
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}`, { method: "DELETE" })
            .then(() => {
              rawDispatch(action);
              action.onCancelled?.();
            })
            .catch(showError);
          break;
        case "steerGroupQueued":
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}/steer`, {
            method: "POST",
            body: JSON.stringify({ threadId: action.threadId }),
          })
            .then((body) => {
              if (body?.steered === true && Array.isArray(body.messages) && typeof body.threadId === "string") {
                for (const message of body.messages) {
                  rawDispatch({ type: "messageAdded", threadId: body.threadId, message });
                }
                for (const queueId of body.queueIds ?? []) {
                  rawDispatch({ type: "consumePendingQueued", threadId: body.threadId, queueId });
                }
              } else if (body?.queued === true && body.blockedBy === "images") {
                wrapped({ type: "notice", notice: { kind: "steer-images", botName: null } });
              }
              action.onSettled?.();
            })
            .catch((error) => {
              showError(error);
              action.onError?.();
            });
          break;
        case "send": {
          if (quizBeforeSend) persistCard(action.botId, quizBeforeSend.id, { dismissed: true });
          const threadId =
            action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void waitForExecutionSettings(botBeforeSend ? [botBeforeSend] : [], threadId)
            .then(() => api(`/api/bots/${action.botId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.text, replyToId: action.replyToId, threadId, sendId, ...(action.dataContext ? { dataContext: action.dataContext } : {}), ...(action.pointed?.length ? { pointed: action.pointed } : {}) }),
              }))
            .then((body) => {
              if (body?.message && typeof body.threadId === "string") {
                rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
              }
              if (
                body?.queued &&
                typeof body.threadId === "string" &&
                typeof body.queueId === "string"
              ) {
                rawDispatch({
                  type: "optimisticMessageRemoved",
                  threadId: body.threadId,
                  sendId,
                });
                rawDispatch({
                  type: "pendingQueued",
                  threadId: body.threadId,
                  queueId: body.queueId,
                  text: action.text,
                  reason: body.reason === "capacity" || body.reason === "group-turn" ? body.reason : undefined,
                });
              }
            })
            .catch((error) => {
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId });
              }
              showError(error);
              action.onError?.();
            });
          break;
        }
        case "editMessage": {
          const threadId =
            action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void waitForExecutionSettings(executionBotsBeforeAction, threadId)
            .then(() => api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
              method: "POST",
              body: JSON.stringify({ text: action.text.trim(), threadId, sendId }),
            }))
            .then((body) => {
              if (body?.message && threadId) {
                rawDispatch({ type: "messageAdded", threadId, message: body.message });
              }
            })
            .catch((error) => {
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId, restoreLeafId: leafBeforeEdit });
              }
              showError(error);
            });
          break;
        }
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId, threadId: action.threadId }),
          }).catch(showError);
          break;
        case "decideRequest": {
          const respond = () =>
            api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: action.requestId,
                behavior: action.behavior,
                message: action.message,
                reviewedSha256: action.reviewedSha256,
                always: action.always,
                rememberCommand: action.rememberCommand,
              }),
            });
          void waitForExecutionSettings(executionBotsBeforeAction, action.threadId)
            .then(async () => {
              if (action.alwaysAllow) {
                const bot = stateRef.current.bots.find((candidate) => candidate.id === action.alwaysAllow?.botId);
                const owner = bot?.tasks?.some((task) => task.threadId === action.threadId);
                const next = [...new Set([...(bot ? currentTaskBot(bot, action.threadId).alwaysAllow ?? [] : []), action.alwaysAllow.key])];
                try {
                  await api(owner ? `/api/bots/${action.alwaysAllow.botId}/always-allow` : `/api/bots/${action.alwaysAllow.botId}`, {
                    method: owner ? "POST" : "PATCH",
                    body: JSON.stringify(owner ? { threadId: action.threadId, allowKey: action.alwaysAllow.key } : { alwaysAllow: next }),
                  });
                } catch (error) {
                  showError(error);
                }
              }
              const response = await respond();
              if (response?.settlementPending && typeof response.message === "string") {
                showError(new Error(response.message));
              }
            })
            .catch((error) => {
              showError(error);
              action.onError?.(error instanceof Error ? error.message : String(error));
            });
          break;
        }
        case "answerCard": {
          const { host, card, inRoom } = cardTarget(action);
          void waitForExecutionSettings(executionBotsBeforeAction, action.threadId)
            .then(() => {
              if (card?.requestId && host) {
                const response = card.skillRequest
                  ? { behavior: skillRequestBehavior(action.answer) }
                  : answerResponse(card, action.answer);
                return api(`/api/threads/${action.threadId ?? host.threadId}/respond`, {
                  method: "POST",
                  body: JSON.stringify({
                    requestId: card.requestId,
                    ...response,
                    reviewedSha256: response.behavior === "allow" && card.skillRequest
                      ? reviewedSkillSha256(card.skillRequest)
                      : undefined,
                  }),
                });
              }
              if (inRoom) return;
              persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
              return api(`/api/bots/${action.botId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.answer, threadId: action.threadId }),
              });
            })
            .catch(showError);
          break;
        }
        case "dismissCard": {
          const { host, card, inRoom } = cardTarget(action);
          if (card?.requestId && host) {
            api(`/api/threads/${action.threadId ?? host.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, ...dismissResponse(card) }),
            }).catch(() => {});
          } else if (!inRoom) {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot": {
          // The picker can close/remount before React paints pending state.
          if (creatingBot) break;
          creatingBot = true;
          rawDispatch({ type: "botCreationPending", on: true });
          void createBotWithRole(action.role, api, action.visibility, action.section)
            .then(({ bot, profileError }) => {
              rawDispatch({ type: "botAdded", bot, preserveSelection: action.preserveSelection });
              action.onCreated?.(bot);
              if (profileError) {
                showError(t("newBot.profileFailed", { error: profileError }));
                rawDispatch({ type: "toggleSettings", open: true, section: "soul" });
              }
            })
            .catch((error) => {
              if (action.onError) action.onError(error instanceof Error ? error.message : String(error));
              else showError(error);
            })
            .finally(() => {
              creatingBot = false;
              rawDispatch({ type: "botCreationPending", on: false });
            });
          break;
        }
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          const duplicateProfile = duplicateBotProfile(source);
          // A copy of a restricted bot is restricted from its first moment.
          api("/api/bots", {
            method: "POST",
            body: JSON.stringify(restrictedCopyRequest(source)),
          })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify(duplicateProfile),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          rawDispatch({ type: "botDeletionPending", botId: action.botId, on: true });
          void requestConfirmedBotDeletion(
            action.botId,
            async (botId) => {
              await botPatchQueue.flush(botId);
              return api<{ notice?: string } | undefined>(`/api/bots/${botId}`, { method: "DELETE" });
            },
            (botId, answer) => {
              botPatchQueue.cancel(botId);
              rawDispatch({ type: "deleteBot", botId });
              if (answer?.notice) wrapped({ type: "notice", notice: { kind: "note", botName: null, text: answer.notice } });
            },
          )
            .catch(showError)
            .finally(() => rawDispatch({ type: "botDeletionPending", botId: action.botId, on: false }));
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "openDataResult":
        case "select": {
          const id = action.type === "select" ? action.id : action.botId;
          const bot = stateRef.current.bots.find((b) => b.id === id);
          const group = stateRef.current.groups.find((g) => g.id === id);
          if (bot?.unread) {
            api(`/api/bots/${id}/read`, { method: "POST", body: JSON.stringify({ threadId: bot.threadId }) }).catch(() => {});
          } else if (group?.unread) {
            api(`/api/groups/${id}/read`, { method: "POST" }).catch(() => {});
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({
              memberIds: action.memberIds,
              name: action.name,
              section: action.section,
              ...(window.ogb?.remoteClient?.active
                ? { setup: { bulletin: "", defaultResponder: { kind: "mentions" } } }
                : {}),
            }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup": {
          const threadId =
            action.threadId ?? stateRef.current.groups.find((group) => group.id === action.groupId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void waitForExecutionSettings(executionBotsBeforeAction)
            .then(() => api(`/api/groups/${action.groupId}/messages`, {
              method: "POST",
              body: JSON.stringify({
                text: action.text,
                replyToId: action.replyToId,
                threadId,
                sendId,
                mode: action.mode ?? "chat",
              }),
            }))
            .then((body) => {
              if (body?.message && typeof body.threadId === "string") {
                rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
              }
              if (
                body?.queued &&
                typeof body.threadId === "string" &&
                typeof body.queueId === "string"
              ) {
                rawDispatch({
                  type: "optimisticMessageRemoved",
                  threadId: body.threadId,
                  sendId,
                });
                rawDispatch({
                  type: "pendingQueued",
                  threadId: body.threadId,
                  queueId: body.queueId,
                  text: action.text,
                });
              }
            })
            .catch((error) => {
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId });
              }
              showError(error);
              action.onError?.();
            });
          break;
        }
        case "patchGroup":
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showSavedState({ groupId: action.groupId }));
          break;
        case "deleteGroup":
          api(`/api/groups/${action.groupId}`, { method: "DELETE" }).catch(showError);
          break;
        case "setModel":
          if (action.threadId) {
            persistTaskPatch(action.botId, action.threadId, {
              modelSelection: action.selection,
              ...(action.updateBotDefault ? { updateBotDefault: true } : {}),
              ...(action.resetApprovalToAsk ? { resetApprovalToAsk: true } : {}),
            });
            break;
          }
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(
              action.botId,
              { modelSelection: action.selection, threadId: botBeforeUpdate.switchingTo ?? botBeforeUpdate.threadId },
              botBeforeUpdate,
            );
          }
          break;
        case "updateTask":
          persistTaskPatch(action.botId, action.threadId, action.patch);
          break;
        case "refreshTaskPermissions": {
          const bot = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
          const task = bot?.tasks?.find((candidate) => candidate.threadId === action.threadId);
          if (!bot || !task) {
            showError(new Error("That thread is no longer available"));
            break;
          }
          const mode = approvalModeFor(bot);
          const current = approvalModeFor(currentTaskBot(bot, action.threadId));
          const acknowledgeLocalAuto = action.acknowledgeLocalAuto === true;
          const bridge = desktopApprovalBridge();
          const viaBridge = mode === "custom" || current === "custom" || (mode === "full" && bridge !== undefined);
          const refreshed = viaBridge
            ? bridge
              ? bridge.setMode(action.botId, mode, {
                threadId: action.threadId, threadOnly: true, refreshPermissions: true, acknowledgeLocalAuto,
              })
              : Promise.reject(new Error("This approval change requires the packaged desktop app"))
            : api<{ bot: BotAnnouncement }>(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
              method: "PATCH",
              body: JSON.stringify({ refreshPermissions: true, ...(acknowledgeLocalAuto ? { acknowledgeLocalAuto: true } : {}) }),
            }).then((result) => result.bot);
          void refreshed.then((updated) => {
            if (updated) rawDispatch({ type: "botPatched", bot: withTaskWrites(updated) });
          }).catch(showError);
          break;
        }
        case "followBotModel":
          void api<{ bot: BotAnnouncement; busy?: number }>(`/api/bots/${action.botId}/threads/follow-model`, { method: "POST", body: "{}" })
            .then(({ bot, busy }) => { rawDispatch({ type: "botPatched", bot: withTaskWrites(bot) }); action.onSettled?.({ busy: busy ?? 0 }); })
            .catch(showError);
          break;
        case "createProject":
          api(`/api/bots/${action.botId}/projects`, { method: "POST", body: JSON.stringify({ name: action.name, emoji: action.emoji }) })
            .then(({ bot, project }) => {
              dispatch({ type: "botPatched", bot });
              action.onCreated?.(project);
            }).catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "updateProject":
          api(`/api/bots/${action.botId}/projects/${action.projectId}`, { method: "PATCH", body: JSON.stringify(action.patch) })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onSaved?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "deleteProject":
          api(`/api/bots/${action.botId}/projects/${action.projectId}`, { method: "DELETE" })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onDeleted?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "reorderProjects":
          api(`/api/bots/${action.botId}/projects/order`, { method: "PATCH", body: JSON.stringify({ projectIds: action.projectIds }) })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onSaved?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, {
            method: "POST",
            body: action.threadId ? JSON.stringify({ threadId: action.threadId }) : undefined,
          }).catch((error) => {
            showError(error);
            action.onError?.();
          });
          break;
        case "newTask":
        case "switchTask": {
          const revision = (navigation.get(action.botId) ?? 0) + 1;
          navigation.set(action.botId, revision);
          const selectedAtStart = selectionRevision;
          const ready = action.type === "newTask"
            ? botPatchQueue.flush(action.botId)
            : Promise.resolve();
          void ready.then(() => api<{ bot: Bot }>(action.type === "newTask"
            ? `/api/bots/${action.botId}/tasks`
            : `/api/bots/${action.botId}/tasks/${action.threadId}${action.whole ? "" : `?messages=${MESSAGE_PAGE_SIZE}`}`, { method: "POST", body: JSON.stringify(action.type === "newTask" ? { projectId: action.projectId, cwd: action.cwd } : {}) }))
            .then((r) => {
              if (action.type === "newTask") action.onCreated?.();
              if (!r?.bot || navigation.get(action.botId) !== revision) return;
              const selectsAfterCreation = action.type === "newTask" && action.cwd !== undefined;
              if (selectsAfterCreation && selectionRevision !== selectedAtStart) return;
              dispatch({ type: "taskSwitched", bot: r.bot });
              if (selectsAfterCreation) rawDispatch({ type: "select", id: action.botId });
            })
            .catch((error) => {
              if (action.type === "switchTask" && navigation.get(action.botId) === revision) {
                rawDispatch({ type: "switchTaskFailed", botId: action.botId, threadId: action.threadId });
              }
              if (action.type === "newTask" && action.onError) action.onError(error instanceof Error ? error.message : String(error));
              else showError(error);
            });
          break;
        }
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showSavedState({ botId: action.botId }));
          break;
        case "regenerateTaskTitle":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}/title`, { method: "POST" })
            .then(() => action.onSettled?.(true))
            .catch((error) => { showError(error); action.onSettled?.(false); });
          break;
        case "deleteTask":
          api<{ bot?: BotAnnouncement }>(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r) => r?.bot && dispatch({ type: "botPatched", bot: r.bot }))
            .catch(showError);
          break;
        case "newGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks`, { method: "POST", body: "{}" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "switchGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks/${action.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "renameGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showSavedState({ groupId: action.groupId }));
          break;
        case "pinGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ pinned: action.pinned, title: action.title }),
          }).catch(showSavedState({ groupId: action.groupId }));
          break;
        case "setConversationTurnLimit":
          api(action.dm ? `/api/groups/${action.groupId}` : `/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ turnTimeoutMinutes: action.minutes }),
          }).catch(showSavedState({ groupId: action.groupId }));
          break;
        case "deleteGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "setGroupHold":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/holds`, {
            method: "POST",
            body: JSON.stringify({ botId: action.botId, held: action.held }),
          })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, {
            method: "POST",
            body: action.threadId ? JSON.stringify({ threadId: action.threadId }) : undefined,
          }).catch((error) => {
            showError(error);
            action.onError?.();
          });
          break;
        case "updateBot": {
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, action.patch, botBeforeUpdate);
          }
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, [botPatchQueue]);

  const launched = useRef(false);
  useEffect(() => {
    if (!state.hydrated || launched.current) return;
    launched.current = true;
    const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
    if (bot && state.activeView === "chat" && botOpensTo(bot, showThreads) !== bot.threadId) openBot(dispatch, bot, showThreads);
  }, [state.hydrated, state.bots, state.selectedId, state.activeView, showThreads, dispatch]);

  useEffect(() => {
    let alive = true;
    type PeripheralKey = "instances" | "config" | "routines" | "webhooks" | "notifications";
    type PeripheralPart = {
      key: PeripheralKey;
      request: () => Promise<() => void>;
    };
    type PeripheralRefresh = {
      attempt: number;
      generation: number;
      timer: ReturnType<typeof setTimeout> | null;
      version: number;
    };
    const peripheralRefresh = new Map<PeripheralKey, PeripheralRefresh>();
    const refreshState = (key: PeripheralKey) => {
      let current = peripheralRefresh.get(key);
      if (!current) {
        current = { attempt: 0, generation: 0, timer: null, version: 0 };
        peripheralRefresh.set(key, current);
      }
      return current;
    };
    const peripheralParts: PeripheralPart[] = [
      {
        key: "instances",
        request: async () => {
          const { instances } = await api("/api/instances");
          return () => rawDispatch({ type: "instances", instances });
        },
      },
      {
        key: "config",
        request: async () => {
          const config = await api("/api/config");
          return () => rawDispatch({ type: "configStatus", config });
        },
      },
      {
        key: "routines",
        request: async () => {
          const { routines, runs } = await api("/api/routines");
          return () => rawDispatch({ type: "routinesHydrated", routines, runs });
        },
      },
      {
        key: "notifications",
        request: async () => {
          const { notifications } = await api("/api/notifications");
          return () => rawDispatch({ type: "notificationsHydrated", notifications: Array.isArray(notifications) ? notifications : [] });
        },
      },
      ...(window.ogb?.remoteClient?.active ? [] : [{
        key: "webhooks",
        request: async () => {
          const { webhooks, attempts, ingress } = await api("/api/webhooks");
          return () =>
            rawDispatch({ type: "webhooksHydrated", webhooks, attempts: attempts ?? [], ingress });
        },
      } satisfies PeripheralPart]),
    ];
    const partByKey = new Map(peripheralParts.map((part) => [part.key, part]));
    const schedulePeripheralRetry = (part: PeripheralPart, error?: Error) => {
      if (!alive) return;
      const refresh = refreshState(part.key);
      if (refresh.timer) return;
      if (error !== undefined) {
        if (part.key === "routines") rawDispatch({ type: "routinesLoadFailed" });
        console.warn(`snapshot: ${part.key} refresh failed; retrying`, error);
      }
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(refresh.attempt, 5));
      refresh.attempt += 1;
      refresh.timer = setTimeout(() => {
        refresh.timer = null;
        const retry = () => void loadPeripheral(part, true).catch((nextError) => schedulePeripheralRetry(part, nextError));
        // A Cloud home asleep: retry once it is awake again, never wake it for this.
        if (!cloudAsleep()) return retry();
        const stop = onCloudPower((asleep) => { if (!asleep) { stop(); if (alive) retry(); } });
      }, delay);
    };
    const loadPeripheral = async (part: PeripheralPart, protectLiveFrames: boolean): Promise<void> => {
      const refresh = refreshState(part.key);
      if (refresh.timer) {
        clearTimeout(refresh.timer);
        refresh.timer = null;
      }
      const generation = ++refresh.generation;
      const version = refresh.version;
      try {
        const apply = await part.request();
        if (!alive || refresh.generation !== generation) return;
        if (protectLiveFrames && refresh.version !== version) {
          schedulePeripheralRetry(part);
          return;
        }
        apply();
        refresh.attempt = 0;
      } catch (error) {
        if (!alive || refresh.generation !== generation) return;
        throw normalizeSnapshotFailure(error);
      }
    };
    const bumpPeripheralVersion = (...keys: PeripheralKey[]) => {
      for (const key of keys) refreshState(key).version += 1;
    };
    const loadAll = async (): Promise<boolean> => {
      const since = stateRef.current.liveCallVersion;
      const seq = nextLiveCallLookup();
      void api<unknown>("/api/live/call")
        .then((body) => {
          const answer = liveCallFromFrame(body);
          if (alive && answer) flushSync(() => rawDispatch({ type: "liveCallLookup", call: answer.call, since, seq }));
        })
        .catch(() => {});
      const chat = () =>
        api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`).then(({ bots, groups, sections, computerControl, botQueuedMessages }) => {
          if (!alive) return;
          rawDispatch({
            type: "hydrate",
            bots,
            groups: groups ?? [],
            sections: sections ?? [],
            computerControl: computerControl ?? {},
            botQueuedMessages,
            resumeId: readLastConversation() ?? undefined,
          });
        });
      const peripherals = peripheralParts.map((part) => ({
        key: part.key,
        load: () => loadPeripheral(part, false),
      }));
      const chatReady = await loadSnapshotBoundary(chat, peripherals, (failed, error) => {
        const part = partByKey.get(failed.key);
        if (part) schedulePeripheralRetry(part, error);
      });
      return alive && chatReady;
    };

    let hydrated = false;
    let hydrationPromise: Promise<boolean> | null = null;
    let rehydrateRequested = false;
    const pendingFrames: ServerFrame[] = [];
    let handleFrame: (frame: ServerFrame) => void;
    const hydrate = (): Promise<boolean> => {
      if (hydrationPromise) {
        rehydrateRequested = true;
        return hydrationPromise;
      }
      hydrated = false;
      hydrationPromise = (async () => {
        let loaded = false;
        do {
          rehydrateRequested = false;
          loaded = await loadAll();
        } while (alive && rehydrateRequested);
        if (!alive || !loaded) return false;
        hydrated = true;
        for (const frame of pendingFrames.splice(0)) handleFrame(frame);
        return true;
      })().finally(() => {
        hydrationPromise = null;
      });
      return hydrationPromise;
    };
    const hydrationFallback = setTimeout(hydrate, 1_000);

    handleFrame = (frame) => {
      if (frame.kind === "config") bumpPeripheralVersion("config", "instances");
      else if (frame.kind === "routine" || frame.kind === "routine.deleted" || frame.kind === "routine.run") {
        bumpPeripheralVersion("routines");
      } else if (
        frame.kind === "webhook" ||
        frame.kind === "webhook.attempt" ||
        frame.kind === "webhook.deleted"
      ) {
        bumpPeripheralVersion("webhooks");
      }
      switch (frame.kind) {
        case "sections":
          rawDispatch({ type: "sections", sections: frame.sections });
          break;
        case "bots.order":
          rawDispatch({ type: "botsOrdered", botIds: frame.botIds });
          break;
        case "bot.queued":
          rawDispatch({ type: "botQueues", queues: frame.queues });
          break;
        case "message": {
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message as Message });
          if (frame.message?.role === "user" && typeof frame.message.queueId === "string") {
            rawDispatch({
              type: "consumePendingQueued",
              threadId: frame.threadId,
              queueId: frame.message.queueId,
            });
          }
          if (frame.message?.role === "bot" && frame.message?.kind === "text") {
            const owner = stateRef.current.bots.find((b) => b.threadId === frame.threadId || b.tasks?.some((task) => task.threadId === frame.threadId));
            const live = stateRef.current.liveCall;
            const onLiveCall = Boolean(live && live.status !== "ended" && live.botId === owner?.id);
            if (owner?.speakReplies && currentCall() === null && !onLiveCall && frame.message.text?.trim()) {
              void speaker.speak(frame.message.text, {
                botId: owner.id,
                messageId: frame.message.id,
                voiceId: owner.voice,
              });
            }
          }
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message as Message });
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          break;
        case "bot": {
          const bot = frame.bot as BotAnnouncement;
          const selected = stateRef.current.bots.find((candidate) => candidate.id === bot.id);
          const shown = selected?.switchingTo ?? selected?.threadId;
          const selectedTask = bot.tasks?.find((task) => task.threadId === shown);
          if (bot.id === stateRef.current.selectedId && stateRef.current.activeView === "chat" &&
              (selectedTask?.unread || (!bot.tasks && bot.unread))) {
            if (selectedTask) selectedTask.unread = false;
            bot.unread = botShowsUnread(bot);
            fetch(`/api/bots/${bot.id}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: shown }) }).catch(() => {});
          }
          rawDispatch({
            type: "botPatched",
            bot: withTaskWrites({ ...bot, ...botPatchQueue.overlayFor(bot.id) }),
          });
          break;
        }
        case "group": {
          const group = frame.group as Partial<Group> & { id: string };
          if (group.unread && group.id === stateRef.current.selectedId) {
            group.unread = false;
            fetch(`/api/groups/${group.id}/read`, { method: "POST" }).catch(() => {});
          }
          rawDispatch({ type: "groupPatched", group });
          break;
        }
        case "notify":
          showNotification(
            frame.notification,
            (target) => openNotificationTarget(dispatch, target, stateRef.current, showThreadsRef.current),
            stateRef.current.bots.find((bot) => bot.id === frame.notification.botId)?.avatarUrl,
            visibleNotificationThread(stateRef.current),
          );
          rawDispatch({ type: "notificationReceived", entry: frame.notification });
          break;
        case "notifications.read":
          bumpPeripheralVersion("notifications");
          rawDispatch({ type: "notificationsRead", ids: frame.ids });
          break;
        case "group.deleted":
          rawDispatch({ type: "groupDeleted", groupId: frame.groupId });
          break;
        case "routine":
          rawDispatch({ type: "routinePatched", routine: frame.routine });
          break;
        case "routine.deleted":
          rawDispatch({ type: "routineDeleted", routineId: frame.routineId });
          break;
        case "routine.run":
          rawDispatch({ type: "routineRunPatched", run: frame.run });
          break;
        case "webhook":
          rawDispatch({ type: "webhookPatched", webhook: frame.webhook });
          break;
        case "webhook.attempt":
          rawDispatch({ type: "webhookAttempted", attempt: frame.attempt });
          break;
        case "webhook.deleted":
          rawDispatch({ type: "webhookDeleted", webhookId: frame.webhookId });
          break;
        case "runtime": {
          const action = runtimeFrameAction(frame.event);
          if (action) rawDispatch(action);
          break;
        }
        case "screen":
          if (stateRef.current.computerStarts[frame.botId]) {
            rawDispatch({ type: "computerStart", botId: frame.botId, start: null });
          }
          break;
        case "computer":
          rawDispatch({ type: "computerStart", botId: frame.botId,
            start: { state: frame.state, ...(frame.place ? { place: frame.place } : {}) } });
          break;
        case "computer-control":
          rawDispatch({
            type: "computerControl",
            botId: frame.botId,
            held: frame.held === true,
            helpReason: typeof frame.helpReason === "string" ? frame.helpReason : null,
            help: parseComputerHelp(frame.help),
          });
          break;
        case "data":
          rawDispatch({ type: "dataSheet", sheet: frame.sheet });
          break;
        case "bot.deleted":
          botPatchQueue.cancel(frame.botId);
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        case "live.call": {
          const framed = liveCallFromFrame(frame);
          if (framed) flushSync(() => rawDispatch({ type: "liveCall", call: framed.call }));
          break;
        }
        case "config":
          rawDispatch({
            type: "configStatus",
            config: configStatusFromFrame(frame as unknown as ConfigStatusFrame),
          });
          {
            const instances = partByKey.get("instances");
            if (instances) {
              void loadPeripheral(instances, true).catch((error) =>
                schedulePeripheralRetry(instances, error),
              );
            }
          }
          break;
      }
    };
    const stopLive = openLiveEvents({
      onOpen: () => rawDispatch({ type: "connected", value: true }),
      onError: () => rawDispatch({ type: "connected", value: false }),
      onSnapshotRequired: () => {
        clearTimeout(hydrationFallback);
        publishMissedFrames();
        pendingFrames.splice(0);
        return hydrate();
      },
      onFrame: (frame) => {
        publishLiveFrame(frame as ServerFrame);
        if (hydrated) handleFrame(frame as ServerFrame);
        else pendingFrames.push(frame as ServerFrame);
      },
    });
    return () => {
      alive = false;
      clearTimeout(hydrationFallback);
      for (const refresh of peripheralRefresh.values()) {
        if (refresh.timer) clearTimeout(refresh.timer);
      }
      stopLive();
    };
  }, []);

  const instanceProbe = useRef<Promise<void> | null>(null);
  const refreshInstances = useCallback(async (options?: { reportErrors?: boolean }) => {
    const probe = instanceProbe.current ??= api("/api/instances", { timeoutMs: 120_000 }).then(({ instances }) => {
      if (!Array.isArray(instances)) throw new Error(t("engineSetup.invalidStatus"));
      rawDispatch({ type: "instances", instances });
    });
    try {
      await probe;
    } catch (error) {
      if (options?.reportErrors) throw error;
    } finally {
      if (instanceProbe.current === probe) instanceProbe.current = null;
    }
  }, []);

  const refreshModels = useCallback(async (instanceId: string) => {
    const { instances } = await api(`/api/instances/${encodeURIComponent(instanceId)}/refresh-models`, {
      method: "POST",
    });
    rawDispatch({ type: "instances", instances });
  }, []);

  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 30_000) return; // every engine's CLI runs; a Keychain prompt refocuses the window
      lastFocusProbe.current = now;
      void refreshInstances();
    };
    window.addEventListener("focus", onFocus);
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshInstances]);

  const flushBotPatches = useCallback(
    (botId: string) => botPatchQueue.flush(botId),
    [botPatchQueue],
  );
  const value = useMemo(
    () => ({ state, dispatch, flushBotPatches, refreshInstances, refreshModels }),
    [state, dispatch, flushBotPatches, refreshInstances, refreshModels],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

 export function BotEditorStore({ value, children }: { value: ReturnType<typeof useStore>; children: ReactNode }) {
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

   const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function formatTime(at: number) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "Invalid Date" : TIME_FORMAT.format(date);
}
