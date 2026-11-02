import type { Surface } from "../shared/wire.ts";
import { canWorkOnCloud, type CloudEngine } from "../shared/cloud-computer.ts";
import { canUseMcpServer } from "../shared/tool-scope.ts";
import { placeRowText, type PlaceRow, type PlaceSource } from "../shared/place-view.ts";
import { PLAIN_WORDS } from "./local-computer-guidance.ts";
export type { Surface, PlaceSource };

/** The bot's "Works on" setting; undefined = Auto. */
export type Destination = Surface | "off" | undefined;

export type ComputerWant = "cloud" | "vm" | "local" | "off" | undefined;

export interface MountedSurfaces {
  computer: Surface | null;
  browser: boolean;
}

export interface SurfacePlan {
  computer: ComputerWant;
  browser: boolean;
  pinned: Surface | null;
  note: string;
  /** A bot opened this thread, so no person watches its Screen panel: the browser is mounted beside any computer. */
  botOpened?: true;
}

const SURFACES: ReadonlySet<string> = new Set(["cloud", "vm", "local", "browser"]);

export function parseSurface(value: unknown): Surface | undefined {
  // SAFETY: the set membership check is the narrowing; only the four literals pass.
  return typeof value === "string" && SURFACES.has(value) ? (value as Surface) : undefined;
}

export function surfaceOfComputerKind(kind: "box" | "vps" | "vm" | "local" | null): Surface | null {
  if (kind === "box" || kind === "vps") return "cloud";
  return kind;
}

const NO_BROWSER_NOTE =
  " This bot is set to work in the built-in browser, but the built-in browser is switched off in App Settings, so you have no browser and no computer this turn — say so instead of guessing.";

const OFF_NOTE =
  " This bot's \"Works on\" setting is Off, so no computer and no built-in browser are mounted this turn: you cannot open a page, click, or type on any screen. If the user asks for something that needs one, tell them Works on is Off in this bot's settings — never claim you are opening a browser you do not have.";

export function computerSkippedNote(cause: string): string {
  const why = cause.trim().replace(/[\s.]+$/, "");
  return ` This turn answers a Team incidents report and your computer could not be prepared for it (${why}), so no computer is mounted: you cannot open, click or check anything on it this turn. Act through your teammates, or tell the person what only they can fix — never claim to have checked that computer yourself.`;
}

/** One place per turn, plus the browser beside it in a thread a bot opened. A person's pin beats the bot's default (only Off overrides it), an Auto pin yields to a Works on change, and a pin the turn cannot honour is reported, never swapped. */
export function resolveSurface(input: {
  destination: Destination;
  pinnedSurface?: Surface | null;
  browserOn: boolean;
  botOpened?: boolean;
}): SurfacePlan {
  const plan = placeOf(input);
  return input.botOpened ? { ...plan, botOpened: true } : plan;
}

function placeOf(input: { destination: Destination; pinnedSurface?: Surface | null; browserOn: boolean; botOpened?: boolean }): SurfacePlan {
  const { destination, browserOn } = input;
  if (destination === "off") {
    return { computer: "off", browser: false, pinned: null, note: OFF_NOTE };
  }
  const beside = input.botOpened === true && browserOn;
  const pin = input.pinnedSurface ?? null;
  if (pin === "browser") {
    if (browserOn) return { computer: "off", browser: true, pinned: "browser", note: "" };
    // A missing browser is not permission to act on the host instead.
    return { computer: "off", browser: false, pinned: pin,
      note: " This conversation is pinned to the built-in browser, but its tools are unavailable this turn. No computer is mounted instead. Do not claim to have used it; a different place must be selected before acting there." };
  }
  if (pin) return { computer: pin, browser: beside, pinned: pin, note: "" };
  if (destination === "browser") {
    return browserOn
      ? { computer: "off", browser: true, pinned: null, note: "" }
      : { computer: "off", browser: false, pinned: null, note: NO_BROWSER_NOTE };
  }
  if (destination !== undefined) {
    return { computer: destination, browser: beside, pinned: null, note: "" };
  }
  return { computer: undefined, browser: browserOn, pinned: null, note: "" };
}

export function browserIsThePlace(plan: SurfacePlan): boolean {
  return plan.computer === "off" && plan.browser;
}

/** The conversation's pin as a person chose it: a pin a turn made on its own (auto) is none. */
export function chosenPin(task: { surface?: Surface; surfaceSource?: "user" | "auto" } | undefined): Surface | null | undefined {
  return task?.surfaceSource === "auto" ? null : task?.surface;
}

