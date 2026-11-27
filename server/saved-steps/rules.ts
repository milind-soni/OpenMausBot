import type { Message } from "../store.ts";
import { elementPath, type SlimStructured, type WireElement } from "./driver-wire.ts";
import type { RecordedCall, RequestJournal } from "./journal.ts";
import { exactRequest, hasMomentWords, inRequest, requestKey } from "./key.ts";
import { matchElement } from "./resolve.ts";
import { namesFinalAction, namesSecret } from "./screen-words.ts";

export type ActionTool = "click" | "double_click" | "right_click" | "type_text" | "set_value" | "press_key" | "scroll" | "launch_app" | "bring_to_front" | "hotkey";

export const OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "get_window_state", "list_apps", "list_windows", "get_accessibility_tree", "get_desktop_state", "get_screen_size",
  "get_cursor_position", "get_agent_cursor_state", "get_session_state", "check_permissions", "screenshot",
]);

export interface AppIdentity { bundleId?: string; name?: string }
export interface ElementIdentity { role: string; label: string; path: string[] }
export interface RecipeStep { tool: ActionTool; args: Record<string, unknown>; app?: AppIdentity; window?: { title: string }; element?: ElementIdentity }
export interface Recipe { id: string; key: string; request: string; steps: RecipeStep[]; createdAt: number; lastUsedAt: number }

export type Refusal =
  | "moment-words" | "several-turns" | "incomplete-journal" | "denied" | "tool-error" | "unknown-tool" | "pixel-or-drag" | "extra-arguments"
  | "unknown-target" | "stale-element" | "unlabelled-element" | "ambiguous-element" | "typed-text-not-in-request" | "url-not-in-request" | "no-steps" | "too-many-steps"
  | "typing-appends" | "toggle-element" | "key-without-window" | "partial-tree" | "final-action" | "secret-field" | "unreadable-field";

const MAX_STEPS = 40;
const ADDRESSING = new Set(["element_token", "element_index", "pid", "window_id", "session"]);
const PIXEL_TOOLS = new Set(["drag", "move_cursor", "zoom"]);
export const ELEMENT_TOOLS: ReadonlySet<ActionTool> = new Set<ActionTool>(["click", "double_click", "right_click", "type_text", "set_value", "scroll"]);
export const KEY_TOOLS: ReadonlySet<ActionTool> = new Set<ActionTool>(["press_key", "hotkey"]);
export const KEPT_ARGS: Record<ActionTool, readonly string[]> = {
  click: ["button", "count", "modifier", "action", "delivery_mode", "scope"],
  double_click: ["delivery_mode"],
  right_click: ["modifier", "delivery_mode"],
  type_text: ["text", "delay_ms", "delivery_mode", "scope"],
  set_value: ["value"],
  press_key: ["key", "modifiers", "delivery_mode", "scope"],
  scroll: ["direction", "amount", "by", "delivery_mode", "scope"],
  hotkey: ["keys", "delivery_mode", "scope"],
  launch_app: ["bundle_id", "name", "urls"],
  bring_to_front: [],
};
/** A second copy of the app would make every later step of a repeat find two apps by that name. */
const DROPPED_ARGS: Partial<Record<ActionTool, ReadonlySet<string>>> = { launch_app: new Set(["creates_new_application_instance"]) };

const isActionTool = (tool: string): tool is ActionTool => Object.hasOwn(KEPT_ARGS, tool);

export const windowScoped = (tool: ActionTool, args: Record<string, unknown>): boolean =>
  !(KEY_TOOLS.has(tool) || ELEMENT_TOOLS.has(tool)) || args.scope === undefined || args.scope === "window";

const TOGGLE_ROLE = /check ?box|switch|toggle|radio|disclosure/i;
const FLIPPING_TOOLS: ReadonlySet<ActionTool> = new Set<ActionTool>(["click", "double_click", "press_key"]);

