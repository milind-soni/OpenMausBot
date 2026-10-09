// Where a bot works, said once: one plain line and at most one next action
// for every state a place can be in, from the facts the server and the app
// already hold. The server words a failed turn's row from it (English, the
// language phones read), and every control that shows or picks a place
// (the Computer panel's cards and Simple grid, the composer chip, the failed
// turn row, the bot's Access settings) renders the same state from it in the
// person's language. Nothing else decides what a place is called or what to
// do when it can't be used.
//
// The English below mirrors src/locales/en.json `place.view.*`,
// `place.action.*` and `place.askAdmin`/`place.backOnAuto` exactly (a test
// holds them together), the way shared/live-approval.ts mirrors its keys:
// the server has no i18n.

export type Place = "cloud" | "vm" | "local" | "browser";

/** Every state a place can be in. cc-* is the cloud computer. */
export const PLACE_STATES = [
  "auto", "auto-team",
  "cc-cannot", "cc-tools-off", "cc-sign-in", "cc-new", "cc-starting", "cc-waking", "cc-on", "cc-asleep",
  "cc-no-hours", "cc-at-once", "cc-unavailable", "cc-ended", "cc-no-start", "cc-clearing", "cc-provider",
  "cc-on-my-cloud", "cc-needs-key", "vps",
  "browser", "browser-off", "browser-cannot",
  "local", "local-unavailable", "vm", "vm-cannot", "place-failed",
  "off",
] as const;
export type PlaceState = (typeof PLACE_STATES)[number];

/** Where a failed place came from: the one control a person changes when it
 * can't be used. A routine and a room member are their own sources; Auto and
 * a team's shared computer name no place, so they never fail as one. */
export type PlaceSource = "works-on" | "pin" | "auto-pin" | "routine" | "room";

/** The next actions a place offers. Each is one button in the app and, on a
 * stored row, one sentence a phone can read. */
export const PLACE_ACTIONS = [
  "choose-model", "open-tools", "sign-in", "start", "wake", "watch", "see-plan", "manage-computers",
  "try-again", "open-my-cloud", "add-boat-key", "turn-on-browser", "open-team-map", "open-vm-settings",
  "clear-pin", "change-routine", "open-computer-panel",
] as const;
export type PlaceActionId = (typeof PLACE_ACTIONS)[number];

/** What a failed-turn row stores about its place, beside its English words,
 * so the app can word it again in the reader's language. */
export interface PlaceRow {
  state: PlaceState;
  params: PlaceParams;
  source: PlaceSource;
}

export interface PlaceParams {
  bot?: string;
  engine?: string;
  model?: string;
  computer?: string;
  hours?: number;
  month?: string;
  plan?: string;
  max?: number;
  holders?: string[];
  words?: string;
  reason?: string;
  cause?: string;
}

export interface PlaceAction {
  id: PlaceActionId;
  label: string;
}

export interface PlaceView {
  state: PlaceState;
  params: PlaceParams;
  /** A few words for a card, a grid tile or a chip row. */
  short: string;
  /** The one plain message. */
  line: string;
  action: PlaceAction | null;
}

/** Where this server runs, as the Auto line describes it. */
export type ServerKind = "my-cloud" | "mac" | "pc" | "linux";

/** The facts a place's state is read from. */
export interface PlaceFacts {
  /** The place to describe: Auto, Off, or one of the four places. */
  place: Place | "auto" | "off";
  server: ServerKind;
  bot: string;
  /** Desktop only: signed in to a paid OpenMausBot Cloud plan (the desktop bridge). */
  plan?: boolean;
  /** Where cloud computers come from here: the plan's, the person's own Boat key, or nowhere. */
  boat: "included" | "own-key" | "none";
  /** The cloud computer's provider: Boat, or the person's own server. */
  backend?: "box" | "vps";
  engine: {
    name: string;
    model?: string;
    /** It can use computer tools (capabilities.computerMcp). */
    computer: boolean;
    /** It can use the built-in browser (capabilities.browserMcp). */
    browser: boolean;
    /** Not waiting on a sign-in (src/lib/failed-turn.ts engineSignedOut). */
    signedIn: boolean;
  };
  /** The bot's tool selection includes the computer. */
  toolsAllowComputer: boolean;
  /** The built-in browser is switched on for this installation and bot. */
  browserOn: boolean;
  role: "admin" | "user";
  mode?: "simple" | "advanced";
  /** The cloud computer as last seen; unknown reads as not made yet. */
  computer?: "none" | "starting" | "waking" | "on" | "asleep";
  /** Auto uses a team's shared cloud computer by this name. */
  teamComputer?: string;
  /** This computer can be picked; `reason` says why not. */
  local?: { ready: boolean; reason?: string };
  /** A refusal already read from a failed start (cloudRefusal). */
  refusal?: { state: PlaceState; params: PlaceParams };
}

