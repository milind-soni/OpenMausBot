// The decision model's browser job: a bot names what to click in words ("the
// blue Sign in button", "the second result's title") and Jev picks the
// element, so the bot need not read a snapshot and pick a ref first.
//
// The built-in browser (agent-browser) gives the page as an accessibility
// tree, one element per line with an `@eN` ref:
//
//   - cell "Solving Factorio Quality (exyr.org)" [ref=e17]
//     - link "Solving Factorio Quality" [ref=e121]
//   - checkbox "Remember me" [checked=false, ref=e10]
//   - combobox "Sort by" [expanded=false, ref=e3]: Newest
//
// Each interactive element becomes one option, keyed by its ref and described
// by role, accessible name, state and the nearest labelled ancestor and
// heading. One Choice over them (BROWSER_CLICK in jobs.ts), with the target
// and the page's URL and title as the state.
//
// Acting on it: an element at p >= 0.6 is clicked. Anything less sure, and
// any failure at all, clicks nothing and lists the best few candidates with
// their refs, so the bot clicks by ref exactly as it would without Jev.
// Nothing here throws except the browser transport's own errors, which the
// runtime turns into its "restart the browser" state as for any other click.
import type { Decider } from "./index.ts";
import { JEV_MAX_OPTIONS, jevRequestBody } from "./jev.ts";
import { BROWSER_CLICK, OPTION_KEY_MAX, OPTION_TEXT_MAX } from "./jobs.ts";
import { RELAY_MAX_BODY_BYTES, RELAY_MAX_STATE_BYTES } from "./relay.ts";
import type { DeciderFailure } from "./types.ts";

/** Same calibration as room routing: below this, the bot picks. */
export const BROWSER_CLICK_MIN_PROBABILITY = 0.6;
export const BROWSER_CLICK_TOOL = "agent_browser_click_text";
const TARGET_MAX = 300;
const URL_MAX = 500;
const TITLE_MAX = 200;
const NAME_MAX = 200;
const CONTEXT_MAX = 160;
const CANDIDATES_SHOWN = 5;
/** Tried in turn until the request fits the relay's body cap; after the
 * last, the least plausible elements are dropped. */
const TEXT_CAPS = [OPTION_TEXT_MAX, 300, 180, 120, 80];

/** What the bot is told this tool does. */
export const BROWSER_CLICK_TOOL_DEFINITION = {
  name: BROWSER_CLICK_TOOL,
  description:
    "Click a page element by describing it in words, without taking a snapshot first: for example \"the blue Sign in button\", " +
    "\"the Remember me checkbox\" or \"the title link of the Factorio result\". A fast decision model picks the element from the " +
    "current page's accessibility tree and clicks it only when it is confident; otherwise nothing is clicked and the reply lists " +
    "the closest elements with their refs, to click with agent_browser_click. Use it for one visible element on the current page; " +
    "use agent_browser_click when you already have a ref, and agent_browser_fill to type into a field.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "The element to click, in words: its visible text, role, and where it is if that helps tell it apart." },
    },
    required: ["target"],
    additionalProperties: false,
  },
} as const;

/** Roles a person can click or type into. Everything else (cells, headings,
 * rows, text) is only context for the elements inside it. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem",
]);

export interface PageElement {
  /** `e12`, without the `@`. */
  ref: string;
  role: string;
  name: string;
  /** Other bracket attributes as written: `checked=false`, `selected`. */
  states: string[];
  /** Text after the colon: a combobox's current value. */
  value?: string;
  /** The nearest named ancestor that is not itself interactive. */
  context?: string;
  heading?: string;
  /** Document order. */
  index: number;
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function unquote(raw: string): string {
  try { return JSON.parse(`"${raw}"`) as string; }
  catch { return raw.replace(/\\"/g, "\""); }
}

const LINE = /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?::\s?(.*))?$/;

/** Every interactive element with a ref, in document order. Lines that do
 * not look like tree nodes are skipped, never guessed at. */
export function parseSnapshot(text: string): PageElement[] {
  const elements: PageElement[] = [];
  const ancestors: Array<{ depth: number; name: string; interactive: boolean }> = [];
  let heading: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const depth = match[1]!.replace(/\t/g, "  ").length;
    const role = match[2]!.toLowerCase();
    const name = match[3] === undefined ? "" : clip(unquote(match[3]), NAME_MAX);
    const attributes = (match[4] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    const ref = attributes.find((part) => /^ref=e\d+$/.test(part))?.slice(4);
    while (ancestors.length && ancestors[ancestors.length - 1]!.depth >= depth) ancestors.pop();
    const interactive = INTERACTIVE_ROLES.has(role);
    if (role === "heading" && name) heading = name;
    if (interactive && ref && ref.length <= OPTION_KEY_MAX) {
      const context = [...ancestors].reverse().find((ancestor) => !ancestor.interactive && ancestor.name && ancestor.name !== name)?.name;
      const value = match[5]?.trim();
      elements.push({
        ref,
        role,
        name,
        states: attributes.filter((part) => !part.startsWith("ref=") && !part.startsWith("level=")),
        ...(value ? { value: clip(value, NAME_MAX) } : {}),
        ...(context ? { context: clip(context, CONTEXT_MAX) } : {}),
        ...(heading ? { heading: clip(heading, CONTEXT_MAX) } : {}),
        index: elements.length,
      });
    }
    ancestors.push({ depth, name, interactive });
  }
  return elements;
}

