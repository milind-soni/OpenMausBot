import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import { t } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const bot: Bot = {
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
};
const chip = (id: string, summary: string, ok?: boolean): Message =>
  ({ id, at: 1, role: "bot", kind: "activity", tool: { name: "Bash", summary, ...(ok === undefined ? {} : { ok }) } });

describe("Verify card in the chat pane", () => {
  it("appears once the bot runs a control CLI, with the run as a checklist", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: {
      ...bot,
      messages: [
        { id: "u1", role: "user", kind: "text", at: 1, text: "verify the fixture" },
        chip("c1", "pnpm control:omb doctor --url http://127.0.0.1:8799", true),
        chip("c2", "node --experimental-strip-types scripts/control-omb.ts send --bot x --text hi", false),
        chip("c3", "git status", true),
        chip("c4", "cat scripts/control-omb.ts", true),
      ],
    } }));
    expect(markup).toContain(`aria-label="${t("chat.verify.aria")}"`);
    expect(markup).toContain("1 passed · 1 failed");
    expect(markup).not.toContain("Execution timeline");
    expect(markup).toContain(">doctor<");
    expect(markup).toContain(">send<");
    expect(markup).not.toContain(">status<");
    // skill authoring is off in the default config: no Save, no footer
    expect(markup).not.toContain(t("chat.verify.save"));
  });

  it("stays out of a thread with no control-CLI run", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: {
      ...bot,
      messages: [chip("c1", "pnpm typecheck", true), chip("c2", "git status", true)],
    } }));
    expect(markup).not.toContain(`aria-label="${t("chat.verify.aria")}"`);
  });
});
