// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const calls = vi.hoisted(() => ({ posts: [] as string[], expired: false }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ refreshInstances: async () => {}, refreshModels: async () => {} }),
  api: async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST") calls.posts.push(path);
    if (path.endsWith("/start")) return { auth: { phase: "waiting", flowId: "flow-1", authorizationUrl: null, expiresAt: calls.expired ? new Date(Date.now() - 1000).toISOString() : null } };
    return {};
  },
}));
import { EngineBrowserSignIn } from "./EngineBrowserSignIn";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; });

async function mounted(name: string) {
  const host = document.createElement("div"); document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => { root.render(createElement(EngineBrowserSignIn, { instanceId: "gemini-antigravity", name })); });
  return { root, host };
}

it("addresses the engine by name in the start copy, not the hardcoded Mistral", async () => {
  setLocale("en");
  const { root, host } = await mounted("Google Gemini (Antigravity)");
  const button = host.querySelector<HTMLButtonElement>("[data-engine-browser-sign-in] button")!;
  expect(button.textContent).toContain("Sign in to Google Gemini (Antigravity)");
  expect(host.textContent).not.toContain("Mistral");
  await act(async () => { button.click(); });
  expect(calls.posts).toContain("/api/instances/gemini-antigravity/auth/start");
  root.unmount();
});

it("names the engine in the expired message, not Mistral", async () => {
  setLocale("en");
  calls.expired = true;
  const { root, host } = await mounted("Google Gemini (Antigravity)");
  const button = host.querySelector<HTMLButtonElement>("[data-engine-browser-sign-in] button")!;
  await act(async () => { button.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(host.textContent).toContain("Google Gemini (Antigravity) sign-in window expired");
  expect(host.textContent).not.toContain("Mistral");
  root.unmount();
  calls.expired = false;
});

it("uses the same name on the retry button after a failed sign-in", async () => {
  setLocale("en");
  const { root, host } = await mounted("Google Gemini (Antigravity)");
  const button = host.querySelector<HTMLButtonElement>("[data-engine-browser-sign-in] button")!;
  await act(async () => { button.click(); });
  // The fake auth status resolves as waiting and never succeeds; the expiry/failed copy still names the engine.
  expect(host.textContent).not.toContain("{name}");
  root.unmount();
});
