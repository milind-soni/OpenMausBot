// Point mode: the person picks a part of a bot's page in the preview and it reaches the composer as a chip.
//
//   host → frame  { jsonrpc: "2.0", method: "mausbot/point", params: { on: boolean } }
//   frame → host  { jsonrpc: "2.0", method: "mausbot/pointed", params: { tag, role, text, selector, html, range? } }
//                 { jsonrpc: "2.0", method: "mausbot/point-ended", params: {} }   Escape in the page
//                 { jsonrpc: "2.0", method: "mausbot/point-selection", params: { state: PointSelectionState } }
//   host → frame  mausbot/highlight-selection commits the frame's current native text selection.
//                 mausbot/marks draws the numbered element and text marks in composer order.
//
// Point stays on after a pick, so the person can mark several parts in one pass; Escape or Point again ends it.
//
// The script below runs inside the page, beside the helper. The page's own scripts can post the same messages, so
// everything a pick carries is the page's word: the host keeps only the frame's own window, clips every field, and
// the server hands it to the model only inside a records block.

export const POINT_METHOD = "mausbot/point";
export const POINTED_METHOD = "mausbot/pointed";
export const POINT_ENDED_METHOD = "mausbot/point-ended";
export const POINT_SELECTION_METHOD = "mausbot/point-selection";
export const HIGHLIGHT_SELECTION_METHOD = "mausbot/highlight-selection";
export const MARKS_METHOD = "mausbot/marks";

export const POINT_LIMITS = {
  text: 200,
  selection: 1_000,
  rangeOffset: 1_000_000,
  selector: 300,
  html: 600,
  /** Chips one message carries; a pick past it is refused, so earlier picks are never dropped. */
  perMessage: 100,
  /** The person's own note on one chip. */
  note: 300,
  label: 40,
} as const;

/** UTF-16 offsets into the element's DOM text and a fingerprint to detect changes when redrawing it. */
export interface PointRange {
  start: number;
  end: number;
  fingerprint: number;
}

/** What a pick says about the element, as the page described it. */
export interface PointedPart {
  tag: string;
  /** ARIA role, given or implied by the tag; "" when neither. */
  role: string;
  text: string;
  selector: string;
  html: string;
  range?: PointRange;
}

/** A pick as a send carries it (POST /api/bots/:id/messages `pointed`): the page row, the version on screen, the part. */
export interface PointedElement extends PointedPart {
  appId: string;
  rev: number;
  /** What the person wrote about this part; absent when they wrote nothing. */
  note?: string;
}

export type PointSelectionState = "none" | "ready" | "too-long";
export type PointEvent = { kind: "pointed"; part: PointedPart } | { kind: "ended" } | { kind: "selection"; state: PointSelectionState };
export type PointMark = string | { selector: string; range: PointRange };

export function pointMessage(on: boolean): { jsonrpc: "2.0"; method: string; params: { on: boolean } } {
  return { jsonrpc: "2.0", method: POINT_METHOD, params: { on } };
}

export function highlightSelectionMessage() {
  return { jsonrpc: "2.0", method: HIGHLIGHT_SELECTION_METHOD, params: {} };
}

