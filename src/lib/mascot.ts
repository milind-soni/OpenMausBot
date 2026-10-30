import { CURSOR_STATES, type CursorState } from "@/components/CursorAvatar";
import { botShowsUnread } from "./bot-unread";
import { lastNonReceipt } from "./receipts";
import type { MausColor } from "../../shared/wire";
import type { LocaleKey } from "@/locales";

export { MAUS_COLOR_NAMES, type MausColor } from "../../shared/wire";

export type MausState = CursorState;
export const MAUS_STATES = CURSOR_STATES;

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
} satisfies Record<string, MausState[]>;

export const MAUS_COLORS = {
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
} satisfies Record<MausColor, string>;

export const MAUS_COLOR_LABEL = {
  green: "mascotColor.green", blue: "mascotColor.blue", red: "mascotColor.red", orange: "mascotColor.orange",
  purple: "mascotColor.purple", cyan: "mascotColor.cyan", pink: "mascotColor.pink", yellow: "mascotColor.yellow",
  teal: "mascotColor.teal", coral: "mascotColor.coral", silver: "mascotColor.silver",
  chrome: "mascotColor.chrome",
} as const satisfies Record<MausColor, LocaleKey>;

export const CHROME_GRADIENT: [string, string, string] = ["#F1F4F7", "#AEB8C3", "#66717E"];
export const CHROME_EYES = "#1E2833";

export function colorSwatch(color: MausColor): string {
  if (color !== "chrome") return MAUS_COLORS[color];
  const [light, mid, edge] = CHROME_GRADIENT;
  return `radial-gradient(circle at 34% 26%, #ffffff 0%, ${light} 20%, ${mid} 55%, ${edge} 100%)`;
}

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

interface LegacyStates {
  [state: string]: MausState;
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

const KNOWN_STATES = new Set<string>(MAUS_STATES);

export function normalizeState(value: string | null | undefined): MausState | null {
  if (!value) return null;
  if (KNOWN_STATES.has(value)) return value as MausState;
  return LEGACY_STATES[value] ?? null;
}

export const PICKABLE_STATES: MausState[] = [
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

export function stateForBot(bot: MascotBotProfile): MausState {
  const pinned = normalizeState(bot.mascotExpression);
  if (pinned) return pinned;

  const last = lastNonReceipt(bot.messages);

  if (last?.kind === "activity" && last.tool?.ok === false) return "alerting";
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
