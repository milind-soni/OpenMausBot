// before() and after() run inside the call's lane, so no other call clears its lists or moves its page between them.
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";

import { redactSecretsInText, scrubHeldSecrets } from "../shared/redact.ts";
import { BrowserEvidence, type StepRecord } from "./browser-evidence.ts";
import { DATA_DIR } from "./config.ts";
import {
  PageHealthReader, healthLine, reduceRequest, sanitizePageText, unansweredWorthSaying,
  type FailedRequest, type HealthDelta, type RelayRead,
} from "./browser-page-health.ts";
import { RelayPorts, RelayTimeout, relay, relayPorts, relayTarget, type RelayTarget } from "./browser-relay.ts";
import type { BrowserSpawnSpec } from "./browser-runtime.ts";
import { sanitizeUrl, scrubBrowserResult } from "./browser-tool-shape.ts";
import { browserEgress } from "./browser/egress/registry.ts";

export interface StepContext {
  botId: string;
  botName: string;
  threadId: string;
  generation: string;
  turnId: () => string | null;
  record: boolean;
  label?: string;
}

export function stepContext(bot: { id: string; name: string; recordBrowserSteps?: boolean }, turn: { threadId: string; generation: string }, turnId: () => string | null): StepContext {
  return { botId: bot.id, botName: bot.name, threadId: turn.threadId, generation: turn.generation, turnId, record: bot.recordBrowserSteps === true };
}

export interface StepCall {
  session: string;
  spec: BrowserSpawnSpec;
  tool: string;
  args: Record<string, unknown>;
  ctx?: StepContext;
  /** A person took the browser, or it became uncertain or is closing: capture nothing more. */
  stopped(): boolean;
  alive(): boolean;
  resize(): Promise<void>;
}

export interface Box { x: number; y: number; w: number; h: number }
export interface Marker extends Box { approx?: true }

/** `frame`: focus is inside a same-origin frame (rect is the frame's) or a cross-origin one no page script can see into. */
interface Focus { role: string; name: string; editable: boolean; valueLength: number; secret: boolean; rect: Box; frame?: "same" | "cross" | null }
export interface Geometry { url: string; title: string; vw: number; vh: number; dpr: number; sx: number; sy: number; focus: Focus | null; unmasked: number; loadedAt?: number }

interface StepState {
  startedAt: number;
  /** When the engine got the action: whatever it stamps later is the action's. */
  actionAt: number;
  action: boolean;
  recorded: boolean;
  aliveBefore: boolean | null;
  /** No daemon answered before the call, so its lists hold only this call's news (a daemon that outlived Chrome keeps old ones). */
  noDaemon: boolean;
  wasRunning: boolean;
  late: HealthDelta | null;
  geometry: Geometry | null;
  box: Box | null;
  target: { selector: string; role?: string; name?: string; inFrame: boolean } | null;
}

const ACTIONS = new Set(["open", "click", "fill", "type", "press", "check", "uncheck", "select", "scroll", "back", "forward", "reload", "tab_new", "tab_switch", "tab_close", "eval", "close"]
  .map((name) => `agent_browser_${name}`));
const REFS_RESET = new Set(["open", "tab_new", "tab_switch", "tab_close", "close"].map((name) => `agent_browser_${name}`));

const PASS_MS = 1_000;
const SETTLE_CAP_MS = 1_500;
const FRAME_WAIT_MS = 300;
/** Headless full Chrome on macOS (Chrome for Testing 152) sometimes stalls 10-20 s on a fresh browser's first capture. */
const SCREENSHOT_MS = 12_000;
const JPEG_QUALITY = 70;
const CODE_LATCH_MS = 60_000;
const FRESH_IMAGE_MS = 2_000;

const RELAUNCHED = "The browser had stopped and was started again during this call: pages, refs and form input from before are gone. Take a snapshot before acting on refs.";

