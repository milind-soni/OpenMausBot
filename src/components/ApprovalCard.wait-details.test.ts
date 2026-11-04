// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import * as session from "@/lib/session";
import type { Message } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.spyOn(session, "readSessionState").mockResolvedValue({ kind: "loopback" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  setLocale("en");
});

const waiting = (persistedAuthor: boolean): Message => ({
  id: "wait-card", at: 1, role: "bot", kind: "options",
  ...(persistedAuthor ? { from: { botId: "pepper", name: "Pepper", color: "green" } } : {}),
  card: {
    title: "Waiting: the build", subtitle: "Then Pepper will: Deploy it.",
    options: [], answered: "allow", dismissed: true, autoApplied: true, requestId: "w1", tool: "wait_until",
    waitRequest: { waitId: "w1", label: "the build", followUp: "Deploy it." },
  },
});

describe.each(["en", "pt-br"] as const)("%s wait details", (locale) => {
  it.each([
    ["renamed", false], ["missing", false], ["renamed", true], ["missing", true],
  ] as const)("opens after the bot is %s, with persisted author %s", async (change, persistedAuthor) => {
    setLocale(locale);
    const message = waiting(persistedAuthor);
    await act(async () => root.render(createElement(ApprovalCard, { bot: { name: "Pepper" }, message, threadId: "t1" })));
    const bot = change === "renamed" ? { name: "Renamed Pepper" } : undefined;
    await act(async () => root.render(createElement(ApprovalCard, { bot, message, threadId: "t1" })));
    const details = [...host.querySelectorAll("button")].find(button => button.textContent === t("approval.applied.details"));
    expect(details).toBeDefined();
    await act(async () => details!.click());
    const content = host.querySelector("pre")?.textContent;
    const localizedName = persistedAuthor ? "Pepper" : bot?.name ?? "Alguém";
    expect(content).toBe(locale === "en" ? message.card!.subtitle : `Depois da espera, ${localizedName} fará o seguinte: Deploy it.`);
    expect(message.card!.subtitle).toBe("Then Pepper will: Deploy it.");
  });
});
