// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { JobNodeRead } from "@/lib/bot-exchanges";
import type { LiveFrameListener } from "@/lib/live-events";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  load: vi.fn(),
  listeners: new Set<LiveFrameListener>(),
}));
const bot = (id: string, name: string, threadId: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId, name, title: "", description: "", notifications: true, color: "blue", unread: false, messages: [],
  modelSelection: { instanceId: "fake", model: "test" }, ...extra,
} as Bot);
const asked: Message = { id: "p1", role: "user", kind: "text", text: "Get the numbers", at: 5_000 };
const pepper = bot("pepper", "Pepper", "chat-1", { messages: [asked] });
const helper = bot("engineer", "Engineer", "engineer-main");
vi.mock("@/state/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/api")>(), api: fixture.api }));
vi.mock("@/state/store-select", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store-select")>(),
  useStoreSelector: (select: (state: unknown) => unknown) => select({ bots: [pepper, helper] }),
}));
vi.mock("@/state/message-history", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/message-history")>(), loadFullThread: fixture.load,
}));
vi.mock("@/lib/live-events", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/live-events")>(),
  listenLiveFrames: (listener: LiveFrameListener) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
}));
vi.mock("./Avatar", () => ({
  BotAvatar: ({ bot: shown }: { bot: Bot }) => createElement("span", { "data-avatar": shown.id }),
  InitialsAvatar: ({ initials }: { initials: string }) => createElement("span", { "data-avatar": initials }),
}));
import { ApiError } from "@/state/api";
import { BotExchangeLine } from "./BotExchangeLine";
import { HandoffExchangeHost } from "./HandoffExchange";

const root = (): JobNodeRead => ({ id: "root", botId: "pepper", botName: "Pepper", threadId: "chat-1", status: "running", reply: "required", createdAt: 5_100 });
const handoff = (extra: Partial<JobNodeRead> = {}): JobNodeRead => ({
  id: "h1", parentId: "root", botId: "engineer", botName: "Engineer", threadId: "work-1", status: "running", reply: "required",
  createdAt: 10_000, ...extra,
});
const job = (nodes: JobNodeRead[], version = "v1") => ({ since: 5_000, version, nodes, needsInput: [] });

/** The job the server answers, by request: `GET .../job…` reads it, `POST .../stop` answers with `stop`. */
let current = job([root(), handoff()]);
let stop: () => unknown = () => ({ ok: true, outcome: "stopped" });
const reads = () => fixture.api.mock.calls.filter(([path]) => String(path).includes("/job") && !String(path).endsWith("/stop"));
const stops = () => fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/stop"));

let host: HTMLDivElement;
let view: Root;

beforeEach(() => {
  setLocale("en");
  fixture.listeners.clear();
  fixture.load.mockReset();
  fixture.api.mockReset();
  current = job([root(), handoff()]);
  stop = () => ({ ok: true, outcome: "stopped" });
  fixture.api.mockImplementation(async (path: string, init?: { method?: string; signal?: AbortSignal }) => {
    if (path.endsWith("/stop")) return stop();
    // A held read is answered when the job changes; a test changes it and answers by rendering again.
    if (path.includes("wait=")) return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    return current;
  });
  if (typeof globalThis.ResizeObserver === "undefined") {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  }
  host = document.createElement("div");
  document.body.append(host);
  view = createRoot(host);
});

afterEach(() => {
  flushSync(() => view.unmount());
  document.body.replaceChildren();
});

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
};
const render = (shown: Bot = { ...pepper, busy: true }) => flushSync(() => view.render(createElement(HandoffExchangeHost, {
  bot: shown, children: createElement("main", { "data-chat": "" }, createElement(BotExchangeLine), createElement("textarea")),
})));
const line = () => host.querySelector<HTMLButtonElement>("[data-bot-exchange]");
const status = () => host.querySelector("[data-bot-exchange-status]");
const stopButton = () => host.querySelector<HTMLButtonElement>("[data-bot-exchange-stop]");

async function openExchange() {
  render();
  await settle();
  flushSync(() => line()!.click());
  await settle();
}