export function cloudPlaceRefusal(engine: CloudEngine & { name: string }, source: PlaceSource, bot: string): PlaceUnavailableError | null {
  if (canWorkOnCloud(engine)) return null;
  return placeUnavailable("cloud", { state: "cc-cannot", params: { bot, model: engine.name }, source });
}

export function computerToolsRefusal(toolScope: unknown, source: PlaceSource, bot: string): PlaceUnavailableError | null {
  if (canUseMcpServer(toolScope, "computer")) return null;
  return placeUnavailable("cloud", { state: "cc-tools-off", params: { bot }, source });
}

export class PlaceUnavailableError extends Error {
  readonly place: Surface;
  readonly row: PlaceRow;
  constructor(place: Surface, row: PlaceRow, cloudHome = false) {
    super(placeRowText(row, cloudHome ? "my-cloud" : undefined));
    this.name = "PlaceUnavailableError";
    this.place = place;
    this.row = row;
  }
}

export function placeUnavailable(place: Surface, row: PlaceRow, cloudHome = false): PlaceUnavailableError {
  return new PlaceUnavailableError(place, row, cloudHome);
}

export function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "cloud":
      return "the cloud computer";
    case "vm":
      return "the Local VM";
    case "local":
      return "this computer";
    case "browser":
      return "the built-in browser";
  }
}

/** This computer is the person's own: web work goes elsewhere first, and their first-use question is the harness's to ask. */
const WEB_WORK_ORDER = "For web work such as finding, booking or looking something up, use, in this order:";
const YOUR_COMPUTER_LAST =
  " Use their own browser or screen only when the task needs their own signed-in session and nothing else works. Before your first action on it in a request, OpenMausBot asks them once whether you may, at every approval level: do not ask in chat yourself, and if they say no, finish another way. " + PLAIN_WORDS;
const YOUR_COMPUTER_BESIDE_BROWSER =
  ` This computer is the person's own: their screen, their apps and the browsers they are signed in to. ${WEB_WORK_ORDER} a connected app that does it, your built-in browser, a cloud computer if select_computer offers one.${YOUR_COMPUTER_LAST}`;
const YOUR_COMPUTER_ALONE =
  ` Everything you do on screen happens on this computer, which is the person's own: their screen, their apps and the browsers they are signed in to; there is no built-in browser of yours this turn. ${WEB_WORK_ORDER} a connected app that does it, web search and fetching pages, a cloud computer if select_computer offers one.${YOUR_COMPUTER_LAST} If you need the user to sign in, tell them it is on this computer.`;

/** A connected app does a task more cheaply and surely than any screen, and one that is refused or broken is the person's
 * to fix: worked around on a screen, it stays broken and they never hear why. */
const CONNECTED_APP_FIRST =
  " When a connected app can do the task, use it before any browser or screen. If that app is refused or fails, say so in one plain line with what fixes it (connecting it, or who can), and ask before doing the task on a screen instead.";

const RESTATE_SENTENCE =
  " Before your first action on a screen or page in a task, say in one short sentence where you are working, using that same name.";

const PLACE_CONTROL = "the Screen panel";
/** surfacePrompt swaps exactly this phrase when select_computer is mounted. */
const ASK_TO_SWITCH = `explain the mismatch and ask the user to change where this conversation works in ${PLACE_CONTROL}`;
const REPORT_BACK = "tell the bot that gave you this job which place you need and end your turn, because no person watches this conversation";

const SURFACE_AUTHORITY =
  ` For browser and computer tasks, use OpenMausBot's mounted browser/computer tools first: inspect the target, perform the action, and verify its result before claiming success. Discover deferred tools by their server/name when needed. Do not substitute the provider's own desktop, a shell-launched browser, or another automation path for the selected OpenMausBot surface. Ordinary code and file tasks may still use their normal tools. Announcing an action is not performing it. A request naming another place does not move these tools: this computer is the user's host, Local VM is an isolated desktop, the cloud computer is remote, and the built-in browser is a separate browser. If the requested place differs from the mounted one, ${ASK_TO_SWITCH}; never act on a different computer or describe a host window as a VM.`;

/** A Cloud home has neither this computer nor a Local VM; each pair rewrites one phrase of the wording above. */
const CLOUD_HOME_WORDING: ReadonlyArray<readonly [string, string]> = [
  ["this computer is the user's host, Local VM is an isolated desktop, the cloud computer is remote, and the built-in browser is a separate browser",
    "the cloud computer is remote, the built-in browser is a separate browser, and the user's own computer cannot be reached from here"],
  [" or describe a host window as a VM", ""],
  ["select an available Local VM without asking", "select an available cloud computer without asking"],
  [" Never silently replace an explicitly requested VM with the host desktop.", ""],
];