/** A click flips a toggle from whatever state it is in, and element values never leave the bridge, so that state is unknown. */
export const flipsToggle = (tool: ActionTool, role: string): boolean => FLIPPING_TOOLS.has(tool) && TOGGLE_ROLE.test(role);

/** Pickers, sliders, steppers and toggles always hold some value, and set_value chooses a new one outright; any other
 * field may hold text someone typed, which set_value would replace. */
const CHOOSER_ROLE = /pop ?up|menu ?button|slider|incrementor|stepper|date|time|color ?well|check ?box|switch|toggle|radio/i;
export const holdsTypedText = (role: string): boolean => !CHOOSER_ROLE.test(role);

const ACTIVATING: ReadonlySet<ActionTool> = new Set<ActionTool>(["click", "double_click", "right_click", "press_key"]);
const SECURE_ROLE = /secure/i;
const TEXT_INPUT_ROLE = /text ?field|text ?area|combo ?box|search ?field/i;
const MENU_ROLE = /pop ?up|menu ?button/i;
const RETURN_KEYS = new Set(["return", "enter", "kp_enter", "keypad_enter", "numpad_enter"]);
const DELETE_KEYS = new Set(["delete", "backspace", "forwarddelete", "forward_delete", "del"]);
const COMMAND_KEYS = new Set(["cmd", "command", "meta", "super", "ctrl", "control"]);

function pressedKeys(tool: ActionTool, args: Record<string, unknown>): string[] {
  const keys = tool === "hotkey" ? args.keys : tool === "press_key" ? [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key] : [];
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string").map((key) => key.toLowerCase()) : [];
}

export const pressesReturn = (tool: ActionTool, args: Record<string, unknown>): boolean => pressedKeys(tool, args).some((key) => RETURN_KEYS.has(key));
const pathLabel = (part: string) => part.slice(part.indexOf(":") + 1);

/** Security invariant: no saved step presses a final, can't-undo action (send, delete, buy, pay, post, submit, order,
 * transfer, publish and their like, in any language this app ships) or touches a secret field. */
export function unsafeStep({ tool, args, window, element }: Pick<RecipeStep, "tool" | "args" | "window" | "element">): "final-action" | "secret-field" | null {
  if (element) {
    if (SECURE_ROLE.test(element.role) || ((tool === "set_value" || TEXT_INPUT_ROLE.test(element.role)) && namesSecret(element.label))) return "secret-field";
    if (ACTIVATING.has(tool) && [element.label, window?.title, ...element.path.map(pathLabel)].some(namesFinalAction)) return "final-action";
    if (tool === "set_value" && MENU_ROLE.test(element.role) && typeof args.value === "string" && namesFinalAction(args.value)) return "final-action";
  }
  if (tool === "launch_app" && Array.isArray(args.urls) && args.urls.some((url) => typeof url === "string" && namesFinalAction(url))) return "final-action";
  const keys = pressedKeys(tool, args);
  if (keys.some((key) => DELETE_KEYS.has(key))) return "final-action";
  if (keys.some((key) => RETURN_KEYS.has(key)) && (keys.some((key) => COMMAND_KEYS.has(key)) || namesFinalAction(window?.title))) return "final-action";
  return null;
}

const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTEXT_TOOLS = new Set(["get_accessibility_tree", "get_desktop_state"]);

type TypedWordsRefusal = "typed-text-not-in-request" | "url-not-in-request";

function wordsOutsideRequest(steps: readonly Pick<RecipeStep, "tool" | "args">[], request: string): TypedWordsRefusal | null {
  const fromPerson = (value: unknown) => typeof value === "string" && inRequest(value, request);
  const typedFromPerson = (value: unknown) => typeof value === "string" && value === value.trim() && !CONTROL_CHARACTERS.test(value) && inRequest(value, request);
  for (const { tool, args } of steps) {
    if (tool === "set_value" && !typedFromPerson(args.value)) return "typed-text-not-in-request";
    if (tool === "launch_app" && args.urls !== undefined && !(Array.isArray(args.urls) && args.urls.every(fromPerson))) return "url-not-in-request";
  }
  return null;
}