describe("the bot exchange line", () => {
  it("reads the job from the person's latest message and holds the next read while the bots work", async () => {
    render();
    await settle();
    expect(reads()[0]![0]).toBe("/api/threads/chat-1/job?since=5000");
    expect(reads()[1]![0]).toBe("/api/threads/chat-1/job?since=5000&wait=25000&version=v1");
    expect(line()!.textContent).toBe("PepperEngineer·working…");
    expect(line()!.getAttribute("aria-label")).toBe("Open the exchange between Pepper and Engineer · working…");
    expect(host.querySelector("[data-bot-exchange-line]")!.getAttribute("role")).toBe("status");
  });

  it.each([
    [{ status: "queued" }, "asking…"],
    [{ status: "needs_input" }, "needs you"],
    [{ status: "waiting" }, "working…"],
  ] as const)("shows %o as %s", async (record, text) => {
    current = job([root(), handoff(record)]);
    render();
    await settle();
    expect(line()!.textContent).toBe(`PepperEngineer·${text}`);
  });

  it("goes quiet once the bots are done: one read, nothing held, and no line left", async () => {
    current = job([{ ...root(), status: "completed" }, handoff({ status: "completed", finishedAt: 52_000 })]);
    render({ ...pepper, busy: false });
    await settle();
    expect(reads()).toHaveLength(1);
    expect(host.querySelector("[data-bot-exchange-line]")).toBeNull();
  });

  it.each([
    [{ status: "completed", finishedAt: 52_000 }],
    [{ status: "cancelled", outcome: "stopped", finishedAt: 22_000 }],
    [{ status: "failed", outcome: "expired", finishedAt: 70_000 }],
    [{ status: "failed", outcome: "error", finishedAt: 13_000 }],
  ] as const)("drops an exchange from the line once it ends (%o), keeping the open ones", async (record) => {
    current = job([root(), handoff({ id: "h0", createdAt: 9_000, ...record }), handoff()]);
    render();
    await settle();
    expect(Array.from(host.querySelectorAll("[data-bot-exchange]")).map((chip) => chip.getAttribute("data-bot-exchange"))).toEqual(["h1"]);
  });

  it("takes a chip off the line when its exchange ends, and the line with it once none is open", async () => {
    fixture.load.mockResolvedValue({ messages: [], activeLeafId: null });
    await openExchange();
    current = job([root(), handoff({ status: "cancelled", outcome: "stopped", finishedAt: 22_000 })], "v2");
    flushSync(() => stopButton()!.click());
    await settle();
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-exchange-back]")!.click());
    expect(host.querySelector("[data-bot-exchange-line]")).toBeNull();
  });

  it("keeps reading while a hand-off that waits for no answer runs after its asker went idle, and drops it when it ends", async () => {
    current = job([{ ...root(), status: "completed" }, handoff({ reply: "none" })]);
    let answer: (value: unknown) => void = () => {};
    fixture.api.mockImplementation(async (path: string) => path.includes("wait=") ? new Promise((resolve) => { answer = resolve; }) : current);
    render({ ...pepper, busy: false });
    await settle();
    expect(line()!.getAttribute("data-state")).toBe("working");
    expect(reads()[1]![0]).toContain("wait=25000");
    answer(job([{ ...root(), status: "completed" }, handoff({ reply: "none", status: "completed", finishedAt: 40_000 })], "v2"));
    await settle();
    expect(host.querySelector("[data-bot-exchange-line]")).toBeNull();
  });

  it("shows nothing when no bot handed anything on", async () => {
    current = job([root()]);
    render();
    await settle();
    expect(host.querySelector("[data-bot-exchange-line]")).toBeNull();
  });
});

