// @vitest-environment happy-dom
// The board: a column per status, cards that open the task, and moves by drag and drop or by the card's menu. A move into
// a status that needs proof asks for it first, and a refusal from the server stays visible while the card stays put.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTaskStatus, BotTaskSummary } from "../../../shared/bot-tasks";
import { botTasksStatus } from "@/lib/bot-tasks";
import { setLocale } from "@/lib/i18n";
import { BotTaskBoard } from "./BotTaskBoard";
import { BotTasksView } from "./BotTasksPage";

const card = (id: string, title: string, status: BotTaskStatus, over: Partial<BotTaskSummary> = {}): BotTaskSummary => ({
  id, title, status, ownerBotId: "b1", ownerName: "Lin", createdBy: { kind: "system" }, createdAt: 1, updatedAt: Date.now() - 60_000, activityCount: 1, ...over,
} as BotTaskSummary);

const tasks = [
  card("t1", "Fix login", "open", { github: { repo: "acme/gadgets", number: 12, kind: "pull" } }),
  card("t2", "Ship notes", "done", { evidenceCount: 2, evidenceStatus: "verified" }),
  card("t3", "Old idea", "cancelled"),
];
const base = botTasksStatus({ botTasks: { ...botTasksStatus(null), enabled: true } });

let host: HTMLDivElement;
let root: Root;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
let reply: () => Response | Promise<Response>;
const changed = vi.fn();
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const render = (settings = base, list = tasks) => flushSync(() => root.render(createElement(BotTaskBoard, { tasks: list, settings, bots: [], onOpen: vi.fn(), onChanged: changed })));
const column = (status: string) => host.querySelector<HTMLElement>(`[data-bot-column="${status}"]`)!;
const cardOf = (id: string) => host.querySelector<HTMLElement>(`[data-bot-task-card="${id}"]`)!;
const fire = (element: Element, type: string) => flushSync(() => { element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); });
const drag = (id: string, to: string) => { fire(cardOf(id), "dragstart"); fire(column(to), "dragover"); fire(column(to), "drop"); };

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sent = [];
  changed.mockClear();
  reply = () => json({ ok: true, task: {} });
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    sent.push({ path: String(input), body: init.body ? JSON.parse(String(init.body)) : {} });
    return Promise.resolve(reply());
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the board", () => {
  it("has a column for every status with its count, and the cancelled one folded", () => {
    render();
    expect([...host.querySelectorAll("[data-bot-column]")].map((one) => (one as HTMLElement).dataset.botColumn)).toEqual(["open", "in_progress", "blocked", "review", "done", "cancelled"]);
    expect([...host.querySelectorAll("[data-bot-column-count]")].map((one) => one.textContent)).toEqual(["1", "0", "0", "0", "1", "1"]);
    expect(cardOf("t3"), "cancelled starts folded").toBeNull();
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-bot-column-toggle="cancelled"]')!.click());
    expect(cardOf("t3")).not.toBeNull();
  });

  it("shows the title, owner, GitHub reference, proof and age on a card", () => {
    render();
    expect(cardOf("t1").textContent).toContain("Fix login");
    expect(cardOf("t1").textContent).toContain("Lin");
    expect(cardOf("t1").querySelector("[data-bot-task-ref]")?.textContent).toBe("gadgets#12");
    expect(cardOf("t1").querySelector("[data-bot-task-proof-summary]"), "no proof, no proof line").toBeNull();
    expect(cardOf("t2").querySelector("[data-bot-task-proof-summary]")?.textContent).toContain("Proof: 2");
    expect(cardOf("t2").querySelector("[data-verification-badge]")?.getAttribute("data-verification-badge")).toBe("verified");
    expect(cardOf("t1").querySelector("time")).not.toBeNull();
  });

  it("moves a card by drag and drop where no proof is needed, and reloads", async () => {
    render();
    drag("t1", "in_progress");
    await settle();
    expect(sent).toEqual([{ path: "/api/bot-tasks/t1", body: { status: "in_progress" } }]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does nothing when a card is dropped on its own column", async () => {
    render();
    drag("t1", "open");
    await settle();
    expect(sent).toEqual([]);
  });

  it("asks for proof before a card moves to done, and moves it with the proof", async () => {
    render();
    drag("t1", "done");
    await settle();
    expect(sent, "nothing is sent before the proof").toEqual([]);
    const dialog = document.querySelector<HTMLElement>("[data-bot-task-proof]")!;
    expect(dialog.getAttribute("data-bot-task-proof")).toBe("t1");
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button[type=submit]")][0]!;
    expect(submit.disabled, "an empty form cannot be sent").toBe(true);
    const field = dialog.querySelector<HTMLInputElement>("[data-bot-task-proof-value]")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => { set.call(field, "abcdef1"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    flushSync(() => submit.click());
    await settle();
    expect(sent).toEqual([{ path: "/api/bot-tasks/t1", body: { status: "done", evidence: [{ kind: "commit", sha: "abcdef1" }] } }]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-bot-task-proof]"), "the dialog closes once the task moved").toBeNull();
  });

  it("keeps the dialog open with the server's reason when the proof is refused", async () => {
    reply = () => json({ error: "Blocked: commit abcdef1 not found in o/r" }, 422);
    render();
    drag("t1", "done");
    const dialog = document.querySelector<HTMLElement>("[data-bot-task-proof]")!;
    const field = dialog.querySelector<HTMLInputElement>("[data-bot-task-proof-value]")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => { set.call(field, "abcdef1"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    flushSync(() => dialog.querySelector<HTMLButtonElement>("button[type=submit]")!.click());
    await settle();
    expect(document.querySelector("[data-bot-task-proof-error]")?.textContent).toBe("Blocked: commit abcdef1 not found in o/r");
    expect(changed, "a refused move reloads nothing").not.toHaveBeenCalled();
    expect(document.querySelector("[data-bot-task-proof]")).not.toBeNull();
  });

  it("moves to done without a dialog when the rule is off, and to review only when its rule is on", async () => {
    render({ ...base, requireEvidenceForDone: false });
    drag("t1", "done");
    await settle();
    expect(sent).toEqual([{ path: "/api/bot-tasks/t1", body: { status: "done" } }]);
    sent.length = 0;
    render({ ...base, requireEvidenceForReview: true });
    drag("t1", "review");
    await settle();
    expect(sent).toEqual([]);
    expect(document.querySelector("[data-bot-task-proof]")).not.toBeNull();
  });

  it("shows why a plain move was refused and leaves the card where it is", async () => {
    reply = () => json({ error: "The task is already blocked." }, 409);
    render();
    drag("t1", "blocked");
    await settle();
    expect(host.querySelector("[data-bot-board-error]")?.textContent).toBe("The task is already blocked.");
    expect(changed).not.toHaveBeenCalled();
    expect(column("open").contains(cardOf("t1"))).toBe(true);
  });

  it("moves a card from its menu, the way a keyboard does, with the same proof rule", async () => {
    render();
    const menuButton = cardOf("t1").querySelector<HTMLButtonElement>("button[aria-haspopup]")!;
    expect(menuButton.getAttribute("aria-label") ?? menuButton.title).toContain("Fix login");
    flushSync(() => menuButton.click());
    await settle();
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((one) => one.textContent?.replace(/Needs proof/, "").trim())).toEqual(["In progress", "Blocked", "In review", "Done", "Cancelled"]);
    expect(items.find((one) => one.textContent?.startsWith("Done"))?.textContent).toContain("Needs proof");
    flushSync(() => items.find((one) => one.textContent?.startsWith("Blocked"))!.click());
    await settle();
    expect(sent).toEqual([{ path: "/api/bot-tasks/t1", body: { status: "blocked" } }]);
  });
});

describe("the page's view toggle", () => {
  const view = () => flushSync(() => root.render(createElement(BotTasksView, { settings: base, bots: [], onOpenSettings: () => {}, openId: null, onOpen: () => {} })));
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve(json({ enabled: true, tasks })));
  });

  it("opens on the board, switches to the list and remembers it", async () => {
    view();
    await settle();
    expect(host.querySelector("[data-bot-board]")).not.toBeNull();
    expect(host.querySelector("[data-bot-task-row]")).toBeNull();
    const list = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((one) => one.textContent === "List")!;
    flushSync(() => list.click());
    expect(host.querySelector("[data-bot-board]")).toBeNull();
    expect(host.querySelectorAll("[data-bot-task-row]")).toHaveLength(3);
    expect(localStorage.getItem("omb.botTasks.view")).toBe("list");
    flushSync(() => root.unmount());
    root = createRoot(host);
    view();
    await settle();
    expect(host.querySelectorAll("[data-bot-task-row]"), "the choice is kept").toHaveLength(3);
  });

  it("narrows the board with the same filters as the list", async () => {
    view();
    await settle();
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => { set.call(search, "login"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect([...host.querySelectorAll("[data-bot-column-count]")].map((one) => one.textContent)).toEqual(["1", "0", "0", "0", "0", "0"]);
  });
});