/** Read-only; reports how much the focused element holds, never its value. A cross-origin frame stops the focus walk. */
export const GEOMETRY_SCRIPT = `(() => {
  const SECRET = /pass|pwd|otp|one.?time|2fa|mfa|security.?code|verif\\w*.?code|cvc|cvv|card.?num|cc.?num/i;
  const AUTO = /(?:^|\\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:\\s|$)/i;
  const tag = (el) => String(el.tagName || "").toLowerCase();
  const attr = (el, name) => (el.getAttribute && el.getAttribute(name)) || "";
  const label = (el) => {
    if (attr(el, "aria-label")) return attr(el, "aria-label");
    if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.innerText || l.textContent || "").join(" ");
    return attr(el, "placeholder") || attr(el, "title") || attr(el, "name");
  };
  const field = (el) => tag(el) === "input" || tag(el) === "textarea";
  const secret = (el) => field(el) && (el.type === "password" || AUTO.test(attr(el, "autocomplete")) ||
    SECRET.test([el.name, el.id, label(el), attr(el, "placeholder")].join(" ")));
  const shown = (el) => {
    const view = el.ownerDocument.defaultView || window;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.right < 0 || r.top > view.innerHeight || r.left > view.innerWidth) return false;
    const s = view.getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const inside = (el) => { try { return el.contentDocument || null; } catch { return null; } };
  const showing = (el) => field(el) && el.value && el.type !== "password" && secret(el) && shown(el);
  let unmasked = Array.from(document.querySelectorAll("input, textarea")).some(showing) ? 1 : 0;
  // Then open shadow roots and same-origin frames, within a bound.
  const roots = [{ root: document, owner: null }];
  let seen = 0;
  scan: for (let i = 0; i < roots.length && !unmasked; i++) {
    const { root, owner } = roots[i];
    if (owner && !shown(owner)) continue;
    for (const el of root.querySelectorAll("*")) {
      if (++seen > 50000) break scan;
      if (el.shadowRoot) roots.push({ root: el.shadowRoot, owner });
      const t = tag(el);
      if (t === "iframe" || t === "frame") { const doc = inside(el); if (doc) roots.push({ root: doc, owner: el }); }
      else if (root !== document && showing(el)) { unmasked = 1; break scan; }
    }
  }
  let a = document.activeElement;
  let frame = null;
  for (let depth = 0; a && depth < 20; depth++) {
    if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
    if (tag(a) !== "iframe" && tag(a) !== "frame") break;
    const doc = inside(a);
    if (!doc) { frame = "cross"; break; }
    if (!doc.activeElement || doc.activeElement === doc.body || doc.activeElement === doc.documentElement) break;
    a = doc.activeElement;
    frame = "same";
  }
  let focus = null;
  if (a && a !== document.body && a !== document.documentElement) {
    const t = tag(a);
    const kinds = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", range: "slider", search: "searchbox" };
    const role = attr(a, "role") || (t === "input" ? kinds[a.type] || "textbox" : t === "textarea" ? "textbox" : t === "select" ? "combobox" :
      t === "button" ? "button" : t === "a" ? "link" : a.isContentEditable ? "textbox" : t);
    const r = a.getBoundingClientRect();
    const name = String(label(a) || "").slice(0, 200);
    focus = { role, name, editable: Boolean(a.isContentEditable || (field(a) && !a.readOnly && !a.disabled)),
      valueLength: typeof a.value === "string" ? a.value.length : a.isContentEditable ? (a.innerText || "").length : 0,
      secret: frame === "cross" ? SECRET.test(name + " " + attr(a, "name")) : secret(a), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, frame };
  }
  return JSON.stringify({ url: location.href, title: document.title, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, sx: scrollX, sy: scrollY, focus, unmasked, loadedAt: performance.timeOrigin });
})()`;

const PAGE_SCRIPT = "JSON.stringify({ url: location.href, loadedAt: performance.timeOrigin })";

const FRAME_SCRIPT = "new Promise((r) => { const t = setTimeout(() => r(0), 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(1); })); })";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function parseGeometry(value: unknown): Geometry | null {
  let parsed: unknown = value;
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth++) {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  const page = record(parsed);
  if (!page || typeof page.url !== "string") return null;
  const focus = record(page.focus);
  const rect = record(focus?.rect);
  return {
    url: page.url, title: typeof page.title === "string" ? page.title : "",
    vw: finite(page.vw) ?? 0, vh: finite(page.vh) ?? 0, dpr: finite(page.dpr) ?? 1, sx: finite(page.sx) ?? 0, sy: finite(page.sy) ?? 0,
    focus: focus ? {
      role: String(focus.role ?? ""), name: String(focus.name ?? ""), editable: focus.editable === true, valueLength: finite(focus.valueLength) ?? 0,
      secret: focus.secret === true, rect: { x: finite(rect?.x) ?? 0, y: finite(rect?.y) ?? 0, w: finite(rect?.w) ?? 0, h: finite(rect?.h) ?? 0 },
      frame: focus.frame === "same" || focus.frame === "cross" ? focus.frame : null,
    } : null,
    unmasked: finite(page.unmasked) ?? 0,
    ...(finite(page.loadedAt) !== null ? { loadedAt: finite(page.loadedAt)! } : {}),
  };
}