/** Steps that type the person's words or open their links: only the request they came from, word for word, may repeat them. */
export function holdsPersonWords(steps: readonly Pick<RecipeStep, "tool" | "args">[]): boolean {
  return steps.some(({ tool, args }) => tool === "set_value" || (tool === "launch_app" && args.urls !== undefined));
}

export function recipeFitsRequest(recipe: Pick<Recipe, "steps" | "request">, request: string): boolean {
  const exact = exactRequest(request);
  if (holdsPersonWords(recipe.steps) && (recipe.request === "" || exact !== recipe.request)) return false;
  return wordsOutsideRequest(recipe.steps, exact) === null;
}

export function personTextRequest(message: Message): boolean {
  if (message.role !== "user" || message.kind !== "text") return false;
  const text = message.text ?? "";
  if (!text.trim() || text.includes("<attached-image") || text.includes("<attached-file")) return false;
  if (message.attachments?.length) return false;
  return !(message.replyToId || message.reaction || message.fromApp || message.pointed || message.dataContext || message.peerAsk
    || message.via || message.relayed || message.setupRequest || message.steered || message.aside);
}

const HARMLESS_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Glob", "Grep", "LS", "ToolSearch", "TodoWrite", "WebSearch", "WebFetch", "mcp__agents__select_computer", "select_computer", "web_search",
]);
const COMPUTER_TOOL_PREFIX = "mcp__computer__";

const driverTool = (name: string): boolean => isActionTool(name) || OBSERVATION_TOOLS.has(name);
const computerTool = (name: string): boolean =>
  name.startsWith(COMPUTER_TOOL_PREFIX) || driverTool(name) || (name.startsWith("computer_") && driverTool(name.slice("computer_".length)));

export function otherToolsHarmless(lines: readonly Message[]): boolean {
  return lines.every(({ tool }) => tool?.itemId === undefined || computerTool(tool.name) || HARMLESS_TOOLS.has(tool.name));
}

export function stepLabel(step: RecipeStep): string {
  const appName = step.app?.name ?? step.app?.bundleId;
  if (step.element) return `"${step.element.label}" in ${appName ?? "the app"}`;
  if (step.tool === "launch_app") {
    const { name, bundle_id: bundleId } = step.args;
    const launched = typeof name === "string" && name ? name : typeof bundleId === "string" && bundleId ? bundleId : undefined;
    if (launched) return launched;
  }
  return step.window?.title ?? appName ?? "the screen";
}

interface Snapshot { pid?: number; windowId?: number; appName?: string; windowTitle?: string; elements: WireElement[]; complete: boolean }

const fillMissing = (known: AppIdentity | undefined, next: AppIdentity): AppIdentity => ({
  bundleId: known?.bundleId ?? next.bundleId,
  name: known?.name ?? next.name,
});

const numberArg = (args: Record<string, unknown>, key: string): number | undefined => (typeof args[key] === "number" ? args[key] : undefined);

