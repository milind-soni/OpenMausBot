// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { ensureSections, readSections, changeEmptySection } from "./section-context.ts";
import type { TeamComputers } from "./team-computers.ts";
import { removeBotFolder, soulFile, soulHash, writeSoulMirror } from "./bot-folder.ts";
import type { BotProfilePatch } from "./bot-profile.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, loadBrowserProfileIdAliases } from "./config.ts";
import * as mdb from "./message-db.ts";
import { runCommand, type Command } from "./commands.ts";
import { workspaceDir } from "./workspace.ts";
import type { Destination } from "./surface.ts";
import { newId, type ModelSelection } from "./contracts.ts";
import { pickBotName } from "./names.ts";
import { redactSecretsInText } from "./redact.ts";
import { botAvatarProfile } from "../shared/bot-avatar.ts";
import { approvalModeFor, isApprovalMode } from "../shared/approval-mode.ts";
import type { ProfileRequestChanges } from "../shared/profile-request.ts";
import type { TeamSetupRequest, TeamSetupResult } from "../shared/team-setup.ts";
import type { GroupGoalRunCardData } from "../shared/group-goal-run.ts";
import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary.ts";
import type { HandedState } from "./delta-context.ts";
import type {
  BotActivity, GroupDefaultResponder, GroupTask as GroupTaskRecord, MausColor,
  OptionCardData, TaskClosedBy, TaskOpenedBy, TaskUsage, WireBot, WireGroup,
  WireMessage, WireTask, BotProject as BotProjectRecord,
} from "../shared/wire.ts";
// Re-exported under their historical names so server-side importers keep working.
export type {
  BotActivity, ConnectorCardData, GroupDefaultResponder, OptionCardData,
  SecretRequestCardData, Surface, TaskClosedBy, TaskOpenedBy, TaskUsage,
} from "../shared/wire.ts";
export type { GroupTask as GroupTaskRecord, BotProject as BotProjectRecord } from "../shared/wire.ts";
export type { InstalledPlaybook, InstalledPackageMetadata, MausColor, MausExpression } from "../shared/wire.ts";


/** One transcript line, serialized as stored — the shared wire shape. */
export type Message = WireMessage;

/** A room record excludes working state and ledger usage, both computed by
 * publicGroupState at projection time. */
export type GroupRecord = Omit<WireGroup, "working" | "usage">;
/** Groups keep no private fields; projection adds computed display fields. */
export type GroupWireProjection = GroupRecord & Pick<WireGroup, "usage"> & { working: boolean };
export type GroupWireProjectionIsExact = AssertExact<WireGroup, GroupWireProjection> & AssertSameKeys<WireGroup, GroupWireProjection>;
export const groupWireProjectionIsExact: GroupWireProjectionIsExact = true;

// Unicode's complete emoji sequences include flags, skin tones and ZWJ
// combinations. Also allow unqualified single symbols (e.g. ♥), but not
// standalone components such as a digit, skin tone or regional indicator.
const projectEmojiPattern = new RegExp("^(?!\\p{Emoji_Component}$)(?:\\p{RGI_Emoji}|[\\p{Emoji}--\\p{Emoji_Component}])$", "v");
export function isProjectEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && projectEmojiPattern.exec(value)?.[0] === value;
}

/** One task = one conversation with its own context. Extends the shared
 * wire shape; the extras below are server-private bookkeeping the wire
 * projection (toWireTask) strips. */
export interface TaskRecord extends WireTask {
  /** provider-native continuation per instance, for THIS task only */
  resumeCursors: Record<string, unknown>;
  /** which instance dispatched the most recent turn. A cursor alone can't
   * say whether an engine's session is current, so this is what decides an
   * inline replay. Absent on tasks from before the field existed. */
  lastInstanceId?: string;
  /** per instance: the stored messages that instance's current native
   * session has been handed on this task (server/delta-context.ts) */
  handedMessages?: Record<string, HandedState>;
  /** Last compaction represented by a dispatched session on this task. */
  appliedCompactionId?: string;
  contextFloor?: number;
  lastContextModel?: string;
  /** Who pinned this conversation's surface: "user" when a person chose it
   * (composer chip or thread setting), "auto" when a turn recorded where
   * it landed. Absent means legacy/unknown: it may be a person's choice,
   * so only positively identified auto pins yield to Works on changes. */
  surfaceSource?: "user" | "auto";
}

/** TaskRecord fields no client may see. Everything else must be on WireTask:
 * the exactness assertion below fails to compile when either side drifts,
 * so a new server field forces a decision — wire-visible or private here. */
export type TaskWirePrivateKeys = "resumeCursors" | "lastInstanceId" | "handedMessages" | "appliedCompactionId" | "contextFloor" | "lastContextModel" | "surfaceSource";
export type TaskWireProjection = Pick<TaskRecord, Exclude<keyof TaskRecord, TaskWirePrivateKeys>>;
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssertSameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
/** Structural exactness alone lets an optional extra field through (a type
 * without the field still extends {field?: T}), so keys are checked too. */
export type TaskWireProjectionIsExact = AssertExact<WireTask, TaskWireProjection> & AssertSameKeys<WireTask, TaskWireProjection>;
export const taskWireProjectionIsExact: TaskWireProjectionIsExact = true;

/** The typed wire projection for one task. Pairs with the assertion above:
 * returning WireTask means an undeclared server field cannot ride silently. */
export function toWireTask(task: TaskRecord): WireTask {
  const { resumeCursors: _resumeCursors, lastInstanceId: _lastInstanceId, handedMessages: _handedMessages,
    appliedCompactionId: _appliedCompactionId, contextFloor: _contextFloor, lastContextModel: _lastContextModel,
    surfaceSource: _surfaceSource, ...wire } = task;
  return wire;
}

const TASK_PATCH_FIELDS = [
  "title", "projectId", "modelSelection", "approvalMode", "autoApprove", "alwaysAllow",
  "unread", "rewound", "archivedAt", "pinned", "pinnedMessageId", "resumeCursors", "lastInstanceId", "cwd",
  "routineRunId", "surface", "surfaceSource", "appliedCompactionId", "contextFloor", "lastContextModel",
] as const satisfies readonly (keyof TaskRecord)[];
export type TaskPatch = Partial<Pick<TaskRecord, typeof TASK_PATCH_FIELDS[number]>>;

/** Only `true` is a pin. false/undefined must not land in bots.json or groups.json. */
function persistedPin<T extends { pinned?: boolean }>(task: T): T {
  if (task.pinned === true) return task;
  if (!("pinned" in task)) return task;
  const { pinned: _pinned, ...rest } = task;
  return rest as T;
}

/** Everything the BOT authored is scrubbed of content-shaped secrets before
 * it is stored: its reply text, a tool title (an ACP engine's title can be
 * the whole command line) and the command beside it, a permission card's
 * summary. What the user typed
 * is theirs and stays as typed. Stored, not just displayed: the transcript
 * is replayed into every rebuild, and a leaked key would otherwise be
 * permanent. */
function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  if (out.compaction) out.compaction = { ...out.compaction, summary: redactSecretsInText(out.compaction.summary) };
  if (out.tool?.name) {
    out.tool = { ...out.tool, name: redactSecretsInText(out.tool.name) };
    if (out.tool.summary) out.tool.summary = redactSecretsInText(out.tool.summary);
  }
  if (out.routineRun) {
    const routineRun = { ...out.routineRun };
    routineRun.routineName = redactSecretsInText(routineRun.routineName);
    if (routineRun.summary) routineRun.summary = redactSecretsInText(routineRun.summary);
    if (routineRun.error) routineRun.error = redactSecretsInText(routineRun.error);
    out.routineRun = routineRun;
  }
  if (out.goalRun) {
    out.goalRun = {
      ...out.goalRun,
      goal: redactSecretsInText(out.goalRun.goal),
      coordinatorName: redactSecretsInText(out.goalRun.coordinatorName),
      detail: out.goalRun.detail ? redactSecretsInText(out.goalRun.detail) : undefined,
    };
  }
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    if (typeof card.held === "string") card.held = redactSecretsInText(card.held);
    if (typeof card.answeredText === "string") card.answeredText = redactSecretsInText(card.answeredText);
    // Bot-authored question text sits behind the subtitle the same way a
    // routine's instructions do, so it is scrubbed on the same boundary.
    if (card.questionRequest) {
      card.questionRequest = {
        ...card.questionRequest,
        questions: card.questionRequest.questions.map((question) => ({
          ...question,
          question: redactSecretsInText(question.question),
          ...(question.header ? { header: redactSecretsInText(question.header) } : {}),
          options: question.options.map((option) => ({
            ...option,
            label: redactSecretsInText(option.label),
            ...(option.description ? { description: redactSecretsInText(option.description) } : {}),
          })),
        })),
      };
    }
    // Routine definitions are executable bot-authored text stored behind the
    // visible summary. Scrub the durable payload too so nesting it on a card
    // cannot bypass the transcript's secret-redaction boundary.
    if (card.routineRequest) {
      const operation = card.routineRequest.operation;
      card.routineRequest = {
        ...card.routineRequest,
        operation: operation.action === "create"
          ? {
              ...operation,
              routine: {
                ...operation.routine,
                name: redactSecretsInText(operation.routine.name),
                instructions: redactSecretsInText(operation.routine.instructions),
              },
            }
          : operation.action === "update"
            ? {
                ...operation,
                changes: {
                  ...operation.changes,
                  ...(typeof operation.changes.name === "string"
                    ? { name: redactSecretsInText(operation.changes.name) }
                    : {}),
                  ...(typeof operation.changes.instructions === "string"
                    ? { instructions: redactSecretsInText(operation.changes.instructions) }
                    : {}),
                },
              }
            : { ...operation },
      };
    }
    if (card.skillRequest) {
      const originalPreview = card.skillRequest.preview;
      const preview = originalPreview === undefined
        ? undefined
        : redactSecretsInText(originalPreview);
      // Current skill proposals are scrubbed before staging and their digest
      // binds the card to the exact SKILL.md bytes that apply will install.
      // Keep that binding only when this store-wide safety pass is a no-op and
      // the supplied digest already matches the persisted preview. A caller
      // that bypassed staging (or an older malformed card) is therefore
      // safely deny-only instead of showing one document and approving
      // another.
      const previewSha256 = preview !== undefined && preview === originalPreview
        ? createHash("sha256").update(preview).digest("hex")
        : undefined;
      const sha256 = card.skillRequest.sha256 !== undefined
        && card.skillRequest.sha256 === previewSha256
        ? card.skillRequest.sha256
        : undefined;
      card.skillRequest = {
        ...card.skillRequest,
        gist: redactSecretsInText(card.skillRequest.gist),
        source: card.skillRequest.source === undefined
          ? undefined
          : redactSecretsInText(card.skillRequest.source),
        preview,
        sha256,
        warnings: card.skillRequest.warnings.map((warning) => redactSecretsInText(warning)),
      };
    }
    // A profile proposal's before/after text (and its reason) is hidden
    // under the card's visible summary the same way a routine's or skill's
    // is — scrub it too so nesting it on a card cannot bypass the
    // transcript's secret-redaction boundary.
    if (card.profileRequest) {
      const scrubChanges = (changes: ProfileRequestChanges): ProfileRequestChanges => {
        const out: ProfileRequestChanges = {};
        for (const [key, value] of Object.entries(changes)) {
          out[key as keyof ProfileRequestChanges] = redactSecretsInText(value);
        }
        return out;
      };
      card.profileRequest = {
        ...card.profileRequest,
        targetName: redactSecretsInText(card.profileRequest.targetName),
        reason: redactSecretsInText(card.profileRequest.reason),
        before: scrubChanges(card.profileRequest.before),
        changes: scrubChanges(card.profileRequest.changes),
      };
    }
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  return out;
}

