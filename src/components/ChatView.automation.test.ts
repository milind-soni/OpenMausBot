// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { t } = await import("@/lib/i18n");

const at = (minute: number) => new Date(2026, 9, 21, 9, minute).getTime();
const line = (runId: string, extra: Partial<NonNullable<Message["automation"]>> = {}): NonNullable<Message["automation"]> => ({
  routineId: "inbox", runId, name: "Inbox brief", trigger: "schedule", executionThreadId: `${runId}-thread`, scheduledFor: at(0), ...extra,
});
const transcript = (tail: Message[]): Message[] => [
  { id: "m1", parentId: null, role: "user", kind: "text", text: "Draft the weekly update.", at: at(1) },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: "Here is the draft.", at: at(2), turnId: "t1", turnTerminal: true },
  ...tail,
];
const pepper = (messages: Message[]): Bot => ({
  id: "pepper", threadId: "main", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)!.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    { threadId: "main", title: "Chat", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
    { threadId: "run-1-thread", title: "Inbox brief · Oct 21", createdAt: 2, busy: false, activity: "idle", routineRunId: "run-1", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
  ],
});

const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(messages: Message[]) {
  const bot = pepper(messages);
  const state: AppState = {
    ...initialState, connected: true, selectedId: "pepper", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await settle();
}
const caption = (runId: string) => document.querySelector<HTMLElement>(`[data-automation-caption="${runId}"]`);
async function regenerateOffers(): Promise<string[]> {
  const found: string[] = [];
  for (const row of document.querySelectorAll("[data-mid]")) {
    const more = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (!more) continue;
    flushSync(() => more.click());
    await settle();
    if ([...row.querySelectorAll("[role=menuitem]")].some((item) => item.textContent === t("chat.regenerate"))) found.push(row.getAttribute("data-mid")!);
    flushSync(() => more.click());
    await settle();
  }
  return found;
}

beforeAll(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("an automation's line in the chat", () => {
  it("is the bot's own message under the automation's name, with its run one click away", async () => {
    await draw(transcript([{ id: "r1", parentId: "m2", role: "bot", kind: "text", text: "Acme replied about the order.", at: at(3), automation: line("run-1") }]));
    const label = caption("run-1");
    expect(label?.textContent).toContain("Inbox brief");
    expect(label?.querySelector("time")?.getAttribute("datetime")).toBe(new Date(at(0)).toISOString());
    expect(document.querySelector('[data-mid="r1"]')?.textContent).toContain("Acme replied about the order.");
    const open = label?.querySelector<HTMLButtonElement>("button");
    expect(open?.textContent).toBe(t("chat.automation.openRun"));
    dispatch.mockClear();
    flushSync(() => open!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "pepper", threadId: "run-1-thread" });
    expect(caption("m2")).toBeNull();
  });

  it("says when the run needs the person or could not finish, and offers no run it cannot open", async () => {
    await draw(transcript([
      { id: "r1", parentId: "m2", role: "bot", kind: "text", text: "Should I send it?", at: at(3), automation: line("run-1", { needsYou: true }) },
      { id: "r2", parentId: "r1", role: "bot", kind: "text", text: "This run didn't finish: signed out.", at: at(4), automation: line("run-gone", { failed: true }) },
    ]));
    expect(caption("run-1")?.textContent).toContain(t("chat.automation.needsYou"));
    expect(caption("run-gone")?.textContent).toContain(t("chat.automation.failed"));
    expect(caption("run-gone")?.querySelector("button")).toBeNull();
  });

  it("never offers Regenerate on a report, which would branch the person's chat away from it", async () => {
    await draw(transcript([]));
    expect(await regenerateOffers()).toEqual(["m2"]);
    await draw(transcript([{ id: "r1", parentId: "m2", role: "bot", kind: "text", text: "Acme replied.", at: at(3), automation: line("run-1") }]));
    expect(await regenerateOffers()).toEqual([]);
  });

  it("stops saying the run needs the person once the copy is answered, or once they wrote after the question", async () => {
    const question = { title: "Your bot has a question", subtitle: "Which account?", options: ["Work", "Home"], requestId: "ask-1", requestType: "question" as const };
    await draw(transcript([{ id: "c1", parentId: "m2", role: "bot", kind: "options", at: at(3), automation: line("run-1", { needsYou: true }), card: { ...question, answered: "answer" } }]));
    expect(caption("run-1")?.textContent).not.toContain(t("chat.automation.needsYou"));
    await draw(transcript([
      { id: "r1", parentId: "m2", role: "bot", kind: "text", text: "Should I send it?", at: at(3), automation: line("run-1", { needsYou: true }) },
      { id: "u1", parentId: "r1", role: "user", kind: "text", text: "Yes, send it.", at: at(4) },
    ]));
    expect(caption("run-1")?.textContent).not.toContain(t("chat.automation.needsYou"));
  });

  it("keeps saying a named sign-in needs the person, whatever they write, until the server settles it", async () => {
    const named = (needsYou: boolean): Message[] => transcript([
      { id: "r1", parentId: "m2", role: "bot", kind: "text", text: "I need you to sign in to example.com.", at: at(3), automation: line("run-1", { copyOf: "card-1", ...(needsYou ? { needsYou: true as const } : {}) }) },
      { id: "u1", parentId: "r1", role: "user", kind: "text", text: "Thanks.", at: at(4) },
    ]);
    await draw(named(true));
    expect(caption("run-1")?.textContent).toContain(t("chat.automation.needsYou"));
    await draw(named(false));
    expect(caption("run-1")?.textContent).not.toContain(t("chat.automation.needsYou"));
  });

  it("labels a copy of a card the run waits on the same way", async () => {
    await draw(transcript([{
      id: "c1", parentId: "m2", role: "bot", kind: "options", at: at(3), automation: line("run-1", { needsYou: true }),
      card: { title: "Your bot has a question", subtitle: "Which account should I check?", options: ["Work", "Home"], requestId: "ask-1", requestType: "question" },
    }]));
    expect(caption("run-1")?.textContent).toContain("Inbox brief");
    expect(document.querySelector('[data-mid="c1"]')?.textContent).toContain("Which account should I check?");
  });
});
