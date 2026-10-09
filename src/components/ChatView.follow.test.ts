// The desktop keeps no in-flight reply text: a reply appears once it is
// finished. So the finished message is what has to move a following
// transcript to its bottom.
import { createElement, type DependencyList, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { refs: [] as { current: unknown }[], ref: 0, effects: [] as { effect: EffectCallback; deps?: DependencyList }[] };
});
// Server rendering runs no effects: record them, and keep refs across renders
// the way a mounted component would.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: EffectCallback, deps?: DependencyList) => { fixture.effects.push({ effect, deps }); },
  useRef: (initial: unknown) => (fixture.refs[fixture.ref++] ??= { current: initial }),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const question: Message = { id: "q", role: "user", kind: "text", text: "Summarise the report", at: 1 };
const answer: Message = { id: "a", role: "bot", kind: "text", text: "Here is the summary.", at: 2, parentId: "q", turnTerminal: true };
const bot = (busy: boolean, messages: Message[]): Bot => ({
  id: "bot", threadId: "thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy, activity: busy ? "working" : "idle", messages, activeLeafId: messages.at(-1)?.id,
  modelSelection: { instanceId: "test", model: "m" },
});
const render = (props: Bot) => {
  fixture.ref = 0;
  fixture.effects = [];
  renderToStaticMarkup(createElement(ChatView, { bot: props }));
  // the effect that pins a following transcript to its end
  return fixture.effects.find(({ effect }) => /scrollTo\(\{\s*top:\s*el\.scrollHeight\s*\}\)/.test(String(effect)))!;
};
const changed = (before?: DependencyList, after?: DependencyList) =>
  !before || !after || before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]));

it("scrolls a following transcript to the bottom when the finished reply arrives", () => {
  const working = render(bot(true, [question]));
  const settled = render(bot(false, [question, answer]));
  expect(working).toBeDefined();
  expect(changed(working.deps, settled.deps)).toBe(true);

  // Mount: the element refs now hold the scroller; following is on.
  const calls: ScrollToOptions[] = [];
  const scroller = { scrollHeight: 2_400, scrollTop: 0, clientHeight: 600,
    scrollTo(options: ScrollToOptions) { calls.push(options); this.scrollTop = options.top ?? 0; } };
  for (const ref of fixture.refs) if (ref.current === null) ref.current = scroller;
  settled.effect();
  expect(calls).toEqual([{ top: 2_400 }]);
});