function pageKey(href: string): string | null {
  try { const url = new URL(href); return `${url.origin}${url.pathname}${url.search}`; } catch { return null; }
}

export class RefIndex {
  private refs = new Map<string, { role: string; name: string; inFrame: boolean }>();

  replace(texts: readonly string[], refs?: unknown): void {
    this.refs.clear();
    const frames: number[] = [];
    for (const text of texts) {
      for (const line of text.split("\n")) {
        const item = /^(\s*)- ([^\s"[\]]+)(?: "((?:[^"\\]|\\.)*)")?/u.exec(line);
        if (!item) continue;
        const indent = item[1]!.length;
        while (frames.length && frames.at(-1)! >= indent) frames.pop();
        const ref = /\[ref=(e\d+)\]/u.exec(line)?.[1];
        let name = item[3] ?? "";
        try { name = JSON.parse(`"${name}"`) as string; } catch {}
        if (ref) this.refs.set(ref, { role: item[2]!, name, inFrame: frames.length > 0 });
        if (item[2]!.toLowerCase() === "iframe") frames.push(indent);
      }
    }
    for (const [ref, value] of Object.entries(record(refs) ?? {})) {
      const known = this.refs.get(ref);
      const entry = record(value);
      if (!entry) continue;
      this.refs.set(ref, { role: String(entry.role ?? known?.role ?? ""), name: String(entry.name ?? known?.name ?? ""), inFrame: known?.inFrame ?? false });
    }
  }

  clear(): void { this.refs.clear(); }

  get(selector: string): { role: string; name: string; inFrame: boolean } | undefined {
    const ref = /^@?(e\d+)$/u.exec(selector.trim())?.[1];
    return ref ? this.refs.get(ref) : undefined;
  }
}

const SECRET_TARGET = /pass|pwd|otp|one.?time|2fa|mfa|security.?code|verif\w*.?code|cvc|cvv|card.?num|cc.?num|\bpin\b|ssn|secret|token/iu;

/** Typed text is scrubbed of held secrets and masked outright for any field that looks secret. */
export function stepLabel(tool: string, args: Record<string, unknown>, ref?: { role: string; name: string }, focus?: Focus | null): string {
  const q = (text: unknown) => JSON.stringify(sanitizePageText(String(text ?? ""), 80));
  const selector = typeof args.selector === "string" ? args.selector : "";
  const element = ref
    ? `${ref.name.trim() ? `the ${q(ref.name.trim())} ` : "a "}${sanitizePageText(ref.role, 40) || "element"}`
    : selector ? `the element ${q(selector)}` : "the page";
  const typed = () => {
    const raw = String(args.text ?? "");
    const hint = `${ref?.role ?? ""} ${ref?.name ?? ""} ${selector}`;
    if (SECRET_TARGET.test(hint) || focus?.secret) return "••••";
    return q(redactSecretsInText(scrubHeldSecrets(raw)));
  };
  switch (tool.replace(/^agent_browser_/u, "")) {
    case "open": return typeof args.url === "string" && args.url ? `Opened ${sanitizeUrl(args.url) || "a page"}` : "Opened the browser";
    case "click": return `Clicked ${element}${args.newTab === true ? " to open it in a new tab" : ""}`;
    case "fill": return `Filled ${element} with ${typed()}`;
    case "type": return `Typed ${typed()} into ${element}`;
    // One character pressed into a secret field is typing, masked like it.
    case "press": return `Pressed ${focus?.secret && [...String(args.key ?? "")].length === 1 ? "••••" : q(args.key)}${focus?.name ? ` in the ${q(focus.name)} ${sanitizePageText(focus.role, 40)}` : ""}`;
    case "check": return `Checked ${element}`;
    case "uncheck": return `Unchecked ${element}`;
    case "select": return `Chose ${Array.isArray(args.values) ? args.values.slice(0, 3).map(q).join(", ") : q(args.value)} in ${element}`;
    case "scroll": return `Scrolled ${["up", "down", "left", "right"].includes(String(args.direction)) ? args.direction : "down"}${typeof args.amount === "number" ? ` ${Math.round(args.amount)} px` : ""}${selector ? ` in ${element}` : ""}`;
    case "back": return "Went back";
    case "forward": return "Went forward";
    case "reload": return "Reloaded the page";
    case "tab_new": return typeof args.url === "string" && args.url ? `Opened a new tab at ${sanitizeUrl(args.url) || "a page"}` : "Opened a new tab";
    case "tab_switch": return `Switched to tab ${q(args.tab)}`;
    case "tab_close": return args.tab === undefined ? "Closed the tab" : `Closed tab ${q(args.tab)}`;
    case "eval": return "Ran a script on the page";
    case "close": return "Closed the browser";
    case "restart_browser": return "Restarted the browser";
    default: return `Used ${sanitizePageText(tool, 60)}`;
  }
}

/** Only a box read before the action counts: afterwards the engine may resolve the ref to another element. */
export function markerFor(box: Box | null, before: Geometry | null, after: Geometry | null, options: { navigated: boolean; inFrame: boolean }): { marker: Marker | null; why: string | null } {
  if (!box) return { marker: null, why: "no-target" };
  if (options.navigated) return { marker: null, why: "navigated" };
  if (options.inFrame) return { marker: null, why: "in-frame" };
  if (!before || !after || after.vw <= 0 || after.vh <= 0) return { marker: null, why: "no-geometry" };
  const dx = after.sx - before.sx, dy = after.sy - before.sy;
  const visible = (b: Box, w: number, h: number) => b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0;
  let shown: Box;
  let approx = false;
  if (dx === 0 && dy === 0) {
    if (!visible(box, before.vw, before.vh)) return { marker: null, why: "scrolled-inside-page" };
    shown = box;
  } else {
    shown = { x: box.x - dx, y: box.y - dy, w: box.w, h: box.h };
    approx = true;
    if (!visible(shown, after.vw, after.vh)) return { marker: null, why: "moved-off-screen" };
  }
  const dpr = after.dpr > 0 ? after.dpr : 1;
  const left = Math.max(0, shown.x), top = Math.max(0, shown.y);
  const right = Math.min(after.vw, shown.x + shown.w), bottom = Math.min(after.vh, shown.y + shown.h);
  const marker: Marker = { x: Math.round(left * dpr), y: Math.round(top * dpr), w: Math.round((right - left) * dpr), h: Math.round((bottom - top) * dpr) };
  return { marker: approx ? { ...marker, approx: true } : marker, why: null };
}

/** Secret when either focus looks secret: typing lands in the field the call named, which may only have taken focus during it. */
function labelFocus(before: Focus | null, after: Focus | null): Focus | null {
  const focus = before ?? after;
  return focus && !focus.secret && after?.secret ? { ...focus, secret: true } : focus;
}

interface SessionSteps {
  running: boolean;
  refs: RefIndex;
  /** After fill_login typed a one-time code: no screenshot until this time or until the page leaves `codeUrl`. */
  codeUntil: number;
  codeUrl: string | null;
  /** Typed into a secret-looking field in a cross-origin frame (a card field): no screenshot until the page leaves this address. */
  secretPage: string | null;
  image: { path: string; at: number } | null;
}

/** Held secrets and key-shaped text out of every text in a step: a title, console line or label can echo them. */
function clean(entry: StepRecord): StepRecord {
  const { v, step, at, threadId, generation, image, botId, turnId, ...rest } = entry;
  return { ...(scrubBrowserResult(rest, redactSecretsInText) as Record<string, unknown>), v, step, at, threadId, generation, image, botId, turnId };
}

function textsOf(result: unknown): string[] {
  const content = record(result)?.content;
  return Array.isArray(content) ? content.flatMap((part) => typeof record(part)?.text === "string" ? [record(part)!.text as string] : []) : [];
}

function engineData(result: unknown): Record<string, unknown> | null {
  return record(record(record(record(result)?.structuredContent)?.response)?.data);
}

export class BrowserSteps {
  readonly ports: RelayPorts;
  readonly health: PageHealthReader;
  readonly evidence: BrowserEvidence | null;
  private sessions = new Map<string, SessionSteps>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(options: { ports: RelayPorts; evidence: BrowserEvidence | null; health?: PageHealthReader; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.ports = options.ports;
    this.evidence = options.evidence;
    this.health = options.health ?? new PageHealthReader();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private session(session: string): SessionSteps {
    let state = this.sessions.get(session);
    if (!state) {
      state = { running: false, refs: new RefIndex(), codeUntil: 0, codeUrl: null, secretPage: null, image: null };
      this.sessions.set(session, state);
    }
    return state;
  }

  refs(session: string): RefIndex { return this.session(session).refs; }

  recentFrame(session: string): { png: string; format: "jpeg" } | null {
    const image = this.sessions.get(session)?.image;
    if (!image || this.now() - image.at >= FRESH_IMAGE_MS) return null;
    try { return { png: readFileSync(image.path).toString("base64"), format: "jpeg" }; } catch { return null; }
  }

  /** Each read ≤ 1 s, all ≤ budgetMs; a timeout trips the breaker. agent-browser relaunches Chrome for any command outside its launch-free list. */
  private reader(target: RelayTarget, port: number, budgetMs = PASS_MS): RelayRead {
    const deadline = this.now() + budgetMs;
    return async (command) => {
      const left = Math.min(PASS_MS, deadline - this.now());
      if (left <= 0 || this.ports.isTripped(target.session)) return null;
      try {
        const answer = await relay(port, command, { timeoutMs: left });
        if (answer.launched) this.ports.noteStarted(target.session);
        return answer;
      } catch (error) {
        if (error instanceof RelayTimeout) this.ports.trip(target.session);
        return null;
      }
    };
  }

  private target(call: { session: string; spec: SessionSpec }): RelayTarget { return relayTarget(call.spec, call.session); }

  /** Never throws. */
  async before(call: StepCall): Promise<StepState> {
    const steps = this.session(call.session);
    steps.image = null;
    const state: StepState = {
      startedAt: this.now(), actionAt: 0, action: ACTIONS.has(call.tool), recorded: call.ctx?.record === true && ACTIONS.has(call.tool),
      aliveBefore: null, noDaemon: false, wasRunning: steps.running, late: null, geometry: null, box: null, target: null,
    };
    try {
      if (call.stopped()) return state;
      const target = this.target(call);
      const probe = await this.ports.probe(target);
      state.aliveBefore = probe ? probe.connected : (this.ports.isTripped(call.session) ? null : false);
      state.noDaemon = !probe && state.aliveBefore === false;
      if (!probe?.connected || !state.action) return state;
      const read = this.reader(target, probe.port);
      state.late = await this.health.read(call.session, read, call.ctx?.threadId ?? null);
      await this.health.clear(call.session, read);
      if (!state.recorded) return state;
      state.geometry = parseGeometry((await read({ action: "evaluate", script: GEOMETRY_SCRIPT }))?.data?.result);
      const selector = typeof call.args.selector === "string" ? call.args.selector : "";
      if (selector) {
        const ref = steps.refs.get(selector);
        state.target = { selector: sanitizePageText(selector, 200), ...(ref ? { role: ref.role, name: sanitizePageText(ref.name, 120) } : {}), inFrame: ref?.inFrame ?? false };
        const box = (await read({ action: "boundingbox", selector }))?.data;
        const x = finite(box?.x), y = finite(box?.y), w = finite(box?.width), h = finite(box?.height);
        if (x !== null && y !== null && w !== null && h !== null) state.box = { x, y, w, h };
      } else if (call.tool === "agent_browser_press" && state.geometry?.focus && !state.geometry.focus.frame) {
        state.box = state.geometry.focus.rect;
      }
    } catch {}
    finally { state.actionAt = this.now(); }
    return state;
  }

  /** Never throws; a person who takes the browser meanwhile ends it at the next check. */
  async after(call: StepCall, result: unknown, state: StepState, engineMs = 0): Promise<{ parts: Array<{ type: "text"; text: string }>; launched: boolean }> {
    const out: { parts: Array<{ type: "text"; text: string }>; launched: boolean } = { parts: [], launched: false };
    const steps = this.session(call.session);
    const ok = record(result)?.isError !== true;
    const tool = call.tool;
    const halted = (facts: { settleMs?: number } = {}) => state.recorded
      ? this.write(call, state, { ok, imageSkipped: call.alive() ? "person-took-control" : "turn-ended", engineMs, ...facts }) : null;
    try {
      if (ok && (REFS_RESET.has(tool) || (tool === "agent_browser_click" && call.args.newTab === true))) steps.refs.clear();
      if (ok && (tool === "agent_browser_snapshot" || tool === "agent_browser_open")) steps.refs.replace(textsOf(result), engineData(result)?.refs);
      if (ok && tool === "agent_browser_screenshot" && call.args.annotate === true) steps.refs.clear();
      if (ok && tool === "agent_browser_close") {
        steps.running = false;
        browserEgress.takeNotice(call.session);
        this.health.forget(call.session);
        this.ports.forget(call.session);
        if (state.recorded) await this.write(call, state, { ok, imageSkipped: "no-browser", engineMs });
        return out;
      }
      if (call.stopped() || !call.alive()) { await halted(); return out; }
      const target = this.target(call);
      const probe = await this.ports.probe(target);
      const aliveAfter = probe ? probe.connected : null;
      const engineStarted = record(engineData(result)?.lifecycle)?.launched === true;
      const startedElsewhere = this.ports.takeStarted(call.session);
      if ((aliveAfter === true && state.aliveBefore === false) || engineStarted || startedElsewhere) {
        await this.started(call, steps, state.wasRunning || startedElsewhere, out);
      }
      if (aliveAfter !== null) steps.running = aliveAfter;
      if (!probe?.connected) {
        if (state.recorded) await this.write(call, state, { ok, imageSkipped: aliveAfter === false ? "no-browser" : "page-not-responding", engineMs });
        return out;
      }
      const recording = state.recorded && ok;
      let pending: FailedRequest[] = [];
      let settleMs = 0;
      if (recording) {
        const settled = await this.settle(target, probe.port, state.actionAt, () => call.stopped());
        pending = settled.pending;
        settleMs = settled.ms;
        if (!call.stopped()) await this.reader(target, probe.port, FRAME_WAIT_MS * 2)({ action: "evaluate", script: FRAME_SCRIPT });
        if (call.stopped()) { await halted({ settleMs }); return out; }
      }
      const read = this.reader(target, probe.port);
      let geometry: Geometry | null = null;
      let failure: string | undefined;
      if (state.recorded) {
        const answer = await read({ action: "evaluate", script: GEOMETRY_SCRIPT });
        geometry = parseGeometry(answer?.data?.result);
        failure = answer?.error;
      }
      const page = geometry ?? parseGeometry((await read({ action: "evaluate", script: PAGE_SCRIPT }))?.data?.result);
      this.health.setPage(call.session, page?.url ?? null, page?.loadedAt ?? null);
      const delta = await this.health.read(call.session, read, call.ctx?.threadId ?? null, state.noDaemon);
      if (this.ports.takeStarted(call.session)) await this.started(call, steps, true, out);
      const pageHost = this.health.pageHost(call.session);
      const lines = [
        state.late ? healthLine(this.health.visible(call.session, state.late), [], "late", SETTLE_CAP_MS / 1000, pageHost) : null,
        delta ? healthLine(this.health.visible(call.session, delta), recording ? unansweredWorthSaying(pending) : [], state.action ? "after" : "late", SETTLE_CAP_MS / 1000, pageHost) : null,
        browserEgress.takeNotice(call.session),
      ];
      for (const text of lines) if (text) out.parts.push({ type: "text", text });
      if (state.recorded) {
        const step = await this.write(call, state, { ok, engineMs, settleMs, geometry, failure, delta, pending, captureFrom: probe.port });
        if (step) out.parts.push({ type: "text", text: `Recorded as step ${step}.` });
      }
    } catch {}
    return out;
  }

  private async started(call: StepCall, steps: SessionSteps, news: boolean, out: { parts: Array<{ type: "text"; text: string }>; launched: boolean }): Promise<void> {
    if (out.launched) return;
    out.launched = true;
    steps.refs.clear();
    await call.resize();
    if (news) out.parts.push({ type: "text", text: RELAUNCHED });
  }

  private async settle(target: RelayTarget, port: number, since: number, stopped: () => boolean): Promise<{ pending: FailedRequest[]; ms: number }> {
    const started = this.now();
    const read = this.reader(target, port, SETTLE_CAP_MS + PASS_MS);
    const site = this.health.pageSite(target.session);
    let pending: FailedRequest[] = [];
    for (let wait = 50; !stopped(); wait = 100) {
      await this.sleep(wait);
      if (stopped()) break;
      const answer = await read({ action: "requests", type: "document,fetch,xhr" });
      const list = Array.isArray(answer?.data?.requests) ? answer.data.requests : null;
      if (!list) break;
      pending = list.flatMap((raw) => {
        const at = finite(record(raw)?.timestamp);
        const request = reduceRequest(raw, site, this.now());
        if (!request?.pending || (at !== null && at < since - 50)) return [];
        return request.type.toLowerCase() === "document" || (request.method !== "GET" && request.firstParty) ? [request] : [];
      });
      if (!pending.length || this.now() - started >= SETTLE_CAP_MS) break;
    }
    return { pending, ms: this.now() - started };
  }

  private async write(call: StepCall, state: StepState, facts: {
    ok: boolean; engineMs: number; imageSkipped?: string; settleMs?: number; geometry?: Geometry | null; failure?: string;
    delta?: HealthDelta | null; pending?: FailedRequest[]; captureFrom?: number;
  }): Promise<number | null> {
    const ctx = call.ctx;
    if (!ctx || !this.evidence) return null;
    const steps = this.session(call.session);
    const geometry = facts.geometry ?? null;
    const navigated = Boolean(state.geometry && geometry && state.geometry.url !== geometry.url);
    const ref = state.target?.role !== undefined ? { role: state.target.role, name: state.target.name ?? "" } : undefined;
    const { marker, why } = markerFor(state.box, state.geometry, geometry, { navigated, inFrame: state.target?.inFrame ?? false });
    const here = geometry ? pageKey(geometry.url) : null;
    if (steps.codeUrl !== null && here !== null && here !== steps.codeUrl) steps.codeUntil = 0;
    if (steps.secretPage !== null && here !== null && here !== steps.secretPage) steps.secretPage = null;
    const typed = call.tool === "agent_browser_fill" || call.tool === "agent_browser_type";
    const target = state.target;
    if (typed && here !== null && ((target?.inFrame && SECRET_TARGET.test(`${target.role ?? ""} ${target.name ?? ""}`)) || (geometry?.focus?.frame === "cross" && geometry.focus.secret))) {
      steps.secretPage = here;
    }
    if (!this.evidence.accepts(ctx.threadId)) return null;
    const step = this.evidence.nextStep();
    let imageSkipped = facts.imageSkipped ?? null;
    if (!imageSkipped) {
      if (!geometry || this.ports.isTripped(call.session)) imageSkipped = /dialog/iu.test(facts.failure ?? "") ? "dialog-open" : "page-not-responding";
      else if (geometry.unmasked > 0 || (steps.secretPage !== null && steps.secretPage === here)) imageSkipped = "secret-on-screen";
      else if (steps.codeUntil > this.now()) imageSkipped = "code-recently-typed";
      else if (call.stopped()) imageSkipped = "person-took-control";
      else if (!call.alive()) imageSkipped = "turn-ended";
    }
    let imagePath: string | null = null;
    let captureMs: number | undefined;
    if (!imageSkipped && facts.captureFrom !== undefined) {
      const slot = this.evidence.imageTarget(ctx.threadId, ctx.generation, step);
      if ("skipped" in slot) imageSkipped = slot.skipped;
      else {
        const captureStarted = this.now();
        let taken = false;
        try {
          taken = (await relay(facts.captureFrom, { action: "screenshot", path: slot.path, format: "jpeg", quality: JPEG_QUALITY }, { timeoutMs: SCREENSHOT_MS, maxBytes: 65_536 })).success;
        } catch (error) { if (error instanceof RelayTimeout) this.ports.trip(call.session); }
        captureMs = this.now() - captureStarted;
        // A person who took the browser while the picture was taken keeps it out.
        if (call.stopped()) { imageSkipped = "person-took-control"; taken = false; }
        if (taken) imagePath = slot.path;
        else {
          try { unlinkSync(slot.path); } catch {}
          imageSkipped ??= "capture-failed";
        }
      }
    }
    const viewport = geometry ? { w: geometry.vw, h: geometry.vh, dpr: geometry.dpr } : null;
    // Null where a read failed: unknown, never "no errors".
    const health = facts.delta === undefined ? (state.late ? { late: state.late, after: null } : null)
      : { late: state.late, after: facts.delta ? { ...facts.delta, pending: facts.pending ?? [] } : null };
    const entry: StepRecord = {
      v: 1, step, at: state.startedAt, botId: ctx.botId, botName: sanitizePageText(ctx.botName, 100),
      threadId: ctx.threadId, generation: ctx.generation, turnId: ctx.turnId(),
      tool: call.tool, kind: call.tool.replace(/^agent_browser_/u, ""),
      action: ctx.label ? sanitizePageText(ctx.label, 200) : stepLabel(call.tool, call.args, ref, labelFocus(state.geometry?.focus ?? null, geometry?.focus ?? null)),
      ok: facts.ok,
      target: state.target ? { ...state.target, box: state.box } : null,
      page: geometry ? {
        url: sanitizeUrl(geometry.url), title: sanitizePageText(scrubHeldSecrets(geometry.title), 200), viewport,
        scrollBefore: state.geometry ? { x: state.geometry.sx, y: state.geometry.sy } : null, scrollAfter: { x: geometry.sx, y: geometry.sy }, navigated,
      } : null,
      marker, markerWhy: why,
      verify: typed && geometry ? {
        focus: geometry.focus ? { role: geometry.focus.role, name: sanitizePageText(geometry.focus.name, 120), editable: geometry.focus.editable, valueLength: geometry.focus.valueLength } : null,
        landed: geometry.focus?.frame === "cross" ? null : Boolean(geometry.focus?.editable && geometry.focus.valueLength > 0),
      } : null,
      health,
      timing: { engineMs: Math.round(facts.engineMs), ...(facts.settleMs !== undefined ? { settleMs: Math.round(facts.settleMs) } : {}), ...(captureMs !== undefined ? { captureMs: Math.round(captureMs) } : {}) },
      image: null, imageSkipped,
    };
    let kept: StepRecord;
    try { kept = await this.evidence.commit(clean(entry), imagePath); }
    catch {
      if (imagePath) { try { unlinkSync(imagePath); } catch {} }
      return null;
    }
    const file = kept.image ? this.evidence.imageFile(ctx.threadId, ctx.generation, kept.image) : null;
    if (file) steps.image = { path: file, at: this.now() };
    return step;
  }

  /** A step with no screenshot, and none for a minute after a one-time code unless the page leaves its address. */
  async signIn(call: { session: string; spec: SessionSpec; ctx?: StepContext }, outcome: { ok: boolean; host?: string; filled?: string[] }): Promise<number | null> {
    const steps = this.session(call.session);
    const ctx = call.ctx;
    if (outcome.ok && outcome.filled?.includes("code")) {
      steps.codeUntil = this.now() + CODE_LATCH_MS;
      steps.codeUrl = null;
      const target = this.target(call);
      const probe = ctx?.record ? await this.ports.probe(target) : null;
      const page = probe?.connected ? parseGeometry((await this.reader(target, probe.port)({ action: "evaluate", script: PAGE_SCRIPT }))?.data?.result) : null;
      if (page) steps.codeUrl = pageKey(page.url);
    }
    if (!ctx?.record || !this.evidence) return null;
    const what = (outcome.filled ?? []).map((field) => field === "code" ? "one-time code" : field);
    const action = outcome.ok
      ? `Signed in with the saved login for ${sanitizePageText(outcome.host ?? "this site", 120)}${what.length ? ` (${what.join(" and ")})` : ""}`
      : `Could not sign in with a saved login${outcome.host ? ` on ${sanitizePageText(outcome.host, 120)}` : ""}`;
    return this.note(ctx, { tool: "fill_login", action, ok: outcome.ok });
  }

  async note(ctx: StepContext | undefined, fact: { tool: string; action?: string; ok: boolean }): Promise<number | null> {
    if (!ctx?.record || !this.evidence?.accepts(ctx.threadId)) return null;
    const step = this.evidence.nextStep();
    try {
      await this.evidence.commit(clean({
        v: 1, step, at: this.now(), botId: ctx.botId, botName: sanitizePageText(ctx.botName, 100), threadId: ctx.threadId, generation: ctx.generation,
        turnId: ctx.turnId(), tool: fact.tool, kind: fact.tool.replace(/^agent_browser_/u, ""), action: fact.action ?? stepLabel(fact.tool, {}), ok: fact.ok,
        image: null, imageSkipped: "no-screenshot",
      }), null);
      return step;
    } catch { return null; }
  }

  /** While a person holds the browser, what its page reports never reaches a bot or a step. */
  personTook(session: string): void {
    this.health.discardNext(session);
    this.session(session).image = null;
  }

  forget(session: string): void {
    this.sessions.delete(session);
    this.health.forget(session);
    this.ports.forget(session);
  }
}

type SessionSpec = Pick<BrowserSpawnSpec, "command" | "env">;

export const browserEvidence = new BrowserEvidence({ root: join(DATA_DIR, "evidence") });
export const browserSteps = new BrowserSteps({ ports: relayPorts, evidence: browserEvidence });
