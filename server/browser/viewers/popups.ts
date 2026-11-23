// What a screencast cannot show. Headless Chrome draws a <select>'s list in a popup widget of its own, outside the
// frames a screencast sends, so the person's view draws the options itself and answers with the one chosen. The page's
// cursor shape travels the same way, and so does whether a point takes text, for a touch viewer's keyboard. All of it
// runs in the isolated world, where the page cannot see it.
import { valueInWorld } from "../cdp/evaluate.ts";
import type { CdpPage } from "../cdp/page.ts";

export interface SelectOption {
  label: string;
  disabled: boolean;
  /** The <optgroup> it sits in. */
  group?: string;
}

export interface SelectPopup {
  options: SelectOption[];
  selectedIndex: number;
  /** Where the list sits, in page CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
}

const OPTIONS_LIMIT = 500;

/** The element under a point, inside open shadow roots. */
const ELEMENT_AT = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}`;

const SELECT_AT = `((x, y, token) => {
  const element = (${ELEMENT_AT})(x, y);
  const select = element && element.closest ? element.closest("select") : null;
  if (!select || select.multiple || select.size > 1 || select.disabled) return null;
  globalThis.__ombSelect = { token, select };
  const rect = select.getBoundingClientRect();
  const options = [...select.options].slice(0, ${OPTIONS_LIMIT}).map((option) => {
    const group = option.parentElement && option.parentElement.tagName === "OPTGROUP" ? option.parentElement : null;
    return { label: (option.label || option.text || "").slice(0, 200), disabled: option.disabled || Boolean(group && group.disabled), ...(group ? { group: String(group.label || "").slice(0, 200) } : {}) };
  });
  return { options, selectedIndex: select.selectedIndex, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
})`;

const HELD_SELECT = `((token) => {
  const held = globalThis.__ombSelect;
  return held && held.token === token && held.select.isConnected ? held.select : null;
})`;

const cssNumber = (value: number) => (Number.isFinite(value) ? value : 0);

const NON_TEXT_INPUTS = JSON.stringify(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** The scripts that find a dropdown list under a point and choose one of its options, for an isolated world. */
export const SELECT_SCRIPTS = {
  /** The list under a point, kept under `token`: its options, selected index and box, or null. */
  at: (x: number, y: number, token: string) => `${SELECT_AT}(${cssNumber(x)}, ${cssNumber(y)}, ${JSON.stringify(token)})`,
  /** Focuses the list and answers the label that names option `index` alone, "" when none does, null when it cannot be chosen. */
  focusLabel: (token: string, index: number) => `(() => {
    const select = ${HELD_SELECT}(${JSON.stringify(token)});
    const option = select && select.options[${Math.trunc(index)}];
    if (!option || option.disabled || (option.parentElement && option.parentElement.tagName === "OPTGROUP" && option.parentElement.disabled)) return null;
    select.focus();
    const label = (option.label || option.text || "").toLowerCase();
    return label && [...select.options].filter((other) => (other.label || other.text || "").toLowerCase().startsWith(label)).length === 1 ? (option.label || option.text) : "";
  })()`,
  selectedIndex: (token: string) => `(() => { const select = ${HELD_SELECT}(${JSON.stringify(token)}); return select ? select.selectedIndex : -1; })()`,
  /** Sets option `index` with untrusted input and change events. */
  set: (token: string, index: number) => `(() => {
    const select = ${HELD_SELECT}(${JSON.stringify(token)});
    if (!select) return false;
    if (select.selectedIndex !== ${Math.trunc(index)}) {
      select.selectedIndex = ${Math.trunc(index)};
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return select.selectedIndex === ${Math.trunc(index)};
  })()`,
};

/** A list's options as a viewer may draw them, or null. */
export function selectPopupOf(found: unknown): SelectPopup | null {
  return found && typeof found === "object" && Array.isArray((found as SelectPopup).options) ? found as SelectPopup : null;
}

/** The dropdown <select> under a point in the tab's main frame, kept under `token` so the choice lands on that list. */
export async function selectAt(page: CdpPage, x: number, y: number, token: string): Promise<SelectPopup | null> {
  return selectPopupOf(await valueInWorld<unknown>(page.frames, page.frames.mainFrameId, SELECT_SCRIPTS.at(x, y, token)));
}

/**
 * Chooses option `index` of the list kept under `token`: by typing its label into the focused list, as a person
 * would, when the label names one option; otherwise set from the isolated world, whose input and change events are
 * untrusted.
 */
export async function chooseOption(page: CdpPage, token: string, index: number): Promise<boolean> {
  return chooseWith({
    value: (script) => valueInWorld<unknown>(page.frames, page.frames.mainFrameId, script),
    type: (label) => page.keyboard.type(label),
  }, token, index);
}

/** The choice of `chooseOption`, through any page that runs a script in an isolated world and types. */
export async function chooseWith(page: { value(script: string): Promise<unknown>; type(text: string): Promise<unknown> }, token: string, index: number): Promise<boolean> {
  const label = await page.value(SELECT_SCRIPTS.focusLabel(token, index));
  if (typeof label !== "string") return false;
  if (label) {
    await page.type(label);
    if (await page.value(SELECT_SCRIPTS.selectedIndex(token)) === Math.trunc(index)) return true;
  }
  return await page.value(SELECT_SCRIPTS.set(token, index)) === true;
}

/** CSS cursor keywords a viewer may show; anything else (an image, say) shows as the default arrow. */
const CURSORS = new Set([
  "default", "pointer", "text", "vertical-text", "move", "grab", "grabbing", "not-allowed", "no-drop", "wait", "progress",
  "help", "crosshair", "cell", "copy", "alias", "context-menu", "col-resize", "row-resize", "ew-resize", "ns-resize",
  "nesw-resize", "nwse-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize",
  "sw-resize", "all-scroll", "zoom-in", "zoom-out", "none",
]);

const CURSOR_AT = `((x, y) => {
  const element = (${ELEMENT_AT})(x, y);
  if (!element) return "default";
  const value = getComputedStyle(element).cursor || "auto";
  const keyword = value.split(",").pop().trim();
  if (keyword !== "auto") return keyword;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return "text";
  if (element.tagName === "INPUT" && !${NON_TEXT_INPUTS}.includes(element.type)) return "text";
  return element.closest && element.closest("a[href]") ? "pointer" : "default";
})`;

/** The cursor the page shows at a point. */
export async function cursorAt(page: CdpPage, x: number, y: number): Promise<string> {
  const shape = await valueInWorld<string>(page.frames, page.frames.mainFrameId, `${CURSOR_AT}(${cssNumber(x)}, ${cssNumber(y)})`);
  return typeof shape === "string" && CURSORS.has(shape) ? shape : "default";
}

const EDITABLE_AT = `((x, y) => {
  let element = (${ELEMENT_AT})(x, y);
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME" || element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  return element.tagName === "INPUT" && !${NON_TEXT_INPUTS}.includes(element.type) && !element.disabled && !element.readOnly;
})`;

/** Whether the point takes text, frames included: a touch viewer raises its keyboard for it. */
export async function editableAt(page: CdpPage, x: number, y: number): Promise<boolean> {
  return await valueInWorld<boolean>(page.frames, page.frames.mainFrameId, `${EDITABLE_AT}(${cssNumber(x)}, ${cssNumber(y)})`) === true;
}

/** A file picker's `accept` attribute, for the person's own picker. */
export const ACCEPT_OF = "function () { return typeof this.accept === \"string\" ? this.accept.slice(0, 1024) : \"\"; }";
