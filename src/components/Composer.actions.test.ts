// @vitest-environment happy-dom
// The round buttons at the end of the message box keep one order and one place in every state, with one Stop while a turn runs.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), advanced: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot], instances: [{
      instanceId: "fake", driverKind: "claude", displayName: "Fake", capabilities: {},
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/lib/use-slash-skills", () => ({ useSlashSkills: () => [] }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", async () => {
  const { createElement: h } = await import("react");
  return { CallButton: () => h("button", { "data-call-button": "composer", "aria-label": "Call" }) };
});
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  const capabilities = { ...initialDesktopCapabilities(), dictation: { available: true, engine: "apple-speech", onDevice: true } };
  return { useDesktopCapabilities: () => ({ capabilities, ready: true }) };
});

import { Composer } from "./Composer";

const bot: Bot = {
  id: "actions-bot", threadId: "actions-thread", name: "Fixture", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "fake", model: "fake" },
};
const draftId = `bot:${bot.id}:${bot.threadId}`;

let root: Root;
let container: HTMLDivElement;
const render = (busy: boolean) => flushSync(() => root.render(createElement(Composer, { bot: { ...bot, busy } })));
const type = (text: string) => flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));

/** The row as names, left to right; the Send button and its follow-up chevron count as two places. */
function row(): string[] {
  const actions = container.querySelector("[data-composer-actions]")!;
  return [...actions.children].flatMap((el) => {
    if (el.matches("[data-composer-stop]")) return ["stop"];
    if (el.matches("[data-composer-follow-up-slot]")) return ["follow-up"];
    if (el.matches("[data-composer-follow-up]")) return ["follow-up", "send"];
    if (el.matches("[data-call-button]")) return ["end"];
    if (el.matches(`button[aria-label="${t("composer.send.message")}"]`)) return ["end"];
    const label = el.querySelector("button")?.getAttribute("aria-label") ?? el.getAttribute("aria-label");
    if (label === t("composer.dictation.start") || label === t("composer.dictation.stop")) return ["mic"];
    return ["context"];
  }).map((name) => name === "send" ? "end" : name);
}
const stops = () => container.querySelectorAll(`button[aria-label="${t("chat.stopTurn")}"]`).length;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  window.ogb = {
    speechStart: vi.fn().mockResolvedValue(undefined), speechStop: vi.fn().mockResolvedValue(undefined),
    onSpeechTranscript: () => vi.fn(), onSpeechEnd: () => vi.fn(),
  } as unknown as typeof window.ogb;
  restoreComposerDraft(draftId, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  restoreComposerDraft(draftId, { text: "", attachments: [] });
  delete window.ogb;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([false, true])("the end of the message box (Advanced %s)", (advanced) => {
  beforeEach(() => { fixture.advanced = advanced; });

  it("keeps one order in every state, adding only Stop in front and the follow-up place while a turn runs", () => {
    const idle = ["context", "mic", "end"];
    const running = ["stop", "context", "mic", "follow-up", "end"];
    render(false);
    expect(row(), "empty").toEqual(idle);
    type("a draft");
    expect(row(), "typing").toEqual(idle);
    type("");
    render(true);
    expect(row(), "running, empty").toEqual(running);
    type("and also this");
    expect(row(), "running, typing").toEqual(running);
    flushSync(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.dictation.start")}"]`)!.click());
    expect(container.querySelector(`button[aria-label="${t("composer.dictation.stop")}"]`), "dictating").not.toBeNull();
    expect(row(), "running, dictating").toEqual(running);
    render(false);
    expect(row(), "dictating").toEqual(idle);
  });

  it("shows a single Stop only while a turn runs, in one look whether or not there is text", () => {
    render(false);
    expect(stops()).toBe(0);
    render(true);
    expect(stops()).toBe(1);
    const empty = container.querySelector("[data-composer-stop]")!;
    const look = [empty.className, empty.getAttribute("style")];
    type("and also this");
    expect(stops()).toBe(1);
    const typing = container.querySelector("[data-composer-stop]")!;
    expect([typing.className, typing.getAttribute("style")]).toEqual(look);
    flushSync(() => (typing as HTMLButtonElement).click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "interrupt", botId: bot.id, threadId: bot.threadId });
  });

  it("keeps Send in the bot's colour while a message would wait, with a clock in place of the arrow", () => {
    type("a draft");
    render(false);
    const idle = container.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.send.message")}"]`)!;
    const look = [idle.className, idle.getAttribute("style")];
    render(true);
    const send = container.querySelector("[data-composer-follow-up] > button:last-child")!;
    expect([send.className, send.getAttribute("style")]).toEqual(look);
  });
});
