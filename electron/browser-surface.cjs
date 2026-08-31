// The built-in browser surface: WebContentsViews driven over the Chrome
// DevTools Protocol that Electron already ships (webContents.debugger), and
// shown inside the app window as the Browser tab of the computer panel.
//
// Why a native view and not a screenshot stream: the view IS the panel. The
// person sees the real page, and taking over is just clicking into it — no
// JPEG plumbing, no VNC, no second Chrome. The renderer only reports where
// the tab's rectangle is; this module owns lifecycle, isolation and input.
//
// Profiles: a bot has one view per profile it has used — its own private
// session, any named shared profile, or a throwaway Guest — and switching
// shows another live view instead of rebuilding one, the way Ferdium and
// pi-desktop do it (Electron cannot move a WebContents between sessions).
// Cold views are evicted least-recently-used so memory stays bounded.
//
// Isolation, per view: a session partition, sandbox on, no preload, every
// permission prompt denied, downloads refused, popups routed back into the
// same view, JavaScript dialogs answered by the surface (never shown as
// native modals), and only http(s) navigations honoured. A bot's browser can
// never reach file://, chrome:// or the app's own origin.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeDesktopWorkspaceBounds } = require("./desktop-workspace.cjs");
const {
  backendNodeIdFromRef,
  browserAddressAllowed,
  browserNavigationAllowed,
  browserNavigationUrl,
  browserPartition,
  browserProfilePartition,
  browserUserAgent,
  formatSnapshot,
  snapshotFromAxNodes,
} = require("./browser-snapshot.cjs");

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const GUEST_PROFILE = "guest";
const MAX_VIEWS = 8;
const SETTLE_MS = 350;
const LOAD_WAIT_MS = 8_000;
const WAIT_POLL_MS = 250;
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 30_000;
const SCREENSHOT_WIDTH = 1024;
const SCREENSHOT_QUALITY = 70;
const MAX_TEXT = 4_000;
const MAX_READ_CHARS = 24_000;
const MAX_PAGE_NOTICES = 20;
const DNS_CACHE_MS = 10_000;
const MAX_DNS_CACHE = 256;
const AGENT_INPUT_SUPPRESS_MS = 100;
const COMPACT_GESTURE_GUARD_MS = 400;
const AX_TREE_DEPTH = 24;
/** The page lays out at this size whatever the panel's rectangle is. Both
 * compact and expanded surfaces scale the same desktop viewport to fit, so
 * responsive pages, refs, screenshots and scroll positions do not change
 * merely because the person opened the larger workspace. */
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** Keys a bot may press by name → CDP key event fields. `text` is what makes
 * Enter/Tab actually fire in inputs; the virtual key code is what makes
 * shortcuts and arrow navigation work in apps that listen at keydown. */
const KEYS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

const SCROLL_DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const INJECTED_BUNDLE = path.join(__dirname, "resources", "browser-snapshot.js");
const SNAPSHOT_MAX_CHARS = 60_000;

/** Playwright's accessibility snapshot, bundled for the page
 * (scripts/build-browser-snapshot.mjs). Missing only in a broken checkout;
 * the surface then falls back to the bare accessibility tree. */
function loadInjectedSource() {
  try {
    return fs.readFileSync(INJECTED_BUNDLE, "utf8");
  } catch {
    return null;
  }
}

function botIdOf(value) {
  const id = String(value ?? "");
  if (!BOT_ID.test(id)) throw new Error("A bot id is required");
  return id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isString = (value) => Object.prototype.toString.call(value) === "[object String]";

/** Page-side helpers, evaluated over CDP. Everything here is plain
 * expressions on the page — nothing is injected persistently. */
const SCROLL_METRICS_EXPRESSION = `(() => {
  const el = document.scrollingElement || document.documentElement;
  return { top: Math.round(el.scrollTop), height: Math.round(el.scrollHeight), view: Math.round(window.innerHeight) };
})()`;
const SCROLL_AT_POINT_FUNCTION = `function __ombScrollAtPoint({ x, y, deltaX, deltaY }) {
  const root = document.scrollingElement || document.documentElement;
  const candidates = [];
  const seen = new Set();
  let current = document.elementFromPoint(x, y);
  while (current instanceof Element) {
    if (!seen.has(current)) {
      seen.add(current);
      candidates.push(current);
    }
    const tree = current.getRootNode && current.getRootNode();
    current = current.parentElement || (tree && tree.host instanceof Element ? tree.host : null);
  }
  if (root && !seen.has(root)) candidates.push(root);
  for (const candidate of candidates) {
    const horizontal = deltaX !== 0;
    const currentOffset = horizontal ? candidate.scrollLeft : candidate.scrollTop;
    const maximum = horizontal
      ? Math.max(0, candidate.scrollWidth - candidate.clientWidth)
      : Math.max(0, candidate.scrollHeight - candidate.clientHeight);
    const delta = horizontal ? deltaX : deltaY;
    const canMove = delta > 0 ? currentOffset < maximum : currentOffset > 0;
    if (!canMove) continue;
    const overflow = getComputedStyle(candidate)[horizontal ? "overflowX" : "overflowY"];
    if (candidate === root) {
      if (["hidden", "clip"].includes(overflow)) continue;
    } else if (!["auto", "scroll", "overlay"].includes(overflow)) continue;
    if (horizontal) candidate.scrollLeft = currentOffset + delta;
    else candidate.scrollTop = currentOffset + delta;
    const nextOffset = horizontal ? candidate.scrollLeft : candidate.scrollTop;
    if (nextOffset !== currentOffset) return true;
  }
  return false;
}`;
const SENSITIVE_FIELD_SOURCE = "password|passwd|passcode|client.?secret|api.?key|secret.?key|private.?key|signing.?key|webhook.?secret|secret.?access.?key|access.?token|auth.?token|refresh.?token|bearer.?token|one.?time|otp|verification.?code|recovery.?code|seed.?phrase|mnemonic|recovery.?phrase|security.?answer|cc-.+|card.?(number|security|cvv|cvc)|cvv|cvc|bank.?(account|routing)|routing.?(number|code)|account.?(number|no)|social.?(security|insurance)|ssn|tax.?id";
const SENSITIVE_FIELD_PATTERN = new RegExp(SENSITIVE_FIELD_SOURCE, "i");

function sensitiveFieldFromHints(type, hints) {
  if (String(type ?? "").toLowerCase() === "password") return true;
  const raw = hints.filter(Boolean).join(" ");
  const words = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase();
  return SENSITIVE_FIELD_PATTERN.test(raw) || /(?:^| )(pin|security code)(?: |$)/.test(words);
}

function axNodeIntegritySignature(node) {
  if (!node || node.ignored === true) return null;
  const backendNodeId = Number(node.backendDOMNodeId ?? 0);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
  const properties = (Array.isArray(node.properties) ? node.properties : [])
    .map((property) => [
      String(property?.name ?? ""),
      String(property?.value?.type ?? ""),
      property?.value?.value ?? null,
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    backendNodeId,
    role: String(node.role?.value ?? ""),
    name: String(node.name?.value ?? ""),
    description: String(node.description?.value ?? ""),
    value: node.value?.value ?? null,
    properties,
  });
}

const HIT_RELATED_FUNCTION = `function __ombHitRelated(hit) {
  const composedContains = (ancestor, candidate) => {
    for (let current = candidate; current;) {
      if (current === ancestor) return true;
      const root = current.getRootNode ? current.getRootNode() : null;
      current = current.parentNode || (root && root.host) || null;
    }
    return false;
  };
  return Boolean(hit && (composedContains(this, hit) || composedContains(hit, this)));
}`;
// Executed with a candidate DOM element as `this`. Keep this in lockstep with
// third_party/playwright-injected/secretInput.ts: raw snapshots and action
// gating must agree about which fields only a person may fill.
const SENSITIVE_FIELD_FUNCTION = `function __ombSensitiveField() {
  const element = this;
  if (!element || !element.tagName) return "unknown";
  const tag = String(element.tagName).toLowerCase();
  const role = String(element.getAttribute("role") || "").toLowerCase();
  const contentEditable = element.isContentEditable === true;
  const editable = tag === "input" || tag === "textarea" || contentEditable
    || ["textbox", "searchbox", "combobox"].includes(role);
  if (!editable) return "unknown";
  const labels = element.labels ? Array.from(element.labels, label => label.textContent || "") : [];
  const wrappingLabel = element.closest("label")?.textContent || "";
  const externalLabels = element.id ? Array.from(element.ownerDocument.querySelectorAll("label[for]"))
    .filter(label => label.getAttribute("for") === element.id).map(label => label.textContent || "") : [];
  const labelledBy = String(element.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
    .map(id => element.ownerDocument.getElementById(id)?.textContent || "");
  const raw = [
    element.getAttribute("name"), element.id, element.getAttribute("aria-label"),
    element.getAttribute("autocomplete"), element.getAttribute("placeholder"),
    element.getAttribute("title"), ...labels, wrappingLabel, ...externalLabels, ...labelledBy,
  ].filter(Boolean).join(" ");
  const words = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase();
  const type = tag === "input" ? String(element.type || "text").toLowerCase() : "textarea";
  const sensitive = type === "password"
    || new RegExp(${JSON.stringify(SENSITIVE_FIELD_SOURCE)}, "i").test(raw)
    || /(?:^| )(pin|security code)(?: |$)/.test(words);
  if (sensitive) return "sensitive";
  if (tag === "input" && !["text", "search", "email", "url", "tel", "number"].includes(type)) return "unknown";
  if (element.disabled === true || element.readOnly === true) return "unknown";
  return "ordinary";
}`;
const DEEPEST_ACTIVE_ELEMENT_EXPRESSION = `(() => {
  let element = document.activeElement;
  for (let depth = 0; element && depth < 16; depth += 1) {
    const shadowActive = element.shadowRoot && element.shadowRoot.activeElement;
    if (shadowActive) { element = shadowActive; continue; }
    if (String(element.tagName || "").toLowerCase() !== "iframe") break;
    try {
      const frameActive = element.contentDocument && element.contentDocument.activeElement;
      if (!frameActive) break;
      element = frameActive;
    } catch { break; }
  }
  return element;
})()`;
const PAGE_TEXT_EXPRESSION = `(() => {
  const root = document.body;
  if (!root) return "";
  const classify = ${SENSITIVE_FIELD_FUNCTION};
  // Preserve innerText's rendered/hidden filtering, then remove the rendered
  // text of every protected subtree. Replacing repeated occurrences is an
  // intentional privacy-biased over-redaction.
  let text = root.innerText || "";
  const stack = [root];
  while (stack.length) {
    const element = stack.pop();
    if (element.shadowRoot) {
      for (const child of element.shadowRoot.children) stack.push(child);
    }
    for (const child of element.children) stack.push(child);
    if (classify.call(element) !== "sensitive") continue;
    const values = [element.innerText, element.textContent, element.value]
      .filter(value => typeof value === "string" && value.length > 0);
    const labels = [
      ...Array.from(element.labels || []),
      element.closest("label"),
      ...Array.from(element.ownerDocument.querySelectorAll("label[for]"))
        .filter(label => element.id && label.getAttribute("for") === element.id),
      ...String(element.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
        .map(id => element.ownerDocument.getElementById(id)),
    ].filter(Boolean);
    for (const label of labels) {
      for (const value of [label.innerText, label.textContent]) {
        if (typeof value === "string" && value.length > 0) values.push(value);
      }
    }
    for (const value of values) text = text.split(value).join("[redacted]");
  }
  return text.replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
})()`;
const MAX_PRIVACY_SNAPSHOT_NODES = 100_000;

function snapshotString(strings, index) {
  return Number.isInteger(index) && index >= 0 && index < strings.length && isString(strings[index])
    ? String(strings[index])
    : "";
}

function snapshotRareStrings(data, strings) {
  const values = new Map();
  if (data === undefined) return values;
  if (!data || !Array.isArray(data.index) || !Array.isArray(data.value) || data.index.length !== data.value.length) {
    throw new Error("malformed browser privacy snapshot");
  }
  for (let offset = 0; offset < data.index.length; offset += 1) {
    const nodeIndex = data.index[offset];
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0) throw new Error("malformed browser privacy snapshot");
    values.set(nodeIndex, snapshotString(strings, data.value[offset]));
  }
  return values;
}