/** Selectors and optional text ranges of the parts waiting in the composer, in chip order. */
export function marksMessage(selectors: readonly PointMark[]): { jsonrpc: "2.0"; method: string; params: { selectors: PointMark[] } } {
  return { jsonrpc: "2.0", method: MARKS_METHOD, params: { selectors: [...selectors] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isPointRange(value: unknown): value is PointRange {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  const { start, end, fingerprint } = value;
  return typeof start === "number" && typeof end === "number" && typeof fingerprint === "number"
    && Number.isInteger(start) && Number.isInteger(end) && Number.isInteger(fingerprint)
    && start >= 0 && end > start && end <= POINT_LIMITS.rangeOffset && end - start <= 2 * POINT_LIMITS.selection
    && fingerprint >= 0 && fingerprint <= 0xffffffff;
}

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

function clipped(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const flat = Array.from(value.slice(0, limit * 2 + 2), (char) => (isControl(char.codePointAt(0)!) ? " " : char)).join("").replace(/\s+/g, " ").trim();
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
  if (!isRecord(data.params)) return null;
  const params = data.params;
  if (data.method === POINT_SELECTION_METHOD && (params.state === "none" || params.state === "ready" || params.state === "too-long")) {
    return { kind: "selection", state: params.state };
  }
  if (data.method !== POINTED_METHOD) return null;
  const tag = typeof params.tag === "string" && params.tag.length <= 41 ? params.tag.toLowerCase() : "";
  if (!TAG.test(tag)) return null;
  const role = typeof params.role === "string" && ROLE.test(params.role) ? params.role : "";
  const { range } = params;
  if (range !== undefined && !isPointRange(range)) return null;
  let selector: string;
  if (range) {
    if (typeof params.selector !== "string" || params.selector.length > POINT_LIMITS.selector
      || Array.from(params.selector).some((char) => isControl(char.codePointAt(0)!))) return null;
    selector = params.selector.trim();
  } else {
    selector = clipped(params.selector, POINT_LIMITS.selector);
  }
  const text = clipped(params.text, range ? POINT_LIMITS.selection : POINT_LIMITS.text);
  if (!selector || (range && !text)) return null;
  return { kind: "pointed", part: { tag, role, text, selector, html: clipped(params.html, POINT_LIMITS.html), ...(range ? { range } : {}) } };
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
  var marks = [];
  var selectionState = "none";
  var highlightName = "mausbot-point-selection";
  var highlights = window.CSS && window.CSS.highlights;
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
  // state.start is true at a word start (after a space or hyphen: "Foo-Bar"); punctuation before the first letter keeps it, as CSS capitalize does ("(Note)"),
  // and it carries across inline tags so a word split by them gets one capital.
  var cased = function (text, transform, state) {
    if (transform === "uppercase") return text.toUpperCase();
    if (transform === "lowercase") return text.toLowerCase();
    return text.replace(/[\\s\\S]/g, function (letter) {
      if (/\\s/.test(letter) || letter === "-") { state.start = true; return letter; }
      if (!/[\\p{L}\\p{N}]/u.test(letter)) return letter;
      var start = state.start;
      state.start = false;
      return start && transform === "capitalize" ? letter.toUpperCase() : letter;
    });
  };
  // innerText runs a badge (an inline-block span) into the next word ("CloudRestore"): any box that is not plain inline
  // is a word break on screen, so it is one here too.
  var wordsOf = function (node, state) {
    if (node.nodeType !== 1 || /^(script|style|noscript|template)$/i.test(node.tagName)) return "";
    var style = window.getComputedStyle(node);
    var display = style.display;
    if (display === "none") return "";
    // A hidden wrapper's own text stays out, but a descendant set visible again is on screen.
    var hidden = style.visibility === "hidden" || style.visibility === "collapse";
    var closed = node.tagName === "DETAILS" && !node.open;
    var summary = closed && Array.prototype.find.call(node.children, function (child) { return child.tagName === "SUMMARY"; });
    var shown = style.contentVisibility === "hidden" ? [] : closed ? (summary ? [summary] : []) : node.childNodes;
    var block = !/^(inline|contents)?$/.test(display) || node.tagName === "BR";
    if (block) state.start = true;
    var words = Array.prototype.map.call(shown, function (child) {
      return child.nodeType === 3 ? (hidden ? "" : cased(child.data, style.textTransform, state)) : wordsOf(child, state);
    }).join("");
    if (block) state.start = true;
    return block ? " " + words + " " : words;
  };
  var describe = function (element) {
    var tag = element.tagName.toLowerCase();
    // A closed single select shows only its chosen option, not every option.
    var chosen = tag === "select" && !element.multiple && !(element.size > 1);
    var text = (chosen ? (element.selectedOptions[0] ? element.selectedOptions[0].text : "") : wordsOf(element, { start: true })).trim() || element.getAttribute("aria-label") || element.getAttribute("alt") ||
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
    return node && node.nodeType === 1 && node !== root && node !== document.body && !(node.closest && node.closest("[data-mausbot-point]")) ? node : null;
  };
  var fingerprint = function (text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return hash >>> 0;
  };
  var resolveRange = function (element, anchor) {
    var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    var offset = 0;
    var started = false;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var next = offset + node.length;
      if (!started && anchor.start < next) {
        range.setStart(node, anchor.start - offset);
        started = true;
      }
      if (started && anchor.end <= next) {
        range.setEnd(node, anchor.end - offset);
        return range;
      }
      offset = next;
    }
    return null;
  };
  var placeMark = function (box, rect) {
    box.style.display = rect ? "block" : "none";
    if (!rect) return;
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  };
  var findElement = function (selector) {
    try { return selector ? document.querySelector(selector) : null; } catch (error) { return null; }
  };
  var visibleRect = function (rect) { return rect.width > 0 && rect.height > 0; };
  var matchesRange = function (element, range, anchor) {
    if (!range || !element.contains(range.commonAncestorContainer)) return false;
    var text = range.toString();
    return text.length === anchor.end - anchor.start && fingerprint(text) === anchor.fingerprint;
  };
  var drawMarks = function () {
    var painted = highlights && typeof window.Highlight === "function" ? new window.Highlight() : null;
    marks.forEach(function (mark) {
      if (!mark.element || !mark.element.isConnected) {
        mark.element = findElement(mark.selector);
        mark.range = null;
      }
      var rect = null;
      if (mark.anchor) {
        if (mark.element && !matchesRange(mark.element, mark.range, mark.anchor)) {
          var found = resolveRange(mark.element, mark.anchor);
          mark.range = matchesRange(mark.element, found, mark.anchor) ? found : null;
        }
        var rects = mark.range ? Array.from(mark.range.getClientRects()).filter(visibleRect) : [];
        rect = rects[0] || null;
        if (rect) mark.box.firstElementChild.style.top = rect.top < 16 ? "0" : "-16px";
        if (painted && rect) painted.add(mark.range);
        mark.fragments.forEach(function (fragment) { fragment.remove(); });
        // shortcut: paint the first 64 fragments in browsers without CSS highlights, raise the cap if longer selections need it.
        mark.fragments = painted ? [] : rects.slice(0, 64).map(function (rect) {
          var fragment = document.createElement("div");
          fragment.style.cssText = "position:fixed;pointer-events:none;background:Mark;opacity:0.35";
          placeMark(fragment, rect);
          mark.box.appendChild(fragment);
          return fragment;
        });
      } else if (mark.element) {
        var bounds = mark.element.getBoundingClientRect();
        if (visibleRect(bounds)) rect = bounds;
      }
      placeMark(mark.box, rect);
    });
    if (painted) {
      if (painted.size) highlights.set(highlightName, painted);
      else highlights.delete(highlightName);
    }
  };
  var highlightStyle = null;
  var setMarks = function (selectors) {
    marks.forEach(function (mark) { mark.box.remove(); });
    marks = [];
    selectors.slice(0, ${POINT_LIMITS.perMessage}).forEach(function (entry, index) {
      var selector = typeof entry === "string" ? entry : entry && entry.selector;
      if (!selector || typeof selector !== "string") return;
      var anchor = entry.range;
      var element = findElement(selector);
      if (!anchor && !element) return;
      if (anchor && highlights && !highlightStyle) {
        highlightStyle = document.createElement("style");
        highlightStyle.textContent = "::highlight(" + highlightName + "){background-color:Mark;color:MarkText}";
        document.head.appendChild(highlightStyle);
      }
      var mark = document.createElement("div");
      mark.setAttribute("data-mausbot-point", "mark");
      mark.setAttribute("aria-hidden", "true");
      mark.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;" +
        (anchor ? "" : "border:2px dashed #f59e0b;background:rgba(245,158,11,0.10);border-radius:4px");
      var number = document.createElement("span");
      number.textContent = String(index + 1);
      number.style.cssText = "position:absolute;right:-2px;top:" + (anchor ? "-16px" : "-2px") +
        ";z-index:1;font:600 11px/16px system-ui,sans-serif;color:#fff;background:#f59e0b;padding:0 5px;border-radius:0 4px 0 4px";
      mark.appendChild(number);
      root.appendChild(mark);
      marks.push({ selector: selector, element: element, box: mark, anchor: anchor, range: null, fragments: [] });
    });
    drawMarks();
  };
  var redrawing = false;
  var redraw = function () {
    if (!marks.length || redrawing) return;
    redrawing = true;
    requestAnimationFrame(function () { redrawing = false; drawMarks(); });
  };
  window.addEventListener("scroll", redraw, true);
  window.addEventListener("resize", redraw);
  // A page can move a marked part without a scroll or resize (a section opens). The marks sit outside body.
  if (typeof MutationObserver === "function") {
    var watchBody = function () {
      if (document.body) new MutationObserver(redraw).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    };
    if (document.body) watchBody();
    else document.addEventListener("DOMContentLoaded", watchBody, { once: true });
  }
  var post = function (method, params) { parent.postMessage({ jsonrpc: "2.0", method: method, params: params }, "*"); };
  var selectionOf = function () {
    var selection = document.getSelection();
    var body = document.body;
    if (!selection || !body || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    return body.contains(range.commonAncestorContainer) ? { selection: selection, range: range } : null;
  };
  var describeSelection = function (picked) {
    if (!picked) return { state: "none" };
    var range = picked.range;
    var element = range.commonAncestorContainer;
    if (element.nodeType !== 1) element = element.parentElement;
    var selector = selectorOf(element);
    if (!selector || selector.length > ${POINT_LIMITS.selector} || findElement(selector) !== element) {
      element = document.body;
      selector = "body";
    }
    var prefix = document.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    var start = prefix.toString().length;
    var raw = range.toString();
    if (!raw.length) return { state: "none" };
    var end = start + raw.length;
    if (end > ${POINT_LIMITS.rangeOffset} || raw.length > ${2 * POINT_LIMITS.selection}) return { state: "too-long" };
    var text = String(picked.selection).replace(/[\\s\\x00-\\x1f\\x7f-\\x9f]+/g, " ").trim();
    if (!text) return { state: "none" };
    if (Array.from(text).length > ${POINT_LIMITS.selection}) return { state: "too-long" };
    var tag = element.tagName.toLowerCase();
    return { state: "ready", part: { tag: tag, role: element.getAttribute("role") || ROLES[tag] || "", text: text,
      selector: selector, html: "", range: { start: start, end: end, fingerprint: fingerprint(raw) } } };
  };
  var reportSelection = function (state) {
    if (state === selectionState) return;
    selectionState = state;
    if (state !== "none" && box) {
      box.style.display = "none";
      current = null;
    }
    post("${POINT_SELECTION_METHOD}", { state: state });
  };
  document.addEventListener("selectionchange", function () {
    if (on) reportSelection(describeSelection(selectionOf()).state);
  });
  var highlightSelection = function () {
    var selected = selectionOf();
    var described = describeSelection(selected);
    if (!described.part) { reportSelection(described.state); return false; }
    post("${POINTED_METHOD}", described.part);
    selected.selection.removeAllRanges();
    reportSelection("none");
    return true;
  };
  var set = function (next) {
    on = next;
    root.style.cursor = on ? "crosshair" : "";
    if (!on && box) box.style.display = "none";
    current = null;
    if (on) reportSelection(describeSelection(selectionOf()).state);
    else selectionState = "none";
  };
  var stopEvent = function (event) {
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  };
  var swallow = function (event) {
    if (!on) return;
    event.preventDefault();
    stopEvent(event);
  };
  window.addEventListener("pointermove", function (event) {
    if (!on || selectionOf()) return;
    var element = pickable(event.target);
    if (element && element !== current) { current = element; place(element); }
  }, true);
  ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "selectstart"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (!on) return;
      var target = event.target;
      if (target.isContentEditable || (target.closest && target.closest("input, textarea, select"))) event.preventDefault();
      stopEvent(event);
    }, { capture: true, passive: false });
  });
  ["auxclick", "dblclick", "dragstart", "submit"].forEach(function (type) {
    window.addEventListener(type, swallow, true);
  });
  window.addEventListener("click", function (event) {
    if (!on) return;
    swallow(event);
    if (selectionOf()) return;
    // A hovered part the page has since removed is not on screen any more, so it is not what the person picked.
    var element = pickable(event.target) || (current && current.isConnected ? current : null);
    if (!element) return;
    post("${POINTED_METHOD}", describe(element));
  }, true);
  window.addEventListener("keydown", function (event) {
    if (!on) return;
    if (event.key === "Escape") { swallow(event); set(false); post("${POINT_ENDED_METHOD}", {}); }
    if (event.key === "Enter" && !event.isComposing && !event.repeat && highlightSelection()) swallow(event);
  }, true);
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0" || !message.params) return;
    if (message.method === "${POINT_METHOD}") set(message.params.on === true);
    if (message.method === "${HIGHLIGHT_SELECTION_METHOD}" && on) highlightSelection();
    if (message.method === "${MARKS_METHOD}" && Array.isArray(message.params.selectors)) setMarks(message.params.selectors);
  });
})();`;
