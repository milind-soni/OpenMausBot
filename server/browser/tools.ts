// The bots' browser tools: OpenMausBot's agent_browser_* names over T3 Code's preview tool semantics.
//
// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/mcp/toolkits/preview/tools.ts and
// packages/contracts/src/previewAutomation.ts, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in
// third_party/t3-code/LICENSE); modified: zod schemas under OpenMausBot's tool names, refs instead of Playwright
// locators, and the names agent-browser advertised accepted as aliases.
import { z } from "zod";

export const RESTART_TOOL = "restart_browser";

const tab = z.string().regex(/^(?:new|t[1-9]\d{0,8})$/u).describe("The tab, as t1, t2… from agent_browser_tabs or agent_browser_status. Omit it for the tab in front.");
const actTab = z.string().regex(/^t[1-9]\d{0,8}$/u).describe("The tab to act in, as t1, t2…. Omit it for the tab in front.");
const ref = z.string().min(1).max(64).describe("An element ref from the latest snapshot, such as e12.");
const selector = z.string().min(1).max(2_048).describe("A CSS selector, role=button[name=\"Save\"] or text=Save, matching exactly one element in the page (not inside frames). Prefer a ref.");
const x = z.number().min(0).max(16_384).describe("A point in the page's viewport as it is now, in CSS pixels, as your latest screenshot maps them; pass y too.");
const y = z.number().min(0).max(16_384).describe("A point in the page's viewport as it is now, in CSS pixels, as your latest screenshot maps them; pass x too.");
const timeoutMs = z.number().int().min(0).max(60_000).describe("How long to wait at most, in milliseconds. Defaults to 15000.");
const point = z.object({ ref: ref.optional(), selector: selector.optional(), x: x.optional(), y: y.optional() });

