// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));

const { ApprovalCard } = await import("./ApprovalCard");

const now = Date.now();
const bot = { id: "bot-1", name: "Scout", hidden: false };
const routine = {
  id: "routine-1", name: "Morning brief", prompt: "Summarize the inbox and post the three priorities.", target: "bot", botId: "bot-1", runOn: "maus",
  enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: now + 3_600_000,
  createdAt: now, updatedAt: now,
};
const webhook = {
  id: "hook-1", endpointId: "wh_abc", name: "Interested replies", prompt: "Draft a follow-up for the lead.", botId: "bot-1", runOn: "maus",
  enabled: true, createdAt: now, updatedAt: now, deliveryCount: 0,
};
const base = { version: 1 as const, requestId: "request-1", botId: "bot-1", threadId: "thread-1", createdAt: now };
function card(extra: Partial<NonNullable<Message["card"]>>): Message {
  return {
    id: "card-1", role: "bot", kind: "options", at: now,
    card: { title: "Trigger", subtitle: "", options: [], answered: "allow", dismissed: true, autoApplied: true, requestId: "request-1", ...extra },
  };
}
const scheduleCard = card({ tool: "schedule_routine", routineRequest: { ...base, resultId: "routine-1", operation: { action: "create", routine: {
  name: "Morning brief", instructions: routine.prompt, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, runOn: "maus", durationMinutes: 30,
} }, undo: { name: "Morning brief" } } });
const webhookCard = card({ tool: "create_trigger", webhookRequest: { ...base, resultId: "hook-1", operation: { action: "create", webhook: { name: "Interested replies", instructions: webhook.prompt, runOn: "maus" } }, undo: { name: "Interested replies" } } });

const render = (message: Message) => renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Scout" }, message, threadId: "thread-1" }));
let root: Root | null = null;
/** Mounts the card for real and clicks the button with this label, so the click runs through React as a person's would. */
function click(message: Message, label: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(ApprovalCard, { bot: { name: "Scout" }, message, threadId: "thread-1" })));
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`no ${label} button in ${container.innerHTML}`);
  flushSync(() => button.click());
}
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; });

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({});
  fixture.state = { bots: [bot], routines: [routine], webhooks: [webhook], routineRuns: [], routinesLoadState: "ready" };
});

