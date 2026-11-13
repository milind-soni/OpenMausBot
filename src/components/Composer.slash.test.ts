// @vitest-environment happy-dom
// The / menu in the real composer: skills can be picked anywhere in a message, built-in commands only at its start.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";

const skillFixture = vi.hoisted(() => ({ status: "ready" as "ready" | "error" | "loading", retry: vi.fn() }));

const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot], instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/use-slash-skills", () => ({
  useSlashSkills: (_botId: string | undefined, _threadId: string, active: boolean) =>
    ({ skills: active && skillFixture.status === "ready" ? [{ name: "standup", description: "Writes the weekly standup note." }] : [], status: active ? skillFixture.status : "idle", retry: skillFixture.retry }),
}));
vi.mock("./CallView", () => ({ CallButton: () => null }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "slash-bot", threadId: "slash-thread", name: "Atlas", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const draftId = `bot:${bot.id}:${bot.threadId}`;

describe("the / menu in the composer", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    skillFixture.status = "ready"; skillFixture.retry.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(Composer, { bot })));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fill(text: string, caret = text.length) {
    flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
    const input = container.querySelector("textarea")!;
    input.setSelectionRange(caret, caret);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keyup", { key: "/", bubbles: true })));
    return input;
  }
  const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
  const labels = () => options().map((option) => option.querySelector(".truncate")?.textContent);

  it("shows a failed skill request with Retry instead of silently hiding it", () => {
    skillFixture.status = "error";
    fill("/");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load skills");
    expect(labels()).toContain("/goal");
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!;
    flushSync(() => retry.click());
    expect(skillFixture.retry).toHaveBeenCalledOnce();
  });

  it("offers the built-in commands and skills at the start of a message", () => {
    fill("/");
    expect(labels()).toEqual(["/goal", "/learn", "/setup", "/burst", "/standup"]);
  });

  it("offers only skills after a space later in the message, and puts the pick in place", () => {
    const input = fill("write it up with /");
    expect(labels()).toEqual(["/standup"]);
    flushSync(() => options()[0]!.click());
    expect(input.value).toBe("write it up with /standup ");
  });

  it("adds no second space when text already follows the pick", () => {
    const input = fill("use /st later", "use /st".length);
    flushSync(() => options()[0]!.click());
    expect(input.value).toBe("use /standup later");
  });

  it("opens nothing inside a path or link", () => {
    fill("open notes/st");
    expect(options()).toEqual([]);
    fill("see https://x.test/");
    expect(options()).toEqual([]);
  });
});
