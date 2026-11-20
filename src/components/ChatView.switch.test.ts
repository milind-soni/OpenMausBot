// @vitest-environment happy-dom
// The real provider, two long chats: switching between them draws the newest rows first and mounts no hover-only part.
import { commitMark, commitsSince, countBy, renderMark, renderedSince } from "@/testing/render-counts";
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MESSAGE_ROW } from "./MessageActions";
import type { BotAnnouncement, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
// The frame after the click's paint, run by the test: rows queued for it are drawn exactly when `paint()` says.
const painted = vi.hoisted(() => [] as (() => void)[]);
vi.mock("@/lib/after-paint", () => ({ afterPaint: (callback: () => void) => {
  painted.push(callback);
  return () => {
    const at = painted.indexOf(callback);
    if (at >= 0) painted.splice(at, 1);
  };
} }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: vi.fn() }));

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const announced = (id: string, name: string): BotAnnouncement => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Chat", createdAt: 1, approvalMode: "ask" },
    { threadId: `${id}-fork`, title: "Fork", createdAt: 2, approvalMode: "ask", origin: { threadId: `${id}-thread`, messageId: `${id}-answer-22` } }],
});

const start = Date.UTC(2026, 10, 1, 9);
/** 120 rows: asks, answers with a link and a list, folded tool steps and work summaries. */
function transcript(bot: string): Message[] {
  const rows: Message[] = [];
  for (let turn = 0; rows.length < 120; turn++) {
    const at = start + turn * 600_000, turnId = `${bot}-turn-${turn}`;
    rows.push({ id: `${bot}-ask-${turn}`, role: "user", kind: "text", at, text: `Question ${turn}: what is slow?` });
    rows.push({ id: `${bot}-step-${turn}a`, role: "bot", kind: "activity", at: at + 2_000, tool: { name: "Bash", ok: true }, turnId });
    rows.push({ id: `${bot}-step-${turn}b`, role: "bot", kind: "activity", at: at + 3_000, tool: { name: "Read", ok: true }, turnId });
    rows.push({ id: `${bot}-answer-${turn}`, role: "bot", kind: "text", at: at + 9_000, turnId, turnTerminal: true,
      text: `## Step ${turn}\n\nThe **merge** re-sorts on every call; see [the notes](https://example.com/${bot}/${turn}).\n\n- first point\n- second point` });
    rows.push({ id: `${bot}-digest-${turn}`, role: "bot", kind: "digest", at: at + 9_500, text: "", digest: {
      turnId, botId: bot, threadId: `${bot}-thread`, at: at + 9_500, durationMs: 9_000, tools: [{ name: "Bash", count: 1, failed: 0 }, { name: "Read", count: 1, failed: 0 }],
      memory: [], reply: "", hookCoverage: "preview",
    } } as Message);
  }
  return rows;
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, models: { options: [{ id: "m", label: "Model" }] } } as unknown as InstanceInfo] },
  "/api/config": { features: { showToolCalls: true } },
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};

const { StoreProvider, useStore } = await import("@/state/store");
const { useStoreSelector } = await import("@/state/store-select");
const { ChatView } = await import("./ChatView");

let dispatch!: ReturnType<typeof useStore>["dispatch"];
function Shown() {
  dispatch = useStore().dispatch;
  return null;
}
function Shell() {
  const bot = useStoreSelector((state) => state.bots.find((candidate) => candidate.id === state.selectedId));
  return bot ? createElement(ChatView, { bot }) : null;
}

let root: Root;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await task(); };
const frames = async () => { for (let i = 0; i < 4; i++) { await new Promise((resolve) => requestAnimationFrame(resolve)); await settle(); } };
const stream = () => FixtureEventSource.opened[0]!;
const rows = () => document.querySelectorAll('[role="log"] [data-mid]');
/** The paint happened: what waited for it runs, and act draws the transition it starts before returning. */
async function paint() {
  const flag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  flag.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { for (const run of painted.splice(0)) run(); });
  } finally {
    flag.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

/** No layout here: the scroller reads as a 900px view over rows 120px tall each. */
function layout() {
  const scroller = (el: Element) => el.classList.contains("glass-scroller");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return scroller(this) ? 900 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return scroller(this) ? 120 * this.querySelectorAll("[data-mid]").length : 0; } });
}

