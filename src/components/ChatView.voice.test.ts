import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span", { "data-test-model-control": true }) }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span", { "data-test-approval-control": true }) }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const bot: Bot = {
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
};

const note = { kind: "audio" as const, path: "/attachments/123e4567-e89b-12d3-a456-426614174000.mp3", mime: "audio/mpeg", durationMs: 4200 };

describe("voice notes in the chat transcript", () => {
  it("renders an audio bubble above the transcript text of a bot message", () => {
    const message: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "Standup summary inside", attachments: [note] };
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, messages: [message] } }));
    expect(markup).toContain('data-test-voice-note=""');
    expect(markup).toContain('aria-label="Play voice note"');
    expect(markup).toContain('src="/api/attachments/123e4567-e89b-12d3-a456-426614174000.mp3"');
    expect(markup).toContain("Standup summary inside");
    // the bubble sits above the transcript, which stays selectable text
    expect(markup.indexOf("data-test-voice-note")).toBeLessThan(markup.indexOf("Standup summary inside"));
  });

  it("still renders the message body when an attachment kind is unknown", () => {
    const message: Message = {
      id: "m2", at: 1, role: "bot", kind: "text", text: "Future-proof body",
      attachments: [{ kind: "gizmo", path: "/x" } as unknown as NonNullable<Message["attachments"]>[number]],
    };
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, messages: [message] } }));
    expect(markup).toContain("Future-proof body");
    expect(markup).not.toContain("data-test-voice-note");
    expect(markup).not.toContain("/api/attachments/");
  });
});
