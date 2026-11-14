import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "cua-driver-unavailable", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => createElement("span") }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const message = (id: string, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: "user", kind: "text", text, at: 1_700_000_000_000, ...extra }) as Message;

const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages,
  modelSelection: { instanceId: "test", model: "m" },
});

const appRow = message("a1", "[App] Coffee counter\nCups of coffee today", {
  role: "bot", kind: "app",
  app: { v: 1, source: "html", title: "Coffee counter", doc: "d0", rev: 0, bytes: 900, height: 200, border: true, network: { connect: [], resources: [] } },
});

describe("app rows", () => {
  it("draw as the host's card with the app's title and who made it", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: bot([message("m1", "count my coffees"), appRow]) }));
    expect(markup).toContain('data-app="a1"');
    expect(markup).toContain("Coffee counter");
    expect(markup).toContain("Page made by Pepper");
    // the readable fallback is for older clients: not drawn as a bubble here
    expect(markup).not.toContain("Cups of coffee today");
  });

  it("read as their text when the payload never arrived", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: bot([{ ...appRow, app: undefined }]) }));
    expect(markup).not.toContain("data-app=");
    expect(markup).toContain("Cups of coffee today");
  });
});

describe("words an app sent as the person", () => {
  it("say which app sent them, and typed words say nothing", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([
        appRow,
        message("m2", "I have had 3 cups of coffee today.", { replyToId: "a1", fromApp: { messageId: "a1", title: "Coffee counter" } }),
        message("m3", "typed words"),
      ]),
    }));
    expect(markup.match(/Sent from Coffee counter/g)).toHaveLength(2); // the line and its tooltip
    expect(markup).toContain('data-sent-from-app="a1"');
    expect(markup.indexOf("Sent from Coffee counter")).toBeGreaterThan(markup.indexOf("I have had 3 cups"));
    expect(markup.indexOf("Sent from Coffee counter")).toBeLessThan(markup.indexOf("typed words"));
    expect(markup).not.toContain("via call");
  });
});
