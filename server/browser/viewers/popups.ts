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

/** The dropdown <select> under a point in the tab's main frame, kept under `token` so the choice lands on that list. */
export async function selectAt(page: CdpPage, x: number, y: number, token: string): Promise<SelectPopup | null> {
  const found = await valueInWorld<SelectPopup | null>(page.frames, page.frames.mainFrameId, `${SELECT_AT}(${cssNumber(x)}, ${cssNumber(y)}, ${JSON.stringify(token)})`);
  return found && Array.isArray(found.options) ? found : null;
}

/**
 * Chooses option `index` of the list kept under `token`: by typing its label into the focused list, as a person
 * would, when the label names one option; otherwise set from the isolated world, whose input and change events are
 * untrusted.
 */
export async function chooseOption(page: CdpPage, token: string, index: number): Promise<boolean> {
  const main = page.frames.mainFrameId;
  const at = Math.trunc(index);
  const label = await valueInWorld<string | null>(page.frames, main, `(() => {
    const select = ${HELD_SELECT}(${JSON.stringify(token)});
    const option = select && select.options[${at}];
    if (!option || option.disabled || (option.parentElement && option.parentElement.tagName === "OPTGROUP" && option.parentElement.disabled)) return null;
    select.focus();
    const label = (option.label || option.text || "").toLowerCase();
    return label && [...select.options].filter((other) => (other.label || other.text || "").toLowerCase().startsWith(label)).length === 1 ? (option.label || option.text) : "";
  })()`);
  if (label === null) return false;
  if (label) {
    await page.keyboard.type(label);
    const reached = await valueInWorld<number>(page.frames, main, `(() => { const select = ${HELD_SELECT}(${JSON.stringify(token)}); return select ? select.selectedIndex : -1; })()`);
    if (reached === at) return true;
  }
  return valueInWorld<boolean>(page.frames, main, `(() => {
    const select = ${HELD_SELECT}(${JSON.stringify(token)});
    if (!select) return false;
    if (select.selectedIndex !== ${at}) {
      select.selectedIndex = ${at};
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return select.selectedIndex === ${at};
  })()`);
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