/** A click on a bot in the sidebar: what its commit draws, then everything until the chat is quiet again. */
async function switchTo(id: string) {
  const mark = renderMark(), commits = commitMark();
  flushSync(() => dispatch({ type: "select", id }));
  const first = { mounted: renderedSince(mark).filter((entry) => entry.mounted).length, rows: rows().length, ids: [...rows()].map((row) => row.getAttribute("data-mid")) };
  await paint();
  await frames();
  const mounted = renderedSince(mark).filter((entry) => entry.mounted);
  const again = renderedSince(mark).filter((entry) => !entry.mounted && entry.row !== null);
  const chat = renderedSince(mark).filter((entry) => entry.component === "ChatView").length;
  return { first, mounted: mounted.length, again, chat, commits: commitsSince(commits), byName: countBy(mounted, (entry) => entry.component) };
}

const HOVER_ONLY = ["ReplyAction", "CopyButton", "ReactAction", "SpeakButton", "SmilePlus", "Reply", "Copy", "ReactionChips", "AttachmentGallery"];
const row = (id: string) => document.querySelector<HTMLElement>(`[data-mid="${id}"] [${MESSAGE_ROW}]`)!;
const tray = (id: string) => row(id).querySelector<HTMLElement>('[data-testid="message-actions"]')!;
const more = (id: string) => tray(id).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;

beforeAll(async () => {
  layout();
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => path.startsWith("/api/bots?")
    ? json({ bots: [{ ...announced("a", "Ada"), messages: transcript("a") }, { ...announced("b", "Bea"), messages: transcript("b") }], groups: [] })
    : json(answers[path.replace(/\?.*$/, "")] ?? {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Shown), createElement(Shell))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "select", id: "a" }));
  await frames();
  await switchTo("b");
  await switchTo("a");
});
afterAll(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("switching between two long chats", () => {
  it("draws the newest rows in the click's commit and the rest of the window after it", async () => {
    const { first, mounted, again, chat, commits } = await switchTo("b");
    expect(first.ids.at(-1)).toBe("b-digest-23");
    expect(first.rows).toBeGreaterThan(5);
    expect(first.rows).toBeLessThanOrEqual(14);
    expect(first.mounted, "components mounted before the first paint").toBeLessThanOrEqual(200);
    expect(rows().length).toBe(72);
    expect(rows()[0]!.getAttribute("data-mid")).toBe("b-ask-0");
    expect(mounted, "components mounted in all").toBeLessThanOrEqual(850);
    expect(countBy(again, (entry) => entry.component), "a row drawn twice").toEqual(new Map());
    expect(chat, "the chat drawn for the click and once for the rows above").toBe(2);
    expect(commits).toBeLessThanOrEqual(5);
  });

  it("mounts no part that only a hover, focus or right-click shows", async () => {
    const { byName } = await switchTo("a");
    for (const name of HOVER_ONLY) expect(byName.get(name) ?? 0, name).toBe(0);
    expect(byName.get("MessageActions")).toBe(48);
    expect(byName.get("ForkLinks"), "only the message a conversation was forked from").toBe(1);
    expect(document.querySelector('[data-mid="a-answer-22"] [data-testid="fork-links"]')?.textContent).toContain("Fork");
    expect(document.querySelectorAll('[data-testid="message-actions"] button[aria-label="Copy message"]')).toHaveLength(0);
  });

  it("mounts a message's buttons when the pointer comes over it", async () => {
    flushSync(() => row("a-answer-23").dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" })));
    expect(tray("a-answer-23").dataset.shown).toBe("true");
    expect([...tray("a-answer-23").querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
      .toEqual(["Reply to message", "Add reaction", "Copy message", "Message actions"]);
    expect(tray("a-answer-22").querySelectorAll("button")).toHaveLength(1);
  });

  it("hands Tab from above to the first button and Shift+Tab from below to the last", async () => {
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const above = row("a-ask-21").querySelector<HTMLElement>("button, a")!;
    above.focus();
    flushSync(() => more("a-answer-21").focus());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Reply to message");
    composer.focus();
    flushSync(() => more("a-answer-20").focus());
    expect(document.activeElement).toBe(more("a-answer-20"));
    expect(tray("a-answer-20").querySelectorAll("button")).toHaveLength(4);
  });

  it("opens the menu on a right-click before any hover", async () => {
    const bubble = row("a-answer-19").querySelector("[data-chat-bubble] p")!;
    flushSync(() => bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 })));
    expect([...document.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual(expect.arrayContaining(["Reply", "Copy message"]));
    flushSync(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  });

  it("draws the whole window at once for a jump to an older message", async () => {
    flushSync(() => dispatch({ type: "focusMessage", threadId: "b-thread", messageId: "b-answer-3" }));
    const { first } = await switchTo("b");
    expect(first.ids).toContain("b-answer-3");
  });
});
