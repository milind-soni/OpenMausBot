// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as Array<{ path: string; body: unknown; background?: boolean }>);
const { BEN, CLEO, ADA } = vi.hoisted(() => ({
  BEN: { email: "ben@acme.test", name: "Ben", role: "member", you: true as const, here: true },
  CLEO: { email: "cleo@acme.test", name: "Cleo", role: "owner", here: true },
  ADA: { email: "ada@acme.test", name: "Ada", role: "admin", here: false },
}));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(),
  api: vi.fn(async (path: string, init?: { body?: string; background?: boolean }) => {
    if (path === "/api/team/people") return { people: [BEN, CLEO, ADA] };
    sent.push({ path, body: init?.body ? JSON.parse(init.body) : undefined, background: init?.background });
    return {};
  }) }));

import { HereDot, ThreadPresenceFaces } from "@/components/TeamPresence";
import { SidebarPeople } from "@/components/SidebarPeople";
import { setLocale } from "@/lib/i18n";
import { publishLiveFrame, publishMissedFrames } from "@/lib/live-events";
import { initialState, StoreContext, type AppState, type Bot } from "./store";
import { setTeamPeople, type TeamPeople } from "./team-people";
import { sharedThreadOf, useTeamPresence } from "./team-presence";

const team: TeamPeople = { people: [BEN, CLEO, ADA], me: BEN, admin: false, needsYou: [], presence: true };
const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "test" }, messages: [],
  tasks: [{ threadId: "scout-main", title: "Shared chat", createdAt: 1 }, { threadId: "ben-own", title: "Mine", createdAt: 2, private: true }], ...overrides,
});

let container: HTMLDivElement, root: Root;
const state = (overrides: Partial<AppState> = {}) => ({ ...initialState, hydrated: true, activeView: "chat", selectedId: "scout", bots: [bot()], config: { team: { id: "t", name: "Acme" } }, ...overrides }) as AppState;
const draw = (child: ReturnType<typeof createElement>, value: AppState = state(), dispatch = vi.fn()) => act(() => {
  root.render(createElement(StoreContext.Provider, { value: { state: value, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
});
function Pinger({ value }: { value: AppState }) {
  useTeamPresence(value);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ kind: "session", id: "s1", scopes: ["client"] }), { status: 200 })));
  setLocale("en");
  sent.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => setTeamPeople(null));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the conversation the server is told about", () => {
  it("is a shared chat or a group chat, never a private chat or a member's own MausBot", () => {
    expect(sharedThreadOf(state())).toBe("scout-main");
    expect(sharedThreadOf(state({ bots: [bot({ threadId: "ben-own" })] }))).toBeNull();
    expect(sharedThreadOf(state({ bots: [bot({ defaultBot: { person: BEN.email } })] }))).toBeNull();
    expect(sharedThreadOf(state({ selectedId: "g1", groups: [{ id: "g1", threadId: "room-1" }] as AppState["groups"] }))).toBe("room-1");
    expect(sharedThreadOf(state({ activeView: "routines" }))).toBeNull();
  });

  it("is sent when it changes, and as no conversation in a private chat", async () => {
    vi.useFakeTimers();
    act(() => setTeamPeople(team));
    await draw(createElement(Pinger, { value: state() }));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(sent.at(-1)).toMatchObject({ path: "/api/presence/here", body: { threadId: "scout-main" } });
    const tab = (sent.at(-1)!.body as { tab: string }).tab;
    expect(tab).toMatch(/^[\w-]{1,64}$/);
    await draw(createElement(Pinger, { value: state({ bots: [bot({ threadId: "ben-own" })] }) }));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(sent.at(-1)!.body).toEqual({ tab, threadId: null });
    expect(JSON.stringify(sent), "the private chat is never named").not.toContain("ben-own");
  });

  it("is sent again as a new window when the stream missed frames, so the server sends the lists again", async () => {
    vi.useFakeTimers();
    act(() => setTeamPeople(team));
    await draw(createElement(Pinger, { value: state() }));
    await act(async () => { vi.advanceTimersByTime(300); });
    const first = sent.at(-1)!.body as { tab: string };
    act(() => publishMissedFrames());
    const again = sent.at(-1)!.body as { tab: string; threadId: string };
    expect(again.threadId).toBe("scout-main");
    expect(again.tab).not.toBe(first.tab);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  });

  it("is never sent to a server that says nothing about presence", async () => {
    vi.useFakeTimers();
    act(() => setTeamPeople({ ...team, presence: undefined }));
    await draw(createElement(Pinger, { value: state() }));
    await act(async () => { vi.advanceTimersByTime(70_000); });
    expect(sent).toEqual([]);
  });
});

describe("what the server says back", () => {
  it("shows the faces of the others who have a shared chat open", async () => {
    act(() => setTeamPeople(team));
    await draw(createElement("div", null, createElement(Pinger, { value: state() }), createElement(ThreadPresenceFaces, { threadId: "scout-main" })));
    expect(container.querySelector("[data-thread-presence]")).toBeNull();
    act(() => publishLiveFrame({ kind: "thread.presence", threadId: "scout-main", people: [BEN.email, CLEO.email] }));
    const faces = container.querySelector("[data-thread-presence]")!;
    expect(faces.getAttribute("data-thread-presence")).toBe("1");
    expect(faces.getAttribute("aria-label")).toBe("Cleo has this open");
    expect(faces.querySelectorAll("[data-here-dot]")).toHaveLength(1);
    act(() => publishLiveFrame({ kind: "thread.presence", threadId: "scout-main", people: [ADA.email, BEN.email, CLEO.email] }));
    expect(container.querySelector("[data-thread-presence]")!.getAttribute("aria-label")).toBe("Ada and Cleo have this open");
    act(() => publishLiveFrame({ kind: "thread.presence", threadId: "scout-main", people: [BEN.email] }));
    expect(container.querySelector("[data-thread-presence]")).toBeNull();
  });

  it("moves the dot as people come and go, and never shows one on your own row", async () => {
    act(() => setTeamPeople(team));
    await draw(createElement("div", null, createElement(Pinger, { value: state() }), createElement(SidebarPeople, { compact: false })));
    const dotOn = (email: string) => container.querySelector(`[data-person="${email}"] [data-here-dot]`) !== null;
    expect([dotOn(BEN.email), dotOn(CLEO.email), dotOn(ADA.email)]).toEqual([false, true, false]);
    act(() => publishLiveFrame({ kind: "team.presence", email: CLEO.email, here: false }));
    act(() => publishLiveFrame({ kind: "team.presence", email: ADA.email, here: true }));
    expect([dotOn(CLEO.email), dotOn(ADA.email)]).toEqual([false, true]);
    expect(container.querySelector(`[data-person="${CLEO.email}"]`)!.getAttribute("aria-label")).toBe("Write to Cleo");
    expect(container.querySelector(`[data-person="${ADA.email}"]`)!.getAttribute("aria-label")).toBe("Write to Ada. Here now");
    expect(container.querySelector("[data-sidebar-people]")!.textContent, "no time of when anyone was here").not.toMatch(/ago|last/i);
  });

  it("closes the phone's full-screen list when a person is chosen", async () => {
    act(() => setTeamPeople(team));
    const onOpened = vi.fn();
    await draw(createElement(SidebarPeople, { compact: false, onOpened }));
    act(() => (container.querySelector(`[data-person="${CLEO.email}"]`) as HTMLButtonElement).click());
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("has a dot that reads as part of the face", () => {
    act(() => root.render(createElement(HereDot, { size: 24, edge: "app" })));
    expect(container.querySelector("[data-here-dot]")!.className).toContain("ring-app");
  });
});
