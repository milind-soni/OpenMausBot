// @vitest-environment happy-dom
// A My Cloud bot opened in place, in this page's real store: its conversation comes in under its place's ids, its live
// frames land in it exactly as this page's own do, a fresh read of this computer's server keeps it, and it leaves the
// store (its stream with it) once the person chooses another bot.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "@/state/store";
import { PlaceChatKeeper } from "@/components/PlacedBotMenu";
import { openPlaceBot, resetPlaceChatForTest } from "./place-chat";
import { liveReplies, resetLiveReplies } from "@/state/live-reply";

class Source {
  static made: Source[] = [];
  url: string; closed = false;
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(url: string) { this.url = url; Source.made.push(this); }
  close() { this.closed = true; }
  say(frame: unknown, id = "") { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}
const local = () => Source.made.filter((source) => source.url.startsWith("/api/events")).at(-1)!;
const placed = () => Source.made.filter((source) => source.url.startsWith("/api/places/cloud/events")).at(-1)!;

const ledger = { id: "ledger", name: "Ledger", threadId: "l1", title: "", description: "", color: "orange", notifications: true, unread: false, createdAt: 1,
  modelSelection: { instanceId: "claude", model: "opus" }, tasks: [{ threadId: "l1", title: "Invoices", createdAt: 1 }], messages: [] };
const scout = { id: "cloud:scout", name: "Scout", threadId: "cloud:t1", title: "", description: "", color: "blue", notifications: true, unread: false, createdAt: 1, chiefOfStaff: true,
  modelSelection: { instanceId: "claude", model: "opus" }, tasks: [{ threadId: "cloud:t1", title: "Flats", createdAt: 1 }],
  messages: [{ id: "m1", role: "bot", kind: "text", text: "Four flats under budget.", at: 1 }] };

let store!: ReturnType<typeof useStore>;
function Reader() { store = useStore(); return null; }
let root: Root;
const asked: string[] = [];
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setTimeout(done, 0)); });
const bots = () => store.state.bots.map((bot) => bot.id);

beforeEach(async () => {
  Source.made = [];
  asked.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("fetch", async (path: unknown) => {
    const url = String(path);
    asked.push(url);
    const body = url.startsWith("/api/bots/cloud%3Ascout") ? { bot: scout } : url.startsWith("/api/bots?") || url === "/api/bots" ? { bots: [ledger, { ...ledger, id: "git", name: "Git", threadId: "g1", tasks: [{ threadId: "g1", title: "Notes", createdAt: 1 }] }], groups: [], sections: [], botQueuedMessages: {}, computerControl: {} } : {};
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  window.ogb = { placesTogether: { openInPlace: async () => ({ ok: true }), open: vi.fn(async () => true) } } as never;
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Reader), createElement(PlaceChatKeeper))));
  await act(async () => local().say({ kind: "hello", cursor: "s:1", resumed: false }));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  resetPlaceChatForTest();
  resetLiveReplies();
  vi.unstubAllGlobals();
  delete (window as { ogb?: unknown }).ogb;
});

it("opens in the store under its place's ids, takes its live frames, survives a fresh read and leaves when another bot is chosen", async () => {
  expect(bots()).toEqual(["ledger", "git"]);
  let opened: string | undefined;
  await act(async () => { opened = await openPlaceBot("scout", store.dispatch); });
  await settle();
  expect(opened).toBe("here");
  expect(store.state.selectedId).toBe("cloud:scout");
  expect(bots()).toContain("cloud:scout");
  const shown = store.state.bots.find((bot) => bot.id === "cloud:scout")!;
  expect(shown.chiefOfStaff).toBe(false);
  expect(shown.messages.map((message) => message.id)).toEqual(["m1"]);

  // A turn's message on the bot's own stream lands in its conversation, by the conversation's place id.
  expect(placed().url).toBe("/api/places/cloud/events?bot=cloud%3Ascout");
  await act(async () => placed().say({ kind: "message", threadId: "cloud:t1", message: { id: "m2", role: "bot", kind: "text", text: "Trains at 9.", at: 2 } }, "s:9"));
  await settle();
  expect(store.state.bots.find((bot) => bot.id === "cloud:scout")!.messages.map((message) => message.id)).toEqual(["m1", "m2"]);

  // This computer's own stream starting over reads its server again: the bot open in place stays, and stays chosen.
  await act(async () => local().say({ kind: "hello", cursor: "s:2", resumed: false }));
  await settle();
  expect(bots()).toEqual(["ledger", "git", "cloud:scout"]);
  expect(store.state.selectedId).toBe("cloud:scout");

  // Choosing another bot lets it go, and its stream with it.
  await act(async () => store.dispatch({ type: "select", id: "ledger" }));
  await settle();
  expect(bots()).toEqual(["ledger", "git"]);
  expect(placed().closed).toBe(true);
  expect((window.ogb!.placesTogether!.open as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
});

it("My Cloud going to sleep closes its stream quietly; the person's next click opens it again", async () => {
  await act(async () => { await openPlaceBot("scout", store.dispatch); });
  await settle();
  const first = placed();
  await act(async () => first.say({ kind: "power", state: "sleeping" }));
  expect(first.closed).toBe(true);
  expect(Source.made.filter((source) => source.url.startsWith("/api/places/")).length).toBe(1);
  await act(async () => { window.dispatchEvent(new Event("pointerdown")); });
  expect(placed()).not.toBe(first);
  expect(store.state.error ?? null).toBeNull();
});

it("a click overtaken by the person choosing something else lands nowhere", async () => {
  let release!: (value: { ok: boolean }) => void;
  window.ogb = { placesTogether: { openInPlace: () => new Promise((done) => { release = done; }), open: vi.fn(async () => true) } } as never;
  let opened: Promise<string> | undefined;
  await act(async () => { opened = openPlaceBot("scout", store.dispatch); });
  await act(async () => store.dispatch({ type: "select", id: "git" }));
  await act(async () => { release({ ok: true }); });
  expect(await opened).toBe("overtaken");
  expect(store.state.selectedId).toBe("git");
  expect(bots()).toEqual(["ledger", "git"]);
});

it("a turn streams in place: each delta of the reply shows live under the conversation's place id, as this page's own do", async () => {
  await act(async () => { await openPlaceBot("scout", store.dispatch); });
  await settle();
  const runtime = (event: Record<string, unknown>) => placed().say({ kind: "runtime", event: { eventId: `e${Math.random()}`, provider: "claudeAgent", threadId: "cloud:t1", createdAt: "2026-11-27T10:00:00.000Z", turnId: "turn-1", ...event } });
  await act(async () => { runtime({ type: "turn.started" }); runtime({ type: "content.delta", streamKind: "assistant_text", delta: "Two of the four " }); });
  expect(liveReplies("cloud:t1").map((item) => item.text)).toEqual(["Two of the four "]);
  await act(async () => runtime({ type: "content.delta", streamKind: "assistant_text", delta: "have a balcony." }));
  expect(liveReplies("cloud:t1").map((item) => item.text)).toEqual(["Two of the four have a balcony."]);
  expect(liveReplies("t1")).toEqual([]);
});
