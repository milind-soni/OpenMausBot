import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { skillPrompt, verifySteps } from "@/lib/verify-steps";
import type { VerifyCard } from "./VerifyCard";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    dispatch: vi.fn(),
    appendComposerDraft: vi.fn(),
    state: null as Partial<AppState> | null,
    verify: null as ComponentProps<typeof VerifyCard> | null,
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/drafts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/drafts")>();
  return { ...original, appendComposerDraft: fixture.appendComposerDraft };
});
// The real card renders; its props are kept so a test can press Save.
vi.mock("./VerifyCard", async (importOriginal) => {
  const original = await importOriginal<typeof import("./VerifyCard")>();
  return { VerifyCard: (props: ComponentProps<typeof VerifyCard>) => {
    fixture.verify = props;
    return createElement(original.VerifyCard, props);
  } };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
// The thread controls read live model lists; they are not what this file tests.
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span", { "data-test-model-control": true }) }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => createElement("span", { "data-test-approval-control": true }) }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  fixture.state = null;
  fixture.verify = null;
  vi.clearAllMocks();
});

const bot: Bot = {
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
};
const chip = (id: string, summary: string, ok?: boolean): Message =>
  ({ id, at: 1, role: "bot", kind: "activity", tool: { name: "Bash", summary, ...(ok === undefined ? {} : { ok }) } });
const run: Message[] = [
  { id: "u1", role: "user", kind: "text", at: 1, text: "verify the fixture" },
  chip("c1", "pnpm control:omb doctor --url http://127.0.0.1:8799", true),
  chip("c2", "node --experimental-strip-types scripts/control-omb.ts send --bot x --text hi", false),
  chip("c3", "git status", true),
  chip("c4", "cat scripts/control-omb.ts", true),
];
// An engine with the agents tools, which Save needs alongside the flag.
const agentsEngine = { instanceId: "test", driverKind: "claude", displayName: "Test", capabilities: { agentsMcp: true } } as unknown as InstanceInfo;
const render = (messages: Message[]) => renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, messages } }));

describe("Verify card in the chat pane", () => {
  it("appears once the bot runs a control CLI, with the run as a checklist", () => {
    const markup = render(run);
    expect(markup).toContain(`aria-label="${t("chat.verify.aria")}"`);
    expect(markup).toContain("1 passed · 1 failed");
    expect(markup).not.toContain("Execution timeline");
    expect(markup).toContain(">doctor<");
    expect(markup).toContain(">send<");
    expect(markup).not.toContain(">status<");
    // no engine in the fixture has the agents tools: no Save, no footer
    expect(markup).not.toContain(t("chat.verify.save"));
  });

  it("withholds Save when skill authoring is switched off in Settings", () => {
    fixture.state = { instances: [agentsEngine], config: { features: { skillAuthoring: false } } as AppState["config"] };
    const markup = render(run);
    expect(markup).toContain(">doctor<");
    expect(markup).not.toContain(t("chat.verify.save"));
  });

  it("offers Save with an agents engine, and Save fills the thread's composer instead of sending", () => {
    fixture.state = { instances: [agentsEngine], config: { features: { skillAuthoring: true } } as AppState["config"] };
    const markup = render(run);
    expect(markup).toContain(t("chat.verify.save"));
    expect(markup).toContain(t("chat.verify.saveHint"));
    expect(fixture.verify?.canSave).toBe(true);

    fixture.verify!.onSave();
    expect(fixture.appendComposerDraft).toHaveBeenCalledTimes(1);
    expect(fixture.appendComposerDraft).toHaveBeenCalledWith("bot:bot:t1", skillPrompt(verifySteps(run)));
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("stays out of a thread with no control-CLI run", () => {
    const markup = render([chip("c1", "pnpm typecheck", true), chip("c2", "git status", true)]);
    expect(markup).not.toContain(`aria-label="${t("chat.verify.aria")}"`);
  });
});