describe("the chat card a bot-made automation leaves", () => {
  const sentence = "Every weekday at 9 AM, Scout summarizes the inbox and posts the three priorities";

  it("says what was set up in one sentence, what happens next, and offers Pause, Edit and Undo — never a confirmation", () => {
    const html = render(scheduleCard);
    expect(html).toContain('data-trigger-card="routine-1"');
    expect(html).toContain(`Set up: ${sentence}`);
    expect(html).toContain("Next: ");
    for (const label of ["Pause", "Edit", "Undo"]) expect(html).toContain(`${label}</button>`);
    expect(html).not.toMatch(/TRIGGER ON|Trigger on|Open in Triggers|Confirm/);
  });

  it("updates as runs come in: last ran, its one-line result and the next run, on one line", () => {
    fixture.state.routineRuns = [
      { id: "run-2", routineId: "routine-1", botId: "bot-1", status: "completed", scheduledFor: now - 60_000, startedAt: now - 60_000, createdAt: now - 60_000, threadId: "exec-2", output: "Three priorities: invoices, hiring, launch.\nMore detail." },
    ];
    const html = render(scheduleCard);
    expect(html).toMatch(/Last ran today [^<]* ✓ Three priorities: invoices, hiring, launch\. · next: /);
    expect(html).not.toContain("More detail.");
    expect(html).not.toContain("Next: ");
  });

  it("says Needs you with the plain reason when a run is waiting on the person", () => {
    fixture.state.routineRuns = [{ id: "run-3", routineId: "routine-1", botId: "bot-1", status: "waiting", attention: "Approve the reply to Ada?", scheduledFor: now, createdAt: now }];
    expect(render(scheduleCard)).toContain("Needs you: It&#x27;s waiting for your answer.");
  });

  it("pauses through its own API, applies the answer at once, and says Paused with Resume once paused", async () => {
    fixture.api.mockResolvedValue({ routine: { ...routine, enabled: false } });
    click(scheduleCard, "Pause");
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "routinePatched", routine: { ...routine, enabled: false } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/routines/routine-1", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    fixture.state.routines = [{ ...routine, enabled: false }];
    const html = render(scheduleCard);
    expect(html).toContain(">Paused<");
    expect(html).toContain("Resume</button>");
  });

  it("says why when turning it back on is refused", async () => {
    fixture.state.routines = [{ ...routine, enabled: false }];
    fixture.api.mockRejectedValue(new Error("Its time has passed. Edit it to pick a new time."));
    click(scheduleCard, "Resume");
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toBe("Its time has passed. Edit it to pick a new time."));
  });

  it("says Done, with no Pause or Resume, once a one-time automation has happened", () => {
    fixture.state.routines = [{ ...routine, enabled: false, nextRunAt: null, schedule: { type: "once", at: now - 60_000 } }];
    fixture.state.routineRuns = [{ id: "run-4", routineId: "routine-1", botId: "bot-1", status: "completed", scheduledFor: now - 60_000, startedAt: now - 60_000, createdAt: now - 60_000, output: "Sent." }];
    const html = render(scheduleCard);
    expect(html).toMatch(/>Done · Last ran today [^<]* ✓ Sent\.</);
    expect(html).not.toMatch(/(Pause|Resume)<\/button>/);
  });

  it("undoes through the conversation's undo route with the card's request id", () => {
    click(scheduleCard, "Undo");
    expect(fixture.api).toHaveBeenCalledWith("/api/threads/thread-1/undo", { method: "POST", body: JSON.stringify({ requestId: "request-1" }) });
  });

  it("opens the automation's panel on the Automations page from the sentence itself", () => {
    click(scheduleCard, `Set up: ${sentence}`);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "list", routineId: "routine-1" });
  });

  it("says when another app sends something, offers Copy address, and shows no address or secret on the card", () => {
    const html = render(webhookCard);
    expect(html).toContain("Set up: When another app sends something, Scout drafts a follow-up for the lead");
    expect(html).toContain(">Hasn&#x27;t run yet<");
    expect(html).toContain("Copy address</button>");
    expect(html).not.toMatch(/whsec_|wh_abc|webhook/i);
  });

  it("pauses one another app sends to through its own API", async () => {
    fixture.api.mockResolvedValue({ webhook: { ...webhook, enabled: false } });
    click(webhookCard, "Pause");
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "webhookPatched", webhook: { ...webhook, enabled: false } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/webhooks/hook-1", { method: "PATCH", body: JSON.stringify({ enabled: false, verificationPending: false }) });
  });

  it("collapses to one muted line once undone, or when the automation is gone", () => {
    expect(render({ ...scheduleCard, card: { ...scheduleCard.card!, undone: true } })).toContain("Automation removed · undone");
    fixture.state.routines = [];
    const gone = render(scheduleCard);
    expect(gone).toContain("This automation no longer exists");
    expect(gone).not.toContain("Pause</button>");
  });

  it("opens Edit over the whole page, never inside the transcript the card sits in", async () => {
    fixture.state = { ...fixture.state, groups: [], sections: [] };
    click(scheduleCard, "Edit");
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).not.toBeNull(), { timeout: 5_000 });
    expect(document.querySelector("[data-trigger-card] [role=dialog]")).toBeNull();
    expect(document.querySelector("[role=dialog]")!.closest("body > div:not(:has([data-trigger-card]))")).not.toBeNull();
  });

  it("never shows an automation whose bot was deleted", () => {
    fixture.state.bots = [];
    expect(render(scheduleCard)).toContain("This automation no longer exists");
    expect(render(webhookCard)).toContain("This automation no longer exists");
  });
});
