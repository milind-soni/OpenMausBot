// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { AccountsSheet } from "./AccountMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; });

it("the accounts sheet takes focus when it opens, Escape closes it, and focus returns to what opened it", async () => {
  setLocale("en");
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), onClose = vi.fn();
  await act(async () => { root.render(createElement(AccountsSheet, { onClose })); });
  const sheet = document.querySelector<HTMLElement>("[data-accounts-sheet]")!;
  expect(sheet.contains(document.activeElement)).toBe(true);
  await act(async () => { sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => { root.unmount(); });
  expect(document.activeElement).toBe(opener);
});
