// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { isToolStep } from "@/lib/activity-runs";
import type { CheckBackLine as Line } from "../../shared/check-back";

const api = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args) }));
const { CheckBackLine, checkBackWhen } = await import("./CheckBackLine");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { setLocale("en"); api.mockClear(); });
afterEach(() => { document.body.innerHTML = ""; });

const NOW = new Date(2026, 10, 19, 14, 0).getTime();
const line = (over: Partial<Line> = {}): Line => ({ id: "cb1", dueAt: new Date(2026, 10, 20, 9, 0).getTime(), status: "pending", note: "chase the client", ...over });

async function draw(value: Line) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(CheckBackLine, { line: value })); });
  return host;
}

it("is one quiet line with the day and time and a Cancel, the note as its tooltip, and no card or question", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    const host = await draw(line());
    const row = host.querySelector<HTMLElement>("[data-check-back]")!;
    expect(row.dataset.checkBack).toBe("pending");
    expect(row.textContent).toBe("Will check back Fri 9:00 AM·Cancel");
    expect(row.title).toBe("chase the client");
    expect(host.querySelectorAll("button")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("Cancel posts to the line's own route", async () => {
  const host = await draw(line());
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-check-back-cancel]")!.click(); });
  expect(api).toHaveBeenCalledWith("/api/check-backs/cb1/cancel", { method: "POST" });
});

it("says what happened once it ran, was cancelled or could not start, with nothing to press", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    expect((await draw(line({ status: "started", startedAt: new Date(2026, 10, 20, 9, 2).getTime() }))).textContent).toBe("Checked back Fri 9:02 AM");
    expect((await draw(line({ status: "cancelled" }))).textContent).toBe("Check-back cancelled");
    const failed = await draw(line({ status: "failed", why: "This bot is paused." }));
    expect(failed.textContent).toBe("Couldn't check back Fri 9:00 AM");
    expect(failed.querySelector<HTMLElement>("[data-check-back]")!.title).toContain("This bot is paused.");
    expect(document.querySelectorAll("[data-check-back-cancel]")).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("reads today's time alone and a date beyond the week", () => {
  expect(checkBackWhen(new Date(2026, 10, 19, 16, 30).getTime(), NOW)).toBe("4:30 PM");
  expect(checkBackWhen(new Date(2026, 11, 3, 9, 0).getTime(), NOW)).toBe("Thu, Dec 3 9:00 AM");
});

it("is never folded into the turn's tool steps", () => {
  expect(isToolStep({ id: "m", role: "bot", kind: "activity", at: 0, tool: { name: "Will check back", ok: true }, checkBack: line() } as never)).toBe(false);
});
