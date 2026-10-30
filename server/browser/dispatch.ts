// Runs one browser tool call: picks the tab, runs the action under the profile's control, and words the answer.
//
// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/preview/ServerBrowser.ts (runOperation, executeTabOperation,
// navigate, status) and apps/server/src/mcp/PreviewAutomationBroker.ts, MIT License, Copyright (c) 2026 T3 Tools Inc.
// (full text in third_party/t3-code/LICENSE); modified: one in-process host instead of a broker, tabs that belong to
// the profile, the CDP driver instead of Playwright, and OpenMausBot's page-change and page-health lines.
import { describePageChange, sanitizeUrl, type PageState } from "../browser-tool-shape.ts";
import type { CdpBrowser } from "./cdp/browser.ts";
import type { Download } from "./cdp/downloads.ts";
import { DriverError, isUnanswered } from "./cdp/errors.ts";
import { callOnNode, valueInWorld } from "./cdp/evaluate.ts";
import type { PointerReporter } from "./cdp/actions.ts";
import { navigable } from "./cdp/page.ts";
import type { Screenshot } from "./cdp/screencast.ts";
import { resolveElement } from "./cdp/selectors.ts";
import { MAX_VISIBLE_TEXT_LENGTH } from "./cdp/snapshot.ts";
import { BROWSER_CONTROL_REFUSAL, type ProfileControl } from "./control.ts";
import { BrowserControlInterrupted } from "./session-control.ts";
import { errorResult, pageLabel, snapshotText, textResult, withParts, type ToolResult } from "./shape.ts";
import type { Tab, TabRegistry } from "./tabs.ts";
import { targetOf, type ToolCall, type ToolInput } from "./tools.ts";

export const DEFAULT_ACTION_MS = 15_000;
/** Kept back from a call's budget for the reads after its action. */
const FOLLOW_UP_MS = 5_000;
const OBSERVE_TEXT_CHARS = 200_000;
/** The longest an action's answer waits for a navigation the page asked for to show its next page. */
const NAVIGATION_FOLLOW_MS = 10_000;
const OBSERVE_PAGE = `({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, ${OBSERVE_TEXT_CHARS}) })`;
const ELEMENT_TEXT = "function () { return String(this.innerText ?? this.textContent ?? this.value ?? ''); }";

export const SECRET_ON_PAGE_EVAL = "A saved password was just filled on this page, so agent_browser_eval is refused here for now. Submit the form or open another page first; to read this page, use agent_browser_snapshot or agent_browser_read.";

export interface BrowserStatus {
  tab: string | null;
  url: string | null;
  title: string;
  loading: boolean;
  tabs: Array<{ tab: string; url: string; title: string; active: boolean; openedBy?: string }>;
  heldByPerson: boolean;
  dialog: { type: string; message: string; defaultPrompt?: string } | null;
  fileChooser: { multiple: boolean } | null;
  signInPrompt: { origin: string; realm: string } | null;
  downloads: Array<{ fileName: string; path: string | null; sizeBytes: number; url: string; state: string }>;
}

export interface ToolContext {
  readonly control: ProfileControl;
  readonly tabs: TabRegistry;
  readonly browser: CdpBrowser;
  readonly deadline: number;
  active(): Tab | null;
  openTab(url?: string): Promise<Tab>;
  closeTab(tab: Tab): Promise<void>;
  closeBrowser(): Promise<void>;
  pointer(tab: Tab): PointerReporter | undefined;
  /** Viewers' screencasts stop while a scaled capture renders, or they would show it. */
  paused<T>(tab: Tab, work: () => Promise<T>): Promise<T>;
  health(tab: Tab): string | null;
  secretOnPage(tab: Tab): Promise<boolean>;
  saveScreenshot(data: Buffer, pageUrl: string): string;
  downloads(): Download[];
}

/** A typed address with its scheme: a bare host means https, loopback http. */
const withScheme = (text: string) => /^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : `${/^(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/iu.test(text) ? "http" : "https"}://${text}`;

/** What a bot passed as an address. */
export function agentUrl(raw: string): string {
  const text = raw.trim();
  if (text === "about:blank" || /^data:/iu.test(text)) return text;
  let url: URL;
  try { url = new URL(withScheme(text)); } catch { throw new DriverError("refused", `${text.slice(0, 200)} is not an address the browser can open.`); }
  if (!navigable(url.href)) throw new DriverError("refused", `Only http(s), about:blank and data: addresses open here, not ${url.protocol}.`);
  return url.href;
}