export const TOOL_INPUTS = {
  agent_browser_status: z.object({ tab: actTab.optional() }),
  agent_browser_open: z.object({
    url: z.string().max(8_192).optional().describe("The address to open: http(s), about:blank or data:. A bare host such as example.com means https. Omit it to start the browser on its current page."),
    tab: tab.optional().describe("new opens another tab; t2 reuses that tab. Omit it for the tab in front."),
  }),
  agent_browser_navigate: z.object({
    url: z.string().max(8_192).optional().describe("The address to go to. Pass this or action."),
    action: z.enum(["back", "forward", "reload"]).optional().describe("Go back, go forward, or reload. Pass this or url."),
    readiness: z.enum(["load", "domcontentloaded", "networkidle", "none"]).optional().describe("What to wait for before answering. Defaults to load."),
    tab: actTab.optional(),
  }),
  agent_browser_snapshot: z.object({
    includeImage: z.boolean().optional().describe("Also return a screenshot. Only when the tree is not enough: it stays in the conversation."),
    save: z.boolean().optional().describe("Save the screenshot as a PNG file and return its path."),
    tab: actTab.optional(),
  }),
  agent_browser_read: z.object({
    url: z.string().max(8_192).optional().describe("Open this address first, then read it. Omit it to read the page that is open."),
    ref: ref.optional(),
    selector: selector.optional(),
    offset: z.number().int().min(0).max(10_000_000).optional().describe("Skip this many characters, to read on from where an earlier read stopped."),
    maxChars: z.number().int().min(1).max(40_000).optional().describe("At most this many characters. Defaults to 20000."),
    tab: actTab.optional(),
  }),
  agent_browser_screenshot: z.object({
    fullPage: z.boolean().optional().describe("The whole page, not just the visible part."),
    ref: ref.optional(),
    selector: selector.optional(),
    tab: actTab.optional(),
  }),
  agent_browser_click: z.object({
    ref: ref.optional(), selector: selector.optional(), x: x.optional(), y: y.optional(),
    button: z.enum(["left", "right", "middle"]).optional().describe("Defaults to left; right opens the page's context menu."),
    clickCount: z.number().int().min(1).max(3).optional().describe("2 for a double-click, 3 for a triple-click. Defaults to 1."),
    tab: actTab.optional(),
  }),
  agent_browser_fill: z.object({
    ref: ref.optional(), selector: selector.optional(),
    text: z.string().max(100_000).describe("The text the field holds afterwards; what it held before is cleared."),
    submit: z.boolean().optional().describe("Press Enter in the field afterwards, to submit its form."),
    tab: actTab.optional(),
  }),
  agent_browser_type: z.object({
    text: z.string().max(100_000).describe("Text typed key by key, as a person types it. Past 500 characters the rest is inserted at once."),
    ref: ref.optional(), selector: selector.optional(),
    clear: z.boolean().optional().describe("Clear the field first. Defaults to false."),
    tab: actTab.optional(),
  }),
  agent_browser_press: z.object({
    key: z.string().min(1).max(64).describe("A key or chord: Enter, Escape, Tab, ArrowDown, a, Control+a, ControlOrMeta+c."),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift", "ControlOrMeta"])).max(4).optional().describe("Modifier keys held while pressing key."),
    tab: actTab.optional(),
  }),
  agent_browser_select: z.object({
    ref: ref.optional(), selector: selector.optional(),
    values: z.array(z.string().max(1_000)).min(1).max(100).describe("Option values or visible labels to choose."),
    tab: actTab.optional(),
  }),
  agent_browser_check: z.object({
    ref: ref.optional(), selector: selector.optional(),
    checked: z.boolean().optional().describe("false unchecks. Defaults to true."),
    tab: actTab.optional(),
  }),
  agent_browser_hover: z.object({ ref: ref.optional(), selector: selector.optional(), x: x.optional(), y: y.optional(), tab: actTab.optional() }),
  agent_browser_drag: z.object({
    from: point.describe("What to drag: a ref, a selector, or x and y."),
    to: point.describe("Where to drop it: a ref, a selector, or x and y."),
    tab: actTab.optional(),
  }),
  agent_browser_scroll: z.object({
    dx: z.number().min(-100_000).max(100_000).optional().describe("Horizontal distance in CSS pixels; positive scrolls right."),
    dy: z.number().min(-100_000).max(100_000).optional().describe("Vertical distance in CSS pixels; positive scrolls down. Defaults to 600."),
    ref: ref.optional(), selector: selector.optional(),
    tab: actTab.optional(),
  }),
  agent_browser_upload: z.object({
    files: z.array(z.string().min(1).max(4_096)).min(1).max(10).describe("Absolute paths of files the person attached to this conversation or files in your own working folder; any other path is refused."),
    ref: ref.optional(), selector: selector.optional(),
    tab: actTab.optional(),
  }),
  agent_browser_wait: z.object({
    ms: z.number().int().min(0).max(60_000).optional().describe("Wait this long first."),
    text: z.string().min(1).max(2_000).optional().describe("Until the page shows this text."),
    ref: ref.optional(), selector: selector.optional(),
    gone: z.boolean().optional().describe("With ref or selector: until that element is gone instead."),
    urlIncludes: z.string().min(1).max(2_048).optional().describe("Until the address contains this."),
    load: z.enum(["load", "domcontentloaded", "networkidle"]).optional().describe("Until the page reaches this load state."),
    timeoutMs: timeoutMs.optional(),
    tab: actTab.optional(),
  }),
  agent_browser_eval: z.object({
    expression: z.string().min(1).max(64_000).describe("A JavaScript expression; its value comes back as JSON (64 KB at most). A promise is awaited."),
    world: z.enum(["isolated", "page"]).optional().describe("isolated (the default) sees the DOM but not the page's own variables, and the page cannot see it. page runs among the page's scripts, which can observe it."),
    tab: actTab.optional(),
  }),
  agent_browser_dialog: z.object({
    accept: z.boolean().describe("true accepts the open alert, confirm or prompt; false dismisses it."),
    promptText: z.string().max(4_000).optional().describe("The answer to a prompt, when accepting."),
    tab: actTab.optional(),
  }),
  agent_browser_tabs: z.object({
    action: z.enum(["list", "new", "switch", "close"]).describe("list the tabs, open a new one (optionally at url), switch to tab, or close tab."),
    url: z.string().max(8_192).optional().describe("For new: the address to open."),
    tab: actTab.optional().describe("For switch and close: the tab, as t1, t2…."),
  }),
  agent_browser_close: z.object({ tab: actTab.optional().describe("Close this tab. Omit it to close the whole browser; saved sign-ins are kept.") }),
  [RESTART_TOOL]: z.object({}),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;
export type ToolInput<N extends ToolName> = z.output<(typeof TOOL_INPUTS)[N]>;

const DESCRIPTIONS: Record<ToolName, string> = {
  agent_browser_status: "Your browser's state: its tabs, the tab in front with its address, title and loading state, who controls it, any open dialog or file picker, and finished downloads with their file paths.",
  agent_browser_open: "Open a page in your browser and answer with its snapshot: the page's accessibility tree with element refs (e12) that the other tools act on. Waits for the page to load, at most 15 s.",
  agent_browser_navigate: "Go to an address in the current tab, or go back, forward or reload. Refs from earlier snapshots stop applying to the new page.",
  agent_browser_snapshot: "The page's accessibility tree with element refs, across frames and shadow roots, plus what the page reported. Take one before acting when you have no current refs; refs expire when the page navigates or a person takes control. Capped near 20 KB; it lists what it left out.",
  agent_browser_read: "The page's visible text, or one element's, for reading long content or a single value such as a price. Pass offset to read on.",
  agent_browser_screenshot: "A PNG of the visible page, the whole page, or one element; its answer says how the picture's pixels map to the page's CSS pixels, which change when a person resizes the panel watching the browser. Use it when the tree is not enough to see the page.",
  agent_browser_click: "Click one element by ref (preferred) or selector, or a point. Waits until the element is visible, still and not covered. Returns early when the click opens a dialog.",
  agent_browser_fill: "Clear a text field and put text in it, as a paste would. Set submit to press Enter afterwards.",
  agent_browser_type: "Type text key by key into a field (by ref or selector) or wherever the focus is, for fields that react to each key.",
  agent_browser_press: "Press a key or a key chord at the focus, such as Enter, Escape or Control+a.",
  agent_browser_select: "Choose options in a native <select> by value or label. A custom dropdown is not a <select>: click it open, then click its option.",
  agent_browser_check: "Check or uncheck a checkbox, radio button or switch, and confirm the page took it.",
  agent_browser_hover: "Move the mouse over an element or a point, for menus and tooltips that open on hover.",
  agent_browser_drag: "Drag one element (or point) onto another.",
  agent_browser_scroll: "Scroll the page, or the scrollable element named by ref or selector, by dx and dy CSS pixels.",
  agent_browser_upload: "Put files into a file input (ref or selector), or answer the file picker the page opened. Then submit its form as usual.",
  agent_browser_wait: "Wait until every condition given holds: a time, text on the page, an element appearing or going, the address, or a load state. 60 s at most.",
  agent_browser_eval: "Run JavaScript in the page and return its value. It needs the same control as clicking, and is refused while a filled password is still on the page.",
  agent_browser_dialog: "Accept or dismiss the alert, confirm or prompt dialog the page opened (agent_browser_status shows it). Nothing else works on the tab until it is answered.",
  agent_browser_tabs: "List, open, switch between or close your browser's tabs.",
  agent_browser_close: "Close a tab, or with no tab the whole browser. Saved sign-ins are kept.",
  [RESTART_TOOL]: "Close and restart your browser. Use it only when a browser tool says the browser must be restarted, or it stays busy after a call that did not answer. Open pages are closed back to one blank tab and form input is lost; sign-ins are kept. Afterwards open the page you need again and check whether the interrupted action already happened before repeating it.",
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const TOOL_LIST: ReadonlyArray<{ name: ToolName; description: string; inputSchema: Record<string, unknown> }> =
  (Object.keys(TOOL_INPUTS) as ToolName[]).map((name) => ({ name, description: DESCRIPTIONS[name], inputSchema: jsonSchema(TOOL_INPUTS[name].strict()) }));

export const TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOL_INPUTS));