/** The English catalog, mirrored by en.json. */
export const PLACE_EN = {
  "place.view.auto.short": "Chooses for you",
  "place.view.auto.lineMyCloud": "Uses the built-in browser. In a chat, it starts its cloud computer by itself when a task needs desktop apps.",
  "place.view.auto.lineDesktop": "Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.",
  "place.view.auto.lineLinux": "Uses the built-in browser, or a running Local VM when a task needs a desktop.",
  "place.view.autoTeam.short": "Shared",
  "place.view.autoTeam.line": "Uses {computer}, the cloud computer this team shares.",
  "place.view.ccCannot.short": "Not with this model",
  "place.view.ccCannot.line": "{model} can't use a computer. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.ccToolsOff.short": "Not allowed",
  "place.view.ccToolsOff.line": "What {bot} can use doesn't include a computer.",
  "place.view.ccSignIn.short": "Sign in first",
  "place.view.ccSignIn.line": "Sign in to {engine} first. {bot} uses it on the cloud computer too.",
  "place.view.ccSignIn.lineMyCloud": "Sign in to {engine} on My Cloud first. {bot} uses it on the cloud computer too.",
  "place.view.ccNew.short": "Ready",
  "place.view.ccNew.line": "{bot} gets its own cloud computer the first time a task needs one. The first start takes about a minute.",
  "place.view.ccStarting.short": "Starting…",
  "place.view.ccStarting.line": "Starting {bot}'s cloud computer. The first start takes about a minute.",
  "place.view.ccWaking.short": "Waking…",
  "place.view.ccWaking.line": "Waking {bot}'s cloud computer. This takes a few seconds.",
  "place.view.ccOn.short": "On",
  "place.view.ccOn.line": "{bot}'s cloud computer is on.",
  "place.view.ccAsleep.short": "Asleep",
  "place.view.ccAsleep.line": "{bot}'s cloud computer is asleep. It wakes in a few seconds when {bot} needs it.",
  "place.view.ccNoHours.short": "No hours left",
  "place.view.ccNoHours.line": "This month's {hours} cloud computer hours are used up. They come back on 1 {month}.",
  "place.view.ccNoHours.lineUnknown": "This month's cloud computer hours are used up.",
  "place.view.ccAtOnce.short": "In use",
  "place.view.ccAtOnce.lineOne": "Your {plan} plan includes 1 cloud computer, and {holders} has it.",
  "place.view.ccAtOnce.lineMany": "Your {plan} plan includes {max} cloud computers, and {holders} have them.",
  "place.view.ccAtOnce.lineUnknown": "All the cloud computers your plan includes are in use.",
  "place.view.ccUnavailable.short": "Not available now",
  "place.view.ccUnavailable.line": "Cloud computers can't start right now. It isn't anything you did.",
  "place.view.ccEnded.short": "Plan ended",
  "place.view.ccEnded.line": "Your OpenMausBot Cloud plan has ended, so cloud computers are off.",
  "place.view.ccNoStart.short": "Didn't start",
  "place.view.ccNoStart.line": "{bot}'s cloud computer didn't start.",
  "place.view.ccClearing.short": "Clearing up",
  "place.view.ccClearing.line": "{bot}'s previous cloud computer is still being removed.",
  "place.view.ccProvider.short": "Couldn't start",
  "place.view.ccProvider.line": "Your Boat account couldn't start {bot}'s cloud computer: {words}",
  "place.view.ccOnMyCloud.short": "On My Cloud",
  "place.view.ccOnMyCloud.line": "Cloud computers from your plan work for bots on My Cloud for now.",
  "place.view.ccNeedsKey.short": "Needs a Boat key",
  "place.view.ccNeedsKey.line": "A cloud computer here needs your own Boat key, a paid service.",
  "place.view.vps.short": "Your server",
  "place.view.vps.line": "Uses your own server, connected over SSH.",
  "place.view.browser.short": "Web pages only",
  "place.view.browser.line": "Works in the built-in browser only: web pages, no desktop apps.",
  "place.view.browserOff.short": "Browser is off",
  "place.view.browserOff.line": "The built-in browser is switched off.",
  "place.view.browserCannot.short": "Not with this model",
  "place.view.browserCannot.line": "{model} can't use the built-in browser.",
  "place.view.local.short": "Your screen",
  "place.view.local.line": "Uses your screen, mouse, and keyboard.",
  "place.view.localUnavailable.short": "Not ready",
  "place.view.localUnavailable.line": "{reason}",
  "place.view.vm.short": "Private desktop",
  "place.view.vm.line": "A private Linux desktop on this device, separate from your own screen.",
  "place.view.vmCannot.short": "Not with this model",
  "place.view.vmCannot.line": "{model} can't use a Local VM. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.placeFailed.short": "Didn't start",
  "place.view.placeFailed.line": "{cause}",
  "place.view.off.short": "No screen",
  "place.view.off.line": "{bot} has no screen. It can still chat and do anything that doesn't need one.",
  "place.action.chooseModel": "Choose a model",
  "place.action.openTools": "Change what {bot} can use",
  "place.action.signIn": "Sign in",
  "place.action.start": "Start it now",
  "place.action.wake": "Wake it now",
  "place.action.watch": "Watch",
  "place.action.seePlan": "See your plan",
  "place.action.manageComputers": "Manage cloud computers",
  "place.action.tryAgain": "Try again",
  "place.action.openMyCloud": "Open My Cloud",
  "place.action.addBoatKey": "Add Boat key",
  "place.action.turnOnBrowser": "Turn on the browser",
  "place.action.openTeamMap": "Open Team map",
  "place.action.openVmSettings": "Local VM settings",
  "place.action.clearPin": "Clear this conversation's place",
  "place.action.usePlace": "Use {place}",
  "place.action.changeRoutine": "Change where it runs",
  "place.action.openComputerPanel": "Open Computer panel",
  "place.askAdmin": "Ask an Admin to change it.",
  "place.backOnAuto": "This conversation is back on Auto.",
} as const;
export type PlaceKey = keyof typeof PLACE_EN;

