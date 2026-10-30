import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { askText, runSteps, skillPrompt } from "@/lib/verify-steps";
import { SAVE_RUN_AS_SKILL_LINE } from "../../shared/learn-request";
import type { VerifyCard } from "./VerifyCard";
import { citationAttachment, createCitationTextSelector, serializeCitation } from "@/lib/citations";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    dispatch: vi.fn(),
    appendComposerDraft: vi.fn(),
    showRunCard: true,
    advanced: true,
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
// The real useCaptionChrome rides along: it only asks this module for the window chrome.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
// A renderer preference, not what these tests are about; the fixture stands in for the stored value.
vi.mock("@/lib/run-card-preferences", () => ({ useShowRunCard: () => fixture.showRunCard }));
// The thread controls read live model lists; they are not what this file tests.
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span", { "data-test-model-control": true }) }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => createElement("span", { "data-test-approval-control": true }) }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  fixture.state = null;
  fixture.verify = null;
  fixture.showRunCard = true;
  fixture.advanced = true;
  vi.clearAllMocks();
});

const bot: Bot = {
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
};
const chip = (id: string, summary: string, ok?: boolean): Message =>
  ({ id, at: 1, role: "bot", kind: "activity", tool: { name: "Bash", summary, ...(ok === undefined ? {} : { ok }) } });
const asked = (id: string, text: string): Message => ({ id, role: "user", kind: "text", at: 1, text });
const run: Message[] = [
  asked("u1", "verify the fixture"),
  chip("c1", "pnpm control:omb doctor --url http://127.0.0.1:8799", true),
  chip("c2", "node --experimental-strip-types scripts/control-omb.ts send --bot x --text hi", false),
  chip("c3", "git status", true),
  chip("c4", "cat scripts/control-omb.ts", true),
];
const release: Message[] = [
  asked("u1", "publish the release"),
  chip("c1", "git push origin main", true),
  chip("c2", "cat CHANGELOG.md", true),
  chip("c3", "npm publish", false),
];
const agentsEngine = { instanceId: "test", driverKind: "claude", displayName: "Test", capabilities: { agentsMcp: true } } as unknown as InstanceInfo;
const saveable = (): void => {
  fixture.state = { instances: [agentsEngine], config: { features: { skillAuthoring: true } } as AppState["config"] };
};
const CARD = `aria-label="${t("chat.verify.aria")}"`;
const TAG = `>${t("chat.verify.verifiedTag")}<`;
const render = (messages: Message[]) => renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, messages } }));
const draft = (): string => fixture.appendComposerDraft.mock.calls[0]![1] as string;

describe("The run card in the chat pane", () => {
  it("stays out of Simple mode's chat, whose steps live in the Activity panel", () => {
    saveable();
    fixture.advanced = false;
    const markup = render(run);
    expect(markup).not.toContain(CARD);
    expect(fixture.verify).toBeNull();
  });

  it("renders a sent citation as a badge and keeps raw metadata out of edit actions", () => {
    const citation = citationAttachment(
      { ownerType: "bot", ownerId: bot.id, threadId: bot.threadId, messageId: "source" },
      createCitationTextSelector("source quote", 0, 12)!,
      "note",
    );
    const markup = render([asked("cited", serializeCitation(citation))]);
    expect(markup).toContain("Open citation: source quote");
    expect(markup).not.toContain("omb-citation-v1");
    expect(markup).not.toContain(`aria-label="${t("chat.editMessage")}"`);
  });

  it("appears once the bot runs a control CLI, with the run as a checklist and its verified steps tagged", () => {
    const markup = render(run);
    expect(markup).toContain(CARD);
    expect(markup).toContain('class="pointer-events-none absolute inset-x-0 bottom-0 z-[2] chat-column-dock"');
    expect(markup).toContain(`>${t("chat.verify.title")}<`);
    expect(markup).toContain("2 steps · 2 verified · 1 failed");
    expect(markup).not.toContain("Execution timeline");
    expect(markup).toContain(">doctor<");
    expect(markup).toContain(">send<");
    expect(markup.match(new RegExp(TAG, "g"))).toHaveLength(2);
    expect(markup).not.toContain(">git status<");
    expect(markup).not.toContain(">cat<");
    expect(markup).not.toContain(t("chat.verify.save"));
  });

  it("withholds Save when skill authoring is switched off in Settings", () => {
    fixture.state = { instances: [agentsEngine], config: { features: { skillAuthoring: false } } as AppState["config"] };
    const markup = render(run);
    expect(markup).toContain(">doctor<");
    expect(markup).not.toContain(t("chat.verify.save"));
  });

  it("offers Save with an agents engine; Save fills the thread's composer with the run and the request instead of sending", () => {
    saveable();
    const markup = render(run);
    expect(markup).toContain(t("chat.verify.save"));
    expect(markup).toContain(t("chat.verify.saveHint"));
    expect(fixture.verify?.canSave).toBe(true);

    fixture.verify!.onSave();
    expect(fixture.appendComposerDraft).toHaveBeenCalledTimes(1);
    expect(fixture.appendComposerDraft).toHaveBeenCalledWith("bot:bot:t1", skillPrompt(runSteps(run), askText(run)));
    expect(draft().startsWith("Create a verification skill from the run below.\nGoal: verify the fixture\n")).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("records a run with no control CLI in it too, and saves that one in plain words the server expands like /learn", () => {
    saveable();
    const markup = render(release);
    expect(markup).toContain(CARD);
    expect(markup).toContain(`>${t("chat.verify.title")}<`);
    expect(markup).toContain("2 steps · 1 failed");
    expect(markup).toContain(">git push<");
    expect(markup).toContain(">npm publish<");
    expect(markup).not.toContain(TAG);

    fixture.verify!.onSave();
    expect(draft().startsWith(`${SAVE_RUN_AS_SKILL_LINE}\nGoal: publish the release\n`)).toBe(true);
    expect(draft()).not.toContain("/learn");
    expect(draft()).toContain("✓ git push — git push origin main\n");
    expect(draft()).toContain("✗ npm publish — npm publish\n");
    expect(draft()).not.toContain("Create a verification skill");
  });

  it("stays out of a thread whose run is one unverified command", () => {
    const markup = render([asked("u1", "push it"), chip("c1", "git push origin main", true), chip("c2", "git status", true)]);
    expect(markup).not.toContain(CARD);
  });

  it("records only the current ask: the person's next message starts a fresh run", () => {
    const markup = render([...run, asked("u2", "now push"), chip("c5", "git push origin main", true)]);
    expect(markup).not.toContain(CARD);
    expect(render([...run, asked("u2", "now publish"), chip("c5", "git push origin main", true), chip("c6", "npm publish", true)]))
      .toContain("2 steps<");
  });

  it("hides the card when 'This run' is turned off in Appearance", () => {
    fixture.showRunCard = false;
    const markup = render(run);
    expect(markup).not.toContain(CARD);
    expect(markup).toContain('class="pointer-events-none absolute inset-x-0 bottom-0 z-[2] chat-column-dock"');
  });

  it("shows the card by default", () => {
    const markup = render(run);
    expect(markup).toContain(CARD);
    expect(markup).toContain(`>${t("chat.verify.title")}<`);
  });
});