/** A tool call after alias translation: `as` names what an old name asked for, when its answer differs. */
export type ToolCall = { [N in ToolName]: { name: N; input: ToolInput<N>; as?: "url" | "title" } }[ToolName];

type Args = Record<string, unknown>;

const selectorOf = (args: Args) => (typeof args.selector === "string" ? { selector: args.selector } : {});
const waitTimeout = (args: Args) => (typeof args.waitTimeoutMs === "number" ? { timeoutMs: Math.min(60_000, args.waitTimeoutMs) } : {});
const tabArg = (value: unknown) => (typeof value === "string" && /^\d+$/u.test(value) ? `t${value}` : value);

const SCROLL_DIRECTIONS: Readonly<Record<string, [number, number]>> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** The names agent-browser advertised, with their arguments, as the new tools. */
const ALIASES: Readonly<Record<string, (args: Args) => { name: ToolName; args: Args; as?: "url" | "title" }>> = {
  agent_browser_get_url: () => ({ name: "agent_browser_status", args: {}, as: "url" }),
  agent_browser_get_title: () => ({ name: "agent_browser_status", args: {}, as: "title" }),
  agent_browser_tools_profiles: () => ({ name: "agent_browser_status", args: {} }),
  agent_browser_back: () => ({ name: "agent_browser_navigate", args: { action: "back" } }),
  agent_browser_forward: () => ({ name: "agent_browser_navigate", args: { action: "forward" } }),
  agent_browser_reload: () => ({ name: "agent_browser_navigate", args: { action: "reload" } }),
  agent_browser_get_text: (args) => ({ name: "agent_browser_read", args: selectorOf(args) }),
  agent_browser_uncheck: (args) => ({ name: "agent_browser_check", args: { ...selectorOf(args), checked: false } }),
  agent_browser_wait_ms: (args) => ({ name: "agent_browser_wait", args: { ms: args.ms } }),
  agent_browser_wait_for_selector: (args) => ({ name: "agent_browser_wait", args: { ...selectorOf(args), ...waitTimeout(args) } }),
  agent_browser_wait_for_text: (args) => ({ name: "agent_browser_wait", args: { text: args.text, ...waitTimeout(args) } }),
  agent_browser_wait_for_load: (args) => ({ name: "agent_browser_wait", args: { load: args.state, ...waitTimeout(args) } }),
  agent_browser_tab_new: (args) => ({ name: "agent_browser_tabs", args: { action: "new", ...(typeof args.url === "string" ? { url: args.url } : {}) } }),
  agent_browser_tab_list: () => ({ name: "agent_browser_tabs", args: { action: "list" } }),
  agent_browser_tab_switch: (args) => ({ name: "agent_browser_tabs", args: { action: "switch", tab: tabArg(args.tab) } }),
  agent_browser_tab_close: (args) => ({ name: "agent_browser_tabs", args: { action: "close", ...(args.tab === undefined ? {} : { tab: tabArg(args.tab) }) } }),
};