/** A stored row's next action as one English sentence: what a phone, which
 * shows only the row's words, reads instead of a button. English only, like
 * the row it ends. */
export const PLACE_WORDS: Record<PlaceActionId, string> = {
  "choose-model": "Choose another model in {bot}'s settings.",
  "open-tools": "Change what {bot} can use in its settings.",
  "sign-in": "Sign in to {engine} in Settings.",
  start: "Start it from the Computer panel.",
  wake: "Wake it from the Computer panel.",
  watch: "Watch it from the Computer panel.",
  "see-plan": "See your plan on the Plan page.",
  "manage-computers": "Manage your cloud computers in Settings → Local VM.",
  "try-again": "Try again.",
  "open-my-cloud": "Open My Cloud from the menu at the top of the sidebar.",
  "add-boat-key": "Add a Boat key in Settings → API keys.",
  "turn-on-browser": "Turn on the built-in browser in the Computer panel.",
  "open-team-map": "Open Team map to manage it.",
  "open-vm-settings": "Check it in Settings → Local VM.",
  "clear-pin": "Clear this conversation's place in the composer to continue.",
  "change-routine": "Change where this routine runs.",
  "open-computer-panel": "Check it in the Computer panel.",
};

/** The words a person reads, in some language: the app passes its t(), the
 * server the English mirror. */
export type PlaceTranslate = (key: PlaceKey, params?: Record<string, string | number>) => string;

function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

export const english: PlaceTranslate = (key, params) => fill(PLACE_EN[key], params);

