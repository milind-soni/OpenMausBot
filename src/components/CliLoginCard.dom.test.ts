// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { CliLoginPrompt } from "./CliLoginCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("shows the terminal's code and what it would get, and Allow answers that one request", async () => {
  setLocale("en");
  const waiting = { id: "req-1234567890abcdef", code: "KQ7M-X2PD", label: "openmausbot CLI on studio", scopes: ["admin", "client"], local: true, source: "127.0.0.1", createdAt: Date.now(), expiresAt: Date.now() + 600_000 };
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === "POST" ? { ok: true, state: "allowed" } : { requests: [waiting] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(CliLoginPrompt)); });
  await act(async () => { await Promise.resolve(); });
  const card = document.querySelector<HTMLElement>("[data-notice='cli-login']")!;
  expect(card.textContent).toContain("A terminal wants to control MausBot");
  expect(card.querySelector("[data-cli-login-code]")!.textContent).toBe("KQ7M-X2PD");
  expect(card.textContent).toContain("Full control · openmausbot CLI on studio");
  const allow = [...card.querySelectorAll("button")].find((button) => button.textContent === "Allow")!;
  await act(async () => { allow.click(); });
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/cli-login/req-1234567890abcdef/allow", expect.objectContaining({ method: "POST" }));
  expect(document.querySelector("[data-notice='cli-login']")).toBeNull();
  await act(async () => { root.unmount(); });
});