/** Built from what was actually mounted, never from the setting, so the model is only told about tools it can call. */
export function surfacePrompt(
  mounted: MountedSurfaces,
  opts: { pinned?: Surface | null; note?: string; canSelect?: boolean; cloudHome?: boolean; botOpened?: boolean } = {},
): string {
  const reportBack = opts.botOpened && !opts.canSelect;
  const computer = mounted.computer ? surfaceLabel(mounted.computer) : null;
  let text = "";
  if (mounted.computer === "local" && !opts.cloudHome) {
    text = mounted.browser
      ? ` Two surfaces are mounted this turn: the built-in browser (the browser server's browser_navigate, browser_snapshot, browser_click, browser_fill and friends) and this computer (the computer server's tools). Web tasks → the built-in browser. Desktop apps, files and shell → this computer tools. Pick one surface for a task and stay on it; if you need the user to sign in, say which surface — the Browser tab or this computer.${YOUR_COMPUTER_BESIDE_BROWSER}`
      : YOUR_COMPUTER_ALONE;
  } else if (computer && mounted.browser) {
    text =
      ` Two surfaces are mounted this turn: the built-in browser (the browser server's browser_navigate, browser_snapshot, browser_click, browser_fill and friends) and ${computer} (the computer server's tools). Web tasks → the built-in browser. Desktop apps, files and shell → ${computer} tools. Pick one surface for a task and stay on it; if you need the user to sign in, say which surface — the Browser tab or ${computer}.`;
  } else if (computer) {
    text =
      ` Everything you do on screen happens on ${computer}, web pages included, through its own browser; there is no separate built-in browser this turn. If you need the user to sign in, tell them it is on ${computer}.`;
  } else if (mounted.browser) {
    text =
      " Everything you do on screen happens in the built-in browser tab; there is no desktop, file or shell computer this turn. If you need the user to sign in, tell them it is in the Browser tab of the Screen panel.";
  }
  if (text) text += RESTATE_SENTENCE + (opts.canSelect
    ? SURFACE_AUTHORITY.replace(ASK_TO_SWITCH, "inspect connected choices with select_computer and select the requested available place; on a pending result end this turn so OpenMausBot can reconnect the correct tools and continue the original request")
    : reportBack ? SURFACE_AUTHORITY.replace(ASK_TO_SWITCH, REPORT_BACK) : SURFACE_AUTHORITY);
  else if (!opts.note && !opts.canSelect) {
    text = ` No computer or built-in browser tools are mounted this turn. You cannot open apps, click, or inspect a screen through OpenMausBot. If asked for screen work, ${reportBack ? REPORT_BACK : "explain this and ask the user to choose where this conversation works in the Screen panel"}; do not claim to have opened or checked it.`;
  }
  if (opts.pinned) {
    text += ` This conversation is pinned to ${surfaceLabel(opts.pinned)}; changing places requires ${opts.canSelect ? "select_computer or " : ""}the user's choice in ${PLACE_CONTROL}, not a different tool name.`;
  }
  if (opts.canSelect) text += " For a screen task, use select_computer with no arguments when you need to inspect the actual available targets. Choose the requested place from its result; if the user left the place open, use a suitable available target or surface auto instead of asking them to operate the menu. Browser-only work can stay in Browser; when it needs desktop apps or capabilities the current Browser lacks, select an available Local VM without asking the user to switch it manually. Choose before taking actions, and do not repeat actions already completed if the task must continue elsewhere. OpenMausBot can start an existing configured computer and highlight the selected target. If the right tools are already mounted, use them directly. On a pending switch, end this turn: the original request resumes automatically with the new tools, and then you must carry out the task. Only ask for input for a genuine blocker, such as missing setup, required sign-in or an approval. Never silently replace an explicitly requested VM with the host desktop.";
  if (opts.canSelect) text += " If no suitable computer is running but its provider is configured, select_computer can provision one for this computer task; reuse existing resources first. Do not provision merely for ordinary chat or inspection.";
  if (opts.canSelect && !computer && !mounted.browser) text += " No computer or browser tools are mounted yet; select_computer is the way to connect them before screen work, not a reason to claim you already performed it.";
  if (computer || mounted.browser) text += CONNECTED_APP_FIRST;
  if (computer || mounted.browser) text += " For online research, use the selected OpenMausBot browser when a search service is unavailable. A failed tool proves only that this attempt failed, not that every browser is unavailable. Inspect the current page after navigation; report a sign-in page, redirect or error as such. A completed model turn is not proof that the user's task succeeded.";
  if (opts.cloudHome) for (const [desktop, cloudHome] of CLOUD_HOME_WORDING) text = text.replace(desktop, cloudHome);
  return text + (opts.note ?? "");
}
