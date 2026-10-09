import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ colorMine: false }));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false, useShowThreadsChoice: () => false, setShowThreads: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./CitationUI", () => ({ CitationSelectionToolbar: () => null, SentCitations: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => null }));
vi.mock("@/lib/user-bubble-preference", () => ({ useColorUserBubbles: () => fixture.colorMine }));

const { ChatView } = await import("./ChatView");
const { userBubbleTone } = await import("@/lib/user-bubble-tone");

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Sample", title: "", description: "", color: "yellow",
  notifications: true, unread: false, busy: false, messages: [
    { id: "u", role: "user", kind: "text", at: 1, text: "hello from me" },
    { id: "b", role: "bot", kind: "text", at: 2, text: "hello back" },
  ],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

afterEach(() => { fixture.colorMine = false; vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.stubGlobal("window", {});
});

describe("bot-colored user bubbles", () => {
  it("keeps the skin bubble until the setting is on", () => {
    const html = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(html).toContain("bg-bubble-user");
    expect(html).not.toContain("user-bubble-colored");
    expect(html).toContain("hello from me");
  });

  it("paints the person's bubble with a deep shade of the bot and white text", () => {
    fixture.colorMine = true;
    const tone = userBubbleTone("yellow");
    const html = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(html).toContain("user-bubble-colored");
    expect(html).toContain(`background-color:${tone.background}`);
    expect(html).toContain("--color-ink:#ffffff");
    expect(html).toContain("hello from me");
    // the bot's own bubble stays on the card, not the person's fill
    const mine = html.indexOf("user-bubble-colored");
    const reply = html.indexOf("hello back");
    expect(mine).toBeGreaterThan(-1);
    expect(html.slice(reply - 80, reply)).not.toContain(tone.background);
  });
});