/** What changed, emitted by the store itself right after each write. The
 * server maps these onto its SSE frames in ONE place, so no mutation path
 * can persist without the app hearing about it — the two-write-paths bug
 * (persist without emit → UI drifts; emit without persist → a restart
 * loses what the user just watched) is closed by construction. Bot and
 * group changes carry only the id: the wire shape (cursor stripping) is
 * the caller's business. */
/** The states in which the bot cannot take a new message. */
export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

export type StoreChange =
  | { type: "sections" }
  | { type: "message"; threadId: string; message: Message }
  | { type: "message.patch"; threadId: string; message: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string };

/** What a task is called before its first message names it. */
export const UNTITLED_TASK = "New task";
export const UNTITLED_THREAD = "New thread";

/** How a thread title is stored: one trim, one cut. Every title arrives
 * through this — the name a bot passes to createTask and the name a person
 * types in the sidebar alike — which is what makes "is this title still
 * the one the machine made?" a question you can answer by comparing. */
const TASK_TITLE_MAX = 80;
export function threadTitleFrom(title?: string): string {
  return title?.trim().slice(0, TASK_TITLE_MAX) || UNTITLED_THREAD;
}

/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

/** One usable line out of a model's title reply: the first line, no
 * surrounding quotes, code fences, or markdown decoration, no trailing
 * period, single spaces — or null when what came back is empty, too long
 * to be a title, or otherwise not a plain name. The caller keeps its
 * fallback then. */
export function titleFromLlm(raw: string): string | null {
  const line = raw
    .trim()
    .split("\n")[0]!
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/^["'\u201C\u201D\u2018\u2019\u0060]+/, "")
    .replace(/["'\u201C\u201D\u2018\u2019\u0060]+$/, "")
    // decoration the quotes were hiding: "## Deploy app" keeps its
    // markers through the strips above, which never reach past a quote
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/[#*]+$/, "")
    .replace(/[.\u3002]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length >= 1 && line.length <= 48 ? line : null;
}

/** A bot record. Extends the shared wire shape; the extras below are
 * server-private (stripped by wireBot). avatarUrl is optional in the record
 * but always present (string | null) on the wire, so the record widens it. */
export interface BotRecord extends Omit<WireBot, "avatarUrl" | "tasks"> {
  /** every task this bot has, newest first */
  tasks?: TaskRecord[];
  /** App-owned attachment served as this bot's custom profile image. */
  avatarUrl?: string;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** Server-private elevation journal. Full/Custom executes as Ask until
   * Electron confirms the exact prepared reply and then activates it over
   * the utility-process channel. Any marker surviving a restart is revoked
   * during Store load. */
  approvalGrant?: {
    requestId: string;
    mode: "full" | "custom";
    phase: "prepared" | "confirmed" | "activated" | "committed";
    /** Optional existing thread receiving this already-approved bot default. */
    threadId?: string;
    /** Composer grant: leave the bot default and other threads unchanged. */
    threadOnly?: true;
    /** Explicit bot-wide grant, including existing threads. */
    allThreads?: true;
  };
  /** Receipt committed with a confirmed profile, for retrying card settlement. */
  lastProfileRequestId?: string;
  /** Receipt committed with a reviewed team batch; prevents replay after a lost response. */
  lastTeamSetupReceipt?: { requestId: string; result: TeamSetupResult };
}

/** BotRecord fields no client may see, plus the two the projection
 * re-derives rather than passes through (tasks are re-projected as
 * WireTask[], avatarUrl is coerced to always-present). The exactness
 * assertion fails to compile when either side drifts, so a new server
 * field forces a decision — wire-visible or private here. */
export type BotWirePrivateKeys = "resumeCursors" | "tasks" | "avatarUrl" | "approvalGrant" | "lastProfileRequestId" | "lastTeamSetupReceipt";
export type BotWireProjection = Pick<BotRecord, Exclude<keyof BotRecord, BotWirePrivateKeys>>;
export type BotWireProjectionIsExact = AssertExact<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection> & AssertSameKeys<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection>;
export const botWireProjectionIsExact: BotWireProjectionIsExact = true;

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");

/** The registries carry souls, project paths and per-bot settings, so they are
 * owner-only like the other data-dir stores. A file written by an older
 * release (or loosened by hand) is tightened on load. Best effort: failing to
 * tighten must never stop the fleet from loading, and the next save replaces
 * the file with a 0600 one anyway. Windows has no POSIX mode bits. */
function tightenRegistryFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    /* absent, or not ours to change */
  }
}
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

const COLORS: MausColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

/** Sections are persisted as display labels, so exact trimmed labels are
 * their identity. Missing/blank means the unsectioned (General) team. */
export const sectionKey = (section?: string | null): string => section?.trim() || "";

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, the name must end on a word boundary (so "@New Bottle" never matches
 * "New Bot"), names match case-insensitively, longest name wins (so
 * "@New Bot 2" never half-matches "New Bot"), hidden bots skipped, results
 * deduped. Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest.slice(name.length); // must not run into a longer word
      return !isMentionNameContinuation(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Normalize persisted or API-provided routing. Old rooms did not have this
 * field; giving them their first member as lead fixes the old silent-send
 * behavior without making every prompt fan out to every model. */
export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
    if (
      candidate.kind === "member" &&
      typeof candidate.botId === "string" &&
      memberIds.includes(candidate.botId)
    ) {
      return { kind: "member", botId: candidate.botId };
    }
  }
  if (memberIds.length === 0) return { kind: "mentions" };
  return { kind: "member", botId: memberIds[0] };
}

/** Resolve the bots invoked by a human room message. Explicit targets win;
 * otherwise the room policy chooses one member, everyone, or nobody. */
export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
): T[] {
  const available = members.filter((member) => !member.hidden);
  const everyone = "everyone";
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const candidate = text.slice(at + 1, at + 1 + everyone.length);
    if (
      isMentionBoundary(text, at) &&
      candidate.toLocaleLowerCase() === everyone &&
      !isMentionNameContinuation(text.slice(at + 1 + everyone.length))
    ) {
      return available;
    }
  }
  const mentioned = mentionedBots(text, available);
  if (mentioned.length) return mentioned;
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  return [];
}

/** Messages form a tree (forks appear when a message is edited); the
 * visible conversation is the path from the root to activeLeafId. */
interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  private threads = new Map<string, ThreadState>();
  private defaultSelection: () => ModelSelection;
  private completeNewBotSelection: (selection: ModelSelection) => ModelSelection;
  private listeners = new Set<(change: StoreChange) => void>();
  /** A broken team registry must not prevent loading independent chat data. */
  private registeringInitialSections = true;
  /** Room turns and old callers have their own activity slot. Clearing
   * that slot must not clear a concurrently running independent task. */
  private legacyActivities = new Map<string, BotActivity>();

  constructor(
    defaultSelection: () => ModelSelection,
    /** Workspace-wide new-bot defaults (config newBots), applied to every
     * new bot's selection whichever path created it. */
    completeNewBotSelection: (selection: ModelSelection) => ModelSelection = (selection) => selection,
  ) {
    this.defaultSelection = defaultSelection;
    this.completeNewBotSelection = completeNewBotSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    for (const file of [BOTS_FILE, GROUPS_FILE]) tightenRegistryFile(file);
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
    // busy never survives a restart — no turn does either. Rooms saved
    // before default responders existed adopt their first member as lead.
    let botsMigrated = false;
    const browserProfileAliases = loadBrowserProfileIdAliases();
    const chiefSectionsSeen = new Set<string>();
    let groupsMigrated = false;
    for (const b of this.bots) {
      // transient state never survives a restart — and if a previous
      // process died mid-turn, bots.json still says busy/working; persist
      // the reset so the next load does not read it again
      if (b.busy || (b.activity !== undefined && b.activity !== "idle")) botsMigrated = true;
      b.busy = false;
      b.activity = "idle";
      if (typeof b.soul !== "string") {
        b.soul = "";
        botsMigrated = true;
      }
      if (b.soulHash !== soulHash(b.soul)) {
        b.soulHash = soulHash(b.soul);
        botsMigrated = true;
      }
      // Existing bots predate their folders. Create missing mirrors before
      // their first history write, but preserve any edits already on disk.
      if (!existsSync(soulFile(b.id))) {
        try { writeSoulMirror(b.id, b.soul); } catch (e) {
          console.warn(`[bot-folder] could not create SOUL.md for ${b.id}: ${(e as Error).message}`);
        }
      }
      if (b.browserProfile) {
        const browserProfile = browserProfileAliases.get(b.browserProfile);
        if (browserProfile && browserProfile !== b.browserProfile) {
          b.browserProfile = browserProfile;
          botsMigrated = true;
        }
      }
      if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
        delete b.cloudBackend;
        botsMigrated = true;
      }
      if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
        delete b.autoStartVps;
        botsMigrated = true;
      }
      if (b.managedSections !== undefined && (!b.chiefOfStaff || !Array.isArray(b.managedSections) ||
          b.managedSections.length > 100 || b.managedSections.some(section => typeof section !== "string" || section.length > 60))) {
        delete b.managedSections;
        botsMigrated = true;
      }
      if (b.approvalMode !== undefined && !isApprovalMode(b.approvalMode)) {
        delete b.approvalMode;
        botsMigrated = true;
      }
      // A trusted elevation is a prepare/confirm/activate commit. If the
      // desktop process or its private reply path died before activation,
      // the durable marker survives beside the mode in the same atomic
      // bots.json write. Revoke it before schedulers, listeners, or HTTP can
      // start any new work.
      if (b.approvalGrant !== undefined) {
        const threadOnly = b.approvalGrant.threadOnly === true;
        if (threadOnly) {
          // A crash may land between saving the target and clearing its
          // journal. Revoke that target only, never unrelated threads.
          const target = b.tasks?.find(task => task.threadId === b.approvalGrant?.threadId);
          if (target) { target.approvalMode = "ask"; target.autoApprove = false; }
        }
        if (!threadOnly) {
        b.approvalMode = "ask";
        b.autoApprove = false;
        for (const task of b.tasks ?? []) {
          if (task.approvalMode === "full" || task.approvalMode === "custom") {
            task.approvalMode = "ask";
            task.autoApprove = false;
          }
        }
        }
        delete b.approvalGrant;
        botsMigrated = true;
      }
      const avatar = botAvatarProfile(b);
      if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
        delete b.avatarUrl;
        botsMigrated = true;
      }
      if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
        delete b.avatarCrop;
        botsMigrated = true;
      }
    }
    for (const b of this.bots) {
      if (!b.chiefOfStaff) continue;
      const key = sectionKey(b.section);
      if (!chiefSectionsSeen.has(key)) {
        chiefSectionsSeen.add(key);
        if (b.hidden) {
          b.hidden = false;
          botsMigrated = true;
        }
        continue;
      }
      b.chiefOfStaff = false;
      delete b.managedSections;
      botsMigrated = true;
    }
    // Peer grants originally used mutable display names (ask_bot:@Helper).
    // Convert only when exactly one bot has that name; ambiguous legacy
    // entries remain inert rather than granting access to the wrong bot.
    for (const b of this.bots) {
      if (!b.alwaysAllow?.length) continue;
      let changed = false;
      const migrated = b.alwaysAllow.map((key) => {
        const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
        if (!match) return key;
        const candidates = this.bots.filter((candidate) => candidate.name === match[2]);
        if (candidates.length !== 1) return key;
        changed = true;
        return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
      });
      if (changed) {
        b.alwaysAllow = [...new Set(migrated)];
        botsMigrated = true;
      }
    }
    for (const g of this.groups) {
      g.busyBotId = null;
      delete g.turnStartedAt;
      const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
      if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder)) groupsMigrated = true;
      g.defaultResponder = normalized;
      // Bot-to-bot channels intentionally remain one canonical thread.
      if (g.dm) {
        if (g.tasks !== undefined) {
          delete g.tasks;
          groupsMigrated = true;
        }
        continue;
      }
      if (!g.tasks?.length) {
        const initialTask: GroupTaskRecord = {
          threadId: g.threadId,
          title: this.firstUserLine(g.threadId) ?? UNTITLED_TASK,
          createdAt: g.createdAt,
          updatedAt: g.createdAt,
        };
        if (g.pinnedCwd !== undefined) initialTask.pinnedCwd = g.pinnedCwd;
        if (g.pinnedMessageId) initialTask.pinnedMessageId = g.pinnedMessageId;
        g.tasks = [initialTask];
        groupsMigrated = true;
      }
      // Repair a malformed/stale active pointer conservatively. Every task
      // transcript is retained; the newest known task becomes active.
      let active = g.tasks.find((task) => task.threadId === g.threadId);
      if (!active) {
        active = g.tasks[0]!;
        g.threadId = active.threadId;
        groupsMigrated = true;
      }
      g.pinnedCwd = active.pinnedCwd;
      g.pinnedMessageId = active.pinnedMessageId;
    }
    if (groupsMigrated) this.saveGroups();
    // bots saved before tasks existed have one endless thread; adopt it as
    // their first task so nothing is lost and nothing special-cases it
    for (const b of this.bots) {
      // Folders are organizational only. Preserve existing thread model
      // snapshots while discarding the unshipped folder-default setting.
      if (b.projects?.some((project) => "modelSelection" in project)) {
        b.projects = b.projects.map(({ id, name, emoji }) => ({ id, name, ...(isProjectEmoji(emoji) ? { emoji } : {}) }));
        botsMigrated = true;
      }
      if (!b.tasks?.length) {
        b.tasks = [{
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          updatedAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        }];
        botsMigrated = true;
      }
      // Retain an old active transcript even if a stale tasks array omitted
      // it. Repairing the pointer by selecting another task would hide it.
      let active = b.tasks.find((task) => task.threadId === b.threadId);
      if (!active) {
        active = {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          updatedAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        };
        b.tasks.unshift(active);
        botsMigrated = true;
      }
      for (const task of b.tasks) {
        if (task.modelSelection === undefined) {
          task.modelSelection = structuredClone(b.modelSelection);
          botsMigrated = true;
        }
        if (!task.resumeCursors) {
          task.resumeCursors = task === active ? (b.resumeCursors ?? {}) : {};
          botsMigrated = true;
        }
        if (task.unread === undefined) {
          task.unread = task === active && b.unread;
          botsMigrated = true;
        }
        if (task === active) {
          if (task.rewound === undefined && b.rewound !== undefined) {
            task.rewound = b.rewound;
            botsMigrated = true;
          }
          if (task.pinnedMessageId === undefined && b.pinnedMessageId !== undefined) {
            task.pinnedMessageId = b.pinnedMessageId;
            botsMigrated = true;
          }
        }
        if (task.approvalMode !== undefined && !isApprovalMode(task.approvalMode)) {
          delete task.approvalMode;
          botsMigrated = true;
        }
        if (task.busy !== undefined || task.activity !== undefined || task.turnStartedAt !== undefined) botsMigrated = true;
        task.busy = false;
        task.activity = "idle";
        task.turnStartedAt = undefined;
      }
      this.mirrorActiveTask(b, active);
      b.unread = b.tasks.some((task) => task.unread);
    }
    if (botsMigrated) this.saveBots();
    // Search reads SQLite directly, so migrate every known legacy transcript
    // at startup rather than waiting until the user happens to open it. Only
    // pending JSON files are touched; already-migrated threads stay lazy.
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
      ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
    ]);
    for (const threadId of knownThreads) {
      const legacyFile = messagesFile(threadId);
      if (existsSync(legacyFile)) mdb.readThread(threadId, legacyFile);
    }
    // After legacy transcripts are in SQLite, so the first boot sees their
    // newest message instead of stamping createdAt and jumping next launch.
    this.repairThreadUpdatedAts();
    // After the roster is loaded, so identity resolution sees which opener
    // ids are still live.
    this.repairDuplicatePairConversations();
    this.registeringInitialSections = false;
  }

  /** Advance a task's update stamp in memory only. Message writes must not
   * rewrite bots.json; the next snapshot and the startup repair read this. */
  private noteThreadActivity(threadId: string, at: number): void {
    if (!Number.isFinite(at)) return;
    const advance = (current: number | undefined) => Math.max(current ?? 0, at);
    for (const bot of this.bots) {
      const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
      if (!task) continue;
      const next = advance(task.updatedAt);
      if (task.updatedAt !== next) task.updatedAt = next;
    }
    for (const group of this.groups) {
      const task = group.tasks?.find((candidate) => candidate.threadId === threadId);
      if (!task) continue;
      const next = advance(task.updatedAt);
      if (task.updatedAt !== next) task.updatedAt = next;
    }
  }

  /** Fill missing stamps, and raise a stamp that is older than the newest
   * stored message. Never moves a stamp backwards: there is no per-message
   * delete, and a clock skew must not reshuffle the list on every boot. */
  private repairThreadUpdatedAts(): void {
    const botTasks = this.bots.flatMap((bot) => bot.tasks ?? []);
    const groupTasks = this.groups.flatMap((group) => group.tasks ?? []);
    const latest = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId));
    let botsDirty = false;
    let groupsDirty = false;
    const repair = (task: { threadId: string; createdAt: number; updatedAt?: number }) => {
      const fromMessages = latest.get(task.threadId);
      const next = fromMessages !== undefined && (task.updatedAt === undefined || fromMessages > task.updatedAt)
        ? fromMessages
        : task.updatedAt ?? task.createdAt;
      if (task.updatedAt === next) return false;
      task.updatedAt = next;
      return true;
    };
    for (const task of botTasks) if (repair(task)) botsDirty = true;
    for (const task of groupTasks) if (repair(task)) groupsDirty = true;
    if (botsDirty) this.saveBots();
    if (groupsDirty) this.saveGroups();
  }

  /** At most one live pair row per (recipient, sender identity). Servers
   * before identity-stable matching minted a second live pair row for a
   * deleted-and-recreated sender while the predecessor's row dangled live
   * forever; collapse those on load by keeping the row the resolver favors
   * (first in the task list — the newest, actively used one) and demoting
   * the rest to closed plain threads. History is kept, never deleted, and
   * a demoted row is never re-adopted: adoption skips closed rows. Runs on
   * every load and touches nothing in a store that already holds the
   * invariant. */
  private repairDuplicatePairConversations(): void {
    let botsDirty = false;
    type SweepTask = { openedBy?: TaskOpenedBy; closedBy?: TaskClosedBy };
    const sweep = (tasks: SweepTask[] | undefined, repaired: () => void) => {
      const pairs = new Map<string, SweepTask[]>();
      for (const task of tasks ?? []) {
        const by = task.openedBy;
        if (by?.kind !== "pair" || task.closedBy) continue;
        const identity = this.openerIdentity(by);
        pairs.set(identity, [...(pairs.get(identity) ?? []), task]);
      }
      for (const rows of pairs.values()) {
        // rows are in task-list order, the same order the resolver's
        // find() favors: the first is the one it keeps using.
        for (const duplicate of rows.slice(1)) {
          const by = duplicate.openedBy!;
          const identity = this.openerIdentity(by);
          const { kind: _kind, ...opened } = by;
          duplicate.openedBy = opened;
          duplicate.closedBy = {
            botId: identity,
            name: this.bot(identity)?.name ?? by.name,
            at: Date.now(),
          };
          repaired();
        }
      }
    };
    // Pair rows only ever live on bots: the resolver requires a bot
    // recipient, and group tasks carry no peer stamps.
    for (const bot of this.bots) sweep(bot.tasks, () => { botsDirty = true; });
    if (botsDirty) this.saveBots();
  }

  private saveBots(bots: BotRecord[] = this.bots, registerSections = true) {
    if (registerSections) this.rememberSections([...this.bots, ...bots].map((bot) => bot.section));
    writeFileAtomic(BOTS_FILE, JSON.stringify(bots.map(({ busy: _busy, activity: _activity, ...bot }) => ({
      ...bot,
      tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, turnStartedAt: _taskTurnStarted, ...task }) => persistedPin(task)),
    })), null, 2), { mode: 0o600 });
  }

  private saveGroups(groups: GroupRecord[] = this.groups, registerSections = true) {
    if (registerSections) this.rememberSections(groups.map((group) => group.section));
    writeFileAtomic(GROUPS_FILE, JSON.stringify(groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => ({
      ...g,
      ...(g.tasks ? { tasks: g.tasks.map((task) => persistedPin(task)) } : {}),
    })), null, 2), { mode: 0o600 });
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

  /** Rename the same team, preserving its members and existing access grants. */
  renameSection(name: string, nextName: string, computers?: TeamComputers): string | undefined {
    if (!name || !this.sections.includes(name)) return "No such team";
    nextName = nextName.trim();
    if (!nextName || nextName.length > 60 || [...nextName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "Team name must be 1 to 60 characters without control characters";
    if (name === nextName) return undefined;
    if (this.sections.includes(nextName) || computers?.forSection(nextName)) return "A team with that name already exists";
    const members = this.bots.filter(bot => sectionKey(bot.section) === name);
    const rooms = this.groups.filter(group => sectionKey(group.section) === name);
    const affected = this.bots.filter(bot => members.includes(bot) || bot.managedSections?.some(section => sectionKey(section) === name));
    if (affected.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
      return "Stop this team's active work before renaming the team";
    }
    // Keep the established empty-team lifecycle: old grants are revoked when
    // an empty identity is removed, so recreating it cannot restore access.
    if (!members.length && !rooms.length && !computers?.forSection(name)) return this.changeEmptySection(name, nextName);
    const nextBots = this.bots.map(bot => ({ ...bot,
      ...(members.includes(bot) ? { section: nextName } : {}),
      ...(bot.managedSections ? { managedSections: [...new Set(bot.managedSections.map(section => sectionKey(section) === name ? nextName : section))] } : {}),
    }));
    const nextGroups = this.groups.map(group => rooms.includes(group) ? { ...group, section: nextName } : group);
    let computerChanged = false;
    try {
      // Register the new name only after saving the records; otherwise the
      // registry's duplicate-name check would reject this same rename.
      this.saveBots(nextBots, false);
      this.saveGroups(nextGroups, false);
      computerChanged = computers?.renameSection(name, nextName) ?? false;
      changeEmptySection(name, nextName);
    } catch (error) {
      this.saveBots(this.bots, false);
      this.saveGroups(this.groups, false);
      if (computerChanged) computers!.renameSection(nextName, name);
      throw error;
    }
    // Preserve identities held by the schedulers and other store consumers.
    for (let i = 0; i < nextBots.length; i++) Object.assign(this.bots[i], nextBots[i]);
    for (let i = 0; i < nextGroups.length; i++) Object.assign(this.groups[i], nextGroups[i]);
    for (const bot of affected) this.emit({ type: "bot", botId: bot.id });
    for (const room of rooms) this.emit({ type: "group", groupId: room.id });
    this.emit({ type: "sections" });
    return undefined;
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

  /** Remove the team, keeping its bots, rooms and conversations in General. */
  deleteSection(name: string): string | undefined {
    if (!name || !this.sections.includes(name)) return "No such team";
    const members = this.bots.filter(bot => sectionKey(bot.section) === name);
    const rooms = this.groups.filter(group => sectionKey(group.section) === name);
    if (members.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
      return "Stop this team's active work before deleting the team";
    }
    if (this.bots.filter(bot => bot.chiefOfStaff && (!sectionKey(bot.section) || sectionKey(bot.section) === name)).length > 1) {
      return "General already has a Chief of Staff. Move or change this team's Chief before deleting the team";
    }
    const nextBots = this.bots.map(bot => ({ ...bot,
      ...(sectionKey(bot.section) === name ? { section: undefined } : {}),
      ...(bot.managedSections ? { managedSections: bot.managedSections.filter(section => sectionKey(section) !== name) } : {}),
    }));
    const nextGroups = this.groups.map(group => sectionKey(group.section) === name ? { ...group, section: undefined } : group);
    try {
      this.saveBots(nextBots);
      this.saveGroups(nextGroups);
      changeEmptySection(name, null);
    } catch (error) {
      this.saveBots();
      this.saveGroups();
      throw error;
    }
    for (let i = 0; i < nextBots.length; i++) Object.assign(this.bots[i], nextBots[i]);
    for (let i = 0; i < nextGroups.length; i++) Object.assign(this.groups[i], nextGroups[i]);
    for (const bot of this.bots) this.emit({ type: "bot", botId: bot.id });
    for (const group of rooms) this.emit({ type: "group", groupId: group.id });
    this.emit({ type: "sections" });
    return undefined;
  }

  // ── groups ────────────────────────────────────────────────────────────
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

  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return this.groups.find(
      (group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId),
    );
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
    this.rememberSections([section]);
    const threadId = newId();
    const createdAt = Date.now();
    const group: GroupRecord = {
      id: newId(),
      threadId,
      name,
      memberIds,
      defaultResponder: dm
        ? { kind: "mentions" }
        : normalizeGroupDefaultResponder(setup?.defaultResponder, memberIds, false),
      bulletin: setup?.bulletin ?? "",
      unread: false,
      createdAt,
      dm: dm || undefined,
      busyBotId: null,
      section,
    };
    if (!dm) {
      group.tasks = [{ threadId, title: UNTITLED_TASK, createdAt, updatedAt: createdAt }];
      group.setupCompletedAt = setup?.completed ? createdAt : null;
      group.setupSkippedAt = null;
    }
    this.groups.unshift(group);
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
  dmGroup(a: string, b: string): GroupRecord | undefined {
    return this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    );
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt" | "audienceFloor">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    if (Object.prototype.hasOwnProperty.call(patch, "section")) {
      this.rememberSections([patch.section]);
    }
    const previousBusyBotId = group.busyBotId;
    Object.assign(group, patch);
    // The group's elapsed readout counts the busy member's turn from the
    // claim time — the group-side twin of a task's turnStartedAt. Derived,
    // never patched directly: stamp it on every transition into a busy
    // speaker and clear it when the group goes idle, so each member's turn
    // counts from its own start.
    if (Object.prototype.hasOwnProperty.call(patch, "busyBotId")) {
      if (patch.busyBotId && patch.busyBotId !== previousBusyBotId) group.turnStartedAt = Date.now();
      else if (!patch.busyBotId) delete group.turnStartedAt;
    }
    if (!group.dm && Object.prototype.hasOwnProperty.call(patch, "pinnedMessageId")) {
      const active = this.activeGroupTask(group.id);
      if (active) active.pinnedMessageId = patch.pinnedMessageId;
    }
    group.defaultResponder = normalizeGroupDefaultResponder(
      group.defaultResponder,
      group.memberIds,
      Boolean(group.dm),
    );
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** A thread's durable record: DB rows, legacy JSON leftovers, and the
   * per-thread event logs. Every delete path funnels here — task, group,
   * and bot deletion — so the logs cannot outlive the thread anywhere. */
  private deleteThreadRecord(threadId: string) {
    this.threads.delete(threadId);
    mdb.deleteThread(threadId);
    for (const file of [
      messagesFile(threadId),
      `${messagesFile(threadId)}.imported`,
      join(EVENTS_DIR, `${threadId}.ndjson`),
      join(NATIVE_DIR, `${threadId}.ndjson`),
    ]) {
      try {
        unlinkSync(file);
      } catch {}
    }
    this.emit({ type: "thread.deleted", threadId });
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    this.groups = this.groups.filter((g) => g.id !== id);
    this.saveGroups();
    for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    this.emit({ type: "group.deleted", groupId: id });
    return true;
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
    const ownedThreadIds = new Set<string>();
    for (const group of this.groups) {
      ownedThreadIds.add(group.threadId);
      for (const task of group.tasks ?? []) ownedThreadIds.add(task.threadId);
    }
    // load() already migrated every legacy transcript file into SQLite, so
    // this recovery query is proportional to unfinished goals, not history.
    let recovered = 0;
    for (const hit of mdb.workingGoalRunMessages()) {
      if (!ownedThreadIds.has(hit.threadId) || !hit.message.goalRun) continue;
      const resolution = resolve?.(hit.message.goalRun.runId, hit.threadId) ?? {
        status: "failed" as const,
        detail: fallbackDetail,
        finishedAt: fallbackFinishedAt,
      };
      const state = resolution.status === "needs-input"
        ? "needs your input"
        : resolution.status === "limit-reached"
          ? "reached its turn limit"
          : resolution.status;
      this.patchMessage(hit.threadId, hit.message.id, {
        text: `Goal ${state}: ${resolution.detail}`,
        goalRun: {
          ...hit.message.goalRun,
          status: resolution.status,
          detail: resolution.detail,
          finishedAt: resolution.finishedAt,
        },
      });
      recovered += 1;
    }
    return recovered;
  }

  // ── channel tasks ────────────────────────────────────────────────────
  groupTasks(groupId: string): GroupTaskRecord[] {
    const group = this.group(groupId);
    return group?.dm ? [] : (group?.tasks ?? []);
  }

  activeGroupTask(groupId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    return group?.tasks?.find((task) => task.threadId === group.threadId);
  }

  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    if (!group || group.dm) return undefined;
    return group.tasks?.find((task) => task.threadId === threadId);
  }

  createGroupTask(groupId: string, title?: string, activate = true): GroupTaskRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm) return null;
    const createdAt = Date.now();
    const task: GroupTaskRecord = {
      threadId: newId(),
      title: title?.trim().slice(0, 80) || UNTITLED_TASK,
      createdAt,
      updatedAt: createdAt,
    };
    group.tasks = [task, ...(group.tasks ?? [])];
    if (activate) {
      group.threadId = task.threadId;
      group.pinnedCwd = undefined;
      group.pinnedMessageId = undefined;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  switchGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    const task = group?.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!group || group.dm || !task) return null;
    group.threadId = task.threadId;
    group.pinnedCwd = task.pinnedCwd;
    group.pinnedMessageId = task.pinnedMessageId;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  setGroupTaskPinned(groupId: string, threadId: string, pinned: boolean): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    if (pinned) task.pinned = true;
    else delete task.pinned;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  renameGroupTask(groupId: string, threadId: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  /** Name a channel task after its first message, once. Returns the task
   * it named so a caller can later replace exactly that machine-made
   * title. */
  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string): GroupTaskRecord | null {
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task || task.titleFromFirstMessage || task.title !== UNTITLED_TASK) return null;
    task.title = titleFromMessage(text);
    task.titleFromFirstMessage = true;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  /** Swap a machine-made first-message channel title for a generated one,
   * once, on the same snippet-equality contract as bot tasks: any rename
   * by the person breaks that equality first and always wins. */
  retitleGroupTask(groupId: string, threadId: string, machineTitle: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task || task.title !== machineTitle) return null;
    return this.renameGroupTask(groupId, threadId, threadTitleFrom(title));
  }

  deleteGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm || !group.tasks || group.tasks.length < 2) return null;
    if (!group.tasks.some((task) => task.threadId === threadId)) return null;
    group.tasks = group.tasks.filter((task) => task.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (group.threadId === threadId) {
      const next = group.tasks[0]!;
      group.threadId = next.threadId;
      group.pinnedCwd = next.pinnedCwd;
      group.pinnedMessageId = next.pinnedMessageId;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  /** Toggle an emoji reaction on a message ("user" or a member botId). */
  toggleReaction(threadId: string, messageId: string, emoji: string, by: string): Message | null {
    const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
    if (!existing) return null;
    const reactions = existing.reactions ?? [];
    const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
    const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
    return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
  }

  private thread(threadId: string): ThreadState {
    const t = this.threads.get(threadId);
    if (t) return t;
    // SQLite is the source of truth; a thread with no rows imports its
    // legacy messages-<threadId>.json once, inside readThread
    return this.cacheThread(threadId, mdb.readThread(threadId, messagesFile(threadId)));
  }

  /** Finish hydrating a full set of thread rows into the cache: chain any
   * legacy (pre-branching) rows' parentId in array order, default the
   * active leaf to the newest message, and store it. Shared by a full load
   * and by messagesTail() when its bounded read turns out to be the whole
   * thread anyway. */
  private cacheThread(threadId: string, rows: mdb.ThreadRows): ThreadState {
    const { messages, activeLeafId: storedLeaf } = rows;
    let activeLeafId = storedLeaf;
    // legacy rows carry no parentId — chain them in array order
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    if (!activeLeafId) activeLeafId = messages.at(-1)?.id ?? null;
    const t = { messages, activeLeafId };
    this.threads.set(threadId, t);
    return t;
  }

  messagesFor(threadId: string): Message[] {
    return this.thread(threadId).messages;
  }

  /** A bounded page of a thread's newest messages, for callers that only
   * need a display page — the startup/reconnect hydrate and a fresh
   * scrollback view. Reads just `limit` rows at the SQL boundary instead of
   * the whole transcript, unless the thread is already cached from other
   * work (then it's a plain in-memory slice, no extra SQL) or the bounded
   * read comes back as the complete thread anyway (short thread, or a
   * one-time legacy import) — that gets cached like any other full load so
   * a later messagesFor() doesn't re-read it. Legacy rows that predate
   * per-message parentId are only chained correctly on a full load, so a
   * bounded page missing that context falls back to one rather than
   * returning messages with a broken parent chain. */
  messagesTail(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; activeLeafId: string | null } {
    let state = this.threads.get(threadId);
    if (!state) {
      const tail = mdb.readThreadTail(threadId, messagesFile(threadId), limit);
      const legacyRows = tail.hasMore !== undefined && tail.messages.some((m) => m.parentId === undefined);
      if (tail.hasMore !== true || legacyRows) {
        state = this.cacheThread(threadId, legacyRows ? mdb.readThread(threadId, messagesFile(threadId)) : tail);
      } else {
        return {
          messages: tail.messages,
          hasMore: tail.hasMore,
          activeLeafId: tail.activeLeafId ?? tail.messages.at(-1)?.id ?? null,
        };
      }
    }
    const { messages, activeLeafId } = state;
    const start = Math.max(0, messages.length - limit);
    return { messages: messages.slice(start), hasMore: start > 0, activeLeafId };
  }

  /** Used only with newly allocated import threads. No live actions are
   * replayed: the importer supplies inert text and freshly remapped IDs. */
  importTranscript(threadId: string, messages: Message[], activeLeafId: string | null): void {
    if (this.messagesFor(threadId).length) throw new Error("Cannot import over an existing conversation");
    mdb.importThread(threadId, messages, activeLeafId);
    this.threads.delete(threadId);
    const newest = messages.reduce((max, message) => Math.max(max, message.at), Number.NEGATIVE_INFINITY);
    if (Number.isFinite(newest)) this.noteThreadActivity(threadId, newest);
  }

  activeLeaf(threadId: string): string | null {
    return this.thread(threadId).activeLeafId;
  }

  /** The visible conversation: root → activeLeafId. */
  activePath(threadId: string): Message[] {
    const t = this.thread(threadId);
    const byId = new Map(t.messages.map((m) => [m.id, m]));
    const path: Message[] = [];
    let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }

  /** Mark the last assistant text on the active branch as this turn's final
   * visible answer. If a provider ends after commentary without emitting a
   * separate answer, that commentary remains visible as the safe fallback. */
  markTerminalAssistantMessage(threadId: string, turnId: string): Message | null {
    const path = this.activePath(threadId);
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const message = path[i];
      if (message.role === "bot" && message.kind === "text" && message.turnId === turnId) {
        if (message.turnTerminal) return message;
        return this.patchMessage(threadId, message.id, { turnTerminal: true });
      }
    }
    return null;
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }, command?: Command): Message {
    const t = this.thread(threadId);
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
    const persist = () => { mdb.appendMessage(threadId, full); return full; };
    const committed = command ? runCommand(command, persist) : persist();
    if (committed.id !== full.id) return committed;
    // Only publish the committed write. A failed receipt must leave both
    // the in-memory branch and subscribers unchanged, just like SQLite.
    t.messages.push(full);
    t.activeLeafId = full.id;
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.noteThreadActivity(threadId, full.at);
    this.emit({ type: "message", threadId, message: full });
    // The first-run quiz is not a live ask. Talking past it hides it so the
    // transcript is just the greeting plus what they said. Cards with a
    // requestId are permission/question prompts and stay until answered.
    if (full.role === "user" && full.kind === "text") this.dismissOnboardingCard(threadId);
    return full;
  }

  /** Insert a message into the active chain directly after `anchorId` — the
   * home for turn artifacts that finish AFTER the world moved on (the
   * settle-time screen capture races a fast follow-up send, which used to
   * leave the user's message stranded above the screenshot). When the anchor
   * is still the leaf this is a plain append; otherwise the anchor's
   * children are re-parented onto the inserted message, so the transcript
   * reads turn → artifact → follow-up and the leaf stays where it was. */
  insertMessageAfter(threadId: string, anchorId: string | undefined, message: Omit<Message, "id" | "at">): Message {
    const t = this.thread(threadId);
    const anchorExists = anchorId !== undefined && t.messages.some((m) => m.id === anchorId);
    if (!anchorExists || t.activeLeafId === anchorId) return this.appendMessage(threadId, message);
    const full: Message = { id: newId(), at: Date.now(), ...redactBotAuthored(message), parentId: anchorId };
    const children = t.messages.filter((m) => m.parentId === anchorId);
    t.messages.push(full);
    mdb.appendMessage(threadId, full);
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.noteThreadActivity(threadId, full.at);
    this.emit({ type: "message", threadId, message: full });
    // announced after the insert so no client ever sees two siblings
    // claiming the same parent
    for (const child of children) this.patchMessage(threadId, child.id, { parentId: full.id });
    return full;
  }

  /** Hide the first-run quiz on this thread, if it is still open. */
  dismissOnboardingCard(threadId: string): Message | null {
    const t = this.thread(threadId);
    const card = t.messages.find(
      (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
    );
    if (!card?.card) return null;
    return this.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
  }

  /** Screen frames are ~100-500KB of base64 each; keeping every frame of a
   * long computer session bloats the transcript for nothing the client
   * would ever show. The newest few keep their pixels; older ones stay in
   * the transcript as placeholders. Mirrors the client's own frame cap.
   * Returns the messages whose pixels were dropped so the caller can
   * persist exactly those. */
  private pruneScreenFrames(t: { messages: Message[] }, keep = 4): Message[] {
    const pruned: Message[] = [];
    let seen = 0;
    for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
      const m = t.messages[i];
      if (m.kind !== "screen" || !m.png) continue;
      seen += 1;
      if (seen > keep) {
        m.png = undefined;
        pruned.push(m);
      }
    }
    return pruned;
  }

  /** Fork the conversation: a new user message that replaces `sourceId`
   * (same parent, new text) and becomes the active leaf. */
  branchMessage(threadId: string, sourceId: string, text: string): Message | null {
    const t = this.thread(threadId);
    const source = t.messages.find((m) => m.id === sourceId);
    if (!source) return null;
    const full: Message = {
      id: newId(),
      at: Date.now(),
      role: "user",
      kind: "text",
      text,
      parentId: source.parentId ?? null,
      replyToId: source.replyToId,
    };
    t.messages.push(full);
    t.activeLeafId = full.id;
    mdb.appendMessage(threadId, full);
    this.noteThreadActivity(threadId, full.at);
    this.emit({ type: "message", threadId, message: full });
    // The message frame alone leaves every client on the OLD branch: a
    // client adopts a new message as its leaf only when it chains onto the
    // current leaf, and this one is a sibling of the edited message, not a
    // child of the reply. Say where the conversation now points, as
    // setActiveLeaf does, or the edit shows only after the next full bot
    // snapshot — in practice, once the reply has arrived.
    this.emit({ type: "thread", threadId, activeLeafId: full.id });
    return full;
  }

  /** Point the visible conversation at the branch containing `messageId`,
   * descending to that branch's most recently active leaf. */
  setActiveLeaf(threadId: string, messageId: string): string | null {
    const t = this.thread(threadId);
    if (!t.messages.some((m) => m.id === messageId)) return null;
    let cur = messageId;
    for (;;) {
      const children = t.messages.filter((m) => m.parentId === cur);
      if (!children.length) break;
      cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
    }
    t.activeLeafId = cur;
    mdb.setActiveLeaf(threadId, cur);
    this.emit({ type: "thread", threadId, activeLeafId: cur });
    return cur;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>, command?: Command): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    const next = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
    // SQLite is the durable source of truth. Persist before changing memory so
    // a failed write cannot make this process believe a card was answered
    // while a restart would still show it as pending.
    let applied = false;
    const persist = () => { mdb.updateMessage(threadId, next); applied = true; return next; };
    const committed = command ? runCommand(command, persist) : persist();
    if (!applied) return committed;
    t.messages[idx] = next;
    this.emit({ type: "message.patch", threadId, message: next });
    return next;
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
  }

  /** The one place a new bot's selection is decided: the caller's choice, or
   * the workspace default, completed with the workspace's new-bot defaults. */
  private newBotSelection(requested?: ModelSelection): ModelSelection {
    return this.completeNewBotSelection(requested ?? this.defaultSelection());
  }

  createBot(
    profile: Partial<
      Pick<
        BotRecord,
        "name" | "title" | "description" | "soul" | "color" | "mascotExpression" | "mascotBody" | "modelSelection" | "section" | "visibility"
      >
    > = {},
    opts: {
      /** false = no greeting/onboarding seed. Imported bots must not open
       * with a first-person greeting the user never asked for. */
      seedMessages?: boolean;
    } = {},
  ): BotRecord {
    this.rememberSections([profile.section]);
    const name = profile.name?.trim() || pickBotName(this.bots.map((b) => b.name));
    const section = sectionKey(profile.section);
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name,
      title: profile.title ?? "",
      description: profile.description ?? "",
      soul: profile.soul ?? "",
      soulHash: soulHash(profile.soul ?? ""),
      notifications: true,
      color: profile.color ?? COLORS[this.bots.length % COLORS.length],
      ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
      ...(profile.mascotBody ? { mascotBody: profile.mascotBody } : {}),
      // Restricted from its first frame: no one else is ever told it exists.
      ...(profile.visibility && profile.visibility !== "everyone" ? { visibility: structuredClone(profile.visibility) } : {}),
      unread: false,
      modelSelection: this.newBotSelection(profile.modelSelection),
      resumeCursors: {},
      createdAt: Date.now(),
    };
    if (section) bot.section = section;
    bot.tasks = [{
      threadId: bot.threadId,
      title: UNTITLED_THREAD,
      createdAt: bot.createdAt,
      updatedAt: bot.createdAt,
      resumeCursors: {},
      modelSelection: structuredClone(bot.modelSelection),
      unread: false,
      activity: "idle",
      busy: false,
    }];
    this.bots.unshift(bot);
    this.saveBots();
    // The folder exists from the first moment, so the user can open
    // SOUL.md before the bot has said a word. The record is canonical: a
    // mirror-write failure must never fail bot creation.
    try {
      writeSoulMirror(bot.id, bot.soul ?? "");
    } catch (e) {
      console.warn(`[bot-folder] could not write SOUL.md mirror for ${bot.id}: ${(e as Error).message}`);
    }
    // Announce the owner before its onboarding transcript. SSE clients need
    // the bot/thread mapping before they can place either message.
    this.emit({ type: "bot", botId: bot.id });
    // Keep the greeting valid for configured bots and every engine.
    if (opts.seedMessages !== false) {
      this.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `Hi, I'm ${name}. What would you like me to do?`,
      });
    }
    return bot;
  }

  /** All setup fields and the Chief's receipt commit before publishing any
   * mutation. Model defaults never rewrite saved thread selections. */
  applyTeamSetup(request: TeamSetupRequest): TeamSetupResult {
    const chief = this.bot(request.botId);
    if (!chief) throw new Error("The requesting Chief no longer exists");
    if (chief.lastTeamSetupReceipt?.requestId === request.requestId) return chief.lastTeamSetupReceipt.result;
    const managedSections = [...new Set([...(chief.managedSections ?? []), ...request.newTeams])];
    if (managedSections.length > 100 || managedSections.some((name) => name.trim() !== name || name.length > 60) ||
        request.newTeams.some((name) => !name) || (request.newTeams.length && !chief.chiefOfStaff)) throw new Error("Invalid reviewed Chief team scope");
    const nextBots = [...this.bots];
    const changed: BotRecord[] = [];
    for (const operation of request.operations) {
      const at = nextBots.findIndex((bot) => bot.id === operation.botId);
      let next: BotRecord;
      if (operation.action === "create") {
        if (at >= 0 || !operation.threadId || !operation.fields.name || !operation.fields.modelSelection) throw new Error("Invalid new bot in team setup");
        const createdAt = Date.now();
        const modelSelection = this.newBotSelection(operation.fields.modelSelection);
        next = { id: operation.botId, threadId: operation.threadId, name: operation.fields.name,
          title: "", description: "", soul: "", notifications: true, color: COLORS[nextBots.length % COLORS.length], unread: false,
          resumeCursors: {}, createdAt, ...operation.fields, modelSelection,
          approvalMode: "ask", autoApprove: false, composio: false, approvePeerComms: false,
          // A Chief's new teammate is seen by exactly the Chief's audience:
          // a restricted Chief never creates a bot everyone sees.
          ...(chief.visibility && chief.visibility !== "everyone" ? { visibility: structuredClone(chief.visibility) } : {}),
          tasks: [{ threadId: operation.threadId, title: UNTITLED_THREAD, createdAt, updatedAt: createdAt, resumeCursors: {},
            modelSelection: structuredClone(modelSelection), approvalMode: "ask", autoApprove: false,
            unread: false, activity: "idle", busy: false }],
        };
        nextBots.unshift(next);
      } else {
        if (at < 0) throw new Error("A setup target no longer exists");
        const previous = nextBots[at];
        next = { ...previous, ...operation.fields };
        if (operation.fields.modelSelection) next.tasks = previous.tasks?.map((task) => ({
          ...task,
          modelSelection: structuredClone(task.modelSelection ?? previous.modelSelection),
          approvalMode: approvalModeFor(this.projectBotForTask(previous.id, task.threadId)!),
          autoApprove: task.autoApprove ?? previous.autoApprove,
          alwaysAllow: structuredClone(task.alwaysAllow ?? previous.alwaysAllow ?? []),
        }));
        nextBots[at] = next;
      }
      if (operation.fields.chiefOfStaff === false) delete next.managedSections;
      next.section = sectionKey(next.section) || undefined;
      if (operation.fields.soul !== undefined) { next.soulHash = soulHash(operation.fields.soul); next.soulDrift = false; }
      changed.push(next);
    }
    const result: TeamSetupResult = { state: "applied", newTeams: request.newTeams, bots: changed.map((bot, index) => ({
      id: bot.id, name: bot.name, section: bot.section, modelSelection: structuredClone(bot.modelSelection), chiefOfStaff: Boolean(bot.chiefOfStaff),
      action: request.operations[index].action === "create" ? "created" : "updated",
    })) };
    const chiefAt = nextBots.findIndex((bot) => bot.id === chief.id);
    const nextChief = { ...nextBots[chiefAt], lastTeamSetupReceipt: { requestId: request.requestId, result } };
    // Only the newly-created teams explicitly named in the human review may
    // extend this Chief's reach. Existing teams require owner settings.
    if (request.newTeams.length && nextChief.chiefOfStaff) {
      nextChief.managedSections = managedSections;
    }
    nextBots[chiefAt] = nextChief;
    this.saveBots(nextBots);
    this.bots = nextBots;
    for (const bot of changed) {
      try { writeSoulMirror(bot.id, bot.soul ?? ""); } catch (error) {
        console.warn(`[bot-folder] could not refresh reviewed setup mirror for ${bot.id}: ${(error as Error).message}`);
      }
      this.emit({ type: "bot", botId: bot.id });
    }
    this.emit({ type: "bot", botId: chief.id });
    return result;
  }

  deleteBot(id: string, setupRequest?: TeamSetupRequest): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    let nextBots = this.bots.filter((b) => b.id !== id);
    if (setupRequest) {
      const chief = this.bot(setupRequest.botId);
      if (!chief || chief.id === id || setupRequest.deletion?.botId !== id) throw new Error("The reviewed deletion no longer has a valid owner");
      const lastTeamSetupReceipt: NonNullable<BotRecord["lastTeamSetupReceipt"]> = { requestId: setupRequest.requestId, result: { state: "applied", newTeams: [], bots: [
        { id: bot.id, name: bot.name, action: "deleted" },
      ] } };
      nextBots = nextBots.map((candidate) => candidate.id === chief.id ? { ...candidate, lastTeamSetupReceipt } : candidate);
    }
    // Persist removal and the review receipt before deleting conversation or
    // workspace data. A failed save must leave the bot recoverable in place.
    this.saveBots(nextBots);
    this.bots = nextBots;
    this.legacyActivities.delete(id);
    // every task's transcript goes with the bot, not just the open one
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    // the bot's workspace (files + memory) goes with it — same rule as its
    // transcripts: deleting a bot deletes what it knew
    try {
      rmSync(workspaceDir(id), { recursive: true, force: true });
    } catch {}
    // Generated task-workspaces are project files, not bot memory. Keep
    // them (and user-selected cwd folders) when deleting conversations.
    // Approval state deliberately lives outside the bot-writable workspace.
    // It still belongs to the bot, so deleting the bot must remove staged
    // proposals, manifests, and native-link ownership records with it.
    try {
      rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
    } catch {}
    // The bot folder (SOUL.md mirror) is the bot's too.
    removeBotFolder(id);
    this.emit({ type: "bot.deleted", botId: id });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    // Runtime revocations must become effective in memory even when disk is
    // unavailable. Profile edits use the separate atomic path below.
    Object.assign(bot, patch);
    const task = this.activeTask(id);
    if (task) {
      for (const key of ["resumeCursors", "rewound", "pinnedMessageId", "unread"] as const) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          Object.assign(task, { [key]: structuredClone(patch[key]) });
        }
      }
      bot.unread = bot.tasks!.some((candidate) => candidate.unread);
    }
    this.saveBots();
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  /** Voice ids belong to one provider's catalog. Changing the workspace
   * provider invalidates every per-agent selection as one durable mutation,
   * before clients are told to pick replacement voices. */
  clearVoiceSelections(): BotRecord[] {
    const changed = this.bots.filter((bot) => bot.voice !== undefined && bot.voice !== "");
    if (!changed.length) return [];
    const next = this.bots.map((bot) =>
      bot.voice === undefined || bot.voice === "" ? bot : { ...bot, voice: undefined });
    this.saveBots(next);
    for (const bot of changed) {
      delete bot.voice;
      this.emit({ type: "bot", botId: bot.id });
    }
    return changed;
  }

  /** Commit a validated profile change before publishing its fields. Unlike
   * runtime revocation, a failed user edit must leave the old profile intact. */
  patchBotProfile(id: string, patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch };
    if (patch.soul !== undefined) {
      next.soulHash = soulHash(patch.soul);
      next.soulDrift = false;
    }
    // Persist all fields together before publishing anything to the live
    // record. A failed write leaves both memory and disk at the old profile.
    this.saveBots(this.bots.map((candidate) => candidate.id === id ? next : candidate));
    Object.assign(bot, next);
    if (patch.soul !== undefined) {
      try { writeSoulMirror(id, patch.soul); } catch (e) {
        console.warn(`[bot-folder] could not write SOUL.md mirror for ${id}: ${(e as Error).message}`);
      }
    }
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  /** Convenience for a soul-only change. The record is canonical; a failed
   * mirror write is reported in logs and can be retried by discarding drift. */
  setSoul(id: string, soul: string): BotRecord | null {
    return this.patchBotProfile(id, { soul });
  }

  /** File visible bots into one sidebar section as a single durable write.
   *
   * This deliberately stages the complete next file before touching the
   * live records. A missing/hidden target therefore changes nothing, and a
   * failed atomic write cannot leave memory ahead of disk. A Chief collision
   * is refused rather than silently removing somebody's coordinator role. */
  setBotsSection(
    botIds: string[],
    section: string,
  ): { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" } {
    const ids = [...new Set(botIds)];
    const targets = ids.map((id) => this.bot(id));
    if (targets.some((bot) => !bot || bot.hidden)) return { ok: false, reason: "unavailable" };

    const targetSection = sectionKey(section);
    const selected = targets as BotRecord[];
    const destinationChiefIds = new Set([
      ...selected.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id),
      ...this.bots
        .filter((bot) => bot.chiefOfStaff && sectionKey(bot.section) === targetSection)
        .map((bot) => bot.id),
    ]);
    if (destinationChiefIds.size > 1) return { ok: false, reason: "chief-conflict" };

    const patches = new Map<string, Partial<BotRecord>>();
    for (const bot of selected) {
      patches.set(bot.id, { section: targetSection || undefined });
    }

    const changedIds = new Set<string>();
    const nextBots = this.bots.map((bot) => {
      const patch = patches.get(bot.id);
      if (!patch) return bot;
      const next = { ...bot, ...patch };
      if (JSON.stringify(next) !== JSON.stringify(bot)) changedIds.add(bot.id);
      return next;
    });
    if (changedIds.size) {
      this.saveBots(nextBots);
      for (const bot of this.bots) {
        const patch = patches.get(bot.id);
        if (patch) Object.assign(bot, patch);
      }
      for (const botId of changedIds) this.emit({ type: "bot", botId });
    }
    this.rememberSections([targetSection]);
    return { ok: true, bots: ids.map((id) => this.bot(id)!) };
  }

  /** Apply only the membership edits the user made, in one bots-file write. */
  updateTeamMembers(section: string, addIds: string[], removeIds: string[]):
    { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" | "membership-changed" } {
    const key = sectionKey(section);
    if (!key || !this.sections.includes(key)) return { ok: false, reason: "unavailable" };
    const adds = new Set(addIds), removes = new Set(removeIds);
    const ids = new Set([...adds, ...removes]);
    for (const id of ids) {
      const bot = this.bot(id);
      if (!bot || bot.hidden) return { ok: false, reason: "unavailable" };
      if (adds.has(id) && removes.has(id)) return { ok: false, reason: "membership-changed" };
      if (removes.has(id) && sectionKey(bot.section) !== key) return { ok: false, reason: "membership-changed" };
    }
    const next = this.bots.map(bot => ids.has(bot.id)
      ? { ...bot, section: adds.has(bot.id) ? key : undefined } : bot);
    for (const destination of [key, ""]) {
      if (next.filter(bot => bot.chiefOfStaff && sectionKey(bot.section) === destination).length > 1) {
        return { ok: false, reason: "chief-conflict" };
      }
    }
    if (ids.size) {
      this.saveBots(next);
      for (let i = 0; i < next.length; i++) if (ids.has(next[i].id)) Object.assign(this.bots[i], next[i]);
      for (const botId of ids) this.emit({ type: "bot", botId });
    }
    return { ok: true, bots: this.bots.filter(bot => ids.has(bot.id)) };
  }

  /** Legacy bot/room activity occupies its own slot; direct conversations
   * use setTaskActivity so settling one thread cannot clear another. */
  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if ((this.legacyActivities.get(botId) ?? "idle") === activity) return bot;
    this.legacyActivities.set(botId, activity);
    this.refreshBotActivity(bot);
    this.emit({ type: "bot", botId });
    return bot;
  }

  setTaskActivity(botId: string, threadId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const busy = ACTIVITY_BUSY.has(activity);
    if ((task.activity ?? "idle") === activity && Boolean(task.busy) === busy) return bot;
    const wasBusy = Boolean(task.busy);
    task.activity = activity;
    task.busy = busy;
    if (busy && !wasBusy) task.turnStartedAt = Date.now();
    else if (!busy) delete task.turnStartedAt;
    this.refreshBotActivity(bot);
    this.emit({ type: "bot", botId });
    return bot;
  }

  private refreshBotActivity(bot: BotRecord) {
    const activities = [this.legacyActivities.get(bot.id), ...(bot.tasks ?? []).map((task) => task.activity)];
    bot.activity = (["waiting-on-you", "no-signal", "working", "dead"] as const)
      .find((activity) => activities.includes(activity)) ?? "idle";
    bot.busy = ACTIVITY_BUSY.has(bot.activity);
  }

  /** Elect one Chief of Staff in its section (or clear one section) as one persisted change.
   * The changed records are returned so the server can update every open
   * window, including the bot that just handed the role over. */
  setChiefOfStaff(id: string | null, section?: string | null): BotRecord[] | null {
    const selected = id ? this.bot(id) : null;
    if (id && !selected) return null;
    const targetSection = sectionKey(selected?.section ?? section);
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      if (sectionKey(bot.section) !== targetSection) continue;
      const next = bot.id === id;
      if (Boolean(bot.chiefOfStaff) === next && !(next && bot.hidden)) continue;
      if (next) {
        bot.chiefOfStaff = true;
        // A section's main contact must stay reachable in the sidebar.
        bot.hidden = false;
      } else {
        bot.chiefOfStaff = false;
        delete bot.managedSections;
      }
      changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed;
  }

  /** Company instance ids became stable across re-enrolment. Moves every
   * saved reference to an old id onto its replacement in one save: model
   * choices, native resume cursors and handed-message records. An entry that
   * already exists under the new id wins over the old one. */
  renameInstances(ids: ReadonlyMap<string, string>): number {
    const touches = (record?: Record<string, unknown>) => Boolean(record && Object.keys(record).some(key => ids.has(key)));
    const rename = <T>(record: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {};
      for (const [key, value] of Object.entries(record)) {
        const target = ids.get(key);
        if (!target) next[key] = value;
        else if (!Object.prototype.hasOwnProperty.call(record, target)) next[target] = value;
      }
      return next;
    };
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      let dirty = false;
      const selected = ids.get(bot.modelSelection.instanceId);
      if (selected) { bot.modelSelection = { ...bot.modelSelection, instanceId: selected }; dirty = true; }
      if (touches(bot.resumeCursors)) { bot.resumeCursors = rename(bot.resumeCursors); dirty = true; }
      for (const task of bot.tasks ?? []) {
        const taskSelected = task.modelSelection && ids.get(task.modelSelection.instanceId);
        if (task.modelSelection && taskSelected) { task.modelSelection = { ...task.modelSelection, instanceId: taskSelected }; dirty = true; }
        if (touches(task.resumeCursors)) { task.resumeCursors = rename(task.resumeCursors); dirty = true; }
        if (task.handedMessages && touches(task.handedMessages)) { task.handedMessages = rename(task.handedMessages); dirty = true; }
        const last = task.lastInstanceId && ids.get(task.lastInstanceId);
        if (last) { task.lastInstanceId = last; dirty = true; }
      }
      if (dirty) changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed.length;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string) {
    const bot = this.bot(botId);
    if (!bot) return;
    // the cursor belongs to the task that produced it, not to the bot
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (task) task.resumeCursors[instanceId] = cursor;
    // The legacy mirror follows the task visible in chat, never a detached
    // routine task working in the background.
    if (!threadId || bot.threadId === threadId) bot.resumeCursors[instanceId] = cursor;
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** Record which instance just took a turn on this task. Called at
   * dispatch, not at cursor time — transcript-replay engines never
   * produce a cursor, and they still count as having run last. */
  markTaskDispatched(botId: string, threadId: string, instanceId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.lastInstanceId === instanceId) return;
    task.lastInstanceId = instanceId;
    this.saveBots();
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
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    const prev: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
    const cost = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
    const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
    // providers occasionally report NaN or a negative on a partial turn —
    // never let that poison a running tally
    const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    // the cached share exists on a record only once a driver has reported
    // it — a driver that never does leaves the record shaped as before
    const cachedKnown = typeof prev.cachedInput === "number" || typeof turn.cachedInput === "number";
    const prevInput = clean(prev.input);
    const turnInput = clean(turn.input);
    const nextCachedInput = Math.min(clean(prev.cachedInput), prevInput)
      + Math.min(clean(turn.cachedInput), turnInput);
    const contextTokens = clean(turn.context?.tokens);
    const contextWindow = clean(turn.context?.window);
    task.usage = {
      input: prevInput + turnInput,
      output: prev.output + clean(turn.output),
      ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
      costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
      turns: prev.turns + 1,
      lastTurn: {
        input: turnInput, output: clean(turn.output),
        ...(typeof turn.cachedInput === "number" ? { cachedInput: Math.min(clean(turn.cachedInput), turnInput) } : {}),
        costUsd: cost,
      },
      // a turn that reported no context keeps the previous reading rather
      // than pretending the window emptied
      ...(contextTokens > 0
        ? { context: { tokens: contextTokens, ...(contextWindow > 0 ? { window: contextWindow } : {}) } }
        : prev.context ? { context: prev.context } : {}),
    };
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task.usage;
  }

  /** The folder a task's turn runs in. Pins on first call from the bot's
   * current folder — unless the task already has a session (a thread from
   * before folders existed), which pins to the default so the folder can't
   * move under it. Returns the pinned value: a path, or null for default. */
  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean } = {}): string | null {
    const bot = this.bot(botId);
    const task = bot ? this.taskByThread(botId, threadId) : undefined;
    if (!bot || !task) return null;
    if (opts.none) {
      if (task.cwd !== null) {
        task.cwd = null;
        this.saveBots();
        this.emit({ type: "bot", botId });
      }
      return null;
    }
    if (task.cwd === undefined) {
      task.cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
      this.saveBots();
      this.emit({ type: "bot", botId });
    }
    return task.cwd;
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
    const group = this.group(groupId);
    if (!group) return null;
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    // Direct-message channels retain the original single-thread contract.
    if (!task) {
      if (!group.dm) return null;
      if (group.pinnedCwd === undefined) {
        group.pinnedCwd = group.cwd ?? null;
        this.saveGroups();
        this.emit({ type: "group", groupId: group.id });
      }
      return group.pinnedCwd;
    }
    if (task.pinnedCwd === undefined) {
      task.pinnedCwd = group.cwd ?? null;
      if (group.threadId === task.threadId) group.pinnedCwd = task.pinnedCwd;
      this.saveGroups();
      this.emit({ type: "group", groupId: group.id });
    }
    return task.pinnedCwd;
  }

  // ── tasks ─────────────────────────────────────────────────────────────
  project(botId: string, projectId: string): BotProjectRecord | undefined {
    return this.bot(botId)?.projects?.find((project) => project.id === projectId);
  }

  createProject(botId: string, name: string, emoji?: string | null): BotProjectRecord | null {
    const bot = this.bot(botId);
    if (!bot || !name.trim() || (emoji != null && !isProjectEmoji(emoji))) return null;
    const project: BotProjectRecord = {
      id: newId(), name: name.trim().slice(0, 80),
      ...(emoji == null ? {} : { emoji }),
    };
    bot.projects = [...(bot.projects ?? []), project];
    this.saveBots();
    this.emit({ type: "bot", botId });
    return project;
  }

  patchProject(botId: string, projectId: string, patch: { name?: string; emoji?: string | null }): BotProjectRecord | null {
    const project = this.project(botId, projectId);
    if (!project || (patch.name !== undefined && !patch.name.trim()) || (patch.emoji != null && !isProjectEmoji(patch.emoji))) return null;
    if (patch.name !== undefined) project.name = patch.name.trim().slice(0, 80);
    if (patch.emoji === null) delete project.emoji;
    else if (patch.emoji !== undefined) project.emoji = patch.emoji;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return project;
  }

  /** The stored array is the sidebar order; only a full owned permutation is valid. */
  reorderProjects(botId: string, projectIds: string[]): BotProjectRecord[] | null {
    const bot = this.bot(botId);
    const projects = bot?.projects ?? [];
    if (!bot || projectIds.length !== projects.length || new Set(projectIds).size !== projects.length) return null;
    const byId = new Map(projects.map((project) => [project.id, project]));
    if (projectIds.some((id) => !byId.has(id))) return null;
    bot.projects = projectIds.map((id) => byId.get(id)!);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot.projects;
  }

  /** Removing an organizational label never removes its conversations. */
  deleteProject(botId: string, projectId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !this.project(botId, projectId)) return null;
    bot.projects = bot.projects!.filter((project) => project.id !== projectId);
    for (const task of bot.tasks ?? []) {
      if (task.projectId === projectId) delete task.projectId;
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** The first thing the human asked in a thread — a task's natural name. */
  private firstUserLine(threadId: string): string | null {
    const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    return first?.text ? titleFromMessage(first.text) : null;
  }

  tasks(botId: string): TaskRecord[] {
    return this.bot(botId)?.tasks ?? [];
  }

  activeTask(botId: string): TaskRecord | undefined {
    const bot = this.bot(botId);
    return bot?.tasks?.find((t) => t.threadId === bot.threadId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
  }

  /** A turn gets an independent snapshot without changing the selected task
   * or mutating the bot's defaults while another turn is running. */
  projectBotForTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    return {
      ...bot,
      threadId: task.threadId,
      approvalGrant: bot.approvalGrant?.threadOnly && bot.approvalGrant.threadId !== threadId ? undefined : bot.approvalGrant,
      modelSelection: structuredClone(task.modelSelection ?? bot.modelSelection),
      resumeCursors: structuredClone(task.resumeCursors),
      approvalMode: task.approvalMode ?? (task.autoApprove === undefined ? bot.approvalMode : undefined),
      autoApprove: task.autoApprove ?? bot.autoApprove,
      alwaysAllow: structuredClone(task.alwaysAllow ?? bot.alwaysAllow),
      unread: Boolean(task.unread),
      rewound: task.rewound,
      pinnedMessageId: task.pinnedMessageId,
      activity: task.activity ?? "idle",
      busy: Boolean(task.busy),
    };
  }

  patchTask(botId: string, threadId: string, patch: TaskPatch): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    if (patch.projectId !== undefined && !this.project(botId, patch.projectId)) return null;
    for (const key of TASK_PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        Object.assign(task, { [key]: structuredClone(patch[key]) });
      }
    }
    if (typeof patch.title === "string") task.title = patch.title.trim().slice(0, 80) || UNTITLED_THREAD;
    if (Object.prototype.hasOwnProperty.call(patch, "pinned") && task.pinned !== true) delete task.pinned;
    if (bot.threadId === threadId) this.mirrorActiveTask(bot, task);
    bot.unread = bot.tasks!.some((candidate) => candidate.unread);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** A Works on change is the newest explicit choice, so this bot's
   * machine-recorded pins that now point somewhere else give way. A pin a
   * person set, a legacy pin with unknown provenance, and a pin that already
   * matches the new destination survive. Returns how many pins were cleared. */
  clearAutoSurfacePins(botId: string, destination: Destination): number {
    const bot = this.bot(botId);
    if (!bot?.tasks) return 0;
    let cleared = 0;
    for (const task of bot.tasks) {
      if (task.surface === undefined || task.surfaceSource !== "auto" || task.surface === destination) continue;
      task.surface = undefined;
      task.surfaceSource = undefined;
      cleared++;
    }
    if (!cleared) return 0;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return cleared;
  }

  /** Model/provider changes are one configuration transaction: never publish
   * a new provider before its confirmed approval downgrade, or change the
   * default while leaving the selected thread behind after a write failure. */
  switchTaskModel(botId: string, threadId: string, selection: ModelSelection,
    updateBotDefault: boolean, resetApprovalToAsk: boolean, taskPatch: TaskPatch = {}): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const patch = { modelSelection: structuredClone(selection),
      ...(resetApprovalToAsk ? { approvalMode: "ask" as const, autoApprove: false, alwaysAllow: [] } : {}) };
    const nextTask = persistedPin({ ...task, ...taskPatch, ...patch,
      ...(typeof taskPatch.title === "string" ? { title: taskPatch.title.trim().slice(0, 80) || UNTITLED_THREAD } : {}) });
    // Older threads may still inherit settings. Freeze their effective
    // values before updating the default so "other threads unchanged" also
    // holds for workspaces created before per-thread approval settings.
    const nextTasks = bot.tasks!.map((candidate) => candidate === task ? nextTask : !updateBotDefault ? candidate : {
      ...candidate,
      modelSelection: structuredClone(candidate.modelSelection ?? bot.modelSelection),
      approvalMode: approvalModeFor(this.projectBotForTask(botId, candidate.threadId)!),
      autoApprove: candidate.autoApprove ?? bot.autoApprove,
      alwaysAllow: structuredClone(candidate.alwaysAllow ?? bot.alwaysAllow ?? []),
    });
    const next = { ...bot, ...(updateBotDefault ? patch : {}),
      tasks: nextTasks };
    this.saveBots(this.bots.map((candidate) => candidate === bot ? next : candidate));
    bot.tasks!.forEach((candidate, index) => Object.assign(candidate, nextTasks[index]));
    if (updateBotDefault) Object.assign(bot, patch);
    this.emit({ type: "bot", botId });
    return task;
  }

  /** One durable write: never leave only part of a bot's threads updated. */
  setAllThreadApprovalMode(botId: string, mode: "full" | "ask"): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const patch = { approvalMode: mode, autoApprove: false, alwaysAllow: [] };
    const tasks = (bot.tasks ?? []).map(task => ({ ...task, ...patch }));
    const next = { ...bot, ...patch, approvalGrant: undefined, tasks };
    this.saveBots(this.bots.map(candidate => candidate === bot ? next : candidate));
    bot.tasks?.forEach((task, index) => Object.assign(task, tasks[index]));
    Object.assign(bot, patch, { approvalGrant: undefined });
    this.emit({ type: "bot", botId });
    return bot;
  }

  private mirrorActiveTask(bot: BotRecord, task: TaskRecord) {
    bot.threadId = task.threadId;
    bot.resumeCursors = structuredClone(task.resumeCursors);
    bot.rewound = task.rewound;
    bot.pinnedMessageId = task.pinnedMessageId;
  }

  /** A fresh context on the same bot: new thread, new session, same
   * persona/tools/computer. Becomes the active task. */
  createTask(botId: string, title?: string, activate = true, projectId?: string, openedBy?: TaskOpenedBy, approvalMode?: "ask" | "full"): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if (projectId !== undefined && !this.project(botId, projectId)) return null;
    const createdAt = Date.now();
    const task: TaskRecord = {
      threadId: newId(),
      title: threadTitleFrom(title),
      createdAt,
      updatedAt: createdAt,
      ...(projectId ? { projectId } : {}),
      ...(openedBy ? { openedBy: structuredClone(openedBy) } : {}),
      resumeCursors: {},
      modelSelection: structuredClone(bot.modelSelection),
      approvalMode: approvalMode ?? approvalModeFor(bot),
      autoApprove: approvalMode ? false : Boolean(bot.autoApprove),
      alwaysAllow: approvalMode ? [] : [...(bot.alwaysAllow ?? [])],
      unread: false,
      activity: "idle",
      busy: false,
    };
    bot.tasks = [task, ...(bot.tasks ?? [])];
    if (activate) {
      this.mirrorActiveTask(bot, task);
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Attach (or complete) the opener record after the thread exists — the
   * handoff id is only known once the thread it targets has an id, so a
   * peer-opened thread is created first and stamped second. Never reachable
   * from the HTTP task PATCH: openedBy is not a TASK_PATCH_FIELD. */
  setTaskOpenedBy(botId: string, threadId: string, openedBy: TaskOpenedBy): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    task.openedBy = structuredClone(openedBy);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Stamp or clear the closer record. `null` reopens: the next turn in a
   * closed thread calls this so the row comes back to the sidebar. Never
   * reachable from the HTTP task PATCH: closedBy is not a TASK_PATCH_FIELD. */
  setTaskClosedBy(botId: string, threadId: string, closedBy: TaskClosedBy | null): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    if (closedBy) task.closedBy = structuredClone(closedBy);
    else if (!task.closedBy) return task;
    else delete task.closedBy;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Where a bot-to-bot send outside a room lands: the PAIR CONVERSATION
   * for (sender, recipient) — the recipient's task stamped `openedBy` this
   * sender with kind "pair".
   *
   * Its scope is global for those two bots: deliberately not per source
   * thread and not per assignment, so a teammate you work with all day is
   * one readable row in the recipient's sidebar that remembers what was
   * asked last time, instead of one row per message. Nothing about the
   * caller's current turn takes part in choosing it — no dispatch
   * generation, no request key — and never the recipient's selected
   * thread, which belongs to the person.
   *
   * Two things bend that rule, both deliberately:
   *
   *   adoption — a recipient still carrying threads this sender opened
   *   before pair conversations existed (one per assignment, each titled
   *   with a sliced brief) has its most recently active one stamped as the
   *   pair conversation instead of gaining yet another row, so the sprawl
   *   stops on upgrade day. Nothing is deleted or closed. A start_thread
   *   handoff is left alone: the sender named that job itself and tracks
   *   it by its own delegation id.
   *
   *   concurrency — a second assignment arriving while the pair
   *   conversation is still working (`working`, which the caller answers
   *   from live turn state) gets its own work thread, so two jobs never
   *   interleave in one transcript. `label` names that thread; the caller
   *   closes it once its result has been reported. A pair conversation
   *   never auto-closes. */

  /** The identity a peer-opened row belongs to: its opener's id while that
   * bot lives, else the one live bot the stamp's name still points at —
   * what a deleted-and-recreated same-name bot inherits — else the dead id
   * itself. A name two live bots share resolves to nobody's twin:
   * ambiguous means unmatched, never a wrong merge. */
  private openerIdentity(openedBy: TaskOpenedBy): string {
    if (this.bot(openedBy.botId)) return openedBy.botId;
    const named = this.bots.filter((bot) => bot.name === openedBy.name);
    return named.length === 1 ? named[0].id : openedBy.botId;
  }

  resolvePairConversation(
    sender: Pick<BotRecord, "id" | "name">,
    recipientId: string,
    options: { label?: string; working: (threadId: string) => boolean },
  ): { task: TaskRecord; created: boolean } | null {
    if (!this.bot(recipientId)) return null;
    const title = `@${sender.name}`;
    const opener = (kind: "pair" | "work", at = Date.now()): TaskOpenedBy => ({ botId: sender.id, name: sender.name, kind, at });
    // Identity-stable: the sender's own rows, plus ones a deleted
    // predecessor opened when the stamp's name still points at exactly
    // this bot — a same-name recreation inherits the conversation instead
    // of minting a twin while the old row dangles live. A name two live
    // bots share matches nobody's inheritance: refusing the fallback can
    // cost a new row, never merge two bots' histories.
    const fromSender = this.tasks(recipientId).filter((task) => task.openedBy && this.openerIdentity(task.openedBy) === sender.id);
    let pair = fromSender.find((task) => task.openedBy?.kind === "pair");
    if (!pair) {
      const lastActivity = (task: TaskRecord) =>
        this.messagesTail(task.threadId, 1).messages.at(-1)?.at ?? task.openedBy?.at ?? task.createdAt;
      const adopted = fromSender
        .filter((task) => !task.openedBy?.kind && !task.openedBy?.delegationId && !task.closedBy)
        .sort((a, b) => lastActivity(b) - lastActivity(a))[0];
      if (adopted) {
        // Keep the hour it was really opened: list_threads and the sidebar
        // order by it, and adoption is not a new conversation.
        this.setTaskOpenedBy(recipientId, adopted.threadId, opener("pair", adopted.openedBy?.at ?? adopted.createdAt));
        // The title changes only when nobody typed it. The rule: rename it
        // when it still equals what createTask made of the assignment that
        // opened the thread — and that assignment is still the thread's
        // first message, "@Recipient <brief>" — so the comparison is
        // threadTitleFrom(that brief). Anything else is a name a person
        // chose, and a thread with no request to read (its handoff never
        // ran) cannot be checked, so both keep the title they have.
        if (adopted.title === this.openingRequestTitle(recipientId, adopted.threadId)) {
          this.renameTask(recipientId, adopted.threadId, title);
        }
        pair = adopted;
      }
    }
    if (pair && !options.working(pair.threadId)) {
      // A conversation the sender closed after reading a result is picked
      // back up, never replaced: closing is only the sidebar's idle state.
      if (pair.closedBy) this.setTaskClosedBy(recipientId, pair.threadId, null);
      // An inherited row carries the predecessor's id; rebind it to the
      // live bot so the name fallback is needed only once — a namesake
      // appearing later cannot claim the row. The hour it was opened
      // stays: inheritance is not a new conversation.
      const inherited = pair.openedBy;
      if (inherited && inherited.botId !== sender.id) {
        this.setTaskOpenedBy(recipientId, pair.threadId, { ...inherited, botId: sender.id, name: sender.name });
      }
      return { task: pair, created: false };
    }
    // The brief is never a title. An 80-character slice of an assignment
    // is the row nobody can read, and a durable conversation outlives the
    // one brief that opened it.
    const task = this.createTask(recipientId, pair ? `${title} · ${options.label || "parallel work"}` : title,
      false, undefined, opener(pair ? "work" : "pair"));
    return task ? { task, created: true } : null;
  }

  /** The title a peer-opened thread was born with: what createTask made of
   * the request that opened it, which is still the first message in it,
   * addressed "@Recipient <brief>". null when there is no such message to
   * read — an unrun handoff proves nothing about who named the row. */
  private openingRequestTitle(recipientId: string, threadId: string): string | null {
    const first = this.messagesFor(threadId)[0]?.text?.trim();
    if (!first) return null;
    const addressed = `@${this.bot(recipientId)?.name ?? ""} `;
    return threadTitleFrom(first.startsWith(addressed) ? first.slice(addressed.length) : first);
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    this.mirrorActiveTask(bot, task);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    return this.patchTask(botId, threadId, { title });
  }

  /** Name a task after its first message, once. Returns the task it named
   * so a caller can later replace exactly that machine-made title — and
   * can see the peer provenance it must leave alone. */
  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string): TaskRecord | null {
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!task || task.titleFromFirstMessage || (task.title !== UNTITLED_TASK && task.title !== UNTITLED_THREAD)) return null;
    task.title = titleFromMessage(text);
    task.titleFromFirstMessage = true;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Swap a machine-made first-message title for a generated one, once.
   * Equality against the snippet is the whole contract: a rename by the
   * person, by pair adoption, or by an earlier generated title each break
   * it, so this never overwrites a name anyone chose. */
  retitleTask(botId: string, threadId: string, machineTitle: string, title: string): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.title !== machineTitle) return null;
    return this.renameTask(botId, threadId, threadTitleFrom(title));
  }

  /** Delete a task and its transcript, retaining generated project files.
   * When no visible tasks remain, replace it with a fresh conversation. */
  deleteTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot?.tasks) return null;
    if (!bot.tasks.some((t) => t.threadId === threadId)) return null;
    bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
    const visible = bot.tasks.find((task) => !task.routineRunId)
      ?? this.createTask(botId, undefined, bot.threadId === threadId)!;
    if (bot.threadId === threadId || this.taskByThread(botId, bot.threadId)?.routineRunId) {
      this.mirrorActiveTask(bot, visible);
    }
    this.deleteThreadRecord(threadId);
    bot.unread = bot.tasks.some((task) => task.unread);
    this.refreshBotActivity(bot);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** First-run seed: one bot so the app never opens empty — it gets a
   * random friendly name like every other bot. */
  seedIfEmpty() {
    if (this.bots.length) return;
    this.createBot();
  }
}
