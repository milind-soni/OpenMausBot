// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BugReportDialog } from "./BugReportDialog";

const PREVIEW: BugReportPreview = { installId: "env-1", appVersion: "0.1.109", platform: "darwin-arm64", diagnostics: "OpenMausBot diagnostics\nversion=0.1.109" };
let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn<() => void>();
const sendBugReport = vi.fn<(input: BugReportInput) => Promise<BugReportResult>>();
const previewBugReport = vi.fn<(input: Pick<BugReportInput, "threadId" | "includeChatLog">) => Promise<BugReportPreview>>();

const field = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
const checkbox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]');
const settle = async () => { for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field(), value);
  flushSync(() => field().dispatchEvent(new Event("input", { bubbles: true })));
};
const submit = () => flushSync(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const render = (threadId?: string) => flushSync(() => root.render(createElement(BugReportDialog, { threadId, onClose })));

beforeEach(() => {
  setLocale("en");
  sendBugReport.mockReset();
  previewBugReport.mockReset().mockResolvedValue(PREVIEW);
  onClose.mockReset();
  Object.assign(window, { ogb: { sendBugReport, previewBugReport } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, "ogb");
});

describe("Send a bug report", () => {
  it("asks what went wrong, starts in the field, and sends nothing until there is something to send", () => {
    render();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Send a bug report");
    expect(document.body.textContent).toContain("What went wrong?");
    expect(document.activeElement).toBe(field());
    expect(button("Send")!.disabled).toBe(true);
    expect(checkbox()).toBeNull();
    submit();
    expect(sendBugReport).not.toHaveBeenCalled();
  });

  it("offers the open conversation, off by default, and sends it only when ticked", async () => {
    render("thread-7");
    expect(document.body.textContent).toContain("Include this chat’s conversation");
    expect(checkbox()!.checked).toBe(false);
    sendBugReport.mockResolvedValue({ ok: false, error: "The OpenMausBot team's server could not take the report right now." });
    type("  The sign-in loops.  ");
    submit();
    expect(sendBugReport).toHaveBeenLastCalledWith({ description: "The sign-in loops.", source: "button", threadId: "thread-7", includeChatLog: false });
    await settle();
    flushSync(() => checkbox()!.click());
    submit();
    expect(sendBugReport).toHaveBeenLastCalledWith({ description: "The sign-in loops.", source: "button", threadId: "thread-7", includeChatLog: true });
  });

  it("shows sending, then the thanks once the team's server took it", async () => {
    render();
    let answer!: (result: BugReportResult) => void;
    sendBugReport.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    type("Team tools never connect.");
    submit();
    expect(button("Sending…")!.disabled).toBe(true);
    expect(field().disabled).toBe(true);
    flushSync(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).not.toHaveBeenCalled();
    answer({ ok: true, id: "br_1" });
    await settle();
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Thanks — the report reached the OpenMausBot team.");
    expect(document.activeElement).toBe(button("Close"));
    flushSync(() => button("Close")!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps what was written after a failure, says why, and tries again", async () => {
    render();
    sendBugReport.mockResolvedValueOnce({ ok: false, error: "Too many reports were sent from this computer. Try again in 10 minutes.", retryAfter: 600 });
    type("It crashed.");
    submit();
    await settle();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("Too many reports were sent from this computer. Try again in 10 minutes.");
    expect(field().value).toBe("It crashed.");
    sendBugReport.mockResolvedValueOnce({ ok: true, id: "br_2" });
    flushSync(() => button("Try again")!.click());
    await settle();
    expect(sendBugReport).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Thanks — the report reached the OpenMausBot team.");
  });

  it("shows exactly what is sent, and the conversation too once it is ticked", async () => {
    render("thread-7");
    type("It crashed.");
    expect(previewBugReport).not.toHaveBeenCalled();
    const details = document.querySelector("details")!;
    expect(details.querySelector("summary")!.textContent).toBe("See exactly what’s sent");
    details.open = true;
    flushSync(() => details.dispatchEvent(new Event("toggle")));
    await settle();
    expect(previewBugReport).toHaveBeenLastCalledWith({ threadId: "thread-7", includeChatLog: false });
    const shown = () => document.querySelector('[data-testid="bug-report-preview"]')!.textContent!;
    expect(shown()).toContain("It crashed.");
    expect(shown()).toContain("installId=env-1");
    expect(shown()).toContain("version=0.1.109");
    expect(shown()).not.toContain("This conversation");
    previewBugReport.mockResolvedValue({ ...PREVIEW, chatLog: "**You:** hello" });
    flushSync(() => checkbox()!.click());
    await settle();
    expect(previewBugReport).toHaveBeenLastCalledWith({ threadId: "thread-7", includeChatLog: true });
    expect(shown()).toContain("This conversation");
    expect(shown()).toContain("**You:** hello");
  });
});