/** One element as an option: `button "Sign in", in "Welcome back"…`. */
export function elementOption(element: PageElement, max = OPTION_TEXT_MAX): string {
  const states = element.states.length ? ` (${element.states.join(", ")})` : "";
  const parts = [`${element.role}${element.name ? ` "${element.name}"` : " with no label"}${states}`];
  if (element.value) parts.push(`showing "${element.value}"`);
  if (element.context) parts.push(`inside "${element.context}"`);
  if (element.heading) parts.push(`under the heading "${element.heading}"`);
  return clip(parts.join(", "), max);
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);

/** How plausible an element is before anyone asks Jev: words it shares with
 * the target, and whether it has a label at all. Ties keep page order. */
function plausibility(element: PageElement, target: Set<string>): number {
  const own = words(`${element.role} ${element.name} ${element.value ?? ""}`);
  const around = words(`${element.context ?? ""} ${element.heading ?? ""}`);
  let score = element.name ? 0.5 : 0;
  for (const word of target) {
    if (own.has(word)) score += 2;
    else if (around.has(word)) score += 1;
  }
  return score;
}

/** Most plausible first. */
export function rankElements(elements: readonly PageElement[], target: string): PageElement[] {
  const wanted = words(target);
  return elements
    .map((element) => ({ element, score: plausibility(element, wanted) }))
    .sort((a, b) => b.score - a.score || a.element.index - b.element.index)
    .map(({ element }) => element);
}

export interface BrowserClickPage {
  url?: string;
  title?: string;
}

/** The request for up to 255 of the most plausible elements, within the
 * relay's state and body caps. Null with fewer than two elements. */
/** Always offered last: Jev can only choose among what it is shown, so a
 * vague or unmatched target needs somewhere to go other than the likeliest
 * element on the page. Choosing it never clicks anything. */
export const NO_MATCH_OPTION = "__none__";
const NO_MATCH_MEANING = "None of these: no element on the page is the one `target` describes, or `target` is too vague to tell which.";

export function browserClickRequest(target: string, page: BrowserClickPage, elements: readonly PageElement[]) {
  const state = {
    target: clip(target, TARGET_MAX),
    page: { url: clip(page.url ?? "", URL_MAX), title: clip(page.title ?? "", TITLE_MAX) },
  };
  if (Buffer.byteLength(JSON.stringify(state)) > RELAY_MAX_STATE_BYTES) return null;
  let kept = rankElements(elements, target).slice(0, JEV_MAX_OPTIONS - 1);
  const build = (cap: number) => {
    const options: Record<string, string> = {};
    // Page order reads more naturally than plausibility order.
    for (const element of [...kept].sort((a, b) => a.index - b.index)) options[element.ref] = elementOption(element, cap);
    options[NO_MATCH_OPTION] = NO_MATCH_MEANING;
    return options;
  };
  const fits = (options: Record<string, string>) =>
    Buffer.byteLength(JSON.stringify(jevRequestBody(state, { answer: { type: "choice", instructions: BROWSER_CLICK.instructions, options } }))) <= RELAY_MAX_BODY_BYTES;
  for (const cap of TEXT_CAPS) {
    if (kept.length < 2) return null;
    const options = build(cap);
    if (fits(options)) return { state, question: { instructions: BROWSER_CLICK.instructions, options }, elements: kept };
  }
  while (kept.length > 2) {
    kept = kept.slice(0, Math.max(2, Math.floor(kept.length * 0.8)));
    const options = build(TEXT_CAPS[TEXT_CAPS.length - 1]!);
    if (fits(options)) return { state, question: { instructions: BROWSER_CLICK.instructions, options }, elements: kept };
  }
  return null;
}

export type BrowserClickPick =
  | { kind: "click"; element: PageElement; probability: number }
  | { kind: "unsure"; reason: DeciderFailure | "low_confidence" | "no_choice"; candidates: Array<{ element: PageElement; probability?: number }> };

