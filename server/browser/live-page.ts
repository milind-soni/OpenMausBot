// agent-browser 0.37.0's `input_keyboard` relay hands Chrome only a key's type, key, code and text, so a page reads keyCode 0
// and no modifier flags (vercel-labs/agent-browser#2560), and its `press` knows a fixed table of keys. Its headless Chrome
// draws a <select>'s list outside the screencast. The person's view therefore reaches the page it shows over the second
// DevTools client it already holds for the page's dialogs: key events carry every field a page reads, and a press on a
// dropdown list gets the list drawn by the view, as the v2 stream does. Without that client the engine's relay remains.
import type { DialogWatch } from "../browser-dialogs.ts";
import { object, type ObjectValue } from "./live-action.ts";
import { chooseWith, SELECT_SCRIPTS, selectPopupOf, type SelectPopup } from "./viewers/popups.ts";

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
/** Keys the engine's `press` resolves, sent as one acknowledged press on the relay. */
export const DISCRETE_KEYS = new Set(["Backspace", "Enter", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const WORLD = "omb-live-view";

type KeyFields = { key: string; code?: unknown; windowsVirtualKeyCode?: unknown; modifiers?: unknown; text?: unknown };

/** A shortcut (a key with Control, Meta or Alt, not a modifier itself, not a shifted character) or a key the engine's `press`
 * knows: sent as one acknowledged down-and-up, since macOS sends no key-up for a key let go while Cmd is down. */
export function pressedAtOnce(fields: KeyFields): boolean {
  const modifiers = Number(fields.modifiers) || 0;
  const key = String(fields.key);
  const shortcut = modifiers > 0 && !MODIFIER_KEYS.has(key) && !(modifiers === 8 && [...key].length === 1);
  return shortcut || DISCRETE_KEYS.has(key);
}

/** The engine's `press` chord for a key and its modifier bits. */
export function pressChord(fields: KeyFields): string {
  const modifiers = Number(fields.modifiers) || 0;
  const chord = [[1, "Alt"], [2, "Control"], [4, "Meta"], [8, "Shift"]] as const;
  return [...chord.filter(([bit]) => modifiers & bit).map(([, key]) => key), fields.key].join("+");
}

const NAMED_KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Meta: 91,
};

/** A US layout's virtual key code for a key the view sent without one; 0 when there is none to give. */
function keyCodeOf(key: string): number {
  if (/^[a-z]$/iu.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^\d$/u.test(key)) return key.charCodeAt(0);
  return NAMED_KEY_CODES[key] ?? 0;
}

/** Chrome's `Input.dispatchKeyEvent` for a view's key: a key-down with text types it, one without is raw, as in Puppeteer. No
 * native key code: a Windows code given as macOS's native one repeats the key-down there (vercel-labs/agent-browser#2112). */
export function keyEvent(type: "keyDown" | "keyUp", fields: KeyFields): ObjectValue {
  const key = String(fields.key);
  const code = typeof fields.code === "string" ? fields.code : "";
  const keyCode = Number(fields.windowsVirtualKeyCode) || keyCodeOf(key);
  const modifiers = Number(fields.modifiers) || 0;
  // Enter types a line break unless a shortcut holds it, as the engine's press does.
  const given = typeof fields.text === "string" && fields.text ? fields.text : key === "Enter" && !(modifiers & 6) ? "\r" : undefined;
  const text = type === "keyDown" ? given : undefined;
  const location = /(?:Left|Right)$/u.test(code) && MODIFIER_KEYS.has(key) ? (code.endsWith("Left") ? 1 : 2) : code.startsWith("Numpad") ? 3 : 0;
  return {
    type: type === "keyUp" ? "keyUp" : text ? "keyDown" : "rawKeyDown", key, code,
    windowsVirtualKeyCode: keyCode, modifiers,
    ...(location ? { location } : {}), ...(text ? { text, unmodifiedText: text } : {}),
  };
}

/** The active tab's target in the stream's `tabs` message; undefined for any other message. */
export function activeTargetOf(message: unknown): string | null | undefined {
  const value = object(message);
  if (value?.type !== "tabs" || !Array.isArray(value.tabs)) return undefined;
  const active = value.tabs.map(object).find((tab) => tab?.active === true);
  return typeof active?.targetId === "string" && /^[\w-]{1,128}$/u.test(active.targetId) ? active.targetId : null;
}

/** A dropdown list the view drew, and the tab it is in. */
export interface OpenSelect { id: string; target: string }

/** The page the view shows, over its DevTools client: absent, every call answers null and the caller uses the relay. */
export class LivePage {
  readonly #watch: () => DialogWatch | undefined;
  readonly #target: () => string | null;
  readonly #worlds = new Map<string, number>();

  constructor(watch: () => DialogWatch | undefined, target: () => string | null) {
    this.#watch = watch;
    this.#target = target;
  }

  #page(): { watch: DialogWatch; target: string } | null {
    const watch = this.#watch();
    const target = this.#target();
    return watch && !watch.closed && target ? { watch, target } : null;
  }

  /** Dispatches the key events in order, each confirmed by Chrome; null when no page is reachable this way. */
  async keys(events: ObjectValue[]): Promise<boolean | null> {
    const page = this.#page();
    if (!page) return null;
    for (const [at, event] of events.entries()) {
      const answer = await page.watch.toPage(page.target, "Input.dispatchKeyEvent", event).catch((error: unknown) => {
        if (at === 0 && page.watch.closed) return null;
        throw error;
      });
      if (answer === null) return at === 0 ? null : false;
    }
    return true;
  }

  /** Evaluates in the page's isolated world, made once per document: a world a navigation discarded is made again. */
  async #value(expression: string, page: { watch: DialogWatch; target: string }): Promise<unknown> {
    for (const fresh of [false, true]) {
      let world = this.#worlds.get(page.target);
      if (world === undefined || fresh) {
        const frame = object(object((await page.watch.toPage(page.target, "Page.getFrameTree"))?.frameTree)?.frame)?.id;
        if (typeof frame !== "string") return null;
        const made = (await page.watch.toPage(page.target, "Page.createIsolatedWorld", { frameId: frame, worldName: WORLD }))?.executionContextId;
        if (typeof made !== "number") return null;
        this.#worlds.set(page.target, world = made);
      }
      const answer = await page.watch.toPage(page.target, "Runtime.evaluate", { expression, contextId: world, returnByValue: true }).catch(() => null);
      if (answer && !answer.exceptionDetails) return object(answer.result)?.value;
    }
    return null;
  }

  /** The dropdown list under a page point, kept under `id` in an isolated world the page cannot see. */
  async selectAt(x: number, y: number, id: string): Promise<{ popup: SelectPopup; select: OpenSelect } | null> {
    const page = this.#page();
    if (!page) return null;
    const popup = selectPopupOf(await this.#value(SELECT_SCRIPTS.at(x, y, id), page));
    return popup ? { popup, select: { id, target: page.target } } : null;
  }

  /** Chooses option `index` of an open list: its label typed into the focused list when that names it, else set. */
  async choose(select: OpenSelect, index: number): Promise<boolean> {
    const page = this.#page();
    if (!page || page.target !== select.target) return false;
    return chooseWith({
      value: (script) => this.#value(script, page),
      type: async (label) => {
        for (const character of label) await this.keys([keyEvent("keyDown", { key: character, text: character }), keyEvent("keyUp", { key: character })]);
      },
    }, select.id, index).catch(() => false);
  }
}