/** Inspect a DOMSnapshot capture without executing page JavaScript. Chrome
 * flattens open *and closed* shadow roots and includes current input/textarea
 * values. Redaction strings stay in the Electron main process and are used
 * only to remove protected flat-tree text before it reaches a bot. */
function inspectDomSnapshotPrivacy(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.documents) || !Array.isArray(snapshot.strings)) {
    throw new Error("malformed browser privacy snapshot");
  }
  const strings = snapshot.strings;
  let totalNodes = 0;
  let hasProtectedValue = false;
  let hasClosedShadowRoot = false;
  let hasClosedShadowProtectedValue = false;
  const redactions = new Set();
  for (const document of snapshot.documents) {
    const nodes = document?.nodes;
    if (!nodes || !Array.isArray(nodes.nodeName) || !Array.isArray(nodes.parentIndex) || !Array.isArray(nodes.attributes)) {
      throw new Error("malformed browser privacy snapshot");
    }
    const count = nodes.nodeName.length;
    totalNodes += count;
    if (totalNodes > MAX_PRIVACY_SNAPSHOT_NODES || nodes.parentIndex.length !== count || nodes.attributes.length !== count) {
      throw new Error("browser privacy snapshot is too large or malformed");
    }
    const inputValues = snapshotRareStrings(nodes.inputValue, strings);
    const textValues = snapshotRareStrings(nodes.textValue, strings);
    const shadowRootTypes = snapshotRareStrings(nodes.shadowRootType, strings);
    if ([...shadowRootTypes.values()].some((value) => String(value).toLowerCase() === "closed")) {
      hasClosedShadowRoot = true;
    }
    const attributes = [];
    const children = Array.from({ length: count }, () => []);
    for (let index = 0; index < count; index += 1) {
      const raw = nodes.attributes[index];
      if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new Error("malformed browser privacy snapshot");
      const parsed = new Map();
      for (let offset = 0; offset < raw.length; offset += 2) {
        parsed.set(snapshotString(strings, raw[offset]).toLowerCase(), snapshotString(strings, raw[offset + 1]));
      }
      attributes.push(parsed);
      const parent = nodes.parentIndex[index];
      if (Number.isInteger(parent) && parent >= 0 && parent < count) children[parent].push(index);
    }
    const tagAt = (index) => snapshotString(strings, nodes.nodeName[index]).toLowerCase();
    const valueAt = (index) => snapshotString(strings, nodes.nodeValue?.[index]);
    const ids = new Map();
    for (let index = 0; index < count; index += 1) {
      const id = attributes[index].get("id");
      if (id && !ids.has(id)) ids.set(id, index);
    }
    const subtreeTextCache = new Map();
    const subtreeText = (rootIndex) => {
      if (subtreeTextCache.has(rootIndex)) return subtreeTextCache.get(rootIndex);
      const pending = [rootIndex];
      const seen = new Set();
      const parts = [];
      let length = 0;
      while (pending.length && length < 4_096) {
        const index = pending.pop();
        if (seen.has(index)) continue;
        seen.add(index);
        const value = valueAt(index);
        if (value) {
          parts.push(value);
          length += value.length;
        }
        for (const child of children[index]) pending.push(child);
      }
      const text = parts.join(" ").slice(0, 4_096);
      subtreeTextCache.set(rootIndex, text);
      return text;
    };
    const labelsFor = new Map();
    for (let index = 0; index < count; index += 1) {
      if (tagAt(index) !== "label") continue;
      const target = attributes[index].get("for");
      if (!target) continue;
      const list = labelsFor.get(target) ?? [];
      list.push(subtreeText(index));
      labelsFor.set(target, list);
    }
    for (let index = 0; index < count; index += 1) {
      const tag = tagAt(index);
      const attrs = attributes[index];
      const role = String(attrs.get("role") ?? "").toLowerCase();
      const editable = tag === "input" || tag === "textarea"
        || (attrs.has("contenteditable") && String(attrs.get("contenteditable")).toLowerCase() !== "false")
        || ["textbox", "searchbox", "combobox"].includes(role);
      if (!editable) continue;
      const id = attrs.get("id") ?? "";
      const labelTexts = [attrs.get("aria-label"), attrs.get("placeholder"), attrs.get("title"), ...(labelsFor.get(id) ?? [])];
      const hints = [attrs.get("name"), id, attrs.get("autocomplete"), ...labelTexts];
      const labelledBy = String(attrs.get("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      for (const labelledId of labelledBy) {
        const labelledIndex = ids.get(labelledId);
        if (labelledIndex !== undefined) {
          const text = subtreeText(labelledIndex);
          hints.push(text);
          labelTexts.push(text);
        }
      }
      const seenParents = new Set();
      for (let parent = nodes.parentIndex[index]; Number.isInteger(parent) && parent >= 0 && parent < count && !seenParents.has(parent); parent = nodes.parentIndex[parent]) {
        seenParents.add(parent);
        if (tagAt(parent) === "label") {
          const text = subtreeText(parent);
          hints.push(text);
          labelTexts.push(text);
          break;
        }
      }
      const type = tag === "input" ? attrs.get("type") ?? "text" : tag;
      if (!sensitiveFieldFromHints(type, hints)) continue;
      const values = [
        inputValues.get(index), textValues.get(index), attrs.get("value"), attrs.get("aria-valuetext"),
        tag !== "input" && tag !== "textarea" ? subtreeText(index) : "",
      ];
      const populated = values.filter((value) => isString(value) && String(value).trim().length > 0).map(String);
      if (!populated.length) continue;
      hasProtectedValue = true;
      for (const value of populated) redactions.add(value);
      // A protected field's accessible-name contributors may themselves be
      // an OTP/recovery secret. Suppress meaningful label text too, while
      // avoiding one-character global replacements.
      for (const value of labelTexts) {
        if (isString(value) && String(value).trim().length >= 3) redactions.add(String(value));
      }
      const ancestry = new Set();
      for (let current = index; Number.isInteger(current) && current >= 0 && current < count && !ancestry.has(current); current = nodes.parentIndex[current]) {
        ancestry.add(current);
        if (String(shadowRootTypes.get(current) ?? "").toLowerCase() === "closed") {
          hasClosedShadowProtectedValue = true;
          break;
        }
      }
    }
  }
  return { hasProtectedValue, hasClosedShadowRoot, hasClosedShadowProtectedValue, redactions: [...redactions] };
}

function domSnapshotContainsProtectedValue(snapshot) {
  return inspectDomSnapshotPrivacy(snapshot).hasProtectedValue;
}

/**
 * @param {object} options
 * @param {import("electron").BrowserWindow} options.owner the app window that hosts the views
 * @param {(options: object) => import("electron").WebContentsView} options.createView
 * @param {(state: object) => void} [options.notify] renderer-facing state changes
 * @param {(state: {botId: string, profile: string}) => void} [options.onUserInteraction]
 * @param {(session: object, hostname: string) => Promise<{endpoints?: Array<{address?: string}>}>} [options.resolveHost]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(botId: string) => string} [options.partitionFor] test seam for the per-bot partition
 * @param {number} [options.settleMs]
 * @param {number} [options.loadWaitMs]
 * @param {number} [options.maxViews]
 * @param {() => number} [options.now]
 */