/** Each state's key segment, short and line keys, and own action. */
const STATE: Record<PlaceState, { key: string; action: PlaceActionId | null }> = {
  auto: { key: "auto", action: null },
  "auto-team": { key: "autoTeam", action: "open-team-map" },
  "cc-cannot": { key: "ccCannot", action: "choose-model" },
  "cc-tools-off": { key: "ccToolsOff", action: "open-tools" },
  "cc-sign-in": { key: "ccSignIn", action: "sign-in" },
  "cc-new": { key: "ccNew", action: "start" },
  "cc-starting": { key: "ccStarting", action: "watch" },
  "cc-waking": { key: "ccWaking", action: "watch" },
  "cc-on": { key: "ccOn", action: "watch" },
  "cc-asleep": { key: "ccAsleep", action: "wake" },
  "cc-no-hours": { key: "ccNoHours", action: "see-plan" },
  "cc-at-once": { key: "ccAtOnce", action: "manage-computers" },
  "cc-unavailable": { key: "ccUnavailable", action: "try-again" },
  "cc-ended": { key: "ccEnded", action: "see-plan" },
  "cc-no-start": { key: "ccNoStart", action: "try-again" },
  "cc-clearing": { key: "ccClearing", action: "try-again" },
  "cc-provider": { key: "ccProvider", action: "try-again" },
  "cc-on-my-cloud": { key: "ccOnMyCloud", action: "open-my-cloud" },
  "cc-needs-key": { key: "ccNeedsKey", action: "add-boat-key" },
  vps: { key: "vps", action: null },
  browser: { key: "browser", action: null },
  "browser-off": { key: "browserOff", action: "turn-on-browser" },
  "browser-cannot": { key: "browserCannot", action: "choose-model" },
  local: { key: "local", action: null },
  "local-unavailable": { key: "localUnavailable", action: null },
  vm: { key: "vm", action: "open-vm-settings" },
  "vm-cannot": { key: "vmCannot", action: "choose-model" },
  "place-failed": { key: "placeFailed", action: "open-computer-panel" },
  off: { key: "off", action: null },
};

/** A passing cause: nothing to fix, so where the place came from decides the
 * way on (sourceAction). Every other state's action removes its cause. */
const PASSING: ReadonlySet<PlaceState> = new Set(["cc-unavailable", "cc-no-start", "cc-clearing", "cc-provider", "place-failed"]);

/** Actions that change a setting, a sign-in or the plan: a User can't take
 * them, so the line ends "Ask an Admin to change it." instead. */
const ADMIN_ONLY: ReadonlySet<PlaceActionId> = new Set([
  "choose-model", "open-tools", "sign-in", "see-plan", "manage-computers", "open-my-cloud",
  "add-boat-key", "turn-on-browser", "open-team-map", "open-vm-settings", "change-routine",
]);
/** Starting or waking a computer early: a User's own message does it, so
 * there is nothing to ask anyone for. */
const ADMIN_SHORTCUT: ReadonlySet<PlaceActionId> = new Set(["start", "wake"]);

const ACTION_KEY: Record<PlaceActionId, PlaceKey> = {
  "choose-model": "place.action.chooseModel",
  "open-tools": "place.action.openTools",
  "sign-in": "place.action.signIn",
  start: "place.action.start",
  wake: "place.action.wake",
  watch: "place.action.watch",
  "see-plan": "place.action.seePlan",
  "manage-computers": "place.action.manageComputers",
  "try-again": "place.action.tryAgain",
  "open-my-cloud": "place.action.openMyCloud",
  "add-boat-key": "place.action.addBoatKey",
  "turn-on-browser": "place.action.turnOnBrowser",
  "open-team-map": "place.action.openTeamMap",
  "open-vm-settings": "place.action.openVmSettings",
  "clear-pin": "place.action.clearPin",
  "change-routine": "place.action.changeRoutine",
  "open-computer-panel": "place.action.openComputerPanel",
};

/** The state and its params, from the facts. Pure: the panel, the chip, the
 * Access line and the server all ask this. */
export function placeState(facts: PlaceFacts): { state: PlaceState; params: PlaceParams } {
  const bot = facts.bot;
  const model = facts.engine.model || facts.engine.name;
  if (facts.place === "off") return { state: "off", params: { bot } };
  if (facts.place === "auto") {
    return facts.teamComputer
      ? { state: "auto-team", params: { bot, computer: facts.teamComputer } }
      : { state: "auto", params: { bot } };
  }
  if (facts.place === "browser") {
    if (!facts.engine.browser) return { state: "browser-cannot", params: { bot, model } };
    return facts.browserOn ? { state: "browser", params: { bot } } : { state: "browser-off", params: { bot } };
  }
  if (facts.place === "local") {
    return facts.local?.ready === false
      ? { state: "local-unavailable", params: { bot, reason: facts.local.reason ?? "" } }
      : { state: "local", params: { bot } };
  }
  if (facts.place === "vm") {
    return facts.engine.computer ? { state: "vm", params: { bot } } : { state: "vm-cannot", params: { bot, model } };
  }
  // The cloud computer: on the person's own server (VPS) or on Boat, one
  // rule for both (shared/cloud-computer.ts).
  const vps = facts.backend === "vps";
  if (!facts.engine.computer) return { state: "cc-cannot", params: { bot, model } };
  if (!facts.toolsAllowComputer) return { state: "cc-tools-off", params: { bot } };
  if (!facts.engine.signedIn) return { state: "cc-sign-in", params: { bot, engine: facts.engine.name } };
  if (vps) return { state: "vps", params: { bot } };
  if (facts.refusal) return { state: facts.refusal.state, params: { bot, ...facts.refusal.params } };
  if (facts.boat === "none") {
    // My Cloud always has the plan's computers while the plan is active.
    if (facts.server === "my-cloud") return { state: "cc-unavailable", params: { bot } };
    return { state: facts.plan ? "cc-on-my-cloud" : "cc-needs-key", params: { bot } };
  }
  switch (facts.computer) {
    case "starting": return { state: "cc-starting", params: { bot } };
    case "waking": return { state: "cc-waking", params: { bot } };
    case "on": return { state: "cc-on", params: { bot } };
    case "asleep": return { state: "cc-asleep", params: { bot } };
    default: return { state: "cc-new", params: { bot } };
  }
}

