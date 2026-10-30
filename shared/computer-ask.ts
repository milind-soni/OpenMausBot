// A bot on the person's own Cloud that needs their computer (its apps and screen, its files, or its terminal) when it
// isn't available asks once with a card: what it wants and why, why it isn't available, and the one-tap fix. The English
// mirrors src/locales/en.json `computerAsk.*` exactly (a test holds them together): the server has no i18n.

/** The card's tool name: no engine has a tool by this name, and "Always allow" is never offered for it. */
export const COMPUTER_ASK_TOOL = "turn_on_your_computer";
/** The bots' tool that raises the card. */
export const ASK_FOR_COMPUTER_TOOL = "ask_for_computer";
export const DESKTOP_DOWNLOAD_URL = "https://www.openmausbot.com/download";

export const COMPUTER_NEEDS = ["screen", "folders", "terminal"] as const;
export type ComputerNeed = (typeof COMPUTER_NEEDS)[number];

/**
 * Why the computer can't give what's needed now. From the app on that computer: "paused" (the person paused it from its
 * icon), and for apps and screen "starting", "permissions" (macOS hasn't allowed it), "blocked" (its helper is missing
 * or stopped, as Windows Security does), "off" (Linux control is off), "not-running" and "unsupported"; "terminal-off"
 * (running commands isn't turned on). Without the app there: "closed" (it was used before), "never", and "update" (an
 * app too old to answer the card).
 */
export const COMPUTER_ASK_REASONS = [
  "paused", "starting", "permissions", "blocked", "off", "not-running", "unsupported", "terminal-off", "closed", "never", "update",
] as const;
export type ComputerAskReason = (typeof COMPUTER_ASK_REASONS)[number];

/** "asking" until an answer; "turning-on" once Turn on was tapped; "on" once it lends what was needed; "failed" when the
 * app there couldn't turn it on (Turn on again tries again); "declined" for Not now; "ended" when the conversation
 * was stopped or deleted. */
export type ComputerAskState = "asking" | "turning-on" | "on" | "failed" | "declined" | "ended";

export type ComputerDevice = "PC" | "Mac" | "computer";

export interface ComputerAskCard {
  need: ComputerNeed;
  reason: ComputerAskReason;
  device: ComputerDevice;
  state: ComputerAskState;
  /** What the bot wants to do and why, in its own words, cleaned. */
  why?: string;
}

export interface ComputerAskField {
  /** A bot on the person's own Cloud asks to turn on what it needs from their computer. */
  computerAsk?: ComputerAskCard;
}

/** A tap on Turn on can fix this from wherever the card is: the app on that computer does it. */
export function turnsOnFromHere(reason: ComputerAskReason): boolean {
  return reason === "paused" || reason === "permissions" || reason === "blocked" || reason === "off" || reason === "not-running" || reason === "terminal-off";
}

/** The fix is getting the app there: install it, open it, or update it. */
export function needsTheApp(reason: ComputerAskReason): boolean {
  return reason === "closed" || reason === "never" || reason === "update";
}

export const COMPUTER_ASK_WORDS = {
  "computerAsk.want.screen": "{name} wants to use your {device}'s apps and screen",
  "computerAsk.want.folders": "{name} wants to use the files on your {device}",
  "computerAsk.want.terminal": "{name} wants to run commands on your {device}",
  "computerAsk.reason.paused": "Using your {device} is paused.",
  "computerAsk.reason.starting": "Screen control is still starting on your {device}.",
  "computerAsk.reason.permissions": "macOS hasn't allowed {app} to see and use the screen yet.",
  "computerAsk.reason.blocked": "Screen control is blocked on your {device}.",
  "computerAsk.reason.blockedPc": "Screen control is blocked on your PC: Windows Security may have stopped it.",
  "computerAsk.reason.off": "Screen control is off on your {device}.",
  "computerAsk.reason.notRunning": "Screen control isn't running on your {device}.",
  "computerAsk.reason.unsupported": "Screen control can't work on your {device} right now.",
  "computerAsk.reason.terminalOff": "Running commands isn't turned on for your {device}.",
  "computerAsk.reason.closed": "{app} isn't open on your {device}. Open it there and {name} carries on.",
  "computerAsk.reason.never": "{app} isn't on your computer yet. Install it, sign in to MausBot Cloud there, and {name} carries on.",
  "computerAsk.reason.update": "{app} on your {device} needs an update first. Update it, and {name} carries on.",
  "computerAsk.action.turnOn": "Turn on",
  "computerAsk.action.tryAgain": "Try again",
  "computerAsk.action.notNow": "Not now",
  "computerAsk.action.getApp": "Get {app}",
  "computerAsk.state.turningOn": "Turning on…",
  "computerAsk.state.on": "Turned on. {name} is carrying on.",
  "computerAsk.state.failed": "It didn't turn on.",
  "computerAsk.state.declined": "Not now",
  "computerAsk.state.ended": "No longer needed",
} as const;

export type ComputerAskKey = keyof typeof COMPUTER_ASK_WORDS;

/** The product's name as the person reads it, as the app fills `{app}`. */
export const COMPUTER_ASK_APP = "MausBot";

export function computerAskText(key: ComputerAskKey, params: Record<string, string>): string {
  return COMPUTER_ASK_WORDS[key].replace(/\{(\w+)\}/g, (whole, name: string) => (name === "app" ? params.app ?? COMPUTER_ASK_APP : params[name] ?? whole));
}

const WANT_KEY: Record<ComputerNeed, ComputerAskKey> = {
  screen: "computerAsk.want.screen",
  folders: "computerAsk.want.folders",
  terminal: "computerAsk.want.terminal",
};

/** The card's headline: who wants what, from which computer. */
export function computerAskHeadline(card: Pick<ComputerAskCard, "need" | "device">): { key: ComputerAskKey; params: Record<string, string> } {
  return { key: WANT_KEY[card.need], params: { device: card.device } };
}

/** Why it isn't available, as a catalog key and its values. */
export function computerAskReasonLine(card: Pick<ComputerAskCard, "reason" | "device">, name: string): { key: ComputerAskKey; params: Record<string, string> } {
  const params = { device: card.device, name };
  switch (card.reason) {
    case "paused": return { key: "computerAsk.reason.paused", params };
    case "starting": return { key: "computerAsk.reason.starting", params };
    case "permissions": return { key: "computerAsk.reason.permissions", params };
    case "blocked": return { key: card.device === "PC" ? "computerAsk.reason.blockedPc" : "computerAsk.reason.blocked", params };
    case "off": return { key: "computerAsk.reason.off", params };
    case "unsupported": return { key: "computerAsk.reason.unsupported", params };
    case "terminal-off": return { key: "computerAsk.reason.terminalOff", params };
    case "closed": return { key: "computerAsk.reason.closed", params };
    case "never": return { key: "computerAsk.reason.never", params };
    case "update": return { key: "computerAsk.reason.update", params };
    default: return { key: "computerAsk.reason.notRunning", params };
  }
}

/** What a bot wrote as its reason, made safe for one line on the card: no control or direction characters, at most 200. */
export function cleanAskWhy(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 199).trimEnd()}…` : line;
}