/** Ask once and decide whether to click. Never throws. */
export async function pickElement(
  decider: Pick<Decider, "choose">,
  target: string,
  page: BrowserClickPage,
  elements: readonly PageElement[],
  options: { signal?: AbortSignal } = {},
): Promise<BrowserClickPick> {
  const byPlausibility = () => rankElements(elements, target).slice(0, CANDIDATES_SHOWN).map((element) => ({ element }));
  try {
    const request = browserClickRequest(target, page, elements);
    if (!request) return { kind: "unsure", reason: "no_choice", candidates: byPlausibility() };
    const result = await decider.choose("browserClick", request.state, request.question, {
      timeoutMs: BROWSER_CLICK.timeoutMs,
      signal: options.signal,
    });
    if (!result.ok) return { kind: "unsure", reason: result.reason, candidates: byPlausibility() };
    const { choice, pTop, probabilities } = result.answers;
    const chosen = request.elements.find((element) => element.ref === choice);
    if (!chosen && choice !== NO_MATCH_OPTION) return { kind: "unsure", reason: "malformed", candidates: byPlausibility() };
    if (!chosen || pTop < BROWSER_CLICK_MIN_PROBABILITY) {
      const candidates = request.elements
        .map((element) => ({ element, probability: probabilities[element.ref] ?? 0 }))
        .sort((a, b) => b.probability - a.probability || a.element.index - b.element.index)
        .slice(0, CANDIDATES_SHOWN);
      return { kind: "unsure", reason: "low_confidence", candidates };
    }
    return { kind: "click", element: chosen, probability: pTop };
  } catch {
    return { kind: "unsure", reason: "malformed", candidates: byPlausibility() };
  }
}

const percent = (p: number) => `${Math.round(p * 100)}%`;
const describe = (element: PageElement) => `${element.role}${element.name ? ` "${element.name}"` : ""}`;

const WHY: Partial<Record<string, string>> = {
  low_confidence: "no element was a clear match",
  no_choice: "the page has too few clickable elements to choose between",
  timeout: "the decision model did not answer in time",
};

/** What the bot reads when nothing was clicked. */
export function unsureMessage(target: string, pick: Extract<BrowserClickPick, { kind: "unsure" }>): string {
  const why = WHY[pick.reason] ?? "the decision model was unavailable";
  const lines = pick.candidates.map(({ element, probability }) =>
    `- ${elementOption(element, 200)} [ref=${element.ref}]${probability !== undefined ? ` (${percent(probability)})` : ""}`);
  return `Could not tell which element "${clip(target, TARGET_MAX)}" means (${why}), so nothing was clicked.` +
    (lines.length
      ? ` Closest elements:\n${lines.join("\n")}\nClick one with agent_browser_click and its ref (for example selector "@${pick.candidates[0]!.element.ref}"), or take agent_browser_snapshot to look for it.`
      : " Take agent_browser_snapshot to see the page's elements, then click one with agent_browser_click.");
}

type ToolResult = { content: Array<{ type: "text"; text: string } | Record<string, unknown>>; isError?: boolean };

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return "";
  return ((result as { content: unknown[] }).content)
    .map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
    .filter(Boolean)
    .join("\n");
}

const failed = (result: unknown) => Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError === true);

export interface BrowserClickIo {
  /** One call to the engine's own tools, in the same session. Transport
   * errors propagate: the runtime owns what a lost click means. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Throws when the turn was revoked or a person took the browser. Called
   * before the click, after the (slow) decision. */
  checkpoint(): void;
  decider: Pick<Decider, "choose">;
}

/** The whole tool: snapshot, ask, click or explain. */
export async function clickByDescription(args: unknown, io: BrowserClickIo): Promise<ToolResult> {
  const raw = args && typeof args === "object" ? (args as { target?: unknown }).target : undefined;
  const target = typeof raw === "string" ? raw.trim() : "";
  if (!target) return { isError: true, content: [{ type: "text", text: "Say which element to click in `target`, for example \"the Sign in button\"." }] };
  const snapshot = await io.callTool("agent_browser_snapshot", { compact: true });
  const tree = failed(snapshot) ? "" : resultText(snapshot);
  if (!tree.trim()) {
    return { content: [{ type: "text", text: "Could not read the current page, so nothing was clicked. Open a page with agent_browser_open, or take agent_browser_snapshot and click by ref with agent_browser_click." }] };
  }
  const elements = parseSnapshot(tree);
  const page: BrowserClickPage = {};
  for (const [key, tool] of [["url", "agent_browser_get_url"], ["title", "agent_browser_get_title"]] as const) {
    const answer = await io.callTool(tool, {});
    if (!failed(answer)) page[key] = resultText(answer).trim();
  }
  const pick = await pickElement(io.decider, target, page, elements);
  if (pick.kind === "unsure") return { content: [{ type: "text", text: unsureMessage(target, pick) }] };
  io.checkpoint();
  const clicked = await io.callTool("agent_browser_click", { selector: `@${pick.element.ref}` });
  if (failed(clicked)) {
    const detail = resultText(clicked);
    return {
      isError: true,
      content: [{ type: "text", text: `Tried to click ${describe(pick.element)} [ref=${pick.element.ref}] (Jev ${percent(pick.probability)}), but the click failed${detail ? `: ${detail}` : "."}` }],
    };
  }
  // The engine's own success body is launch bookkeeping, not page news.
  return {
    content: [{
      type: "text",
      text: `Clicked ${describe(pick.element)} [ref=${pick.element.ref}] (Jev ${percent(pick.probability)}). Take a snapshot before acting on refs if the page changed.`,
    }],
  };
}
