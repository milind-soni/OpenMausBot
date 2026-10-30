// @vitest-environment happy-dom
// The live desktop's own lifecycle, with the connection played by the test.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Events = { connected(): void; disconnected(): void };
const fixture = vi.hoisted(() => ({
  attempts: [] as Array<{ target: string; events: Events; client: { focus: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } }>,
  refuse: false,
  typed: [] as string[],
}));
vi.mock("@/lib/desktop-connection", () => ({
  connectDesktop: async (_screen: HTMLElement, target: string, options: { events: Events }) => {
    if (fixture.refuse) throw new Error("unreachable");
    const client = { focus: vi.fn(), disconnect: vi.fn() };
    fixture.attempts.push({ target, events: options.events, client });
    return client;
  },
  typeOnDesktop: (_client: unknown, text: string) => fixture.typed.push(text),
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined, dragProps: {}, noDragStyle: undefined }),
  useDesktopCapabilities: () => ({ ready: true, capabilities: { windowChrome: "native" } }),
}));

const { LiveDesktop } = await import("./LiveDesktop");
let root: Root;
let props: Parameters<typeof LiveDesktop>[0];
const draw = (patch: Partial<typeof props> = {}) => {
  props = { ...props, ...patch };
  flushSync(() => root.render(createElement(LiveDesktop, props)));
};
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const state = () => document.querySelector<HTMLElement>("[data-live-desktop]")?.dataset.state;
const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);

beforeEach(async () => {
  fixture.attempts = [];
  fixture.refuse = false;
  fixture.typed = [];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    target: "local/shared", threadId: "thread", name: "Scout", poster: null, expanded: false,
    onExpandedChange: vi.fn(), onHandBack: vi.fn(), handingBack: false, onUnreachable: vi.fn(),
  };
  draw();
  await settle();
});
afterEach(() => {
  root.unmount();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the live desktop", () => {
  it("takes the keyboard once the desktop answers", () => {
    expect(state()).toBe("connecting");
    flushSync(() => fixture.attempts[0]!.events.connected());
    expect(state()).toBe("connected");
    expect(fixture.attempts[0]!.client.focus).toHaveBeenCalled();
  });

  it("a desktop that never answers is reported, so the computer goes back to the bot", () => {
    flushSync(() => fixture.attempts[0]!.events.disconnected());
    expect(props.onUnreachable).toHaveBeenCalledTimes(1);
  });

  it("a connection the server refuses is reported the same way", async () => {
    root.unmount();
    fixture.refuse = true;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    draw({ onUnreachable: vi.fn() });
    await settle();
    expect(props.onUnreachable).toHaveBeenCalledTimes(1);
  });

  it("a drop mid-session reconnects once by itself, then offers Reconnect", async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    flushSync(() => fixture.attempts[0]!.events.connected());
    flushSync(() => fixture.attempts[0]!.events.disconnected());
    expect(state()).toBe("disconnected");
    expect(props.onUnreachable).not.toHaveBeenCalled();
    await wait(1_200);
    expect(fixture.attempts).toHaveLength(2);
    expect(fixture.attempts[0]!.client.disconnect).toHaveBeenCalled();
    flushSync(() => fixture.attempts[1]!.events.disconnected());
    await wait(1_500);
    expect(fixture.attempts, "no endless reconnect loop").toHaveLength(2);
    flushSync(() => button("Reconnect")!.click());
    await settle();
    expect(fixture.attempts).toHaveLength(3);
  });

  it("closes its connection when it goes away", () => {
    const client = fixture.attempts[0]!.client;
    root.unmount();
    expect(client.disconnect).toHaveBeenCalled();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("full screen keeps the same connection and offers Exit, typing and Hand back", async () => {
    flushSync(() => fixture.attempts[0]!.events.connected());
    draw({ expanded: true });
    await settle();
    expect(fixture.attempts, "growing the view must not reconnect").toHaveLength(1);
    const field = document.querySelector<HTMLInputElement>("input[aria-label='Text to type on the desktop']")!;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "hunter2");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => field.form!.requestSubmit());
    expect(fixture.typed).toEqual(["hunter2"]);
    flushSync(() => button("Exit fullscreen")!.click());
    expect(props.onExpandedChange).toHaveBeenCalledWith(false);
    flushSync(() => button("Hand control back")!.click());
    expect(props.onHandBack).toHaveBeenCalledTimes(1);
  });
});