function createBrowserSurfaceManager({
  owner,
  createView,
  notify,
  onUserInteraction,
  resolveHost,
  platform = process.platform,
  partitionFor: ownPartitionFor = browserPartition,
  settleMs = SETTLE_MS,
  loadWaitMs = LOAD_WAIT_MS,
  maxViews = MAX_VIEWS,
  now = () => Date.now(),
  injectedSource = loadInjectedSource(),
}) {
  if (!owner || owner.isDestroyed?.()) throw new Error("The OpenMausBot window is unavailable");
  if (createView?.constructor !== Function) throw new Error("The browser surface viewer is unavailable");
  const emit = notify instanceof Function ? notify : () => {};
  const emitUserInteraction = onUserInteraction instanceof Function ? onUserInteraction : () => {};
  const resolveNavigationHost = resolveHost instanceof Function
    ? resolveHost
    : (ses, hostname) => ses.resolveHost(hostname, { cacheUsage: "allowed", secureDnsPolicy: "allow" });
  /** One listener and one short DNS cache per Electron session. Named
   * profiles share a session across views, so this must not belong to a bot. */
  const sessionSecurity = new WeakMap();
  /** every live view, keyed by `${botId}\0${partition}` */
  const entries = new Map();
  /** the view a bot currently shows / acts on */
  const active = new Map();
  /** Human control is bot-wide, matching the harness control endpoint. A
   * stale process scoped to another profile must not see around takeover. */
  const botControl = new Map();
  /** A live per-turn capability pins its exact bot/profile view. Hidden
   * views between two actions are otherwise eligible for LRU eviction. */
  const capabilityPins = new Set();
  let guestCounter = 0;

  const partitionForProfile = (botId, profile) => {
    if (profile === GUEST_PROFILE) return `openmausbot-browser-guest-${botId}-${++guestCounter}`;
    return profile ? browserProfilePartition(profile) : ownPartitionFor(botId);
  };
  const profileIdOf = (profile) => {
    const wanted = String(profile ?? "");
    if (!wanted || wanted === GUEST_PROFILE) return wanted;
    // Validation is intentionally delegated to the one function that owns
    // the durable partition mapping, so every surface boundary stays exact.
    browserProfilePartition(wanted);
    return wanted;
  };
  const layoutOwnerIdOf = (ownerId) =>
    Object.prototype.toString.call(ownerId) === "[object String]" && ownerId.length > 0 && ownerId.length <= 128
      ? ownerId
      : undefined;
  const keyOf = (botId, partition) => `${botId}\0${partition}`;
  const controlFor = (botId) => botControl.get(botId) ?? { held: false, epoch: 0, agentEpoch: 0 };

  const closedState = (botId, entry) => ({
    botId,
    open: false,
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    visible: false,
    partition: entry?.partition ?? null,
    profile: entry?.profile ?? null,
    mode: entry?.mode ?? null,
  });

  const stateFor = (entry) => {
    const contents = entry.view.webContents;
    const destroyed = contents.isDestroyed?.() === true;
    const history = destroyed ? null : contents.navigationHistory;
    return {
      botId: entry.botId,
      open: true,
      url: destroyed ? "" : contents.getURL?.() ?? "",
      title: destroyed ? "" : contents.getTitle?.() ?? "",
      loading: destroyed ? false : contents.isLoading?.() === true,
      canGoBack: destroyed ? false : history?.canGoBack?.() ?? contents.canGoBack?.() ?? false,
      canGoForward: destroyed ? false : history?.canGoForward?.() ?? contents.canGoForward?.() ?? false,
      visible: entry.visible,
      partition: entry.partition,
      profile: entry.profile,
      mode: entry.mode,
    };
  };

  const sameBounds = (left, right) =>
    Boolean(
      left &&
        right &&
        left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height,
    );

  const emitState = (entry) => {
    if (active.get(entry.botId) === entry) emit(stateFor(entry));
  };

  const pushBounded = (list, value) => {
    list.push(value);
    if (list.length > MAX_PAGE_NOTICES) list.splice(0, list.length - MAX_PAGE_NOTICES);
  };

  const agentEchoMatches = (entry, kind, details = {}) => {
    const current = now();
    entry.agentEchoes = entry.agentEchoes.filter((echo) => echo.until > current);
    const index = entry.agentEchoes.findIndex((echo) => {
      if (echo.kind !== kind) return false;
      if (echo.type && echo.type !== details.type) return false;
      if (echo.button && details.button && echo.button !== details.button) return false;
      if (Number.isFinite(echo.x) && Number.isFinite(details.x) && Math.abs(echo.x - details.x) > 2) return false;
      if (Number.isFinite(echo.y) && Number.isFinite(details.y) && Math.abs(echo.y - details.y) > 2) return false;
      if (echo.key && details.key && echo.key.toLowerCase() !== String(details.key).toLowerCase()) return false;
      if (echo.text && details.key && !echo.text.includes(String(details.key))) return false;
      return true;
    });
    if (index < 0) return false;
    entry.agentEchoes.splice(index, 1);
    return true;
  };

  const rememberAgentEcho = (entry, method, params) => {
    const until = now() + AGENT_INPUT_SUPPRESS_MS;
    let echo = null;
    if (method === "Input.dispatchMouseEvent") {
      const type = { mousePressed: "mouseDown", mouseReleased: "mouseUp", mouseMoved: "mouseMove", mouseWheel: "mouseWheel" }[params.type];
      if (type) echo = { kind: "mouse", type, button: params.button, x: params.x, y: params.y, until };
    } else if (method === "Input.dispatchKeyEvent") {
      const type = params.type === "rawKeyDown" ? "keyDown" : params.type;
      echo = { kind: "keyboard", type, key: params.key, until };
    } else if (method === "Input.insertText") {
      echo = { kind: "keyboard", type: "char", text: String(params.text ?? ""), until };
    }
    if (echo) {
      entry.agentEchoes.push(echo);
      if (entry.agentEchoes.length > 20) entry.agentEchoes.splice(0, entry.agentEchoes.length - 20);
    }
  };

  const claimHumanControl = (entry, kind = "focus", details) => {
    const control = controlFor(entry.botId);
    // Once held, browser agents cannot generate input. Any further native
    // event is therefore human input and remains relevant to document taint.
    if (control.held) return true;
    if (agentEchoMatches(entry, kind, details)) return false;
    // Focus carries no source details. A concrete mouse/key event follows a
    // real interaction and is compared against the exact synthetic echo;
    // only the ambiguous focus signal needs the short time guard.
    if (kind === "focus" && (entry.agentInputDepth > 0 || now() < entry.agentInputUntil)) return false;
    botControl.set(entry.botId, { ...control, held: true, epoch: control.epoch + 1 });
    void neutralizeAgentInput(entry);
    emitUserInteraction({ botId: entry.botId, profile: entry.profile });
    return true;
  };

  const beginAgentAction = (entry, source) => {
    if (source === "user") return null;
    const control = controlFor(entry.botId);
    if (control.held) {
      throw new Error("Browser control is currently held by the user — wait until they hand it back");
    }
    return { controlEpoch: control.epoch, agentEpoch: control.agentEpoch };
  };

  const assertAgentLease = (entry, lease, source) => {
    if (source === "user") return;
    const control = controlFor(entry.botId);
    if (control.held) {
      throw new Error("Browser control is currently held by the user — wait until they hand it back");
    }
    if (lease?.controlEpoch !== control.epoch) {
      throw new Error("Browser control changed while the action was running — retry after the user hands it back");
    }
    if (lease?.agentEpoch !== control.agentEpoch) {
      throw new Error("The browser action was cancelled because its turn ended");
    }
  };

  const ensurePublicResolution = async (ses, hostname) => {
    // Literal addresses were already checked by browserNavigationUrl.
    if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return;
    const security = sessionSecurity.get(ses);
    const cached = security?.dns.get(hostname);
    if (cached && cached.until > now()) {
      // Map insertion order doubles as a tiny LRU.
      security.dns.delete(hostname);
      security.dns.set(hostname, cached);
      if (!cached.allowed) throw new Error("Local and private-network pages cannot be opened in the built-in browser");
      return;
    }
    let resolved;
    try {
      resolved = await resolveNavigationHost(ses, hostname);
    } catch {
      throw new Error(`Could not resolve ${hostname}`);
    }
    const addresses = (resolved?.endpoints ?? []).map((endpoint) => endpoint?.address).filter(Boolean);
    if (!addresses.length) throw new Error(`Could not resolve ${hostname}`);
    const allowed = addresses.every((address) => browserAddressAllowed(address));
    if (security) {
      const current = now();
      for (const [name, decision] of security.dns) if (decision.until <= current) security.dns.delete(name);
      security.dns.delete(hostname);
      while (security.dns.size >= MAX_DNS_CACHE) security.dns.delete(security.dns.keys().next().value);
      security.dns.set(hostname, { allowed, until: current + DNS_CACHE_MS });
    }
    if (!allowed) throw new Error("Local and private-network pages cannot be opened in the built-in browser");
  };

  const validateNavigationTarget = async (entry, rawUrl) => {
    const url = browserNavigationUrl(rawUrl);
    if (url === "about:blank") return url;
    const parsed = new URL(url);
    await ensurePublicResolution(entry.view.webContents.session, parsed.hostname.replace(/^\[|\]$/g, ""));
    return url;
  };

  /** Explicit address-bar/agent loads are DNS-checked before loadURL. Page
   * form submissions and redirects are checked by the session's async
   * onBeforeRequest policy so Chromium preserves their method, body and
   * history entry instead of canceling and replaying them as a fresh GET. */
  const loadSafe = async (entry, rawUrl, source = "agent", lease) => {
    const actionLease = lease === undefined ? beginAgentAction(entry, source) : lease;
    const url = await validateNavigationTarget(entry, rawUrl);
    // Dialog/file-chooser interception must exist before the first hostile
    // document runs. A lazy post-load Page.enable lets initial-load alert()
    // wedge Electron behind a native modal.
    await ensureProtocol(entry);
    assertAgentLease(entry, actionLease, source);
    await entry.view.webContents.loadURL(url);
    return url;
  };

  const remove = (entry, code) => {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    entry.sessionSecurity?.entries.delete(entry);
    const wasActive = active.get(entry.botId) === entry;
    if (wasActive) active.delete(entry.botId);
    try {
      entry.view.setVisible(false);
    } catch {}
    try {
      owner.contentView.removeChildView(entry.view);
    } catch {}
    try {
      if (entry.attached) entry.view.webContents.debugger.detach();
    } catch {}
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    } catch {}
    if (wasActive) {
      // Preserve the removed entry's identity. A terminal event can race a
      // profile switch; without this, the renderer can pin the old page's
      // crash/eviction onto whichever profile is selected now.
      const state = closedState(entry.botId, entry);
      if (code) state.code = code;
      emit(state);
    }
  };

  /** Make room for one more view: drop the coldest view nobody is showing. */
  const evictIfNeeded = () => {
    if (entries.size < maxViews) return;
    const candidates = [...entries.values()]
      // `active` means "this bot's selected profile", not "on screen". A
      // workspace with nine bots therefore has nine active-but-hidden views.
      // Evict only a hidden view with no action/navigation in flight.
      .filter((entry) => !entry.visible
        && !capabilityPins.has(`${entry.botId}\0${entry.profile}`)
        && entry.operationDepth === 0
        && entry.agentInputDepth === 0
        && entry.view.webContents.isLoading?.() !== true)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = candidates[0];
    if (!victim) throw new Error(`Only ${maxViews} bot browsers can be open at once`);
    remove(victim, "evicted");
  };

  const installSessionPolicy = (entry) => {
    const ses = entry.view.webContents.session;
    let security = sessionSecurity.get(ses);
    if (security) {
      security.entries.add(entry);
      entry.sessionSecurity = security;
      return;
    }
    security = { dns: new Map(), entries: new Set([entry]) };
    sessionSecurity.set(ses, security);
    entry.sessionSecurity = security;
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // A download would land on the user's disk under a bot's control; refuse
    // until there is a reviewed place for it to go. Install once: named
    // profiles share a session, and EventEmitter listeners accumulate.
    ses.on("will-download", (event) => event.preventDefault());
    ses.webRequest?.onBeforeRequest((details, callback) => {
      void (async () => {
        try {
          const parsed = new URL(String(details?.url ?? ""));
          if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
            // Reuse the top-level URL checks by mapping WebSocket schemes to
            // their HTTP equivalents, then resolve the original hostname.
            const policyUrl = new URL(parsed.toString());
            if (policyUrl.protocol === "ws:") policyUrl.protocol = "http:";
            if (policyUrl.protocol === "wss:") policyUrl.protocol = "https:";
            browserNavigationUrl(policyUrl.toString());
            await ensurePublicResolution(ses, parsed.hostname.replace(/^\[|\]$/g, ""));
          } else if (!["about:", "blob:", "data:"].includes(parsed.protocol)) {
            throw new Error("Only safe web resources can be loaded in the built-in browser");
          }
          callback({ cancel: false });
        } catch (error) {
          const notice = `Blocked page request: ${error?.message ?? error}`;
          for (const candidate of security.entries) pushBounded(candidate.notices, notice);
          callback({ cancel: true });
        }
      })().catch(() => {
        try {
          callback({ cancel: true });
        } catch {}
      });
    });
  };

  const secure = (entry) => {
    const contents = entry.view.webContents;
    const ses = contents.session;
    installSessionPolicy(entry);
    try {
      ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
    } catch {}
    contents.setWindowOpenHandler(({ url, postBody }) => {
      // target=_blank links stay in this bot's one tab: a second window would
      // escape the panel, the partition guarantees and the person's view.
      // Replaying a POST popup with loadURL would silently turn it into a GET;
      // refuse it instead. A simple GET is intentionally opened in this tab.
      if (postBody) {
        pushBounded(entry.notices, "Blocked a popup that tried to submit form data; open it in the current page instead");
      } else if (browserNavigationAllowed(url) && !contents.isDestroyed()) {
        void loadSafe(entry, url, botControl.get(entry.botId)?.held === true ? "user" : "page").catch((error) => {
          pushBounded(entry.notices, `Blocked popup: ${error?.message ?? error}`);
          emitState(entry);
        });
      }
      return { action: "deny" };
    });
    const guard = (event, target) => {
      try {
        // This synchronous edge catches unsafe schemes and literal private
        // addresses. Hostname DNS policy runs in onBeforeRequest below.
        browserNavigationUrl(target);
      } catch (error) {
        event.preventDefault();
        pushBounded(entry.notices, `Blocked navigation: ${error?.message ?? error}`);
      }
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("login", (event, _details, _authInfo, callback) => {
      event.preventDefault();
      callback();
      pushBounded(entry.notices, "Blocked an HTTP authentication prompt; take control and use a normal web sign-in instead");
    });
    contents.on("select-client-certificate", (event, _url, _certificates, callback) => {
      event.preventDefault();
      callback();
      pushBounded(entry.notices, "Blocked a client-certificate prompt in the built-in browser");
    });
    const beginCompactGestureGuard = (wasHeld) => {
      const current = now();
      const alreadyGuarded = current < entry.blockCompactGestureUntil;
      entry.blockCompactGestureUntil = current + COMPACT_GESTURE_GUARD_MS;
      if (wasHeld && !alreadyGuarded) {
        emitUserInteraction({ botId: entry.botId, profile: entry.profile });
      }
    };
    contents.on("focus", () => {
      const wasHeld = controlFor(entry.botId).held;
      const human = claimHumanControl(entry, "focus");
      // A newly acquired hold emits above and may expand before Electron
      // delivers its mouse event, so latch that gesture. An already-held view
      // must wait for a concrete pointer event; merely restoring its focus
      // while shrinking should not bounce the workspace open again.
      if (human && !wasHeld && entry.mode === "compact") beginCompactGestureGuard(false);
    });
    contents.on("before-input-event", (_event, input) => {
      const human = claimHumanControl(entry, "keyboard", input);
      // A page can transform/copy a password on input and immediately clear
      // the protected field, defeating later DOM scans. Conservatively taint
      // this document after real human typing. Observations/actions stay
      // blocked until a committed navigation replaces the document.
      if (human && input?.type !== "keyUp") entry.documentTainted = true;
    });
    contents.on("before-mouse-event", (event, mouse) => {
      // The compact surface is a watch-only preview. A person's first
      // pointer gesture takes control and asks the renderer to expand it, but
      // must not also activate whatever happens to be under that point on the
      // web page. Keep the matching mouse-up blocked even if the renderer has
      // already switched this entry to expanded mode in response to the
      // takeover notification.
      if (mouse?.type === "mouseUp" && entry.blockCompactMouseUp) {
        entry.blockCompactMouseUp = false;
        event.preventDefault();
        return;
      }
      if (!["mouseDown", "contextMenu", "mouseWheel"].includes(mouse?.type)) return;
      // Focus can reach Electron before layout IPC expands the panel. Keep the
      // whole originating gesture watch-only even after mode changes: this
      // catches the following context-menu event and trackpad inertia. Exact
      // synthetic echoes remain agent input and must never be swallowed.
      if (now() < entry.blockCompactGestureUntil) {
        if (agentEchoMatches(entry, "mouse", mouse)) return;
        event.preventDefault();
        if (mouse.type === "mouseDown") entry.blockCompactMouseUp = true;
        if (mouse.type === "mouseWheel") beginCompactGestureGuard(false);
        return;
      }
      const wasHeld = controlFor(entry.botId).held;
      const human = claimHumanControl(entry, "mouse", mouse);
      const compactTakeover = human && entry.mode === "compact";
      if (compactTakeover) {
        event.preventDefault();
        if (mouse.type === "mouseDown") entry.blockCompactMouseUp = true;
        // claimHumanControl emits only for the transition into human control;
        // an already-controlled compact page still has to reopen. The guard
        // also suppresses the remainder of this pointer/wheel gesture.
        beginCompactGestureGuard(wasHeld);
        return;
      }
      // A click can submit or copy an autofilled password without producing a
      // keyboard event. A hostile page can then clear the protected control
      // and echo a transformed secret into ordinary DOM/title text before the
      // agent gets control back. Pointer activation is therefore as sensitive
      // as typing; passive wheel scrolling still claims control but does not
      // taint the document.
      if (human && ["mouseDown", "contextMenu"].includes(mouse?.type)) entry.documentTainted = true;
    });
    for (const signal of ["did-navigate-in-page", "page-title-updated"]) {
      contents.on(signal, () => emitState(entry));
    }
    contents.on("did-stop-loading", () => {
      // A commit-time emulation call can briefly race Chromium's renderer
      // replacement. Retry once the document is stable instead of leaving
      // this page at the native panel's responsive resolution until some
      // later React layout happens to run.
      if (entry.mode && entry.emulationKey === null) applyMode(entry, entry.mode);
      emitState(entry);
    });
    contents.on("did-navigate", () => {
      // Chromium drops WebContents device emulation when a main-frame
      // navigation commits. Keeping the previous emulationKey made later
      // layout calls believe the 1280x800 compact viewport was still active,
      // so every newly-opened site fell back to the small panel's CSS size.
      // Reapply the current presentation mode after the new document exists.
      if (entry.mode) {
        entry.emulationKey = null;
        applyMode(entry, entry.mode);
      }
      // refs name nodes of the page that just went away
      entry.documentTainted = false;
      entry.refs = null;
      entry.refIntegrity = null;
      entry.isolatedContextId = null;
      entry.isolatedContextReady = null;
      emitState(entry);
    });
    contents.on("render-process-gone", () => remove(entry, "renderer-gone"));
    contents.debugger.on("detach", () => {
      entry.attached = false;
      entry.protocolReady = null;
    });
    contents.debugger.on("message", (_event, method, params) => {
      onProtocolEvent(entry, method, params ?? {});
    });
  };

  /** Things the page does on its own that a bot must hear about. */
  const onProtocolEvent = (entry, method, params) => {
    if (method === "Page.javascriptDialogOpening") {
      // alert/confirm/prompt would otherwise be a native modal over the app
      // window that nobody can answer for the bot. Alerts are harmless to
      // acknowledge; confirms, prompts and beforeunload dialogs fail closed
      // so a page cannot make a destructive choice on the user's behalf.
      const type = String(params.type ?? "alert");
      const accepted = type === "alert";
      // A page can echo a password/OTP from its DOM into alert(input.value).
      // Page-supplied dialog text is therefore never model-facing.
      pushBounded(entry.dialogs, { type, message: "", accepted });
      void cdp(entry, "Page.handleJavaScriptDialog", {
        accept: accepted,
      }).catch(() => {});
    } else if (method === "Page.fileChooserOpened") {
      pushBounded(entry.dialogs, { type: "filechooser", message: "the page asked for a file upload; uploads are not supported yet", accepted: false });
      // Interception pauses the renderer until it receives an answer. Merely
      // recording the notice leaves the page wedged behind a pending chooser.
      void cdp(entry, "Page.handleFileChooser", { action: "cancel" }).catch(() => {});
    }
  };

  const create = (botId, profile) => {
    evictIfNeeded();
    if (owner.isDestroyed?.()) throw new Error("The OpenMausBot window is unavailable");
    const partition = partitionForProfile(botId, profile);
    const view = createView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition,
      },
    });
    const entry = {
      key: keyOf(botId, partition),
      botId,
      profile: profile || "",
      partition,
      view,
      attached: false,
      protocolReady: null,
      isolatedContextId: null,
      isolatedContextReady: null,
      visible: false,
      bounds: null,
      mode: null,
      layoutOwner: null,
      emulationKey: null,
      refs: null,
      refKind: "ax",
      refIntegrity: null,
      dialogs: [],
      notices: [],
      agentInputDepth: 0,
      agentInputUntil: 0,
      agentEchoes: [],
      pressedMouse: new Map(),
      pressedKeys: new Map(),
      presentationScale: 1,
      blockCompactMouseUp: false,
      blockCompactGestureUntil: 0,
      neutralizingInput: null,
      documentTainted: false,
      operationDepth: 0,
      lastUsed: now(),
    };
    entries.set(entry.key, entry);
    secure(entry);
    // A tab nobody is looking at (panel closed, another tab shown) still
    // needs a real viewport: a zero-size view lays the page out as nothing
    // visible, and Playwright's snapshot hands out refs only for visible
    // nodes. Hidden views keep the desktop size until the panel lays them
    // out. Attach first — bounds set before a view has a parent are dropped.
    owner.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
    view.setVisible(false);
    void view.webContents.loadURL("about:blank").catch(() => {});
    return entry;
  };

  /** The view a bot should be looking at: `undefined` keeps whatever is
   * active (callers that don't know the profile never evict a tab); "" is
   * the bot's own session; "guest" a throwaway; anything else a named
   * profile. Switching hides the previous view and shows this one in the
   * same rectangle. */
  const ensure = (rawBotId, profile) => {
    const botId = botIdOf(rawBotId);
    const current = active.get(botId);
    if (profile === undefined) {
      if (current) return touch(current);
      const ownPartition = partitionForProfile(botId, "");
      return activate(botId, entries.get(keyOf(botId, ownPartition)) ?? create(botId, ""), null);
    }
    const wantedProfile = profileIdOf(profile);
    if (current && current.profile === wantedProfile && wantedProfile !== GUEST_PROFILE) return touch(current);
    if (current && current.profile === GUEST_PROFILE && wantedProfile === GUEST_PROFILE) return touch(current);
    const partition = wantedProfile === GUEST_PROFILE ? null : partitionForProfile(botId, wantedProfile);
    const existing = partition ? entries.get(keyOf(botId, partition)) : null;
    return activate(botId, existing ?? create(botId, wantedProfile), current);
  };

  const touch = (entry) => {
    entry.lastUsed = now();
    return entry;
  };

  const runOperation = async (entry, operation) => {
    try {
      return await operation();
    } catch (error) {
      await neutralizeAgentInput(entry);
      throw error;
    } finally {
      entry.operationDepth = Math.max(0, entry.operationDepth - 1);
      touch(entry);
    }
  };

  /** Agent operations on one page are deliberately serialized. Without a
   * small per-entry queue, two tool calls can interleave their privacy
   * preflights and pointer/key sequences, making otherwise valid refs land on
   * the wrong post-action document. Different profiles and bots still run in
   * parallel. */
  const withOperation = (entry, operation) => {
    entry.operationDepth += 1;
    touch(entry);
    const previous = entry.operationTail ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => runOperation(entry, operation));
    entry.operationTail = pending.catch(() => {});
    return pending;
  };

  const activate = (botId, entry, previous) => {
    const takesOverScreen = Boolean(previous && previous !== entry && previous.visible);
    if (previous && previous !== entry) {
      previous.visible = false;
      try {
        previous.view.setVisible(false);
      } catch {}
      // a Guest session is for one visit: switching away forgets it
      if (previous.profile === GUEST_PROFILE) remove(previous);
      // The new view takes the old one's place on screen. Keep the logical
      // bounds and the native WebContentsView bounds in lockstep even when
      // React hid the old profile just before selecting the new one. Without
      // this, a freshly-created view keeps its 1280x800 hidden viewport while
      // `entry.bounds` says it already has the compact panel rectangle; the
      // following layout then skips setBounds and the native view covers the
      // app from the top-left corner.
      if (previous.bounds) {
        entry.bounds = { ...previous.bounds };
        entry.view.setBounds(entry.bounds);
      }
      // A reused profile may have last been shown in the other presentation
      // mode. Match the surface it replaces before it becomes visible so
      // there is no one-frame scale jump during profile switches.
      if (previous.mode) applyMode(entry, previous.mode);
    }
    active.set(botId, entry);
    touch(entry);
    if (entry.bounds && takesOverScreen) {
      entry.view.setBounds(entry.bounds);
      entry.visible = true;
      entry.view.setVisible(true);
      // raise above siblings that were added later
      try {
        owner.contentView.addChildView(entry.view);
      } catch {}
    }
    emit(stateFor(entry));
    return entry;
  };

  const ensureProtocol = async (entry) => {
    const dbg = entry.view.webContents.debugger;
    if (entry.protocolReady) return entry.protocolReady;
    const ready = (async () => {
      if (!entry.attached) {
        dbg.attach("1.3");
        entry.attached = true;
      }
      await dbg.sendCommand("Page.enable");
      // Never show a native file picker for a bot. Unlike focus emulation,
      // interception is a safety invariant and failure aborts navigation.
      await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
      try {
        // Chromium drops synthetic mouse input for a widget that is not
        // focused — and a child view is not focused while the person types
        // in the chat, or while another app is in front. Playwright makes
        // every page believe it has focus for exactly this reason.
        await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch {
        // Optional on older protocol revisions; interception above is not.
      }
    })();
    entry.protocolReady = ready;
    try {
      await ready;
    } catch (error) {
      if (entry.protocolReady === ready) entry.protocolReady = null;
      entry.attached = false;
      try {
        dbg.detach();
      } catch {}
      throw error;
    }
    return ready;
  };

  const ensureIsolatedContext = async (entry) => {
    if (entry.isolatedContextId) return entry.isolatedContextId;
    if (entry.isolatedContextReady) return entry.isolatedContextReady;
    const ready = (async () => {
      const { frameTree } = await cdp(entry, "Page.getFrameTree");
      const frameId = frameTree?.frame?.id;
      if (!frameId) throw new Error("the browser page has no main frame");
      const { executionContextId } = await cdp(entry, "Page.createIsolatedWorld", {
        frameId,
        worldName: "openmausbot-browser-snapshot",
        grantUniveralAccess: false,
      });
      if (!executionContextId) throw new Error("could not create the protected browser helper world");
      entry.isolatedContextId = executionContextId;
      return executionContextId;
    })();
    entry.isolatedContextReady = ready;
    try {
      return await ready;
    } finally {
      if (entry.isolatedContextReady === ready) entry.isolatedContextReady = null;
    }
  };

  const capturePrivacy = async (entry, lease) => {
    if (lease !== undefined) assertAgentLease(entry, lease);
    let privacySnapshot;
    try {
      privacySnapshot = await cdp(entry, "DOMSnapshot.captureSnapshot", {
        computedStyles: [],
        includePaintOrder: false,
        includeDOMRects: false,
      });
    } catch {
      throw new Error("the browser page could not be inspected safely for protected fields");
    }
    if (lease !== undefined) assertAgentLease(entry, lease);
    try {
      return inspectDomSnapshotPrivacy(privacySnapshot);
    } catch {
      throw new Error("the browser page could not be inspected safely for protected fields");
    }
  };

  const assertScreenshotHasNoProtectedValues = async (entry, lease) => {
    if (entry.documentTainted) {
      throw new Error("browser_screenshot is unavailable after human keyboard input on this page; navigate away before returning browser control to the agent");
    }
    const privacy = await capturePrivacy(entry, lease);
    if (privacy.hasProtectedValue) {
      throw new Error("browser_screenshot is unavailable while a protected field contains a value; use browser_snapshot or browser_read, or take control to inspect it yourself");
    }
  };

  const assertNoPopulatedProtectedFields = async (entry, lease) => {
    if (entry.documentTainted) {
      throw new Error("browser actions are unavailable after human keyboard input on this page; navigate away before returning browser control to the agent");
    }
    const privacy = await capturePrivacy(entry, lease);
    if (privacy.hasProtectedValue) {
      throw new Error("a protected credential, verification, payment, or identity field contains a value — take control to complete or clear that step first");
    }
  };

  const protectedReadError = () => new Error(
    "browser_read is unavailable while a protected field contains a value; take control to complete or clear that step first",
  );

  const redactPrivacyStrings = (value, privacies) => {
    let result = String(value ?? "");
    const redactions = [...new Set(privacies.flatMap((privacy) => privacy?.redactions ?? []))]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    for (const secret of redactions) result = result.split(secret).join("[redacted]");
    return result;
  };

  const safePageRead = async (entry) => {
    if (entry.documentTainted) throw protectedReadError();
    const before = await capturePrivacy(entry);
    if (before.hasProtectedValue) throw protectedReadError();
    const raw = String((await evaluate(entry, PAGE_TEXT_EXPRESSION)) ?? "");
    // Capture the title before the postflight. If page JavaScript mirrored a
    // password/OTP/API key into either body text or document.title, the
    // populated field is visible to the postflight and the whole read fails
    // closed instead of trying to enumerate every possible transformation.
    const state = stateFor(entry);
    const after = await capturePrivacy(entry);
    if (entry.documentTainted || after.hasProtectedValue) throw protectedReadError();
    return {
      state: {
        ...state,
        url: redactPrivacyStrings(state.url, [before, after]),
        title: redactPrivacyStrings(state.title, [before, after]),
      },
      text: redactPrivacyStrings(raw, [before, after]),
    };
  };

  const safePageText = async (entry) => (await safePageRead(entry)).text;

  const protectedSnapshot = (entry) => {
    entry.refs = new Set();
    entry.refKind = null;
    entry.refIntegrity = null;
    // Never defer page-controlled notices until after the credential is
    // cleared: URLs and other text could themselves be a mirrored secret.
    entry.dialogs.splice(0);
    entry.notices.splice(0);
    const message = "Protected page content is hidden while a credential, verification, payment, or identity field contains a value. Take control to complete or clear that step first.";
    return {
      url: "",
      title: "Protected content hidden",
      elements: [],
      yaml: null,
      truncated: false,
      dialogs: [],
      notes: [message],
      text: message,
    };
  };

  const protectedState = (entry) => ({
    ...stateFor(entry),
    url: "",
    title: "Protected content hidden",
  });

  const trackAgentInputState = (entry, method, params) => {
    if (method === "Input.dispatchMouseEvent") {
      const button = String(params.button ?? "none");
      if (params.type === "mousePressed" && button !== "none") {
        entry.pressedMouse.set(button, { button, x: Number(params.x) || 0, y: Number(params.y) || 0, clickCount: Number(params.clickCount) || 1 });
      } else if (params.type === "mouseReleased") {
        entry.pressedMouse.delete(button);
      }
      return;
    }
    if (method !== "Input.dispatchKeyEvent") return;
    const keyId = String(params.code || params.key || params.windowsVirtualKeyCode || "");
    if (!keyId) return;
    if (params.type === "keyDown" || params.type === "rawKeyDown") {
      entry.pressedKeys.set(keyId, {
        key: params.key,
        code: params.code,
        windowsVirtualKeyCode: params.windowsVirtualKeyCode,
      });
    } else if (params.type === "keyUp") {
      entry.pressedKeys.delete(keyId);
    }
  };

  /** Epoch changes may interrupt a compound click/key sequence between down
   * and up. Only matching neutralizing releases bypass the agent lease; no
   * new movement, text or key-down is allowed after takeover. */
  const neutralizeAgentInput = async (entry) => {
    if (!entry?.pressedMouse || (!entry.pressedMouse.size && !entry.pressedKeys.size)) return;
    if (entry.neutralizingInput) return entry.neutralizingInput;
    const pending = (async () => {
      const dbg = entry.view.webContents.debugger;
      const mouse = [...entry.pressedMouse.values()];
      const keys = [...entry.pressedKeys.values()];
      entry.pressedMouse.clear();
      entry.pressedKeys.clear();
      const release = async (method, params) => {
        // Neutralizing releases intentionally bypass a revoked action lease,
        // but they are still synthetic. Mark them exactly like normal CDP
        // input so Electron's before-input-event cannot mistake keyUp for a
        // person taking control and leave the bot stuck behind a false hold.
        rememberAgentEcho(entry, method, params);
        entry.agentInputDepth += 1;
        entry.agentInputUntil = Math.max(entry.agentInputUntil, now() + AGENT_INPUT_SUPPRESS_MS);
        try {
          await dbg.sendCommand(method, params);
        } finally {
          entry.agentInputDepth = Math.max(0, entry.agentInputDepth - 1);
          entry.agentInputUntil = Math.max(entry.agentInputUntil, now() + AGENT_INPUT_SUPPRESS_MS);
        }
      };
      for (const press of mouse) {
        try {
          await release("Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
        } catch {}
      }
      for (const press of keys) {
        try {
          await release("Input.dispatchKeyEvent", { type: "keyUp", ...press });
        } catch {}
      }
    })();
    entry.neutralizingInput = pending;
    try {
      await pending;
    } finally {
      if (entry.neutralizingInput === pending) entry.neutralizingInput = null;
    }
  };

  const presentationMouseParams = (entry, params) => {
    if (params?.type === undefined) return params;
    const scale = Number.isFinite(entry.presentationScale) ? entry.presentationScale : 1;
    if (scale === 1 || (!Number.isFinite(params.x) && !Number.isFinite(params.y))) return params;
    // Electron's WebContents device-emulation `scale` is a presentation
    // transform outside the page's CSS viewport. DOM boxes and hit testing
    // remain in 1280x800 page coordinates, while Input.dispatchMouseEvent is
    // received in the scaled native view. Only the event position is scaled;
    // wheel deltas intentionally remain CSS scroll distances.
    const mapped = { ...params };
    if (Number.isFinite(params.x)) mapped.x = params.x * scale;
    if (Number.isFinite(params.y)) mapped.y = params.y * scale;
    return mapped;
  };

  const cdp = async (entry, method, params = {}, lease) => {
    const dbg = entry.view.webContents.debugger;
    await ensureProtocol(entry);
    let commandParams = params;
    if (method === "Runtime.evaluate" && params.contextId === undefined) {
      const contextId = await ensureIsolatedContext(entry);
      commandParams = { ...params, contextId };
    }
    if (method === "Input.dispatchMouseEvent") {
      commandParams = presentationMouseParams(entry, commandParams);
    }
    const isAgentInput = method.startsWith("Input.");
    if (isAgentInput) {
      assertAgentLease(entry, lease);
      rememberAgentEcho(entry, method, commandParams);
      entry.agentInputDepth += 1;
      entry.agentInputUntil = Math.max(entry.agentInputUntil, now() + AGENT_INPUT_SUPPRESS_MS);
    }
    try {
      const result = await dbg.sendCommand(method, commandParams);
      if (isAgentInput) {
        trackAgentInputState(entry, method, commandParams);
        try {
          assertAgentLease(entry, lease);
        } catch (error) {
          await neutralizeAgentInput(entry);
          throw error;
        }
      }
      return result;
    } finally {
      if (isAgentInput) {
        entry.agentInputDepth = Math.max(0, entry.agentInputDepth - 1);
        entry.agentInputUntil = Math.max(entry.agentInputUntil, now() + AGENT_INPUT_SUPPRESS_MS);
      }
    }
  };

  const targetObjectId = async (entry, target, lease) => {
    assertAgentLease(entry, lease);
    if (entry.refKind === "aria") {
      const { result } = await cdp(entry, "Runtime.evaluate", {
        expression: `window.__ombBrowser && window.__ombBrowser.elementForRef(${JSON.stringify(target.ref)})`,
        returnByValue: false,
      });
      assertAgentLease(entry, lease);
      return result?.objectId;
    }
    const executionContextId = await ensureIsolatedContext(entry);
    const { object } = await cdp(entry, "DOM.resolveNode", { backendNodeId: target.backendNodeId, executionContextId });
    assertAgentLease(entry, lease);
    return object?.objectId;
  };

  /** Agent text is never entered into credentials, OTP, payment, banking or
   * identity fields. The user can still type there while holding control. */
  const assertTargetAcceptsAgentText = async (entry, target, lease) => {
    const objectId = await targetObjectId(entry, target, lease);
    if (!objectId) throw new Error("that element is gone; take a new browser_snapshot");
    assertAgentLease(entry, lease);
    const { result, exceptionDetails } = await cdp(entry, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: SENSITIVE_FIELD_FUNCTION,
      returnByValue: true,
    });
    assertAgentLease(entry, lease);
    if (exceptionDetails) throw new Error("could not inspect that field safely");
    if (result?.value === "sensitive") {
      throw new Error("protected credential, verification, payment, or identity fields require user control");
    }
    if (result?.value !== "ordinary") throw new Error("that ref is not a proven ordinary editable field");
  };

  const assertFocusedFieldAcceptsAgentText = async (entry, lease) => {
    assertAgentLease(entry, lease);
    const { result: activeElement } = await cdp(entry, "Runtime.evaluate", {
      expression: DEEPEST_ACTIVE_ELEMENT_EXPRESSION,
      returnByValue: false,
    });
    assertAgentLease(entry, lease);
    if (!activeElement?.objectId) throw new Error("no page field has keyboard focus");
    const { result, exceptionDetails } = await cdp(entry, "Runtime.callFunctionOn", {
      objectId: activeElement.objectId,
      functionDeclaration: SENSITIVE_FIELD_FUNCTION,
      returnByValue: true,
    });
    assertAgentLease(entry, lease);
    if (exceptionDetails) throw new Error("could not inspect the focused field safely");
    if (result?.value === "sensitive") {
      throw new Error("protected credential, verification, payment, or identity fields require user control");
    }
    if (result?.value !== "ordinary") {
      throw new Error("browser_type requires a proven ordinary editable field in the current page");
    }
  };

  const assertFocusedTargetAllowsKeyAction = async (entry, lease) => {
    assertAgentLease(entry, lease);
    const { result: activeElement } = await cdp(entry, "Runtime.evaluate", {
      expression: DEEPEST_ACTIVE_ELEMENT_EXPRESSION,
      returnByValue: false,
    });
    assertAgentLease(entry, lease);
    if (!activeElement?.objectId) throw new Error("the focused page target could not be inspected safely");
    const { result, exceptionDetails } = await cdp(entry, "Runtime.callFunctionOn", {
      objectId: activeElement.objectId,
      functionDeclaration: `function __ombKeyTarget() {
        const classification = (${SENSITIVE_FIELD_FUNCTION}).call(this);
        if (classification !== "unknown") return classification;
        const tag = String(this && this.tagName || "").toLowerCase();
        const role = String(this && this.getAttribute && this.getAttribute("role") || "").toLowerCase();
        if (["html", "body", "button", "a", "select", "option", "summary"].includes(tag)) return "noneditable";
        if (["button", "link", "menuitem", "option", "radio", "checkbox", "switch", "tab"].includes(role)) return "noneditable";
        return "unknown";
      }`,
      returnByValue: true,
    });
    assertAgentLease(entry, lease);
    if (exceptionDetails) throw new Error("the focused page target could not be inspected safely");
    if (result?.value === "sensitive") {
      throw new Error("protected credential, verification, payment, or identity fields require user control");
    }
    if (!['ordinary', 'noneditable'].includes(result?.value)) {
      throw new Error("the focused page target is not proven safe for synthetic key presses");
    }
  };

  /** Fit the fixed desktop viewport into either rectangle the panel gives us.
   * Expanded is a larger presentation of the exact same page viewport, not a
   * responsive-layout transition. */
  const applyMode = (entry, mode) => {
    const contents = entry.view.webContents;
    entry.mode = mode;
    if (entry.bounds) {
      const scale = Math.min(entry.bounds.width / VIEWPORT.width, entry.bounds.height / VIEWPORT.height);
      // Very large workspaces may legitimately enlarge the desktop viewport;
      // keep a generous ceiling only to avoid pathological native values.
      const boundedScale = Math.max(0.1, Math.min(2, scale));
      const emulationKey = `fixed:${boundedScale}`;
      if (entry.emulationKey === emulationKey) {
        entry.presentationScale = boundedScale;
        return;
      }
      try {
        contents.enableDeviceEmulation({
          screenPosition: "desktop",
          screenSize: { ...VIEWPORT },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: 0,
          viewSize: { ...VIEWPORT },
          scale: boundedScale,
        });
        entry.presentationScale = boundedScale;
        entry.emulationKey = emulationKey;
      } catch {
        // Keep the retry sentinel and coordinate conversion honest. A failed
        // emulation call means Input coordinates still use the native view.
        entry.presentationScale = 1;
        entry.emulationKey = null;
      }
    } else {
      entry.presentationScale = 1;
    }
  };

  /** Wait for the page to be idle enough to observe: a short settle, and if a
   * navigation is in flight, its end (bounded — a page that never stops
   * loading must not hang the bot). */
  const settle = async (entry, ms = settleMs) => {
    await sleep(ms);
    const contents = entry.view.webContents;
    if (!contents.isLoading?.()) return;
    await new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        contents.removeListener?.("did-stop-loading", finish);
        resolve();
      };
      contents.once("did-stop-loading", finish);
      timer = setTimeout(finish, loadWaitMs);
      timer.unref?.();
    });
  };

  const evaluate = async (entry, expression) => {
    const { result, exceptionDetails } = await cdp(entry, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? "page script failed");
    return result?.value;
  };

  const scrollHint = async (entry) => {
    try {
      const metrics = await evaluate(entry, SCROLL_METRICS_EXPRESSION);
      if (!metrics || !Number.isFinite(metrics.height)) return null;
      const below = metrics.height - metrics.top - metrics.view;
      const above = metrics.top;
      if (below <= 8 && above <= 8) return null;
      const parts = [];
      if (above > 8) parts.push(`${Math.round(above)}px above`);
      if (below > 8) parts.push(`${Math.round(below)}px below`);
      return `More of the page is off-screen: ${parts.join(", ")} (browser_scroll to see it).`;
    } catch {
      return null;
    }
  };

  /** Make sure the page carries our snapshot script (a fresh document loses
   * it). False when the bundle is missing or the page refuses scripts. */
  const ensureInjected = async (entry) => {
    if (!injectedSource) return false;
    try {
      if ((await evaluate(entry, "Boolean(window.__ombBrowser)")) === true) return true;
      await cdp(entry, "Runtime.evaluate", { expression: injectedSource, returnByValue: true });
      return (await evaluate(entry, "Boolean(window.__ombBrowser)")) === true;
    } catch {
      return false;
    }
  };

  /** Playwright's ARIA snapshot with `[ref=eN]` refs — what models were
   * trained to read. Falls back to the bare accessibility tree (`bN` refs)
   * when the script cannot run. */
  const snapshot = async (entry) => {
    if (entry.documentTainted) return protectedSnapshot(entry);
    let beforePrivacy;
    try {
      beforePrivacy = await capturePrivacy(entry);
    } catch {
      return protectedSnapshot(entry);
    }
    if (beforePrivacy.hasProtectedValue) return protectedSnapshot(entry);
    const state = stateFor(entry);
    let elements = [];
    let yaml = null;
    let truncated = false;
    // A closed shadow tree is intentionally invisible to page JavaScript,
    // including the rich snapshot helper. Use the conservative CDP AX
    // fallback so its interactive controls are not silently omitted (and its
    // flattened accessible text cannot bypass protected-field redaction).
    const richSnapshotAllowed = !beforePrivacy.hasClosedShadowRoot;
    if (richSnapshotAllowed && await ensureInjected(entry)) {
      try {
        const result = await evaluate(entry, `window.__ombBrowser.snapshot(${SNAPSHOT_MAX_CHARS})`);
        if (result && isString(result.yaml) && Array.isArray(result.refs)) {
          yaml = result.yaml;
          truncated = result.truncated === true;
          entry.refs = new Set(result.refs.map(String));
          entry.refKind = "aria";
          entry.refIntegrity = null;
        }
      } catch {
        yaml = null;
      }
    }
    if (yaml === null) {
      await cdp(entry, "Accessibility.enable");
      const { nodes = [] } = await cdp(entry, "Accessibility.getFullAXTree", { depth: AX_TREE_DEPTH });
      elements = snapshotFromAxNodes(nodes);
      entry.refs = new Set(elements.map((element) => element.ref));
      entry.refKind = "ax";
      entry.refIntegrity = new Map();
      for (const node of nodes) {
        const backendNodeId = Number(node?.backendDOMNodeId ?? 0);
        const ref = `b${backendNodeId}`;
        if (!entry.refs.has(ref)) continue;
        const signature = axNodeIntegritySignature(node);
        if (signature) entry.refIntegrity.set(ref, signature);
      }
    }
    const dialogs = entry.dialogs.splice(0);
    const notices = entry.notices.splice(0);
    const hint = await scrollHint(entry);
    const notes = [
      ...dialogs.map((dialog) => `Dialog (${dialog.type}) was ${dialog.accepted ? "acknowledged" : "dismissed"} automatically; its page-supplied text was hidden.`),
      ...notices,
      ...(hint ? [hint] : []),
    ];
    let afterPrivacy;
    try {
      afterPrivacy = await capturePrivacy(entry);
    } catch {
      return protectedSnapshot(entry);
    }
    if (entry.documentTainted || afterPrivacy.hasProtectedValue) return protectedSnapshot(entry);
    const safeState = {
      ...state,
      url: redactPrivacyStrings(state.url, [beforePrivacy, afterPrivacy]),
      title: redactPrivacyStrings(state.title, [beforePrivacy, afterPrivacy]),
    };
    const safeYaml = yaml === null ? null : redactPrivacyStrings(yaml, [beforePrivacy, afterPrivacy]);
    const safeElements = elements.map((element) => {
      const safe = { ...element, name: redactPrivacyStrings(element.name, [beforePrivacy, afterPrivacy]) };
      if (element.value !== undefined) safe.value = redactPrivacyStrings(element.value, [beforePrivacy, afterPrivacy]);
      return safe;
    });
    const safeNotes = notes.map((note) => redactPrivacyStrings(note, [beforePrivacy, afterPrivacy]));
    const body = safeYaml !== null
      ? safeYaml || "(empty page)"
      : formatSnapshot({ title: safeState.title, url: safeState.url, elements: safeElements });
    return {
      url: safeState.url,
      title: safeState.title,
      elements: safeElements,
      yaml: safeYaml,
      truncated,
      dialogs,
      notes: safeNotes,
      text: [safeYaml !== null ? `Browser — ${safeState.title || "Untitled"}: ${safeState.url || "about:blank"}` : "", body, ...safeNotes].filter(Boolean).join("\n"),
    };
  };

  const observe = async (entry) => {
    await settle(entry);
    return snapshot(entry);
  };

  const staleRefError = () => new Error("that browser ref is stale because the page changed — take a new browser_snapshot");

  /** Re-check the exact reviewed target before every ref action. Rich refs
   * compare the current accessible role/name/actionability in the protected
   * isolated world. Bare AX refs compare a fresh CDP accessibility node. */
  const assertRefCurrent = async (entry, ref, lease) => {
    const wanted = String(ref ?? "").trim();
    if (!entry.refs) throw new Error("the page changed since the last browser_snapshot — take a new one");
    if (!entry.refs.has(wanted)) throw new Error("that browser ref is stale or unknown — take a new browser_snapshot");
    assertAgentLease(entry, lease);
    if (entry.refKind === "aria") {
      const valid = await evaluate(entry, `Boolean(window.__ombBrowser && window.__ombBrowser.validateRef(${JSON.stringify(wanted)}))`);
      assertAgentLease(entry, lease);
      if (valid !== true) throw staleRefError();
      return wanted;
    }
    const backendNodeId = backendNodeIdFromRef(wanted);
    const reviewed = entry.refIntegrity?.get(wanted);
    if (!reviewed) throw staleRefError();
    const { nodes = [] } = await cdp(entry, "Accessibility.getFullAXTree", { depth: AX_TREE_DEPTH });
    assertAgentLease(entry, lease);
    const current = nodes.find((node) => Number(node?.backendDOMNodeId ?? 0) === backendNodeId);
    if (axNodeIntegritySignature(current) !== reviewed) throw staleRefError();
    return wanted;
  };

  /** Verify the compositor will dispatch a click to the reviewed node (or a
   * composed ancestor/descendant), not a late overlay. Must run immediately
   * before mouse-down, after mouse-move/hover handlers have had a chance to
   * change the page. */
  const assertRefHitTarget = async (entry, target, lease) => {
    await assertRefCurrent(entry, target.ref ?? `b${target.backendNodeId}`, lease);
    assertAgentLease(entry, lease);
    if (entry.refKind === "aria") {
      const hit = await evaluate(entry, `Boolean(window.__ombBrowser && window.__ombBrowser.hitTestRef(${JSON.stringify(target.ref)}, ${JSON.stringify(target.x)}, ${JSON.stringify(target.y)}))`);
      assertAgentLease(entry, lease);
      if (hit !== true) throw new Error("another page element now covers that ref — take a new browser_snapshot");
      return;
    }
    const location = await cdp(entry, "DOM.getNodeForLocation", {
      x: Math.round(target.x),
      y: Math.round(target.y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    });
    assertAgentLease(entry, lease);
    const hitBackendNodeId = Number(location?.backendNodeId ?? 0);
    if (hitBackendNodeId === target.backendNodeId) return;
    if (!Number.isInteger(hitBackendNodeId) || hitBackendNodeId <= 0) {
      throw new Error("another page element now covers that ref — take a new browser_snapshot");
    }
    const executionContextId = await ensureIsolatedContext(entry);
    const [{ object: reviewed }, { object: hit }] = await Promise.all([
      cdp(entry, "DOM.resolveNode", { backendNodeId: target.backendNodeId, executionContextId }),
      cdp(entry, "DOM.resolveNode", { backendNodeId: hitBackendNodeId, executionContextId }),
    ]);
    assertAgentLease(entry, lease);
    if (!reviewed?.objectId || !hit?.objectId) {
      throw new Error("another page element now covers that ref — take a new browser_snapshot");
    }
    const { result, exceptionDetails } = await cdp(entry, "Runtime.callFunctionOn", {
      objectId: reviewed.objectId,
      functionDeclaration: HIT_RELATED_FUNCTION,
      arguments: [{ objectId: hit.objectId }],
      returnByValue: true,
    });
    assertAgentLease(entry, lease);
    if (exceptionDetails || result?.value !== true) {
      throw new Error("another page element now covers that ref — take a new browser_snapshot");
    }
  };

  /** Where a ref is, in viewport CSS pixels — plus what the two ref kinds
   * need to act on it: the DOM node id (accessibility refs) or nothing more
   * (Playwright refs resolve in the page). */
  const centerOf = async (entry, ref, lease) => {
    const wanted = await assertRefCurrent(entry, ref, lease);
    if (entry.refKind === "aria") {
      assertAgentLease(entry, lease);
      const box = await evaluate(entry, `window.__ombBrowser ? window.__ombBrowser.boxForRef(${JSON.stringify(wanted)}) : { found: false }`);
      await assertRefCurrent(entry, wanted, lease);
      if (!box || box.found !== true) throw new Error("that browser ref is stale or unknown — take a new browser_snapshot");
      if (box.connected !== true) throw new Error("that element is gone; take a new browser_snapshot");
      if (box.visible !== true) throw new Error("that element is not visible; take a new browser_snapshot");
      return { ref: wanted, x: box.x, y: box.y };
    }
    const backendNodeId = backendNodeIdFromRef(wanted);
    try {
      assertAgentLease(entry, lease);
      await cdp(entry, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
      assertAgentLease(entry, lease);
    } catch {
      assertAgentLease(entry, lease);
      // not every node can be scrolled into view; the box model is the real check
    }
    let model;
    try {
      ({ model } = await cdp(entry, "DOM.getBoxModel", { backendNodeId }));
    } catch {
      throw new Error("that element is gone; take a new browser_snapshot");
    }
    assertAgentLease(entry, lease);
    await assertRefCurrent(entry, wanted, lease);
    const quad = model?.border ?? model?.content;
    if (!Array.isArray(quad) || quad.length < 8) throw new Error("that element is not visible; take a new browser_snapshot");
    return {
      ref: wanted,
      backendNodeId,
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  };

  const viewportCenter = () => ({ x: Math.floor(VIEWPORT.width / 2), y: Math.floor(VIEWPORT.height / 2) });

  const selectAllModifiers = platform === "darwin" ? 4 : 2;

  const entryForProfile = (botId, profile) => {
    let entry = active.get(botId);
    if (!isString(profile)) return entry;
    const wantedProfile = profileIdOf(profile);
    if (entry?.profile === wantedProfile) return entry;
    if (wantedProfile === GUEST_PROFILE) {
      return [...entries.values()].find((candidate) => candidate.botId === botId && candidate.profile === GUEST_PROFILE);
    }
    return entries.get(keyOf(botId, partitionForProfile(botId, wantedProfile)));
  };

  const api = {
    /** Create or switch the bot's view; hidden until laid out. */
    ensure(botId, profile) {
      return stateFor(ensure(botId, profile));
    },

    state(botId, profile) {
      const id = botIdOf(botId);
      const entry = entryForProfile(id, profile);
      return entry ? stateFor(entry) : closedState(id);
    },

    /** Host-facing state excludes page-controlled title/address text whenever
     * the document is protected/tainted. Renderer state remains synchronous
     * and local, while scoped bot capabilities get this inspected form. */
    async agentState(botId, profile) {
      const id = botIdOf(botId);
      const entry = entryForProfile(id, profile);
      if (!entry) return closedState(id);
      return withOperation(entry, async () => {
        if (entry.documentTainted) return protectedState(entry);
        let before;
        let after;
        try {
          before = await capturePrivacy(entry);
          if (before.hasProtectedValue) return protectedState(entry);
          const state = stateFor(entry);
          after = await capturePrivacy(entry);
          if (entry.documentTainted || after.hasProtectedValue) return protectedState(entry);
          return {
            ...state,
            url: redactPrivacyStrings(state.url, [before, after]),
            title: redactPrivacyStrings(state.title, [before, after]),
          };
        } catch {
          return protectedState(entry);
        }
      });
    },

    isHumanControlled(botId, profile) {
      const id = botIdOf(botId);
      void profile;
      return botControl.get(id)?.held === true;
    },

    controlLease(botId, profile) {
      const id = botIdOf(botId);
      void profile;
      return controlFor(id);
    },

    /** Position the bot's active view over the renderer's rectangle (or hide
     * it: null). `profile` switches views; `mode` picks the scaling. A
     * profile-scoped hide is ignored after another profile has become active,
     * which makes React effect cleanup safe during profile switches. */
    layout(botId, bounds, profile, mode, layoutOwner) {
      const ownerId = layoutOwnerIdOf(layoutOwner);
      if (bounds === null || bounds === undefined) {
        const entry = active.get(botIdOf(botId));
        if (!entry) return closedState(botIdOf(botId));
        if (profile !== undefined && entry.profile !== profileIdOf(profile)) return stateFor(entry);
        // Compact and expanded BrowserPanel instances can overlap briefly
        // during React handoff. Cleanup from the old owner must never hide
        // the newer native surface for the same bot and profile.
        if (ownerId !== undefined && entry.layoutOwner !== ownerId) return stateFor(entry);
        if (entry.visible) {
          entry.visible = false;
          entry.view.setVisible(false);
        }
        entry.layoutOwner = null;
        return stateFor(entry);
      }
      const entry = ensure(botId, profile);
      entry.layoutOwner = ownerId ?? null;
      const normalized = normalizeDesktopWorkspaceBounds(bounds, owner.getContentSize());
      if (!sameBounds(entry.bounds, normalized)) {
        entry.bounds = normalized;
        entry.view.setBounds(normalized);
      }
      applyMode(entry, mode === "expanded" ? "expanded" : "compact");
      if (!entry.visible) {
        // A hidden sibling may have been added after this view (profile
        // switch, workspace overlay, another bot). Re-adding raises this
        // native child before it becomes visible, matching DOM stacking.
        try {
          owner.contentView.addChildView(entry.view);
        } catch {}
        entry.visible = true;
        entry.view.setVisible(true);
      }
      return stateFor(entry);
    },

    async navigate(botId, rawUrl, profile, { source } = {}) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry, source);
        let url;
        try {
          url = await loadSafe(entry, rawUrl, source, lease);
        } catch (error) {
          // ERR_ABORTED (-3) is a redirect or an in-page replacement, not a failure
          if (error?.errno !== -3 && error?.code !== "ERR_ABORTED") {
            throw new Error(`could not open ${url ?? String(rawUrl ?? "")}: ${error?.message ?? error}`);
          }
        }
        return observe(entry);
      });
    },

    async back(botId, profile, { source } = {}) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry, source);
        const contents = entry.view.webContents;
        const canGoBack = contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack?.();
        if (!canGoBack) throw new Error("there is no previous page");
        assertAgentLease(entry, lease, source);
        if (contents.navigationHistory?.goBack) contents.navigationHistory.goBack();
        else contents.goBack();
        return observe(entry);
      });
    },

    async forward(botId, profile, { source } = {}) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry, source);
        const contents = entry.view.webContents;
        const canGoForward = contents.navigationHistory?.canGoForward?.() ?? contents.canGoForward?.();
        if (!canGoForward) throw new Error("there is no next page");
        assertAgentLease(entry, lease, source);
        if (contents.navigationHistory?.goForward) contents.navigationHistory.goForward();
        else contents.goForward();
        return observe(entry);
      });
    },

    async reload(botId, profile, { source } = {}) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry, source);
        assertAgentLease(entry, lease, source);
        entry.view.webContents.reload();
        return observe(entry);
      });
    },

    async snapshot(botId, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        await settle(entry, 0);
        return snapshot(entry);
      });
    },

    async click(botId, ref, { button = "left", clickCount = 1, profile } = {}) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        await assertNoPopulatedProtectedFields(entry, lease);
        const target = await centerOf(entry, ref, lease);
        const { x, y } = target;
        const which = button === "right" ? "right" : button === "middle" ? "middle" : "left";
        const clicks = Math.min(3, Math.max(1, Math.trunc(Number(clickCount)) || 1));
        await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, lease);
        await assertRefHitTarget(entry, target, lease);
        await assertNoPopulatedProtectedFields(entry, lease);
        // Chromium derives click and dblclick DOM events from a sequence whose
        // detail rises 1, 2, ...; sending only one down/up pair marked as 2
        // skips the first click and behaves differently from a real pointer.
        for (let detail = 1; detail <= clicks; detail += 1) {
          await cdp(entry, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: which, clickCount: detail }, lease);
          await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: which, clickCount: detail }, lease);
        }
        return observe(entry);
      });
    },

    async hover(botId, ref, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        await assertNoPopulatedProtectedFields(entry, lease);
        const { x, y } = await centerOf(entry, ref, lease);
        await assertNoPopulatedProtectedFields(entry, lease);
        await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, lease);
        return observe(entry);
      });
    },

    async drag(botId, fromRef, toRef, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        await assertNoPopulatedProtectedFields(entry, lease);
        const from = await centerOf(entry, fromRef, lease);
        const to = await centerOf(entry, toRef, lease);
        await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y }, lease);
        await assertRefHitTarget(entry, { ...from, ref: String(fromRef) }, lease);
        await assertNoPopulatedProtectedFields(entry, lease);
        await cdp(entry, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 }, lease);
        // a few intermediate moves so drag-and-drop libraries see a gesture
        for (const step of [0.25, 0.5, 0.75, 1]) {
          await cdp(entry, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: from.x + (to.x - from.x) * step,
            y: from.y + (to.y - from.y) * step,
            button: "left",
            buttons: 1,
          }, lease);
        }
        await assertRefHitTarget(entry, { ...to, ref: String(toRef) }, lease);
        await assertNoPopulatedProtectedFields(entry, lease);
        await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 }, lease);
        return observe(entry);
      });
    },

    async fill(botId, ref, text, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        const value = String(text ?? "");
        if (value.length > MAX_TEXT) throw new Error(`text is limited to ${MAX_TEXT} characters`);
        await assertNoPopulatedProtectedFields(entry, lease);
        const target = await centerOf(entry, ref, lease);
        await assertTargetAcceptsAgentText(entry, target, lease);
        await assertRefCurrent(entry, ref, lease);
        if (entry.refKind === "aria") {
          assertAgentLease(entry, lease);
          const focused = await evaluate(entry, `window.__ombBrowser.focusRef(${JSON.stringify(target.ref)})`);
          assertAgentLease(entry, lease);
          if (focused !== true) throw new Error("that element cannot take keyboard focus; click it first or pick a text field");
        } else {
          assertAgentLease(entry, lease);
          await cdp(entry, "DOM.focus", { backendNodeId: target.backendNodeId });
          assertAgentLease(entry, lease);
        }
        await assertRefCurrent(entry, ref, lease);
        await assertFocusedFieldAcceptsAgentText(entry, lease);
        await cdp(entry, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: selectAllModifiers }, lease);
        await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: selectAllModifiers }, lease);
        await assertFocusedFieldAcceptsAgentText(entry, lease);
        await cdp(entry, "Input.dispatchKeyEvent", { type: "keyDown", ...KEYS.backspace }, lease);
        await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", ...KEYS.backspace }, lease);
        if (value) {
          await assertNoPopulatedProtectedFields(entry, lease);
          await assertFocusedFieldAcceptsAgentText(entry, lease);
          await cdp(entry, "Input.insertText", { text: value }, lease);
        }
        return observe(entry);
      });
    },

    async type(botId, text, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        const value = String(text ?? "");
        if (!value) throw new Error("text is required");
        if (value.length > MAX_TEXT) throw new Error(`text is limited to ${MAX_TEXT} characters`);
        await assertNoPopulatedProtectedFields(entry, lease);
        await assertFocusedFieldAcceptsAgentText(entry, lease);
        await assertNoPopulatedProtectedFields(entry, lease);
        await cdp(entry, "Input.insertText", { text: value }, lease);
        return observe(entry);
      });
    },

    async press(botId, rawKey, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        const key = KEYS[String(rawKey ?? "").toLowerCase().replace(/[\s_-]/g, "")];
        if (!key) throw new Error(`unsupported key; use one of ${Object.keys(KEYS).join(", ")}`);
        await assertNoPopulatedProtectedFields(entry, lease);
        await assertFocusedTargetAllowsKeyAction(entry, lease);
        await assertNoPopulatedProtectedFields(entry, lease);
        await assertFocusedTargetAllowsKeyAction(entry, lease);
        await cdp(entry, "Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...key }, lease);
        await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode }, lease);
        return observe(entry);
      });
    },

    async scroll(botId, rawDirection, amount, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        const direction = SCROLL_DIRECTIONS[String(rawDirection ?? "down").toLowerCase()];
        if (!direction) throw new Error("direction must be up, down, left, or right");
        const pixels = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Math.min(Number(amount), 5_000) : 600;
        const { x, y } = viewportCenter();
        await assertNoPopulatedProtectedFields(entry, lease);
        // Move first so hover-driven layouts settle around the same point the
        // user sees. Standard DOM scrollers are moved in the isolated world:
        // Chromium's Linux/X11 compositor can acknowledge a mouseWheel packet
        // while dropping it, which made this tool silently do nothing. Keep a
        // real wheel fallback for canvas and virtual surfaces with no native
        // scroll container at the pointer.
        await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, lease);
        let pageScrolled = false;
        if (platform === "linux") {
          try {
            pageScrolled = await evaluate(entry, `(${SCROLL_AT_POINT_FUNCTION})(${JSON.stringify({
              x,
              y,
              deltaX: direction[0] * pixels,
              deltaY: direction[1] * pixels,
            })})`) === true;
            assertAgentLease(entry, lease);
          } catch {
            assertAgentLease(entry, lease);
          }
        }
        if (!pageScrolled) {
          await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: direction[0] * pixels, deltaY: direction[1] * pixels }, lease);
        }
        return observe(entry);
      });
    },

    /** Choose options in a <select> by value or visible label. */
    async select(botId, ref, rawValues, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        const values = (Array.isArray(rawValues) ? rawValues : [rawValues]).map((value) => String(value ?? "")).filter(Boolean);
        if (!values.length) throw new Error("at least one option value or label is required");
        await assertNoPopulatedProtectedFields(entry, lease);
        const target = await centerOf(entry, ref, lease);
        const objectId = await targetObjectId(entry, target, lease);
        if (!objectId) throw new Error("that element is gone; take a new browser_snapshot");
        await assertRefCurrent(entry, ref, lease);
        await assertNoPopulatedProtectedFields(entry, lease);
        assertAgentLease(entry, lease);
        const { result, exceptionDetails } = await cdp(entry, "Runtime.callFunctionOn", {
          objectId,
          returnByValue: true,
          arguments: [{ value: values }],
          functionDeclaration: `function (wanted) {
            const select = this.tagName === "SELECT" ? this : this.closest && this.closest("select");
            if (!select) return { error: "that ref is not a select field" };
            const options = [...select.options];
            const chosen = [];
            for (const option of options) {
              const hit = wanted.includes(option.value) || wanted.includes(option.textContent.trim());
              if (!select.multiple && chosen.length) { option.selected = false; continue; }
              option.selected = hit;
              if (hit) chosen.push(option.textContent.trim());
            }
            if (!chosen.length) return { error: "no option matched: " + options.map((o) => o.textContent.trim()).slice(0, 30).join(" | ") };
            select.dispatchEvent(new Event("input", { bubbles: true }));
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return { chosen };
          }`,
        });
        assertAgentLease(entry, lease);
        if (exceptionDetails) throw new Error("could not change that select field");
        if (result?.value?.error) throw new Error(result.value.error);
        return observe(entry);
      });
    },

    /** Wait until text appears, the address contains something, or the page
     * simply settles — bounded, so a bot never hangs on a page that stalls. */
    async waitFor(botId, { text, url, timeoutMs } = {}, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const deadline = now() + Math.min(Math.max(Number(timeoutMs) || WAIT_DEFAULT_MS, WAIT_POLL_MS), WAIT_MAX_MS);
        const wantText = isString(text) && text.trim() ? text.trim() : null;
        const wantUrl = isString(url) && url.trim() ? url.trim() : null;
        if (!wantText && !wantUrl) {
          await settle(entry);
          return snapshot(entry);
        }
        for (;;) {
          const current = entry.view.webContents.getURL?.() ?? "";
          let hit = wantUrl ? current.includes(wantUrl) : true;
          if (hit && wantText) {
            try {
              const pageText = await safePageText(entry);
              hit = String(pageText ?? "").includes(wantText);
            } catch (error) {
              if (/browser_read is unavailable while a protected field/i.test(String(error?.message ?? error))) throw error;
              hit = false;
            }
          }
          if (hit) return observe(entry);
          if (now() >= deadline) {
            throw new Error(
              `timed out waiting for ${[wantText ? `text ${JSON.stringify(wantText)}` : "", wantUrl ? `url containing ${JSON.stringify(wantUrl)}` : ""].filter(Boolean).join(" and ")}`,
            );
          }
          await sleep(WAIT_POLL_MS);
        }
      });
    },

    /** The page's readable text — for reading, not for acting. */
    async read(botId, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        await settle(entry, 0);
        const { text, state } = await safePageRead(entry);
        return {
          url: state.url,
          title: state.title,
          text: text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(truncated at ${MAX_READ_CHARS} characters)` : text,
          truncated: text.length > MAX_READ_CHARS,
        };
      });
    },

    /** JPEG of the page at the fixed viewport, downscaled for the model. */
    async screenshot(botId, profile) {
      const entry = ensure(botId, profile);
      return withOperation(entry, async () => {
        const lease = beginAgentAction(entry);
        await assertScreenshotHasNoProtectedValues(entry, lease);
        assertAgentLease(entry, lease);
        let shot = null;
        // Electron's CDP screenshot command can remain pending forever under
        // Linux/X11 software compositing. Native capturePage is reliable in
        // that environment and is normalized to the same fixed pixel size
        // below; other platforms keep the sharper fixed-viewport CDP path.
        if (platform !== "linux") {
          try {
            let deviceScaleFactor = 1;
            try {
              const reported = Number(await evaluate(entry, "window.devicePixelRatio"));
              if (Number.isFinite(reported) && reported >= 0.25 && reported <= 8) deviceScaleFactor = reported;
            } catch {}
            assertAgentLease(entry, lease);
            shot = await cdp(entry, "Page.captureScreenshot", {
              format: "jpeg",
              quality: SCREENSHOT_QUALITY,
              // captureScreenshot applies this scale before rasterizing at the
              // page's device pixel ratio. Divide by DPR so the encoded JPEG —
              // not just its metadata — is always exactly 1024x640.
              clip: {
                x: 0,
                y: 0,
                width: VIEWPORT.width,
                height: VIEWPORT.height,
                scale: SCREENSHOT_WIDTH / (VIEWPORT.width * deviceScaleFactor),
              },
            });
            assertAgentLease(entry, lease);
          } catch {
            // A control transition invalidates the result even if Chromium
            // already captured pixels. Never fall back and accidentally return
            // a frame that overlapped the user's typing.
            assertAgentLease(entry, lease);
            shot = null;
          }
        }
        if (shot?.data) {
          // The page can populate an API key/OTP/card field asynchronously
          // after the preflight. A post-capture scan makes that race
          // privacy-biased: discard the pixels if the page changed either
          // before or during capture.
          await assertScreenshotHasNoProtectedValues(entry, lease);
          const buffer = Buffer.from(shot.data, "base64");
          return { png: buffer.toString("base64"), format: "jpeg", width: SCREENSHOT_WIDTH, height: Math.round((VIEWPORT.height * SCREENSHOT_WIDTH) / VIEWPORT.width) };
        }
        assertAgentLease(entry, lease);
        const nativeBounds = entry.bounds ?? { width: VIEWPORT.width, height: VIEWPORT.height };
        const nativeScale = Number.isFinite(entry.presentationScale) ? entry.presentationScale : 1;
        const captureRect = {
          x: 0,
          y: 0,
          width: Math.max(1, Math.min(nativeBounds.width, Math.round(VIEWPORT.width * nativeScale))),
          height: Math.max(1, Math.min(nativeBounds.height, Math.round(VIEWPORT.height * nativeScale))),
        };
        const image = await entry.view.webContents.capturePage(captureRect);
        assertAgentLease(entry, lease);
        await assertScreenshotHasNoProtectedValues(entry, lease);
        const screenshotHeight = Math.round((VIEWPORT.height * SCREENSHOT_WIDTH) / VIEWPORT.width);
        // capturePage() reflects the native panel rectangle, which can be
        // smaller than the model-facing screenshot contract in compact mode.
        // Normalize both dimensions even when this means upscaling so callers
        // never receive pixels whose size disagrees with the fixed metadata.
        const scaled = image.resize({ width: SCREENSHOT_WIDTH, height: screenshotHeight });
        return { png: scaled.toJPEG(SCREENSHOT_QUALITY).toString("base64"), format: "jpeg", width: scaled.getSize().width, height: scaled.getSize().height };
      });
    },

    /** Mirror the renderer's explicit Take control / Hand back state into
     * the process that owns input. This closes the small network race before
     * the server-side control endpoint observes the same transition. */
    setHumanControl(botId, held, profile) {
      const id = botIdOf(botId);
      void profile;
      const control = controlFor(id);
      const next = held === true;
      if (control.held !== next) {
        botControl.set(id, { ...control, held: next, epoch: control.epoch + 1 });
        if (next) {
          for (const entry of entries.values()) {
            if (entry.botId === id) void neutralizeAgentInput(entry);
          }
        }
      }
      return true;
    },

    /** Invalidate every compound agent action already in flight for this
     * bot. The loopback host calls this before revoking a turn capability,
     * so a paused click/type cannot continue after the turn has ended. */
    cancelAgentActions(botId) {
      const id = botIdOf(botId);
      const control = controlFor(id);
      botControl.set(id, { ...control, agentEpoch: control.agentEpoch + 1 });
      for (const entry of entries.values()) {
        if (entry.botId === id) void neutralizeAgentInput(entry);
      }
      return true;
    },

    setCapabilityActive(botId, profile, active) {
      const id = botIdOf(botId);
      const wantedProfile = profileIdOf(profile);
      const key = `${id}\0${wantedProfile}`;
      if (active === true) capabilityPins.add(key);
      else capabilityPins.delete(key);
      return true;
    },

    /** Drop every bot's view on a named profile — before its data is cleared. */
    forgetProfile(profileId) {
      const wanted = profileIdOf(profileId);
      if (!wanted || wanted === GUEST_PROFILE) return 0;
      const wantedPartition = browserProfilePartition(wanted);
      for (const key of capabilityPins) if (key.endsWith(`\0${wanted}`)) capabilityPins.delete(key);
      let dropped = 0;
      for (const entry of entries.values()) {
        if (entry.partition === wantedPartition) {
          remove(entry, "profile-deleted");
          dropped += 1;
        }
      }
      return dropped;
    },

    /** Drop every view a bot has (all profiles). */
    close(botId) {
      const id = botIdOf(botId);
      for (const entry of entries.values()) if (entry.botId === id) remove(entry);
      for (const key of capabilityPins) if (key.startsWith(`${id}\0`)) capabilityPins.delete(key);
      const control = controlFor(id);
      botControl.set(id, {
        ...control,
        held: false,
        epoch: control.held ? control.epoch + 1 : control.epoch,
        agentEpoch: control.agentEpoch + 1,
      });
      return true;
    },

    closeAll() {
      const botIds = new Set([...entries.values()].map((entry) => entry.botId));
      for (const entry of entries.values()) remove(entry);
      capabilityPins.clear();
      for (const id of new Set([...botControl.keys(), ...botIds])) {
        const control = controlFor(id);
        botControl.set(id, {
          ...control,
          held: false,
          epoch: control.held ? control.epoch + 1 : control.epoch,
          agentEpoch: control.agentEpoch + 1,
        });
      }
    },

    hideAll() {
      for (const entry of entries.values()) {
        entry.visible = false;
        try {
          entry.view.setVisible(false);
        } catch {}
      }
    },

    size() {
      return entries.size;
    },

    /** Which views exist — for the panel's profile picker and diagnostics. */
    list() {
      return [...entries.values()].map((entry) => ({
        botId: entry.botId,
        profile: entry.profile,
        partition: entry.partition,
        active: active.get(entry.botId) === entry,
        visible: entry.visible,
        url: entry.view.webContents.isDestroyed?.() ? "" : entry.view.webContents.getURL?.() ?? "",
      }));
    },
  };
  return api;
}

module.exports = {
  GUEST_PROFILE,
  KEYS,
  MAX_VIEWS,
  VIEWPORT,
  createBrowserSurfaceManager,
  domSnapshotContainsProtectedValue,
};