describe("an opened exchange", () => {
  // The server writes a hand-off's request into the helper's thread as Pepper's line, tagged with the assignment.
  const request = (id: string, text: string, at: number, parentId: string, exchange: string): Message =>
    ({ id, role: "bot", kind: "text", text, at, parentId, from: { botId: "pepper", name: "Pepper", color: "blue" }, roomRequest: { id: exchange, phase: "request" } } as Message);
  const line1: Message = { id: "old", role: "bot", kind: "text", text: "An earlier request's answer", at: 8_000, parentId: null };
  const ask = request("ask", "Count the rows", 10_100, "old", "h1");
  const reply: Message = { id: "reply", role: "bot", kind: "text", text: "There are 12 rows", at: 20_000, parentId: "ask" };
  const later = request("next", "Now the totals", 31_000, "reply", "h0");
  const shown = () => Array.from(host.querySelectorAll("[data-side]")).map((row) => row.textContent);
  const note = () => host.querySelector("[data-exchange-note]")?.textContent;
  async function openOne(id: string) {
    render();
    await settle();
    flushSync(() => host.querySelector<HTMLButtonElement>(`[data-bot-exchange="${id}"]`)!.click());
    await settle();
  }

  it("shows only that exchange's lines of the helper's thread", async () => {
    fixture.load.mockResolvedValue({ messages: [line1, ask, reply, later], activeLeafId: "next" });
    await openExchange();
    expect(fixture.load).toHaveBeenCalledWith("work-1");
    expect(shown()).toEqual(["PepperCount the rows", "EngineerThere are 12 rows"]);
  });

  it("has Stop while the helper works, and shows the stop once the server has it", async () => {
    fixture.load.mockResolvedValue({ messages: [line1, ask], activeLeafId: "ask" });
    await openExchange();
    expect(shown()).toEqual(["PepperCount the rows"]);
    expect(status()!.textContent).toContain("Engineer is working on it…");
    current = job([root(), handoff({ status: "cancelled", outcome: "stopped", finishedAt: 22_000 })], "v2");
    flushSync(() => stopButton()!.click());
    await settle();
    expect(stops().map(([path, init]) => [path, init.method])).toEqual([["/api/threads/chat-1/job/h1/stop", "POST"]]);
    expect(status()!.getAttribute("data-bot-exchange-status")).toBe("stopped");
    expect(status()!.textContent).toBe("Stopped after 12s");
    expect(stopButton()).toBeNull();
    expect(host.querySelector("[role=alert]")).toBeNull();
  });

  it("takes an exchange that already ended as done, with no error", async () => {
    fixture.load.mockResolvedValue({ messages: [ask], activeLeafId: "ask" });
    await openExchange();
    stop = () => ({ ok: true, outcome: "already-ended" });
    current = job([root(), handoff({ status: "completed", finishedAt: 52_000 })], "v2");
    flushSync(() => stopButton()!.click());
    await settle();
    expect(status()!.textContent).toBe("Engineer answered in 42s");
    expect(host.querySelector("[role=alert]")).toBeNull();
  });

  it.each([
    [403, "Only the person who asked can stop this."],
    [404, "This exchange can't be stopped from here."],
    [500, "Couldn't stop it. Check that you're online and try again."],
  ])("says why a stop answered %i was refused, and keeps Stop to try again", async (code, text) => {
    fixture.load.mockResolvedValue({ messages: [ask], activeLeafId: "ask" });
    await openExchange();
    stop = () => { throw new ApiError("refused", code, code === 403 ? { code: "stop_not_yours" } : {}); };
    flushSync(() => stopButton()!.click());
    await settle();
    expect(host.querySelector("[role=alert]")!.textContent).toBe(text);
    expect(stopButton()!.disabled).toBe(false);
  });

  it("keeps two hand-offs to the same thread apart: the one waiting its turn shows none of the running one's lines", async () => {
    // B was handed out 300 ms after A's latest line: a window by time alone would take that line as B's.
    const queued = handoff({ id: "h2", status: "queued", createdAt: 20_300 });
    current = job([root(), handoff(), queued]);
    fixture.load.mockResolvedValue({ messages: [line1, ask, reply], activeLeafId: "reply" });
    await openOne("h2");
    expect(shown()).toEqual([]);
    expect(note()).toBe("Engineer hasn't started on this yet. It's waiting its turn.");
    expect(status()!.textContent).toContain("Pepper is asking Engineer…");
    expect(stopButton()).not.toBeNull();
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-exchange-back]")!.click());
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-bot-exchange="h1"]')!.click());
    await settle();
    expect(shown()).toEqual(["PepperCount the rows", "EngineerThere are 12 rows"]);
  });

  it("gives each of two hand-offs that ran in turn in the same thread only its own lines", async () => {
    const askB = request("ask-b", "Now the totals", 20_400, "reply", "h2");
    const replyB: Message = { id: "reply-b", role: "bot", kind: "text", text: "The totals add up", at: 25_000, parentId: "ask-b" };
    current = job([root(), handoff(), handoff({ id: "h2", status: "queued", createdAt: 20_300 })]);
    fixture.load.mockResolvedValue({ messages: [line1, ask, reply, askB, replyB], activeLeafId: "reply-b" });
    await openOne("h2");
    expect(shown()).toEqual(["PepperNow the totals", "EngineerThe totals add up"]);
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-exchange-back]")!.click());
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-bot-exchange="h1"]')!.click());
    await settle();
    expect(shown()).toEqual(["PepperCount the rows", "EngineerThere are 12 rows"]);
  });

  it("says so, instead of guessing, when the hand-off's request line is not in the thread", async () => {
    fixture.load.mockResolvedValue({ messages: [line1, reply], activeLeafId: "reply" });
    await openExchange();
    expect(shown()).toEqual([]);
    expect(note()).toBe("It isn't clear which lines of Engineer's conversation belong to this exchange, so none are shown.");
  });
});
