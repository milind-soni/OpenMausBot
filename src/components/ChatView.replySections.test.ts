// The reader's half of the section convention, in the real transcript.
//
// `ReplySections.test.ts` pins the fold itself; this proves the transcript
// actually reaches it — that a settled bot reply with headings renders as a
// lead plus one labelled row, and that a reply without headings is still
// exactly the message it always was. The headless UI recipe would prove the
// same thing in a browser, but its pinned agent-browser download is not
// available in every environment, so the wiring is pinned here instead.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn(), state: null as Partial<AppState> | null };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span", { "data-test-model-control": true }) }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => createElement("span", { "data-test-approval-control": true }) }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  fixture.state = null;
  vi.clearAllMocks();
});

const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages,
  modelSelection: { instanceId: "test", model: "profile-default" },
});
const replied = (text: string): Message => ({ id: "m1", at: 1, role: "bot", kind: "text", text, turnTerminal: true });
const render = (text: string) =>
  renderToStaticMarkup(createElement(ChatView, { bot: bot([{ id: "u1", role: "user", kind: "text", at: 0, text: "fix the redirect" }, replied(text)]) }));

describe("the transcript's reply sections", () => {
  it("shows a headed reply's lead and folds its detail behind one row", () => {
    const html = render(
      "The redirect is fixed and the suite passes.\n\n## What changed\n\nI moved the query string onto the new path.\n\n## Files\n\n- server/auth.ts",
    );
    expect(html).toContain("The redirect is fixed and the suite passes.");
    expect(html).toContain("Show detail");
    expect(html).toContain("What changed · Files");
    expect(html).not.toContain("I moved the query string onto the new path.");
    expect(html).not.toContain("server/auth.ts");
  });

  it("leaves a reply without headings as the one message it always was", () => {
    const html = render("Tests pass.\n\n- one\n- two");
    expect(html).toContain("Tests pass.");
    expect(html).toContain("one");
    expect(html).toContain("two");
    expect(html).not.toContain("Show detail");
  });
});
