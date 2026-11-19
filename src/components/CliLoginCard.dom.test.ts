// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { CLI_LOGIN_LAYER, CliLoginPrompt } from "./CliLoginCard";
import { Layer } from "./Layer";

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

const SRC = join(process.cwd(), "src");
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(tsx|css)$/.test(name) && !/\.test\./.test(name) && name !== "CliLoginCard.tsx") yield path;
  }
}
const zOf = (layer: string) => Number(/^z-\[?(\d+)\]?$/.exec(layer)?.[1]);

it("stays above Settings and every dialog, and its Allow still answers with one open", async () => {
  const dialogLayers: number[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    for (const [, z] of text.matchAll(/fixed inset-0\b[^"`\n]*?\bz-\[?(\d+)\]?/g)) dialogLayers.push(Number(z));
    for (const [, z] of text.matchAll(/(?:LAYER = |layer=)"z-\[?(\d+)\]?"/g)) dialogLayers.push(Number(z));
    for (const [, z] of text.matchAll(/^\.glass-popup-frame \{[^}]*?z-index: (\d+)/gm)) dialogLayers.push(Number(z));
  }
  expect(dialogLayers).toContain(50);
  expect(zOf(CLI_LOGIN_LAYER)).toBeGreaterThan(Math.max(...dialogLayers));

  setLocale("en");
  const waiting = { id: "req-over-settings", code: "AB12-CD34", label: "openmausbot CLI", scopes: ["client"], local: true, source: "127.0.0.1", createdAt: Date.now(), expiresAt: Date.now() + 600_000 };
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === "POST" ? { ok: true, state: "allowed" } : { requests: [waiting] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const settings = createElement(Layer, { modal: true, children: createElement("div", { className: "glass-popup-frame", "data-settings-sheet": "" }) });
  await act(async () => { root.render([createElement(CliLoginPrompt, { key: "card" }), createElement("div", { key: "settings" }, settings)]); });
  await act(async () => { await Promise.resolve(); });
  expect(document.querySelector("[data-settings-sheet]")).not.toBeNull();
  const card = document.querySelector<HTMLElement>("[data-notice='cli-login']")!;
  const classes = card.className.split(/\s+/);
  expect(classes).toContain(CLI_LOGIN_LAYER);
  expect(classes).not.toContain("z-40");
  const allow = [...card.querySelectorAll("button")].find((button) => button.textContent === "Allow")!;
  await act(async () => { allow.click(); });
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/cli-login/req-over-settings/allow", expect.objectContaining({ method: "POST" }));
  await act(async () => { root.unmount(); });
});