/** Arguments the old tools took under other names. */
function oldArguments(name: ToolName, args: Args): Args {
  switch (name) {
    case "agent_browser_eval":
      return typeof args.script === "string" && args.expression === undefined ? { ...args, expression: args.script } : args;
    case "agent_browser_scroll": {
      const direction = typeof args.direction === "string" ? SCROLL_DIRECTIONS[args.direction] : undefined;
      if (!direction || args.dx !== undefined || args.dy !== undefined) return args;
      const amount = typeof args.amount === "number" ? args.amount : 300;
      return { ...args, dx: direction[0] * amount, dy: direction[1] * amount };
    }
    default:
      return args;
  }
}

/** Fields only agent-browser had, which the new tools neither take nor need. */
const OLD_ONLY = new Set(["script", "direction", "amount", "delayMs", "newTab", "compact", "depth", "interactive", "includeUrls", "annotate", "format", "quality", "filter", "llms", "outline", "raw", "readTimeoutMs", "requireMd", "label", "all", "waitTimeoutMs", "state"]);

export type ParsedCall = { ok: true; call: ToolCall } | { ok: false; error: string };

export function parseToolCall(rawName: unknown, rawArgs: unknown): ParsedCall {
  if (typeof rawName !== "string") return { ok: false, error: "The tool call has no name." };
  const given: Args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Args : {};
  const alias = ALIASES[rawName];
  const translated = alias ? alias(given) : TOOL_NAMES.has(rawName) ? { name: rawName as ToolName, args: given } : null;
  if (!translated) return { ok: false, error: `There is no browser tool named ${rawName}.` };
  const args = Object.fromEntries(Object.entries(oldArguments(translated.name, translated.args)).filter(([key]) => !OLD_ONLY.has(key)));
  const parsed = TOOL_INPUTS[translated.name].safeParse(args);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    return { ok: false, error: `${translated.name} got arguments it cannot use (${problems}).` };
  }
  return { ok: true, call: { name: translated.name, input: parsed.data, ...(translated.as ? { as: translated.as } : {}) } as ToolCall };
}

/** Exactly one way to name the element: a ref, a selector, or a point. */
export function targetOf(input: { ref?: string; selector?: string; x?: number; y?: number }, { point = true } = {}): { ref: string } | { selector: string } | { x: number; y: number } | string {
  const given = [input.ref !== undefined, input.selector !== undefined, input.x !== undefined || input.y !== undefined].filter(Boolean).length;
  if (given === 0) return point ? "Name the element with ref (from a snapshot), selector, or x and y." : "Name the element with ref (from a snapshot) or selector.";
  if (given > 1) return "Pass only one of ref, selector, or x and y.";
  if (input.ref !== undefined) return { ref: input.ref };
  if (input.selector !== undefined) return { selector: input.selector };
  if (!point) return "This tool needs an element: pass ref or selector, not a point.";
  if (input.x === undefined || input.y === undefined) return "Pass x and y together.";
  return { x: input.x, y: input.y };
}