/** An address a person typed in the panel: http(s) only, never credentials, and null rather than an error. */
export function personUrl(raw: string): string | null {
  const text = raw.trim().slice(0, 8_192);
  if (!text || [...text].some((char) => char <= " " || char === "\u007f" || char === "\\")) return null;
  try {
    const url = new URL(withScheme(text));
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function remaining(context: ToolContext, preferred = DEFAULT_ACTION_MS): number {
  return Math.max(1_000, Math.min(preferred, context.deadline - Date.now() - FOLLOW_UP_MS));
}

function tabOf(context: ToolContext, id: string | undefined): Tab {
  if (id) {
    const tab = context.tabs.get(id);
    if (!tab) throw new DriverError("not-found", `There is no tab ${id}. agent_browser_tabs lists the open ones.`);
    return tab;
  }
  const active = context.active();
  if (!active) throw new DriverError("not-found", "No tab is open. Call agent_browser_open.");
  return active;
}

async function observe(tab: Tab): Promise<PageState | null> {
  try {
    const value = await valueInWorld<PageState>(tab.page.frames, tab.page.frames.mainFrameId, OBSERVE_PAGE);
    return value && typeof value.url === "string" ? value : null;
  } catch {
    return null;
  }
}

function describe(tab: Tab): { url: string; title: string; tab: string } {
  return { url: tab.page.url(), title: tab.page.title(), tab: tab.id };
}

/** A tab's state for agent_browser_status, the title left out while a dialog is open, as T3 Code does. */
export function statusOf(context: Pick<ToolContext, "tabs" | "control" | "active" | "downloads">, tab: Tab | null = null): BrowserStatus {
  const front = context.active();
  const active = tab ?? front;
  const dialog = active?.page.dialogs.pending ?? null;
  const chooser = active?.page.fileChoosers.open ?? null;
  const auth = active?.page.auth.pending ?? null;
  return {
    tab: active?.id ?? null,
    url: active && active.page.url() !== "about:blank" ? sanitizeUrl(active.page.url()) || active.page.url() : null,
    title: dialog ? "" : active?.page.title() ?? "",
    loading: active ? !active.page.lifecycle.reached("load") : false,
    tabs: context.tabs.list().map((listed) => ({
      tab: listed.id, url: sanitizeUrl(listed.page.url()) || listed.page.url(), title: listed.page.title(), active: listed === front,
      ...(listed.openerTabId ? { openedBy: listed.openerTabId } : {}),
    })),
    heldByPerson: context.control.owner !== null,
    dialog: dialog ? { type: dialog.type, message: dialog.message, ...(dialog.type === "prompt" ? { defaultPrompt: dialog.defaultPrompt } : {}) } : null,
    fileChooser: chooser ? { multiple: chooser.multiple } : null,
    signInPrompt: auth ? { origin: auth.origin, realm: auth.realm } : null,
    downloads: context.downloads().filter((download) => download.state !== "inProgress").slice(-20).map((download) => ({
      fileName: download.fileName, path: download.path, sizeBytes: download.receivedBytes, url: sanitizeUrl(download.url), state: download.state,
    })),
  };
}

function signInWait(tab: Tab, url: string, prompt: { origin: string; realm: string }): string {
  return `${tab.id} is waiting at ${sanitizeUrl(url) || url}: the site asks for a user name and password (HTTP sign-in for ${prompt.origin}${prompt.realm ? `, "${prompt.realm.slice(0, 100)}"` : ""}). The person watching this browser can answer it, and the page loads once they do; agent_browser_status shows the prompt until then. Do not try to answer it yourself.`;
}

/** A dialog the action opened ends its answer: nothing else runs on the tab until it is answered. */
function dialogNote(tab: Tab): string | null {
  const dialog = tab.page.dialogs.pending;
  return dialog ? `The page opened a ${dialog.type} dialog: ${JSON.stringify(dialog.message.slice(0, 300))}. Answer it with agent_browser_dialog before anything else on ${tab.id}.` : null;
}

const POPUP_WAIT_MS = 2_000;

/** A tab the action made the page open, such as a sign-in popup: it is set up, then named. */
async function openedNote(context: ToolContext, tab: Tab, known: ReadonlySet<string>): Promise<string | null> {
  for (const page of context.browser.settingUp()) {
    if (page.openerId === tab.page.targetId) await context.browser.waitForPage((candidate) => candidate === page, POPUP_WAIT_MS).catch(() => undefined);
  }
  const opened = context.tabs.list().filter((candidate) => !known.has(candidate.id) && candidate.openerTabId === tab.id);
  if (!opened.length) return null;
  await context.browser.refreshTargets().catch(() => undefined);
  const front = context.active();
  return opened.map((candidate) => `The page opened a new tab ${candidate.id} at ${sanitizeUrl(candidate.page.url()) || candidate.page.url()}${candidate === front ? ", now in front" : ""}; take a snapshot to act on it.`).join(" ");
}

/** Runs `run` as bot work on `tab` (or the whole browser), with what the page did and reported after it. */
async function act(context: ToolContext, tab: Tab | null, run: () => Promise<ToolResult>, { observeChange = false } = {}): Promise<ToolResult> {
  return context.control.agent(tab, async () => {
    const known = new Set(context.tabs.list().map((candidate) => candidate.id));
    const before = observeChange && tab ? await observe(tab) : null;
    const mark = before && tab ? tab.page.navigations.mark() : null;
    const result = await run();
    if (!tab || result.isError) return result;
    // An open dialog blocks the page's scripts, so the page is read again only once it is answered.
    if (mark && !tab.page.dialogs.pending) await tab.page.navigations.follow(mark, Math.min(NAVIGATION_FOLLOW_MS, remaining(context)));
    const after = before && !tab.page.dialogs.pending ? await observe(tab) : null;
    const opened = observeChange ? await openedNote(context, tab, known) : null;
    return withParts(result, before && after ? describePageChange(before, after) : null, opened, dialogNote(tab), context.health(tab));
  });
}

/** How a picture's pixels map to the CSS pixels the point tools take, so a point read off it lands where it was seen. */
export function pictureNote(shot: Pick<Screenshot, "width" | "height" | "scale" | "region">, of: "viewport" | "page" | "element" = "viewport"): string {
  const pixels = `${shot.width}x${shot.height} pixels`;
  const region = `${Math.round(shot.region.width)}x${Math.round(shot.region.height)} CSS-pixel`;
  if (of !== "viewport") return `${pixels}: the ${region} ${of === "page" ? "page" : "element"}${shot.scale === 1 ? "" : ` drawn at ${shot.scale}`}.`;
  return shot.scale === 1
    ? `${pixels}, one per CSS pixel of the viewport, so x and y read off it are the point the click, hover and drag tools take.`
    : `${pixels}: the ${region} viewport drawn at ${shot.scale}, so divide x and y read off it by ${shot.scale} for the point the click, hover and drag tools take.`;
}

async function snapshotResult(context: ToolContext, tab: Tab, { includeImage = false, save = false }: { includeImage?: boolean; save?: boolean } = {}): Promise<ToolResult> {
  const snapshot = await tab.page.snapshot();
  await context.browser.refreshTargets().catch(() => undefined);
  const text = snapshotText({ ...describe(tab), tree: snapshot.tree, truncated: snapshot.truncated, frames: snapshot.frames, health: context.health(tab) });
  if (!includeImage && !save) return textResult(text);
  const shot = await context.paused(tab, () => tab.page.screenshot());
  const saved = save ? context.saveScreenshot(shot.data, tab.page.url()) : null;
  const shown = includeImage || !save;
  return {
    content: [
      { type: "text", text: `${text}${saved ? `\nScreenshot saved at ${saved}` : ""}${shown ? `\nThe screenshot is ${pictureNote(shot)}` : ""}` },
      ...(shown ? [{ type: "image" as const, data: shot.data.toString("base64"), mimeType: "image/png" }] : []),
    ],
  };
}

async function readText(tab: Tab, input: ToolInput<"agent_browser_read">): Promise<string> {
  const limit = Math.min(input.maxChars ?? MAX_VISIBLE_TEXT_LENGTH, 40_000);
  const offset = input.offset ?? 0;
  let text: string;
  if (input.ref !== undefined || input.selector !== undefined) {
    const handle = await resolveElement(tab.page.frames, tab.page.refs, input.ref !== undefined ? { ref: input.ref } : { selector: input.selector! });
    text = await callOnNode<string>(tab.page.frames, handle, ELEMENT_TEXT);
  } else {
    text = await tab.page.visibleText(offset + limit);
  }
  const part = text.slice(offset, offset + limit);
  const more = text.length > offset + limit || (input.ref === undefined && input.selector === undefined && part.length === limit);
  return `${part}${more ? `\n… (more text: call again with offset ${offset + part.length})` : ""}`;
}

function element(input: { ref?: string; selector?: string; x?: number; y?: number }, point = true) {
  const target = targetOf(input, { point });
  if (typeof target === "string") throw new DriverError("invalid-selector", target);
  return target;
}

export async function executeTool(context: ToolContext, call: ToolCall): Promise<ToolResult> {
  switch (call.name) {
    case "agent_browser_status": {
      const tab = call.input.tab ? tabOf(context, call.input.tab) : null;
      return context.control.agent(tab, async () => {
        await context.browser.refreshTargets().catch(() => undefined);
        const status = statusOf(context, tab);
        if (call.as === "url") return textResult(status.url ?? "about:blank");
        if (call.as === "title") return textResult(status.title);
        return textResult(JSON.stringify(status));
      });
    }
    case "agent_browser_open": {
      const { url, tab: which } = call.input;
      const address = url !== undefined && url.trim() !== "" ? agentUrl(url) : null;
      const existing = which === "new" ? null : which ? tabOf(context, which) : context.active();
      const tab = existing ?? await context.control.agent(null, () => context.openTab());
      return context.control.agent(tab, async () => {
        await tab.page.bringToFront();
        const opened = address ? await tab.page.navigate(address, { readiness: "load", timeoutMs: remaining(context) }) : null;
        if (opened?.signInPrompt) return textResult(signInWait(tab, opened.url, opened.signInPrompt));
        const lead = opened
          ? `Opened ${sanitizeUrl(opened.url) || opened.url} in ${tab.id}${opened.status && opened.status >= 400 ? `; the site answered HTTP ${opened.status}` : ""}.`
          : `${tab.id} is open at ${sanitizeUrl(tab.page.url()) || tab.page.url()}.`;
        const snapshot = await snapshotResult(context, tab);
        return withParts(textResult(lead, "Page observed after navigation. Its refs are current, so act on them without another snapshot. Check this result for redirects, sign-in requirements or page errors before reporting task success:"), ...snapshot.content.map((part) => (part.type === "text" ? part.text : null)), dialogNote(tab));
      });
    }
    case "agent_browser_navigate": {
      const tab = tabOf(context, call.input.tab);
      const { url, action, readiness = "load" } = call.input;
      if ((url === undefined) === (action === undefined)) return errorResult("Pass url or action (back, forward or reload), not both.");
      return act(context, tab, async () => {
        const options = { readiness, timeoutMs: remaining(context) };
        const result = url !== undefined
          ? await tab.page.navigate(agentUrl(url), options)
          : action === "back" ? await tab.page.back(options) : action === "forward" ? await tab.page.forward(options) : await tab.page.reload(options);
        if (result.signInPrompt) return textResult(signInWait(tab, result.url, result.signInPrompt));
        return textResult(`${tab.id} is now at ${sanitizeUrl(result.url) || result.url}${result.status && result.status >= 400 ? ` (HTTP ${result.status})` : ""}. Refs from earlier snapshots do not apply to it; take a snapshot before acting on refs.`);
      });
    }
    case "agent_browser_snapshot": {
      const tab = tabOf(context, call.input.tab);
      return context.control.agent(tab, async () => {
        await tab.page.bringToFront();
        return withParts(await snapshotResult(context, tab, call.input), dialogNote(tab));
      });
    }
    case "agent_browser_read": {
      const tab = tabOf(context, call.input.tab);
      return act(context, tab, async () => {
        await tab.page.bringToFront();
        if (call.input.url !== undefined && call.input.url.trim() !== "") await tab.page.navigate(agentUrl(call.input.url), { readiness: "load", timeoutMs: remaining(context) });
        return textResult(`${pageLabel(describe(tab))}\n${await readText(tab, call.input)}`);
      });
    }
    case "agent_browser_screenshot": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) : undefined;
      return act(context, tab, async () => {
        await tab.page.bringToFront();
        const shot = await context.paused(tab, () => tab.page.screenshot({ fullPage: call.input.fullPage === true, ...(target && !("x" in target) ? { target } : {}) }));
        const note = pictureNote(shot, target ? "element" : call.input.fullPage === true ? "page" : "viewport");
        return { content: [{ type: "text", text: `Screenshot of ${pageLabel(describe(tab))}, ${note}` }, { type: "image", data: shot.data.toString("base64"), mimeType: "image/png" }] };
      });
    }
    case "agent_browser_click": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input);
      return act(context, tab, async () => {
        const clicked = await tab.page.click(target, { button: call.input.button ?? "left", clickCount: call.input.clickCount ?? 1, timeoutMs: remaining(context), pointer: context.pointer(tab) });
        return textResult(`Clicked ${"ref" in target ? target.ref : "selector" in target ? JSON.stringify(target.selector) : `${Math.round(clicked.x)},${Math.round(clicked.y)}`}${clicked.dialog ? "; it opened a dialog" : ""}.`);
      }, { observeChange: true });
    }
    case "agent_browser_fill": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input, false) as { ref: string } | { selector: string };
      return act(context, tab, async () => {
        await tab.page.fill(target, call.input.text);
        if (call.input.submit) await tab.page.press("Enter");
        return textResult(`Filled the field${call.input.submit ? " and pressed Enter" : ""}.`);
      }, { observeChange: true });
    }
    case "agent_browser_type": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) as { ref: string } | { selector: string } : null;
      return act(context, tab, async () => {
        if (call.input.clear && target) await tab.page.fill(target, "");
        await tab.page.type(target, call.input.text);
        return textResult(`Typed ${[...call.input.text].length} characters.`);
      }, { observeChange: true });
    }
    case "agent_browser_press": {
      const tab = tabOf(context, call.input.tab);
      const chord = [...(call.input.modifiers ?? []), call.input.key].join("+");
      return act(context, tab, async () => {
        const pressed = await tab.page.press(chord);
        return textResult(`Pressed ${chord}${pressed.dialog ? "; it opened a dialog" : ""}.`);
      }, { observeChange: true });
    }
    case "agent_browser_select": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input, false) as { ref: string } | { selector: string };
      return act(context, tab, async () => {
        const { selected } = await tab.page.select(target, call.input.values);
        return textResult(`Selected ${selected.map((value) => JSON.stringify(value)).join(", ") || "nothing"}.`);
      }, { observeChange: true });
    }
    case "agent_browser_check": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input, false) as { ref: string } | { selector: string };
      const checked = call.input.checked ?? true;
      return act(context, tab, async () => {
        const result = await tab.page.check(target, checked, { timeoutMs: remaining(context) });
        return textResult(`${result.changed ? (checked ? "Checked" : "Unchecked") : `Already ${checked ? "checked" : "unchecked"}`}.`);
      }, { observeChange: true });
    }
    case "agent_browser_hover": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input);
      return act(context, tab, async () => {
        const point = await tab.page.hover(target, { timeoutMs: remaining(context), pointer: context.pointer(tab) });
        return textResult(`The mouse is over ${Math.round(point.x)},${Math.round(point.y)}.`);
      }, { observeChange: true });
    }
    case "agent_browser_drag": {
      const tab = tabOf(context, call.input.tab);
      const from = element(call.input.from);
      const to = element(call.input.to);
      return act(context, tab, async () => {
        const dragged = await tab.page.drag(from, to, { timeoutMs: remaining(context), pointer: context.pointer(tab) });
        return textResult(`Dragged from ${Math.round(dragged.from.x)},${Math.round(dragged.from.y)} to ${Math.round(dragged.to.x)},${Math.round(dragged.to.y)}${dragged.dropped === "html5" ? " (a drag-and-drop)" : ""}.`);
      }, { observeChange: true });
    }
    case "agent_browser_scroll": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) : null;
      const dx = call.input.dx ?? 0;
      const dy = call.input.dy ?? (call.input.dx === undefined ? 600 : 0);
      return act(context, tab, async () => {
        await tab.page.scroll(target, dx, dy, { timeoutMs: remaining(context) });
        const position = await valueInWorld<[number, number, number]>(tab.page.frames, tab.page.frames.mainFrameId, "[Math.round(scrollX), Math.round(scrollY), Math.round(document.documentElement.scrollHeight)]").catch(() => null);
        return textResult(`Scrolled by ${dx},${dy}.${position ? ` The page is at ${position[0]},${position[1]} of ${position[2]} pixels high.` : ""}`);
      });
    }
    case "agent_browser_upload": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) as { ref: string } | { selector: string } : undefined;
      return act(context, tab, async () => {
        await tab.page.upload(call.input.files, target);
        return textResult(`Put ${call.input.files.length} file${call.input.files.length === 1 ? "" : "s"} into the page. Submit its form as usual.`);
      }, { observeChange: true });
    }
    case "agent_browser_wait": {
      const tab = tabOf(context, call.input.tab);
      const { ms, text, ref, selector, gone, urlIncludes, load, timeoutMs } = call.input;
      return act(context, tab, async () => {
        await tab.page.waitFor({
          ...(ms !== undefined ? { ms } : {}), ...(text !== undefined ? { text } : {}),
          ...(ref !== undefined || selector !== undefined ? { target: { ...(ref !== undefined ? { ref } : {}), ...(selector !== undefined ? { selector } : {}) }, gone: gone === true } : {}),
          ...(urlIncludes !== undefined ? { urlIncludes } : {}), ...(load !== undefined ? { load } : {}),
          timeoutMs: Math.min(timeoutMs ?? DEFAULT_ACTION_MS, Math.max(0, context.deadline - Date.now() - FOLLOW_UP_MS)),
        });
        return textResult(`Done waiting; ${pageLabel(describe(tab))}.`);
      });
    }
    case "agent_browser_eval": {
      const tab = tabOf(context, call.input.tab);
      return act(context, tab, async () => {
        if (await context.secretOnPage(tab)) return errorResult(SECRET_ON_PAGE_EVAL);
        const value = await tab.page.evaluate(call.input.expression, { world: call.input.world ?? "isolated", timeoutMs: remaining(context) });
        return textResult(value === undefined ? "undefined" : JSON.stringify(value));
      });
    }
    case "agent_browser_dialog": {
      const tab = tabOf(context, call.input.tab);
      if (context.control.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      const answered = await tab.page.answerDialog({ accept: call.input.accept, ...(call.input.promptText === undefined ? {} : { promptText: call.input.promptText }) });
      return textResult(`${call.input.accept ? "Accepted" : "Dismissed"} the ${answered.type} dialog.`);
    }
    case "agent_browser_tabs": {
      const { action, url, tab: which } = call.input;
      if (action === "list") {
        return context.control.agent(null, async () => {
          await context.browser.refreshTargets().catch(() => undefined);
          return textResult(JSON.stringify(statusOf(context).tabs));
        });
      }
      if (action === "new") {
        const address = url !== undefined && url.trim() !== "" ? agentUrl(url) : null;
        const tab = await context.control.agent(null, () => context.openTab());
        return act(context, tab, async () => {
          await tab.page.bringToFront();
          if (address) await tab.page.navigate(address, { readiness: "load", timeoutMs: remaining(context) });
          return textResult(`Opened ${tab.id} at ${sanitizeUrl(tab.page.url()) || tab.page.url()}. It is in front; take a snapshot to act on it.`);
        });
      }
      if (!which) return errorResult(`Pass tab for ${action}.`);
      const tab = tabOf(context, which);
      if (action === "close") return context.control.agent(null, async () => { await context.closeTab(tab); return textResult(`Closed ${tab.id}.`); });
      return context.control.agent(tab, async () => {
        await tab.page.bringToFront();
        return textResult(`${tab.id} is in front: ${pageLabel(describe(tab))}. Take a snapshot to act on it.`);
      });
    }
    case "agent_browser_close": {
      if (call.input.tab) {
        const tab = tabOf(context, call.input.tab);
        return context.control.agent(null, async () => { await context.closeTab(tab); return textResult(`Closed ${tab.id}.`); });
      }
      return context.control.agent(null, async () => { await context.closeBrowser(); return textResult("Closed the browser. Saved sign-ins are kept; agent_browser_open starts it again."); });
    }
    case "restart_browser":
      return errorResult("restart_browser is handled before a call reaches its tab.");
  }
}

/** A tool's failure as the bot reads it; null for one the service must handle itself. */
export function toolFailure(error: unknown): ToolResult | null {
  if (isUnanswered(error)) return null;
  if (error instanceof Error && error.message === BROWSER_CONTROL_REFUSAL) return null;
  if (error instanceof DriverError) return errorResult(error.message);
  if (error instanceof BrowserControlInterrupted) return errorResult(error.message);
  return errorResult(error instanceof Error ? error.message : String(error));
}