/** Where the person goes when a passing cause stops a place: try again in
 * place, clear the pin that holds this conversation, change where the
 * routine runs. A room member's turn has no retry of its own. */
function sourceAction(source: PlaceSource, state: PlaceState): PlaceActionId | null {
  switch (source) {
    case "works-on": return state === "place-failed" ? "open-computer-panel" : "try-again";
    case "auto-pin": return "try-again";
    case "pin": return "clear-pin";
    case "routine": return "change-routine";
    case "room": return null;
  }
}

function lineKey(state: PlaceState, params: PlaceParams, server?: ServerKind): PlaceKey {
  const segment = STATE[state].key;
  if (state === "auto") {
    return server === "my-cloud" ? "place.view.auto.lineMyCloud" : server === "linux" ? "place.view.auto.lineLinux" : "place.view.auto.lineDesktop";
  }
  if (state === "cc-sign-in" && server === "my-cloud") return "place.view.ccSignIn.lineMyCloud";
  // A refusal read from a code alone has no numbers or names to give.
  if (state === "cc-no-hours" && (params.hours === undefined || !params.month)) return "place.view.ccNoHours.lineUnknown";
  if (state === "cc-at-once") {
    if (!params.holders?.length || !params.plan || params.max === undefined) return "place.view.ccAtOnce.lineUnknown";
    return params.max === 1 ? "place.view.ccAtOnce.lineOne" : "place.view.ccAtOnce.lineMany";
  }
  return `place.view.${segment}.line` as PlaceKey;
}

/** Join names the way a sentence lists them, in the reader's language. */
export function listNames(names: readonly string[], locale = "en"): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

function templateParams(params: PlaceParams, locale: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? listNames(value, locale) : value;
  }
  return out;
}

export interface PlaceContext {
  server?: ServerKind;
  role: "admin" | "user";
  mode?: "simple" | "advanced";
  source?: PlaceSource;
  /** Simple mode words a pin's way back as "Use {place}", the grid's own label. */
  worksOnLabel?: string;
  translate?: PlaceTranslate;
  locale?: string;
}

/** One state, worded: its short label, its one line and its one action. */
export function placeViewOf(state: PlaceState, params: PlaceParams, context: PlaceContext): PlaceView {
  const translate = context.translate ?? english;
  const values = templateParams(params, context.locale ?? "en");
  const segment = STATE[state].key;
  let line = translate(lineKey(state, params, context.server), values);
  let action: PlaceActionId | null = context.source && PASSING.has(state) ? sourceAction(context.source, state) : STATE[state].action;
  // A failed row never offers what only the panel can do on the spot.
  if (context.source && (action === "start" || action === "wake" || action === "watch")) action = null;
  if (context.source === "auto-pin") line = `${line} ${translate("place.backOnAuto")}`;
  // Simple mode leaves Local VM setup to Advanced.
  if (action === "open-vm-settings" && context.mode === "simple") action = null;
  if (action && context.role === "user" && ADMIN_SHORTCUT.has(action)) action = null;
  if (action && context.role === "user" && ADMIN_ONLY.has(action)) {
    action = null;
    line = `${line} ${translate("place.askAdmin")}`;
  }
  // Simple mode has no composer chip, so a pin's way back is the grid's
  // choice, by the grid's own name for it.
  const label = !action ? null
    : action === "clear-pin" && context.mode === "simple" && context.worksOnLabel
      ? translate("place.action.usePlace", { place: context.worksOnLabel })
      : translate(ACTION_KEY[action], values);
  return {
    state,
    params,
    short: translate(`place.view.${segment}.short` as PlaceKey, values),
    line,
    action: action && label ? { id: action, label } : null,
  };
}

