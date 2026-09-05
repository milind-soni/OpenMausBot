// Where a bot's hands land — and therefore where the person goes when it
// needs them. A turn can mount two places at once (a computer plus the
// built-in browser), which is exactly what confused people: "do this on the
// web" landed in the cloud box's Chrome one turn and in the Browser tab the
// next, and the "needs your hands" plea never said which. Everything that
// decides or describes a surface lives here, so the picker, the dispatch,
// the system prompt and the notification cannot drift apart.

/** A place a bot can act. `cloud` covers both the Box and VPS backends —
 * from the person's seat they are the same "cloud computer" panel. */
export type Surface = "cloud" | "vm" | "local" | "worker" | "browser";

/** The bot's "Works on" setting; undefined = Auto. */
export type Destination = Surface | "off" | undefined;

/** What the computer block of a dispatch aims for. Mirrors the old `wants`
 * local exactly, so its strict/auto branches keep their meaning. */
export type ComputerWant = "cloud" | "vm" | "local" | "worker" | "off" | undefined;

/** What a turn actually mounted, in surface terms. */
export interface MountedSurfaces {
  computer: Surface | null;
  browser: boolean;
}

export interface SurfacePlan {
  computer: ComputerWant;
  browser: boolean;
  /** The surface this Auto turn was held to by the task's pin, or null. */
  pinned: Surface | null;
  /** The pin pointed somewhere that no longer exists; the caller forgets it. */
  clearPin: boolean;
  /** One prompt sentence when the chosen destination cannot be honoured. */
  note: string;
}

const SURFACES: ReadonlySet<string> = new Set(["cloud", "vm", "local", "worker", "browser"]);

/** Parse a surface arriving over the wire; anything else is "not said". */
export function parseSurface(value: unknown): Surface | undefined {
  // SAFETY: the set membership check is the narrowing — only the four
  // literal strings pass, and the assertion just names that fact to the type.
  return typeof value === "string" && SURFACES.has(value) ? (value as Surface) : undefined;
}

/** The per-turn computer kinds the dispatch tracks, folded to a surface. */
export function surfaceOfComputerKind(kind: "box" | "vps" | "vm" | "local" | "worker" | null): Surface | null {
  if (kind === "box" || kind === "vps") return "cloud";
  return kind;
}

const NO_BROWSER_NOTE =
  " This bot is set to work in the built-in browser, but the built-in browser is switched off in App Settings, so you have no browser and no computer this turn — say so instead of guessing.";

/** Decide what a turn mounts from the bot's destination, the task's pin
 * and what is actually reachable. Explicit choices are strict: a computer
 * destination keeps whatever browser the bot has (the prompt tells the
 * model which to use), a browser destination mounts only the browser. Auto
 * follows the task's pin while the pinned place still exists, and otherwise
 * re-resolves the way it always has. */
export function resolveSurface(input: {
  destination: Destination;
  pinnedSurface?: Surface | null;
  /** The built-in browser may mount: workspace flag, bot switch and engine. */
  browserOn: boolean;
  /** Which pinned surfaces could be mounted right now (Auto only). */
  available?: Partial<Record<Surface, boolean>>;
}): SurfacePlan {
  const { destination, browserOn } = input;
  if (destination === "browser") {
    return browserOn
      ? { computer: "off", browser: true, pinned: null, clearPin: false, note: "" }
      : { computer: "off", browser: false, pinned: null, clearPin: false, note: NO_BROWSER_NOTE };
  }
  if (destination !== undefined) {
    return { computer: destination, browser: browserOn, pinned: null, clearPin: false, note: "" };
  }
  const pin = input.pinnedSurface ?? null;
  if (pin === null) {
    return { computer: undefined, browser: browserOn, pinned: null, clearPin: false, note: "" };
  }
  const reachable = pin === "browser" ? browserOn : input.available?.[pin] === true;
  if (!reachable) {
    return { computer: undefined, browser: browserOn, pinned: null, clearPin: true, note: "" };
  }
  return pin === "browser"
    ? { computer: "off", browser: true, pinned: "browser", clearPin: false, note: "" }
    : { computer: pin, browser: false, pinned: pin, clearPin: false, note: "" };
}

/** How the prompt and the app name a surface. Deliberately the same words
 * the panel uses, so "tell them it is on the cloud computer" points at a
 * label the person can find. */
export function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "cloud":
      return "the cloud computer";
    case "vm":
      return "the Local VM";
    case "local":
      return "this computer";
    case "worker":
      return "the selected worker computer";
    case "browser":
      return "the built-in browser";
  }
}

/** The one paragraph that says where this turn's work happens. Assembled
 * from what was actually mounted, never from the setting, so the model is
 * only ever told about tools it can call. */
export function surfacePrompt(
  mounted: MountedSurfaces,
  opts: { pinned?: Surface | null; note?: string } = {},
): string {
  const computer = mounted.computer ? surfaceLabel(mounted.computer) : null;
  let text = "";
  if (computer && mounted.browser) {
    text =
      ` Two surfaces are mounted this turn: the built-in browser (the browser server's browser_navigate, browser_snapshot, browser_click, browser_fill and friends) and ${computer} (the computer server's tools). Web tasks → the built-in browser. Desktop apps, files and shell → ${computer} tools. Pick one surface for a task and stay on it; if you need the user to sign in, say which surface — the Browser tab or ${computer}.`;
  } else if (computer) {
    text =
      ` Everything you do on screen happens on ${computer}, web pages included, through its own browser; there is no separate built-in browser this turn. If you need the user to sign in, tell them it is on ${computer}.`;
  } else if (mounted.browser) {
    text =
      " Everything you do on screen happens in the built-in browser tab; there is no desktop, file or shell computer this turn. If you need the user to sign in, tell them it is in the Browser tab of the Computer panel.";
  }
  if (opts.pinned) {
    text += ` This task has been running on ${surfaceLabel(opts.pinned)}; keep using it unless the user says otherwise.`;
  }
  return text + (opts.note ?? "");
}

/** Tool names that touch a screen, for engines that report bare names.
 * Mirrors the screen-poller regex in the harness. */
const SCREEN_TOOL = /^(?:screenshot|click|type_text|press_key|scroll|open_url|wait_for|computer_|browser_)/i;

/** Which surface a completed tool call landed on, or null when it cannot
 * be told apart. The Claude driver namespaces MCP tools by server, which
 * is the only fully reliable signal; a bare name is trusted only when one
 * surface was mounted, because both servers expose `browser_snapshot`. */
export function surfaceForTool(toolName: string, mounted: MountedSurfaces): Surface | null {
  if (toolName.startsWith("mcp__browser__")) return mounted.browser ? "browser" : null;
  if (toolName.startsWith("mcp__computer__")) return mounted.computer;
  if (!SCREEN_TOOL.test(toolName)) return null;
  if (mounted.computer && !mounted.browser) return mounted.computer;
  if (!mounted.computer && mounted.browser && /^browser_/i.test(toolName)) return "browser";
  return null;
}
