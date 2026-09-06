// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { removeBotFolder, soulFile, soulHash, writeSoulMirror } from "./bot-folder.ts";
import type { BotProfilePatch } from "./bot-profile.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR, loadBrowserProfileIdAliases } from "./config.ts";
import * as mdb from "./message-db.ts";
import { workspaceDir } from "./workspace.ts";
import { newId, type CloudBackend, type ModelSelection, type ThreadId } from "./contracts.ts";
import { pickBotName } from "./names.ts";
import { redactSecretsInText } from "./redact.ts";
import { botAvatarProfile, type BotAvatarCrop } from "../shared/bot-avatar.ts";
import { isApprovalMode, type ApprovalMode } from "../shared/approval-mode.ts";
import type { MascotBodyId } from "../shared/mascot-bodies.ts";
import type { ProfileRequestCardData, ProfileRequestChanges } from "../shared/profile-request.ts";
import type { RoutineRequestCardData } from "../shared/routine-request.ts";
import type { RoutineRunCardData } from "../shared/routine-run.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";
import type { GroupGoalRunCardData } from "../shared/group-goal-run.ts";

export type MausColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type MausExpression = string;

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission cards: the tool being requested, so the card can show what
   * is actually being asked and offer "always allow this tool". */
  tool?: string;
  /** why this stopped despite auto mode (destructive-looking command) */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  /** Local actions never share remembered grants with cloud/tool approvals. */
  approvalScope?: "local-computer";
  /** A durable chat-created routine proposal. The scheduler only applies it
   * after this card is explicitly confirmed by the user. */
  routineRequest?: RoutineRequestCardData;
  /** A durable profile-change proposal (propose_profile). The change lands
   * only after this card is explicitly confirmed by the user. */
  profileRequest?: ProfileRequestCardData;
  /** A durable learned-skill proposal. The skill stays staged until the
   * user confirms this card — it never rides the prompt before that. */
  skillRequest?: SkillRequestCardData;
}

export interface ConnectorCardData {
  /** Composio toolkit slug. It is validated server-side before every action. */
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  /** Cards created by one agent request resume together after all connect. */
  resumeKey: string;
  /** Account alias supplied by the agent when adding a second (or first) account. */
  alias?: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  /** Fixed allowlisted credential id; never an arbitrary config path. */
  target: import("../shared/credential-request.ts").CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  /** Exact successful HPKE operation. This contains no plaintext and prevents
   * a freshly sealed value from being mistaken for a lost-response retry. */
  phoneOperationId?: string;
  provided?: boolean;
  dismissed?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "goal.run";
  text?: string;
  /** Durable provider output stored by the harness. Paths always point into
   * OpenMausBot's private attachment directory; renderers receive only the
   * existing allowlisted /api/attachments URL. */
  attachments?: Array<{ kind: "image"; path: string; mime: string }>;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** One idempotently updated status card in the conversation that created a
   * routine. The actual provider turn remains in its isolated task. */
  routineRun?: RoutineRunCardData;
  /** Terminal receipt for a bounded multi-bot channel goal. */
  goalRun?: GroupGoalRunCardData;
  /** activity messages: tool name + outcome. `spoken` is the same chip as
   * a phrase a voice can read ("reading a file") — computed once here so
   * call mode never has to re-derive it from the raw tool name, and absent
   * for chips not worth interrupting the ear for. */
  /** `setup` marks an error the user fixes by installing or configuring
   * something — the UI offers setup instead of a retry that cannot work. */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean };
  /** user messages sent INTO a running turn (capabilities.queueing): the
   * model saw it mid-turn, so the transcript marks it — a reader should
   * know the reply above it may already account for this line */
  steered?: boolean;
  /** A user-role message that did not come from a person at a keyboard:
   * a headless server's HTTP API, reached with no paired session and no
   * browser origin — which is to say, most often a script, and possibly a
   * bot's own shell. Stamped rather than refused because loopback is the
   * owner on such a server by design; but a reader (a bot's room turn, the
   * posting budget, the transcript) must not take it for the person. */
  via?: "api";
  /** Provider turn that produced this message. Assistant output can arrive
   * in several pieces around tool calls; the UI uses this identity to keep
   * those pieces together without discarding them. */
  turnId?: string;
  /** The last assistant text item from a settled provider turn. Earlier text
   * with the same turnId is progress narration, not another final answer. */
  turnTerminal?: boolean;
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Optional flat reply reference. Unlike parentId this never changes the
   * conversation branch; it only quotes one earlier text message inline. */
  replyToId?: string;
  /** Stable client identity for at-most-once chat POST retries. */
  sendId?: string;
  /** Per-send channel behavior. Absent is legacy quick chat. */
  channelMode?: "chat" | "goal";
  /** group threads: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: string };
  /** Set on a room message a bot pushed in with post_to_room instead of by
   * taking a turn there. Internal transport changes custody, not authorship:
   * a reader's turn wraps this one in a provenance preamble rather than
   * letting it read as ordinary room conversation. `unattended` records that
   * nobody was watching the bot that posted it. */
  peerPost?: { unattended?: boolean };
  /** Set on the user-role line another bot delivered with ask_bot into this
   * bot's own conversation. The text opens with the provenance note, but a
   * reader that windows into the message (recall snippets, a renderer) never
   * sees the opening — this is the same fact where it cannot be cut off.
   * `unattended` records that nobody was watching the bot that asked. */
  peerAsk?: { botId: string; name: string; unattended?: boolean };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" in the caller's chat, linking to the
   * bot⇄bot channel where the exchange is mirrored. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: string };
  /** user messages sent while the bot was mid-turn, waiting in the
   * steer-queue to auto-send on settle. Cleared when the drain consumes
   * them; a true stranded by a restart is inert because the client only
   * shows the affordance while the bot is busy. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. The client pending
   * chip matches on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** One independent conversation inside a user-created channel. Channel
 * membership and instructions stay on GroupRecord; transcript-bound state
 * lives here so switching tasks never moves a pin or working directory into
 * another provider context. */