/** The view of a place from its facts. */
export function placeView(facts: PlaceFacts, options: { translate?: PlaceTranslate; locale?: string } = {}): PlaceView {
  const { state, params } = placeState(facts);
  return placeViewOf(state, params, { server: facts.server, role: facts.role, mode: facts.mode, ...options });
}

/** A stored failed-turn row, worded for this reader. */
export function placeRowView(row: PlaceRow, context: Omit<PlaceContext, "source">): PlaceView {
  return placeViewOf(row.state, row.params, { ...context, source: row.source });
}

/** What the server stores as the row's words: the line and its action as a
 * sentence, in English, so a phone that reads only the words knows both. */
export function placeRowText(row: PlaceRow, server?: ServerKind): string {
  const view = placeViewOf(row.state, row.params, { server, role: "admin", source: row.source });
  if (!view.action) return view.line;
  const words = row.source === "auto-pin" && view.action.id === "try-again"
    ? "Send your message again."
    : fill(PLACE_WORDS[view.action.id], templateParams(row.params, "en"));
  return `${view.line} ${words}`;
}

// ── Reading a failed start ──────────────────────────────────────────────

const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December)";
const HOURS_USED = new RegExp(`Your (.+?) plan's (\\d+) cloud computer hours for \\w+ are used up\\. They reset on 1 ${MONTH}`);
const AT_ONCE = /Your (.+?) plan includes (\d+) cloud computers? at once/;
const PASSING_WORDS = [
  /cloud computers are busy right now/i, /temporarily unavailable/i, /can't be checked right now/i, /could not be reached/i,
  /returned an unexpected answer/i, /could not complete that request/i, /started too often/i, /woken too often/i,
  /included with your Cloud plan aren't available/i, /are not available right now/i, /fetch failed/i, /ECONNREFUSED/,
  /rate-limiting/i, /\b50[234]\b/,
];
const NO_START_WORDS = [
  /did not become ready/i, /desktop link could not be created/i, /could not be created or reached/i, /did not wake/i,
  /no computer yet/i, /didn't start in time/i,
];
const CLEARING_WORDS = [/is being deleted/i, /previous cloud computer deletion/i, /deletion was not confirmed/i, /deletion is still being reconciled/i];

/** Read a failed cloud computer start as a state. The Admin's own codes come
 * first; until every refusal has one, its English is read (the words below
 * are exactly the Admin's, server/cloud-services.ts). `included`: the plan's
 * computers, not the person's own Boat key, whose provider's words are shown
 * as they are. */
export function cloudRefusal(failure: { message: string; code?: string; status?: number }, included: boolean): { state: PlaceState; params: PlaceParams } {
  const message = failure.message.trim();
  const code = failure.code;
  const hours = HOURS_USED.exec(message);
  if (code === "hours_used" || hours) {
    return { state: "cc-no-hours", params: hours ? { plan: hours[1], hours: Number(hours[2]), month: hours[3] } : {} };
  }
  const atOnce = AT_ONCE.exec(message);
  if (code === "at_once" || atOnce) {
    return { state: "cc-at-once", params: atOnce ? { plan: atOnce[1], max: Number(atOnce[2]) } : {} };
  }
  if (code === "subscription_inactive") return { state: "cc-ended", params: {} };
  if (code === "too_many_starts" || code === "rate_limited" || code === "usage_unavailable" || code === "service_unavailable"
    || code === "upstream_unavailable" || code === "invalid_response" || code === "upstream_error") {
    return { state: "cc-unavailable", params: {} };
  }
  // A start that failed and left its new computer still being removed
  // didn't start; the next attempt meets the removal.
  if (NO_START_WORDS.some((words) => words.test(message))) return { state: "cc-no-start", params: {} };
  if (CLEARING_WORDS.some((words) => words.test(message))) return { state: "cc-clearing", params: {} };
  if ((failure.status ?? 0) >= 500 || PASSING_WORDS.some((words) => words.test(message))) return { state: "cc-unavailable", params: {} };
  if (!included && message) return { state: "cc-provider", params: { words: message.replace(/[\s.]+$/, "") + "." } };
  return { state: "cc-no-start", params: {} };
}
