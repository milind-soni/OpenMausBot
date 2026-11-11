// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bots = vi.hoisted(() => [] as Bot[]);
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { GroupView } = await import("./GroupView");
const { noteLiveReplyEvent, resetLiveReplies } = await import("@/state/live-reply");

const member = (id: string, name: string, color: string) =>
  ({ id, name, color, busy: false, messages: [], notifications: true, unread: false, title: "", description: "", modelSelection: { instanceId: "test", model: "default" } }) as unknown as Bot;
bots.push(member("ada", "Ada", "blue"), member("ben", "Ben", "green"));
const at = Date.UTC(2026, 10, 11, 12);
const ask: Message = { id: "u", role: "user", kind: "text", at, text: "Plan the launch" };
const room = (busyBotId: string | undefined): Group => ({
  id: "room", threadId: "room-thread", name: "Planning", memberIds: ["ada", "ben"], defaultResponder: { kind: "member", botId: "ada" },
  bulletin: "", unread: false, createdAt: 1, messages: [ask], busyBotId, working: Boolean(busyBotId), turnStartedAt: at,
} as unknown as Group);

let seq = 0;
const stream = (delta: string, botId?: string) => act(() => noteLiveReplyEvent({
  eventId: `d${++seq}`, provider: "claudeAgent", threadId: "room-thread", createdAt: new Date(at).toISOString(), turnId: "t1", itemId: "x",
  type: "content.delta", streamKind: "assistant_text", delta, ...(botId ? { botId } : {}),
} as RuntimeEvent));

let host: HTMLDivElement;
let root: Root;
const render = (group: Group) => act(() => root.render(createElement(GroupView, { group })));
const liveRow = () => host.querySelector('[data-mid^="live:"]');

beforeEach(() => {
  resetLiveReplies();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a room reply as it streams", () => {
  it("names the member the server says is speaking, whoever the room shows as busy", () => {
    render(room(undefined));
    stream("Drafting the outline now ", "ada");
    expect(liveRow()?.textContent).toContain("Drafting the outline now");
    expect(liveRow()?.textContent, "no one busy yet: still Ada's words").toContain("Ada");
    render(room("ben"));
    expect(liveRow()?.textContent, "the room already shows the next speaker").toContain("Ada");
    expect(liveRow()?.textContent).not.toContain("Ben");
  });
});
