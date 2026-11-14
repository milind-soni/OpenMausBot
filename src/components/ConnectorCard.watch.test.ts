// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ api }));
const { ConnectorCard } = await import("./ConnectorCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const statusChecks = () => api.mock.calls.filter(([path]) => String(path).includes("/status?")).length;

async function render(connector: Partial<NonNullable<Message["connector"]>>) {
  const message: Message = {
    id: "m1", role: "bot", kind: "connector", at: 1,
    connector: { slug: "whatsapp", label: "WhatsApp", description: "Send messages", status: "authorizing", resumeKey: "r1", alias: "business", ...connector },
  };
  await act(async () => root.render(createElement(ConnectorCard, { botId: "atlas", threadId: "thread", message })));
}

beforeEach(() => {
  setLocale("en");
  vi.useFakeTimers();
  api.mockReset();
  api.mockResolvedValue({ connected: false, pending: true, status: "INITIALIZING" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("keeps checking while the sign-in link can still finish, so an expired link is reported instead of waiting forever", async () => {
  await render({});
  await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60 * 1_000); });
  const nineMinutes = statusChecks();
  expect(nineMinutes).toBeGreaterThan(75);
  await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 1_000); });
  expect(statusChecks()).toBeGreaterThan(nineMinutes);
  const watched = statusChecks();
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1_000); });
  expect(statusChecks()).toBe(watched);
});

it("checks again when the person comes back from the browser, even after the watch window", async () => {
  await render({});
  await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60 * 1_000); });
  const before = statusChecks();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(statusChecks()).toBe(before + 1);
});

it("stops checking once the account is connected", async () => {
  api.mockResolvedValue({ connected: true });
  await render({});
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(statusChecks()).toBe(1);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(statusChecks()).toBe(1);
});

it("does not spin Open again while it is only waiting for the sign-in", async () => {
  await render({});
  const button = Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(t("connectors.card.openAgain")))!;
  expect(button.querySelector(".animate-spin")).toBeNull();
  expect(host.textContent).toContain(t("connectors.card.waiting"));
});

it("does not watch a card that is not waiting for a sign-in", async () => {
  await render({ status: "required" });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); window.dispatchEvent(new Event("focus")); });
  expect(statusChecks()).toBe(0);
});
