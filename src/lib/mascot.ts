import { CURSOR_STATES, type CursorState } from "@/components/CursorAvatar";
import { botShowsUnread } from "./bot-unread";
import { lastNonReceipt } from "./receipts";
import type { IndColor } from "../../shared/wire";
import type { LocaleKey } from "@/locales";

export { IND_COLOR_NAMES, type IndColor } from "../../shared/wire";

export type IndState = CursorState;
export const IND_STATES = CURSOR_STATES;

/** CursorAvatar ships French group labels; these mirror its STATE_GROUPS memberships exactly. */
export const STATE_GROUPS = {
  Lifecycle: ["sleeping", "waking", "idle", "listening", "thinking", "searching", "working"],
  Reactions: [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate",
  ],
  "Agent morphs": ["orbit", "radar", "progress"],
  "Product cycle": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down",
  ],
} satisfies Record<string, IndState[]>;

export const IND_COLORS = {
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
  silver: "#A8ADB4",
  chrome: "#B3BAC4",
} satisfies Record<IndColor, string>;

export const IND_COLOR_LABEL = {
  green: "mascotColor.green", blue: "mascotColor.blue", red: "mascotColor.red", orange: "mascotColor.orange",
  purple: "mascotColor.purple", cyan: "mascotColor.cyan", pink: "mascotColor.pink", yellow: "mascotColor.yellow",
  teal: "mascotColor.teal", coral: "mascotColor.coral", silver: "mascotColor.silver",
  chrome: "mascotColor.chrome",
} as const satisfies Record<IndColor, LocaleKey>;

export const CHROME_GRADIENT: [string, string, string] = ["#F1F4F7", "#AEB8C3", "#66717E"];
export const CHROME_EYES = "#1E2833";

export function colorSwatch(color: IndColor): string {
  if (color !== "chrome") return IND_COLORS[color];
  const [light, mid, edge] = CHROME_GRADIENT;
  return `radial-gradient(circle at 34% 26%, #ffffff 0%, ${light} 20%, ${mid} 55%, ${edge} 100%)`;
}

export const IND_MOTIONS = [
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

export type IndMotion = "none" | (typeof IND_MOTIONS)[number];

interface LegacyStates {
  [state: string]: IndState;
}

const LEGACY_STATES: LegacyStates = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "scared",
  mischievous: "playful",
};

const KNOWN_STATES = new Set<string>(IND_STATES);

export function normalizeState(value: string | null | undefined): IndState | null {
  if (!value) return null;
  if (KNOWN_STATES.has(value)) return value as IndState;
  return LEGACY_STATES[value] ?? null;
}

export const PICKABLE_STATES: IndState[] = [
  "idle",
  "happy",
  "curious",
  "drowsy",
  "working",
  "thinking",
  "listening",
  "sleeping",
  "suspicious",
  "proud",
];

type MascotMessage = {
  kind: string;
  tool?: { ok?: boolean };
};

export type MascotBotProfile = {
  name: string;
  title?: string;
  description?: string;
  mascotExpression?: string | null;
  busy?: boolean;
  unread?: boolean;
  tasks?: Array<{ unread?: boolean; routineRunId?: string }> | null;
  messages?: MascotMessage[];
};

const isFailedStep = (message: MascotMessage | undefined) => message?.kind === "activity" && message.tool?.ok === false;

/** The conversation ended on a failed step: the turn's error row, or a tool that failed with nothing after it. */
export function endedOnFailure(messages: readonly MascotMessage[] | undefined): boolean {
  return isFailedStep(lastNonReceipt(messages));
}

export function stateForBot(bot: MascotBotProfile): IndState {
  const pinned = normalizeState(bot.mascotExpression);
  if (pinned) return pinned;

  const last = lastNonReceipt(bot.messages);

  if (isFailedStep(last)) return "alerting";
  if (bot.busy) return "working";
  if (botShowsUnread(bot)) return "notifying";
  if (last?.kind === "options") return "curious";

  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "working";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "searching";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "drowsy";
  }
  if (matches(/\b(monitor|monitoring|incident|alert|watch|status|uptime)\b/)) {
    return "radar";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b/)) {
    return "suspicious";
  }
  if (matches(/\b(security|secure|compliance|risk|privacy|finance|financial)\b/)) {
    return "scared";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "playful";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "happy";
  }

  return "idle";
}