export function buildRecipe(input: { request: string; journal: RequestJournal; id: string; now: number }): { ok: true; recipe: Recipe } | { ok: false; reason: Refusal } {
  const { request, journal } = input;
  const refuse = (reason: Refusal) => ({ ok: false as const, reason });
  if (hasMomentWords(request)) return refuse("moment-words");
  if (!journal.complete) return refuse("incomplete-journal");
  if (journal.tainted) return refuse("denied");
  if (new Set(journal.calls.map((call) => call.generation)).size > 1) return refuse("several-turns");

  const appsByPid = new Map<number, AppIdentity>();
  const windowsById = new Map<number, string>();
  const latestByWindow = new Map<string, Snapshot>();
  const seenTokens = new Set<string>();
  const appFor = (pid: number | undefined): AppIdentity | undefined => {
    const known = pid === undefined ? undefined : appsByPid.get(pid);
    return known && (known.bundleId || known.name) ? stripEmpty(known) : undefined;
  };
  const learnApp = (pid: number | undefined, identity: AppIdentity) => {
    if (pid !== undefined && (identity.bundleId || identity.name)) appsByPid.set(pid, fillMissing(appsByPid.get(pid), identity));
  };

  const observe = ({ tool, result }: RecordedCall) => {
    const data: SlimStructured = result.structured ?? {};
    if (tool === "list_apps") for (const app of data.apps ?? []) if (app.running !== false) learnApp(app.pid, { bundleId: app.bundle_id, name: app.name });
    if (tool === "list_windows") {
      for (const window of data.windows ?? []) {
        windowsById.set(window.window_id, window.title);
        learnApp(window.pid, { name: window.app_name });
      }
    }
    if (tool === "get_window_state") {
      learnApp(data.pid, { bundleId: data.bundle_id, name: data.app_name });
      if (data.window_id !== undefined && data.window_title !== undefined) windowsById.set(data.window_id, data.window_title);
      const snapshot: Snapshot = {
        pid: data.pid, windowId: data.window_id, appName: data.app_name, windowTitle: data.window_title, elements: data.elements ?? [], complete: data.elements_complete === true,
      };
      const key = data.window_id !== undefined ? `w${data.window_id}` : `p${data.pid}`;
      latestByWindow.delete(key);
      latestByWindow.set(key, snapshot);
      for (const element of snapshot.elements) if (element.element_token) seenTokens.add(element.element_token);
    }
  };

  const learnLaunch = ({ arguments: args, result }: RecordedCall) => {
    const data: SlimStructured = result.structured ?? {};
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    learnApp(data.pid, { bundleId: data.bundle_id ?? text(args.bundle_id), name: data.name ?? text(args.name) });
  };

  const resolveElement = (args: Record<string, unknown>): { element: WireElement; snapshot: Snapshot } | Refusal => {
    const token = typeof args.element_token === "string" ? args.element_token : undefined;
    const index = numberArg(args, "element_index");
    if (token !== undefined) {
      for (const snapshot of latestByWindow.values()) {
        const element = snapshot.elements.find((candidate) => candidate.element_token === token);
        if (element) return { element, snapshot };
      }
      return seenTokens.has(token) ? "stale-element" : "unknown-target";
    }
    if (index === undefined) return "unknown-target";
    const windowId = numberArg(args, "window_id");
    if (windowId === undefined || indexUnsafe) return "unknown-target";
    const snapshot = latestByWindow.get(`w${windowId}`);
    const element = snapshot?.elements.find((candidate) => candidate.element_index === index);
    return snapshot && element ? { element, snapshot } : "unknown-target";
  };

  const indexUnsafe = journal.calls.some((call) => CONTEXT_TOOLS.has(call.tool));
  // Return presses a window's default button: it saves only into a window read whole that shows no final action.
  const readWhole = new Set<number>();
  const showsFinalAction = new Set<number>();
  for (const { tool, result } of journal.calls) {
    const data = result.structured;
    if (tool !== "get_window_state" || data?.window_id === undefined) continue;
    if (data.elements_complete === true) readWhole.add(data.window_id);
    if (namesFinalAction(data.window_title) || (data.elements ?? []).some((element) => namesFinalAction(element.label))) showsFinalAction.add(data.window_id);
  }
  const returnSafeIn = (id: number | undefined) => id !== undefined && readWhole.has(id) && !showsFinalAction.has(id);
  const steps: RecipeStep[] = [];
  for (const call of journal.calls) {
    const { tool, arguments: args, result } = call;
    if (result.isError || result.rpcError || result.structured?.refusal) return refuse("tool-error");
    if (OBSERVATION_TOOLS.has(tool)) {
      observe(call);
      continue;
    }
    if (PIXEL_TOOLS.has(tool) || tool.startsWith("browser_") || "x" in args || "y" in args) return refuse("pixel-or-drag");
    if (!isActionTool(tool)) return refuse("unknown-tool");
    // cua-driver 0.28.2's type_text inserts at the selection (AXSetAttribute(kAXSelectedText)), so a field's old text stays.
    if (tool === "type_text") return refuse("typing-appends");
    if (tool === "launch_app") learnLaunch(call);

    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (ADDRESSING.has(key) || DROPPED_ARGS[tool]?.has(key)) continue;
      if (!KEPT_ARGS[tool].includes(key)) return refuse("extra-arguments");
      kept[key] = value;
    }
    const step: RecipeStep = { tool, args: kept };
    const addressed = args.element_token !== undefined || args.element_index !== undefined;
    const pid = numberArg(args, "pid");
    const windowId = numberArg(args, "window_id");
    const malformed = (args.element_token !== undefined && typeof args.element_token !== "string")
      || (args.element_index !== undefined && typeof args.element_index !== "number")
      || (args.pid !== undefined && pid === undefined)
      || (args.window_id !== undefined && windowId === undefined);
    if (malformed) return refuse("unknown-target");
    if (!windowScoped(tool, args)) return refuse("unknown-target");

    let keyWindow = windowId;
    if (ELEMENT_TOOLS.has(tool) || (tool === "press_key" && addressed)) {
      const found = resolveElement(args);
      if (typeof found === "string") return refuse(found);
      const { element, snapshot } = found;
      if (!snapshot.complete) return refuse("partial-tree");
      if (!element.label) return refuse("unlabelled-element");
      if (flipsToggle(tool, element.role)) return refuse("toggle-element");
      const path = elementPath(snapshot.elements, element);
      if (!path) return refuse("unknown-target");
      const twins = matchElement(snapshot.elements, { role: element.role, label: element.label, path });
      if (!twins.ok || twins.value.element_index !== element.element_index) return refuse("ambiguous-element");
      const app = appFor(snapshot.pid ?? pid) ?? (snapshot.appName ? { name: snapshot.appName } : undefined);
      if (!app) return refuse("unknown-target");
      step.app = app;
      const title = snapshot.windowTitle ?? windowsById.get(snapshot.windowId ?? windowId ?? -1);
      if (title === undefined) return refuse("unknown-target");
      step.window = { title };
      step.element = { role: element.role, label: element.label, path };
      keyWindow = snapshot.windowId ?? windowId;
      const unsafe = unsafeStep(step);
      if (unsafe) return refuse(unsafe);
      if (tool === "set_value" && holdsTypedText(element.role) && element.value_read !== true) return refuse("unreadable-field");
    } else if (tool === "launch_app") {
      if (addressed || pid !== undefined || windowId !== undefined) return refuse("unknown-target");
      const unsafe = unsafeStep(step);
      if (unsafe) return refuse(unsafe);
    } else {
      const app = appFor(pid);
      if (addressed || !app) return refuse("unknown-target");
      step.app = app;
      if (windowId !== undefined) {
        const title = windowsById.get(windowId);
        if (title === undefined) return refuse("unknown-target");
        step.window = { title };
      } else if (KEY_TOOLS.has(tool)) return refuse("key-without-window");
      const unsafe = unsafeStep(step);
      if (unsafe) return refuse(unsafe);
    }
    if (pressesReturn(tool, args) && !returnSafeIn(keyWindow)) return refuse("final-action");
    steps.push(step);
  }

  if (steps.length === 0) return refuse("no-steps");
  if (steps.length > MAX_STEPS) return refuse("too-many-steps");
  const outside = wordsOutsideRequest(steps, exactRequest(request));
  if (outside) return refuse(outside);
  return { ok: true, recipe: { id: input.id, key: requestKey(request), request: exactRequest(request), steps, createdAt: input.now, lastUsedAt: input.now } };
}

function stripEmpty(app: AppIdentity): AppIdentity {
  return { ...(app.bundleId ? { bundleId: app.bundleId } : {}), ...(app.name ? { name: app.name } : {}) };
}