export interface GroupTaskRecord {
  threadId: ThreadId;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

/** A room: a shared thread where several bots + the user talk. Plain
 * messages follow `defaultResponder`; explicit @mentions always override it.
 * The bulletin is the room's shared instructions — every member's turn gets
 * it as part of its system prompt. */
export interface GroupRecord {
  id: string;
  /** The active task's thread. Direct-message channels remain single-threaded. */
  threadId: ThreadId;
  /** User-created channels have independent tasks, newest first. */
  tasks?: GroupTaskRecord[];
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** true for auto-created bot⇄bot channels (ask_bot exchanges live here;
   * the user can open the channel and chip in) */
  dm?: boolean;
  /** transient: the member currently running a turn (never persisted) */
  busyBotId?: string | null;
  /** the room's shared desk: where member turns run their shell tools,
   * overriding each member's own folder. The room pins its own copy on its
   * first turn (pinnedCwd). Absent = each member's own default. */
  cwd?: string;
  /** Compatibility mirror of the active task's pinned folder. */
  pinnedCwd?: string | null;
  /** Compatibility mirror of the active task's pinned message. */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under; shares the bots'
   * namespace so one heading can hold a project's room and its people */
  section?: string;
  /** New user-created rooms start with setup pending. Null timestamps are
   * intentional: records from before room setup has existed omit both keys
   * and remain immediately usable. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
}

/** One task = one conversation with its own context.
 *
 * A bot used to be a single endless thread, which meant every job
 * contaminated the next and the only way to get a clean slate was to
 * clone the bot. A task is that clean slate: its own thread, its own
 * transcript, and — the part that actually matters — its own provider
 * session. Sharing resume cursors between tasks would resume the other
 * task's session and quietly undo the whole thing. */
export interface TaskRecord {
  threadId: ThreadId;
  title: string;
  createdAt: number;
  /** provider-native continuation per instance, for THIS task only */
  resumeCursors: Record<string, unknown>;
  /** which instance dispatched the most recent turn. A cursor alone can't
   * say whether an engine's session is current — another engine may have
   * taken turns since — so this is what decides an inline replay. Absent
   * on tasks from before the field existed. */
  lastInstanceId?: string;
  /** what this task has spent: banked once per turn from turn.completed */
  usage?: TaskUsage;
  /** the folder this task's turns run in, pinned on its first turn from
   * the bot's `cwd` at that moment. Pinned, not read live: Claude keeps
   * sessions per project directory and Codex threads carry their cwd, so
   * a folder that moved under a live session would break resume. `null`
   * = pinned to the default (home); absent = not pinned yet. */
  cwd?: string | null;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** The part of `input` the provider served from its prompt cache — context
   * the model re-read rather than fresh text. Every turn resends the whole
   * conversation plus the system prompt and tool schemas, so on a chatty
   * thread this is most of `input`. Absent on records from older builds. */
  cachedInput?: number;
  /** null until any turn reports a cost — most engines never do. Records
   * written by builds before cost existed lack the field; read as null. */
  costUsd: number | null;
  turns: number;
}

/** Everything the BOT authored is scrubbed of content-shaped secrets before
 * it is stored: its reply text, a tool title (an ACP engine's title can be
 * the whole command line), a permission card's summary. What the user typed
 * is theirs and stays as typed. Stored, not just displayed: the transcript
 * is replayed into every rebuild, and a leaked key would otherwise be
 * permanent. */
function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  if (out.tool?.name) out.tool = { ...out.tool, name: redactSecretsInText(out.tool.name) };
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
export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
/** The states in which the bot cannot take a new message. */
export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

export type StoreChange =
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

/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

export interface BotRecord {
  id: string;
  /** the ACTIVE task's thread — everything that runs a turn reads this */
  threadId: ThreadId;
  /** every task this bot has, newest first */
  tasks?: TaskRecord[];
  name: string;
  title: string;
  description: string;
  /** Standing instructions — the persona body. Canonical HERE; SOUL.md in
   * the bot folder is a mirror the server writes. Never read the file to
   * build a prompt: a bot that reads untrusted content must not be able to
   * rewrite its own persona through the filesystem. Optional only so a
   * bots.json written before the field existed still parses; load
   * backfills it, so every live record has a string. */
  soul?: string;
  /** sha256 of `soul`, for spotting a SOUL.md edited outside the app. */
  soulHash?: string;
  /** The mirror differed from `soul` at the last turn dispatch. The Soul
   * editor shows the diff; a user action (apply or discard) clears it. */
  soulDrift?: boolean;
  /** Receipt committed with a confirmed profile, for retrying card settlement. */
  lastProfileRequestId?: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: MausExpression | null;
  mascotBody?: MascotBodyId | null;
  /** App-owned attachment served as this bot's custom profile image. */
  avatarUrl?: string;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  modelSelection: ModelSelection;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** where the bot works ("Works on"): its cloud box, the Local VM, this
   * computer (local CUA), only the built-in browser tab, or nowhere.
   * Unset = auto (box when it exists, else local when available). */
  computer?: "cloud" | "vm" | "local" | "browser" | "off";
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Auto mode may prepare/start this bot's managed VPS container. Off by
   * default because starting remote infrastructure is an external action. */
  autoStartVps?: boolean;
  /** where NEW tasks run their shell tools; each task pins its own copy
   * on its first turn (TaskRecord.cwd). Absent = the home folder. */
  cwd?: string;
  /** Auto mode: the bot approves its own tool permissions and keeps
   * working instead of stopping to ask. Questions it asks YOU still come
   * through, and a short list of destructive commands still stops it. */
  autoApprove?: boolean;
  /** Canonical approval level. Missing means a legacy record and resolves
   * through autoApprove (true = safe Auto, otherwise Ask). */
  approvalMode?: ApprovalMode;
  /** Server-private elevation journal. Full/Custom executes as Ask until
   * Electron confirms the exact prepared reply and then activates it over
   * the utility-process channel. Any marker surviving a restart is revoked
   * during Store load. */
  approvalGrant?: {
    requestId: string;
    mode: "full" | "custom";
    phase: "prepared" | "confirmed" | "activated" | "committed";
  };
  /** Optional model review of otherwise undecided, attended approval cards.
   * Unknown persisted values are treated as off by the review boundary. */
  autoReview?: "off" | "shadow" | "enforce";
  /** Tools this bot may always use without asking, even outside auto mode
   * (set by "Always allow" on an approval card). */
  alwaysAllow?: string[];
  /** Speak this bot's replies aloud as they settle, without being asked.
   * Off by default: a hosted voice costs money per character, so speaking
   * is something you turn on, never something that happens to you. */
  speakReplies?: boolean;
  /** This bot's own voice id, so a room of bots doesn't sound like one
   * person. Falls back to the app-wide voice in config. */
  voice?: string;
  /** true after an edit/branch-switch rewound the visible conversation:
   * provider sessions still hold the abandoned branch, so the next turn
   * must start fresh (drop cursors) and replay the surviving path. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** Optional labeled divider used to organize this bot in the sidebar. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread; a pin
   * that no longer resolves (branch switched away, deleted) renders nothing */
  pinnedMessageId?: string;
  /** The coordinator for this bot's sidebar section. The store enforces
   * at most one Chief per section (including the unsectioned area). */
  chiefOfStaff?: boolean;
  /** Pause for human approval before this bot talks to a peer (ask_bot,
   * delegate_bot). Off by default: a chief-of-staff-style bot is most
   * useful when it can coordinate without nagging. */
  approvePeerComms?: boolean;
  /** Bot ids this bot is allowed to contact. Unset keeps the rule the app
   * shipped with — every visible bot in the same section — because that is
   * what every existing workspace already relies on. An explicit list wires
   * this bot to exactly those peers (and `[]` to none), which is the only
   * way to bound one bot's reach inside the unsectioned team, where every
   * bot the user never filed shares a section. Enforced in one place, by
   * peer-roster.ts, for the roster, list_bots, ask_bot and delegate_bot
   * alike. */
  peers?: string[];
  /** Whether this bot may use the workspace's connected apps (Composio).
   * Unset/true = allowed (the user configured the key deliberately);
   * false = this bot never receives the connection. Imported team members
   * start false — a shared persona must not reach the user's Gmail on
   * turn one. */
  composio?: boolean;
  /** Whether this bot gets the app's built-in browser (the Browser tab of
   * the computer panel). On unless switched off. */
  browser?: boolean;
  /** Id of a named browser profile from config.browserProfiles; absent = the
   * bot's own private session. */
  browserProfile?: string;
  /** Public, package-authored playbooks installed for this bot. They carry
   * process guidance only—never executable code, credentials, or grants. */
  playbooks?: InstalledPlaybook[];
  /** Listing provenance and connector intent retained for package details
   * and future re-export. It never means the apps are authorized. */
  installedPackage?: InstalledPackageMetadata;
  /** Derived from `activity` — kept so the 200+ readers across the app and
   * tests keep working unchanged. Write through setActivity(), never here. */
  busy?: boolean;
  /** What the bot is doing right now, as the harness sees it. `busy` alone
   * could not tell working from waiting-on-you from a stalled engine.
   * Transient like busy: reset to idle on load. */
  activity?: BotActivity;
  createdAt: number;
}

export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: Array<{ slug: string; label: string; reason: string; optional?: boolean }>;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
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
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length]; // must not run into a longer word
      return after === undefined || !/[a-z0-9]/i.test(after);
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
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
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
  private listeners = new Set<(change: StoreChange) => void>();

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
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
        b.approvalMode = "ask";
        b.autoApprove = false;
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
    if (botsMigrated) this.saveBots();
    if (groupsMigrated) this.saveGroups();
    // bots saved before tasks existed have one endless thread; adopt it as
    // their first task so nothing is lost and nothing special-cases it
    for (const b of this.bots) {
      if (b.tasks?.length) continue;
      b.tasks = [
        {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        },
      ];
    }
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
  }

  private saveBots(bots: BotRecord[] = this.bots) {
    writeFileAtomic(BOTS_FILE, JSON.stringify(bots, null, 2));
  }

  private saveGroups() {
    writeFileAtomic(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId: _busyBotId, ...g }) => g), null, 2));
  }

  // ── groups ────────────────────────────────────────────────────────────
  /** Subscribe to every write. Listeners run after the write and after
   * save; a throwing listener never breaks the write. */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange) {
    for (const listener of [...this.listeners]) {
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
      group.tasks = [{ threadId, title: UNTITLED_TASK, createdAt }];
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

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    Object.assign(group, patch);
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

  /** A thread's durable record: DB rows plus any legacy JSON leftovers. */
  private deleteThreadRecord(threadId: string) {
    this.threads.delete(threadId);
    mdb.deleteThread(threadId);
    for (const file of [messagesFile(threadId), `${messagesFile(threadId)}.imported`]) {
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
    const task: GroupTaskRecord = {
      threadId: newId(),
      title: title?.trim().slice(0, 80) || UNTITLED_TASK,
      createdAt: Date.now(),
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

  renameGroupTask(groupId: string, threadId: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string) {
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.saveGroups();
    this.emit({ type: "group", groupId });
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
    let t = this.threads.get(threadId);
    if (t) return t;
    // SQLite is the source of truth; a thread with no rows imports its
    // legacy messages-<threadId>.json once, inside readThread
    const { messages, activeLeafId: storedLeaf } = mdb.readThread(threadId, messagesFile(threadId));
    let activeLeafId = storedLeaf;
    // legacy rows carry no parentId — chain them in array order
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    if (!activeLeafId) activeLeafId = messages.at(-1)?.id ?? null;
    t = { messages, activeLeafId };
    this.threads.set(threadId, t);
    return t;
  }

  messagesFor(threadId: string): Message[] {
    return this.thread(threadId).messages;
  }

  /** Used only with newly allocated import threads. No live actions are
   * replayed: the importer supplies inert text and freshly remapped IDs. */
  importTranscript(threadId: string, messages: Message[], activeLeafId: string | null): void {
    if (this.messagesFor(threadId).length) throw new Error("Cannot import over an existing conversation");
    mdb.importThread(threadId, messages, activeLeafId);
    this.threads.delete(threadId);
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

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const t = this.thread(threadId);
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
    t.messages.push(full);
    t.activeLeafId = full.id;
    mdb.appendMessage(threadId, full);
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
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
    this.emit({ type: "message", threadId, message: full });
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

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    const next = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
    // SQLite is the durable source of truth. Persist before changing memory so
    // a failed write cannot make this process believe a card was answered
    // while a restart would still show it as pending.
    mdb.updateMessage(threadId, next);
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
      unread: false,
      modelSelection: profile.modelSelection ?? this.defaultSelection(),
      resumeCursors: {},
      createdAt: Date.now(),
    };
    if (section) bot.section = section;
    bot.tasks = [{ threadId: bot.threadId, title: UNTITLED_TASK, createdAt: bot.createdAt, resumeCursors: {} }];
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

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    // every task's transcript goes with the bot, not just the open one
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    // the bot's workspace (files + memory) goes with it — same rule as its
    // transcripts: deleting a bot deletes what it knew
    try {
      rmSync(workspaceDir(id), { recursive: true, force: true });
    } catch {}
    // Approval state deliberately lives outside the bot-writable workspace.
    // It still belongs to the bot, so deleting the bot must remove staged
    // proposals, manifests, and native-link ownership records with it.
    try {
      rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
    } catch {}
    // The bot folder (SOUL.md mirror) is the bot's too.
    removeBotFolder(id);
    this.saveBots();
    this.emit({ type: "bot.deleted", botId: id });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    // Runtime revocations must become effective in memory even when disk is
    // unavailable. Profile edits use the separate atomic path below.
    Object.assign(bot, patch);
    this.saveBots();
    this.emit({ type: "bot", botId: id });
    return bot;
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
    return { ok: true, bots: ids.map((id) => this.bot(id)!) };
  }

  /** The one way runtime state changes. Sets `activity` and derives `busy`
   * from it, so a reader that only knows busy sees the same truth. */
  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const busy = ACTIVITY_BUSY.has(activity);
    if (bot.activity === activity && Boolean(bot.busy) === busy) return bot;
    bot.activity = activity;
    bot.busy = busy;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
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
      }
      changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed;
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

  /** Bank one settled turn onto its task. Called once per turn.completed;
   * the running per-driver token indicator is deliberately not used here
   * because its meaning differs by driver. */
  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null },
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
    task.usage = {
      input: prevInput + turnInput,
      output: prev.output + clean(turn.output),
      ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
      costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
      turns: prev.turns + 1,
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

  /** A fresh context on the same bot: new thread, new session, same
   * persona/tools/computer. Becomes the active task. */
  createTask(botId: string, title?: string, activate = true): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const task: TaskRecord = {
      threadId: newId(),
      title: title?.trim() || UNTITLED_TASK,
      createdAt: Date.now(),
      resumeCursors: {},
    };
    bot.tasks = [task, ...(bot.tasks ?? [])];
    if (activate) {
      bot.threadId = task.threadId;
      bot.resumeCursors = {}; // legacy mirror follows the active task
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    bot.threadId = task.threadId;
    bot.resumeCursors = { ...task.resumeCursors };
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    const task = this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Name a task after its first message, once. */
  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string) {
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** Delete a task and its transcript. A bot always keeps one. */
  deleteTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !bot.tasks || bot.tasks.length < 2) return null;
    if (!bot.tasks.some((t) => t.threadId === threadId)) return null;
    bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (bot.threadId === threadId) {
      bot.threadId = bot.tasks[0]!.threadId;
      bot.resumeCursors = { ...bot.tasks[0]!.resumeCursors };
    }
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
