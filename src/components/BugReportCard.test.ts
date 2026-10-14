// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const settleBugReportCard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/bug-report", async (original) => ({
  ...await original<typeof import("@/lib/bug-report")>(),
  settleBugReportCard: (...args: unknown[]) => settleBugReportCard(...args),
}));

import { BugReportCard } from "./BugReportCard";

const sendBugReport = vi.fn<(input: BugReportInput) => Promise<BugReportResult>>();
const draft = (bugReport: Partial<NonNullable<Message["bugReport"]>> = {}): Message => ({
  id: "card-1",
  role: "bot",
  kind: "bugreport",
  at: 1,
  text: "Scout drafted a bug report for the OpenMausBot team: “Team tools did not connect”.",
  bugReport: { summary: "Team tools did not connect", details: "coordinate_bots failed with ECONNREFUSED.", ...bugReport },
});
const props = (bugReport?: Partial<NonNullable<Message["bugReport"]>>) => ({ botId: "scout", botName: "Scout", threadId: "thread-1", message: draft(bugReport) });
const view = (bugReport?: Partial<NonNullable<Message["bugReport"]>>) => renderToStaticMarkup(createElement(BugReportCard, props(bugReport)));
const settle = async () => { for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  setLocale("en");
  sendBugReport.mockReset();
  settleBugReportCard.mockReset().mockResolvedValue(undefined);
  Object.assign(window, { ogb: { sendBugReport, previewBugReport: vi.fn() } });
});
afterEach(() => Reflect.deleteProperty(window, "ogb"));

describe("BugReportCard while it waits", () => {
  it("shows the bot's draft in an editor with Dismiss and Send, and says nothing is sent until Send", () => {
    const html = view();
    expect(html).toContain("Bug report draft");
    expect(html).toContain("Scout wrote this about a problem in OpenMausBot itself.");
    expect(html).toContain("nothing reaches the OpenMausBot team until you press Send");
    expect(html).toMatch(/<textarea[^>]*>Team tools did not connect\n\ncoordinate_bots failed with ECONNREFUSED\.<\/textarea>/);
    expect(html).toContain("Include this chat’s conversation");
    expect(html).toContain("See exactly what’s sent");
    for (const label of [">Dismiss<", ">Send<"]) expect(html).toContain(label);
  });

  it("off the desktop app shows the text, says where to send it, and offers no Send", () => {
    Reflect.deleteProperty(window, "ogb");
    const html = view();
    expect(html).not.toContain("<textarea");
    expect(html).toMatch(/data-testid="bug-report-draft"[^>]*>Team tools did not connect\n\ncoordinate_bots failed/);
    expect(html).toContain("To send it, open this conversation in the OpenMausBot desktop app.");
    expect(html).toContain(">Dismiss<");
    expect(html).not.toContain(">Send<");
  });
});

describe("BugReportCard once answered", () => {
  it.each([
    [{ sent: true, resumed: true }, "Bug report sent · Scout is continuing"],
    [{ sent: true }, "Bug report sent"],
    [{ dismissed: true }, "Bug report dismissed"],
    [{ superseded: true }, "Bug report draft · Replaced by a newer draft"],
    [{ stopped: true }, "Bug report draft · Stopped"],
  ])("%o reads as one settled line", (state, line) => {
    const html = view(state);
    expect(html).toContain('data-ask-card="settled"');
    expect(html.replace(/<[^>]+>/g, "")).toContain(line);
    expect(html).not.toContain("<textarea");
  });
});

describe("BugReportCard answers", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => root.render(createElement(BugReportCard, props())));
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label)!;
  const ref = { botId: "scout", threadId: "thread-1", messageId: "card-1" };

  it("sends what the person edited as the bot's report, then records it with the report id", async () => {
    const field = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "  Edited by the person.  ");
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
    sendBugReport.mockResolvedValue({ ok: true, id: "br_5" });
    flushSync(() => button("Send").click());
    await settle();
    expect(sendBugReport).toHaveBeenCalledExactlyOnceWith({ description: "Edited by the person.", source: "bot", threadId: "thread-1", includeChatLog: false });
    expect(settleBugReportCard).toHaveBeenCalledExactlyOnceWith(ref, "sent", "br_5");
  });

  it("records nothing when the send fails, and after a failed record retries the record only", async () => {
    sendBugReport.mockResolvedValueOnce({ ok: false, error: "Could not reach the OpenMausBot team's server. Check your internet connection and try again." });
    flushSync(() => button("Send").click());
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Could not reach the OpenMausBot team's server");
    expect(settleBugReportCard).not.toHaveBeenCalled();

    sendBugReport.mockResolvedValueOnce({ ok: true, id: "br_6" });
    settleBugReportCard.mockRejectedValueOnce(new Error("network down"));
    flushSync(() => button("Try again").click());
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("network down");
    expect(host.querySelector("textarea")!.disabled).toBe(true);
    flushSync(() => button("Try again").click());
    await settle();
    expect(sendBugReport).toHaveBeenCalledTimes(2);
    expect(settleBugReportCard).toHaveBeenLastCalledWith(ref, "sent", "br_6");
    expect(settleBugReportCard).toHaveBeenCalledTimes(2);
  });

  it("dismisses without sending", async () => {
    flushSync(() => button("Dismiss").click());
    await settle();
    expect(settleBugReportCard).toHaveBeenCalledExactlyOnceWith(ref, "dismissed");
    expect(sendBugReport).not.toHaveBeenCalled();
  });
});
