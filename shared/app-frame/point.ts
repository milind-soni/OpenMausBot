// Point mode: the person picks a part of a bot's page in the preview and it reaches the composer as a chip.
//
//   host → frame  { jsonrpc: "2.0", method: "mausbot/point", params: { on: boolean } }
//   frame → host  { jsonrpc: "2.0", method: "mausbot/pointed", params: { tag, role, text, selector, html } }
//                 { jsonrpc: "2.0", method: "mausbot/point-ended", params: {} }   Escape in the page
//
// The script below runs inside the page, beside the helper. The page's own scripts can post the same messages, so
// everything a pick carries is the page's word: the host keeps only the frame's own window, clips every field, and
// the server hands it to the model only inside a records block.

export const POINT_METHOD = "mausbot/point";
export const POINTED_METHOD = "mausbot/pointed";
export const POINT_ENDED_METHOD = "mausbot/point-ended";

export const POINT_LIMITS = {
  text: 200,
  selector: 300,
  html: 600,
  /** Chips one message carries. */
  perMessage: 5,
  label: 40,
} as const;

/** What a pick says about the element, as the page described it. */
export interface PointedPart {
  tag: string;
  /** ARIA role, given or implied by the tag; "" when neither. */
  role: string;
  text: string;
  selector: string;
  html: string;
}

/** A pick as a send carries it (POST /api/bots/:id/messages `pointed`): the page row, the version on screen, the part. */
export interface PointedElement extends PointedPart {
  appId: string;
  rev: number;
}

export type PointEvent = { kind: "pointed"; part: PointedPart } | { kind: "ended" };

