/**
 * Buddy states. The first group is live: Studio derives it from what a Buddy
 * is doing right now. The rest are resting expressions a Buddy can be given,
 * kept under the names earlier avatars stored so saved appearances still load.
 */
export const LIVE_STATES = [
  "working",
  "thinking",
  "writing",
  "searching",
  "preview",
  "testing",
  "listening",
  "queued",
  "connecting",
  "attention",
  "notifying",
  "error",
  "limited",
  "paused",
  "success",
  "celebrate",
] as const;

export const EXPRESSION_STATES = [
  "idle",
  "happy",
  "curious",
  "excited",
  "proud",
  "playful",
  "shy",
  "drowsy",
  "sleeping",
  "suspicious",
  "confused",
  "sad",
  "surprised",
] as const;

/** Names earlier avatar engines stored; each still renders, as its nearest Buddy look. */
const RETIRED_STATES = [
  "waking",
  "angry",
  "bored",
  "laughing",
  "scared",
  "orbit",
  "radar",
  "progress",
  "spawning",
  "humming",
  "loading",
  "dictating",
  "sending",
  "receiving",
  "uploading",
  "alerting",
  "bouncing",
  "dragging",
  "powering-down",
] as const;

export type MausState =
  | (typeof LIVE_STATES)[number]
  | (typeof EXPRESSION_STATES)[number]
  | (typeof RETIRED_STATES)[number];

export const MAUS_STATES: MausState[] = [...LIVE_STATES, ...EXPRESSION_STATES, ...RETIRED_STATES];

export const STATE_GROUPS: Record<string, MausState[]> = {
  Live: [...LIVE_STATES],
  Expressions: [...EXPRESSION_STATES],
};

export const MAUS_COLOR_NAMES = [
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
  "mint",
] as const;

export type MausColor = (typeof MAUS_COLOR_NAMES)[number];

export const MAUS_COLORS: Record<MausColor, string> = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
  /** the color the Buddy artwork ships in */
  mint: "#00C9A8",
};

export const MAUS_MOTIONS = [
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "blink",
  "surprise",
  "failure",
] as const;

export type MausMotion = "none" | (typeof MAUS_MOTIONS)[number];

/**
 * The first avatar had ten hand-drawn faces. Buddies saved under that
 * vocabulary still carry one of these names, so they are translated on read
 * rather than migrated in place — a stored face should survive a downgrade too.
 */
const LEGACY_STATES: Record<string, MausState> = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "sad",
  mischievous: "playful",
};

const KNOWN_STATES = new Set<string>(MAUS_STATES);

/** Resolves any stored value — current, legacy or junk — to a real state. */
export function normalizeState(value: string | null | undefined): MausState | null {
  if (!value) return null;
  if (KNOWN_STATES.has(value)) return value as MausState;
  return LEGACY_STATES[value] ?? null;
}

/** Resting expressions offered in the appearance picker; each one looks distinct. */
export const PICKABLE_STATES: MausState[] = [
  "idle",
  "happy",
  "curious",
  "excited",
  "proud",
  "playful",
  "shy",
  "drowsy",
  "sleeping",
  "suspicious",
];

type MascotMessage = {
  kind: string;
  role?: string;
  tool?: { name?: string; ok?: boolean };
  card?: { requestId?: string; answered?: string; dismissed?: boolean };
};

export type MascotBotProfile = {
  id?: string;
  name: string;
  title?: string;
  description?: string;
  mascotExpression?: string | null;
  busy?: boolean;
  unread?: boolean;
  messages?: MascotMessage[];
};

/** What a Buddy is doing right now, beyond what its own record carries. */
export type MascotLiveContext = {
  /** reply text is streaming in */
  writing?: boolean;
  /** extended thinking is streaming in, before any reply text */
  reasoning?: boolean;
  /** this Buddy's Preview session, if it has one open */
  preview?: { state: "opening" | "ready" | "paused" | "closed" | "error" } | null;
  /** rooms: this member is the one running */
  roomBusy?: boolean;
  /** rooms: this member is waiting its turn */
  queued?: boolean;
  /** rooms: this member's latest activity status */
  roomStatus?: "waiting" | "running" | "approval" | "completed" | "cancelled" | "failed";
};

const PREVIEW_TOOL = /(^|_)preview_|\bpreview\b/i;
const TEST_TOOL = /\b(test|tests|vitest|jest|pytest|playwright|cypress|typecheck|tsc|lint|check-[\w-]+)\b/i;
const SEARCH_TOOL = /^(grep|glob|websearch|webfetch|toolsearch|search|list_files|read|read_file)\b|\b(rg|grep|find|search)\s/i;
const USAGE_LIMIT = /usage (ran out|limit)/i;

/** The live state a tool run implies, if it implies one. */
export function stateForTool(name: string | undefined): MausState | null {
  if (!name) return null;
  if (PREVIEW_TOOL.test(name)) return "preview";
  if (TEST_TOOL.test(name)) return "testing";
  if (SEARCH_TOOL.test(name)) return "searching";
  return null;
}

/**
 * Picks a Buddy's state. Live activity always wins over the resting
 * expression the user chose, so a Buddy with a saved face still shows that
 * it is working, stuck or waiting on you. Then the chosen face, then one
 * inferred from what the Buddy is about.
 */
export function stateForBot(bot: MascotBotProfile, live: MascotLiveContext = {}): MausState {
  const messages = bot.messages ?? [];
  const last = messages[messages.length - 1];
  const busy = Boolean(bot.busy || live.roomBusy);

  const waitingOnUser = messages.some(
    (m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed,
  );
  if (waitingOnUser || live.roomStatus === "approval") return "attention";
  if (busy && live.preview?.state === "error") return "attention";

  // A turn can end with a notice after the step that failed, so look at the whole latest turn.
  let failed: MascotMessage | undefined;
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== "user"; i--) {
    if (messages[i].kind === "activity" && messages[i].tool?.ok === false) {
      failed = messages[i];
      break;
    }
  }
  if (failed && !busy) return USAGE_LIMIT.test(failed.tool?.name ?? "") ? "limited" : "error";
  if (!busy && live.roomStatus === "failed") return "error";

  if (busy) {
    if (live.writing) return "writing";
    const tool = last?.kind === "activity" && last.tool?.ok === undefined ? stateForTool(last.tool?.name) : null;
    if (tool === "testing") return "testing";
    if (tool === "preview" || live.preview?.state === "ready") return "preview";
    if (live.preview?.state === "opening") return "connecting";
    if (tool) return tool;
    if (live.reasoning) return "thinking";
    return "working";
  }

  if (live.queued) return "queued";
  if (bot.unread) return "notifying";

  const pinned = normalizeState(bot.mascotExpression);
  if (pinned) return pinned;

  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "proud";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "curious";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "drowsy";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal|monitor|security|compliance|risk)\b/)) {
    return "suspicious";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "playful";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "happy";
  }

  return "idle";
}