export function pointMessage(on: boolean): { jsonrpc: "2.0"; method: string; params: { on: boolean } } {
  return { jsonrpc: "2.0", method: POINT_METHOD, params: { on } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

function clipped(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const flat = Array.from(value, (char) => (isControl(char.codePointAt(0)!) ? " " : char)).join("").replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= limit ? flat : `${points.slice(0, limit - 1).join("").trimEnd()}…`;
}

const TAG = /^[a-z][a-z0-9-]{0,40}$/;
const ROLE = /^[a-z-]{1,40}$/;

/** Security: only a message whose source is the frame's own window counts; any other window, or a malformed pick,
 * is dropped. */
export function readPointEvent(event: { source: unknown; data: unknown }, frame: unknown): PointEvent | null {
  if (frame === null || frame === undefined || event.source !== frame) return null;
  const data = event.data;
  if (!isRecord(data) || data.jsonrpc !== "2.0" || "id" in data) return null;
  if (data.method === POINT_ENDED_METHOD) return { kind: "ended" };
  if (data.method !== POINTED_METHOD || !isRecord(data.params)) return null;
  const params = data.params;
  const tag = typeof params.tag === "string" ? params.tag.toLowerCase() : "";
  if (!TAG.test(tag)) return null;
  const role = typeof params.role === "string" && ROLE.test(params.role) ? params.role : "";
  const selector = clipped(params.selector, POINT_LIMITS.selector);
  if (!selector) return null;
  return {
    kind: "pointed",
    part: { tag, role, text: clipped(params.text, POINT_LIMITS.text), selector, html: clipped(params.html, POINT_LIMITS.html) },
  };
}

/** The chip's words: the part's own text, quoted; null when it has none, so the caller says "a part of the page". */
export function pointedLabel(part: Pick<PointedPart, "text">): string | null {
  const text = clipped(part.text, POINT_LIMITS.label);
  return text ? `“${text}”` : null;
}

/** Plain ES2017 with no imports, run as written inside the page. It answers only its parent window. */
export const APP_POINT_SOURCE = `(function () {
  "use strict";
  var parent = window.parent;
  if (!parent || parent === window) return;
  var root = document.documentElement;
  var on = false;
  var box = null;
  var tagLabel = null;
  var current = null;
  var ROLES = { a: "link", button: "button", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    img: "img", svg: "img", input: "textbox", textarea: "textbox", select: "combobox", li: "listitem", ul: "list", ol: "list", nav: "navigation",
    table: "table", tr: "row", td: "cell", th: "columnheader", form: "form", header: "banner", footer: "contentinfo", main: "main",
    section: "region", article: "article", aside: "complementary", dialog: "dialog", p: "paragraph" };
  var clip = function (text, limit) {
    var flat = String(text || "").replace(/\\s+/g, " ").trim();
    return flat.length > limit ? flat.slice(0, limit - 1) + "\\u2026" : flat;
  };
  var segment = function (node) {
    var tag = node.tagName.toLowerCase();
    var keyed = ["data-testid", "data-id", "data-name"];
    for (var k = 0; k < keyed.length; k += 1) {
      var value = node.getAttribute(keyed[k]);
      if (value && /^[\\w -]{1,60}$/.test(value)) return tag + "[" + keyed[k] + "=\\"" + value + "\\"]";
    }
    var siblings = node.parentElement ? Array.prototype.filter.call(node.parentElement.children, function (child) { return child.tagName === node.tagName; }) : [node];
    return siblings.length > 1 ? tag + ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")" : tag;
  };
  var selectorOf = function (element) {
    var parts = [];
    for (var node = element; node && node.nodeType === 1 && node !== root && node !== document.body && parts.length < 6; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\\w-]{0,63}$/.test(node.id)) { parts.unshift("#" + node.id); return parts.join(" > "); }
      parts.unshift(segment(node));
    }
    return parts.join(" > ");
  };
  var describe = function (element) {
    var tag = element.tagName.toLowerCase();
    var text = element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("alt") ||
      element.getAttribute("placeholder") || element.getAttribute("title") || "";
    return { tag: tag, role: element.getAttribute("role") || ROLES[tag] || "", text: clip(text, 200), selector: clip(selectorOf(element), 300),
      html: clip(element.outerHTML, 600) };
  };
  var place = function (element) {
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("data-mausbot-point", "");
      box.setAttribute("aria-hidden", "true");
      box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #3b82f6;" +
        "background:rgba(59,130,246,0.12);border-radius:4px;transition:all 60ms ease-out;display:none";
      tagLabel = document.createElement("span");
      tagLabel.style.cssText = "position:absolute;left:-2px;top:-20px;font:600 11px/16px system-ui,sans-serif;color:#fff;background:#3b82f6;" +
        "padding:1px 6px;border-radius:4px;white-space:nowrap";
      box.appendChild(tagLabel);
      root.appendChild(box);
    }
    var rect = element.getBoundingClientRect();
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    tagLabel.style.top = rect.top < 22 ? "auto" : "-20px";
    tagLabel.style.bottom = rect.top < 22 ? "-20px" : "auto";
    tagLabel.textContent = element.tagName.toLowerCase();
    box.style.display = "block";
  };
  var pickable = function (node) {
    return node && node.nodeType === 1 && node !== root && node !== document.body && node !== box && !(box && box.contains(node)) ? node : null;
  };
  var post = function (method, params) { parent.postMessage({ jsonrpc: "2.0", method: method, params: params }, "*"); };
  var set = function (next) {
    on = next;
    root.style.cursor = on ? "crosshair" : "";
    if (!on && box) box.style.display = "none";
    current = null;
  };
  var swallow = function (event) {
    if (!on) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  };
  window.addEventListener("pointermove", function (event) {
    if (!on) return;
    var element = pickable(event.target);
    if (element && element !== current) { current = element; place(element); }
  }, true);
  ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "submit", "touchstart"].forEach(function (type) {
    window.addEventListener(type, swallow, { capture: true, passive: false });
  });
  window.addEventListener("click", function (event) {
    if (!on) return;
    swallow(event);
    var element = pickable(event.target) || current;
    if (!element) return;
    post("${POINTED_METHOD}", describe(element));
    set(false);
  }, true);
  window.addEventListener("keydown", function (event) {
    if (on && event.key === "Escape") { swallow(event); set(false); post("${POINT_ENDED_METHOD}", {}); }
  }, true);
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var message = event.data;
    if (message && message.jsonrpc === "2.0" && message.method === "${POINT_METHOD}" && message.params) set(message.params.on === true);
  });
})();`;
