// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { HomeLine, homeLineText } from "./HomeLine";

let host: HTMLDivElement;
let root: Root;
const place = vi.hoisted(() => ({ set: [] as Array<string | null> }));
const ais = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock("@/lib/notify", () => ({ setNotificationPlace: (name: string | null) => place.set.push(name) }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { instances: ais.instances } }) }));
vi.mock("@/components/onboarding/ConnectAi", () => ({ ConnectAiDialog: () => createElement("div", { "data-connect-ai": "" }) }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { ready?: boolean }) => instance.ready === true }));
const mount = async (line: ReturnType<typeof vi.fn>, remote = false, state: Record<string, unknown> = { local: false, name: "My Cloud" }) => {
  window.ogb = { workspaces: { state: vi.fn().mockResolvedValue(state), menu: vi.fn(), line }, ...(remote ? { remoteClient: { active: true } } : {}) } as unknown as typeof window.ogb;
  flushSync(() => root.render(createElement(HomeLine)));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { flushSync(() => root.unmount()); host.remove(); delete window.ogb; });

it("says the one line main has for the next page, in plain words, and nothing when there is none", async () => {
  await mount(vi.fn().mockResolvedValue({ kind: "left", name: "Acme" }));
  await vi.waitFor(() => expect(host.querySelector("[data-home-line='left']")?.textContent).toBe("You're no longer in Acme."));
  expect(host.querySelector("button")).toBeNull();
  flushSync(() => root.unmount()); root = createRoot(host);
  await mount(vi.fn().mockResolvedValue(null));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(host.innerHTML).toBe("");
});

it("asks once; a later null (a strict-mode remount) never takes the line back, and a browser or an older app shows nothing", async () => {
  const line = vi.fn().mockResolvedValueOnce({ kind: "left", name: "Acme" }).mockResolvedValue(null);
  await mount(line);
  await vi.waitFor(() => expect(host.querySelector("[data-home-line]")).not.toBeNull());
  flushSync(() => root.render(createElement(HomeLine)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(host.querySelector("[data-home-line]")).not.toBeNull();
  flushSync(() => root.unmount()); root = createRoot(host);
  window.ogb = { workspaces: { state: vi.fn(), menu: vi.fn() } } as unknown as typeof window.ogb;
  flushSync(() => root.render(createElement(HomeLine)));
  expect(host.innerHTML).toBe("");
  flushSync(() => root.unmount()); root = createRoot(host);
  await mount(vi.fn().mockResolvedValue({ kind: "left", name: "Acme" }), true);
  expect(host.innerHTML, "a phone's view of the page never shows the desktop's line").toBe("");
  expect(homeLineText({ kind: "left", name: "Beta" })).toBe("You're no longer in Beta.");
});

it("a team's page names its notifications after the team; My Cloud's names none", async () => {
  place.set.length = 0;
  await mount(vi.fn().mockResolvedValue(null), false, { local: false, name: "Acme", role: "User" });
  await vi.waitFor(() => expect(place.set).toEqual(["Acme"]));
  flushSync(() => root.unmount()); root = createRoot(host);
  await mount(vi.fn().mockResolvedValue(null));
  await vi.waitFor(() => expect(place.set).toEqual(["Acme", null]));
});

it("the clean workspace's line says the bots are safe in their Cloud, on every load, with no Sign in button: that stays in the You menu", async () => {
  ais.instances = [{ ready: true, instanceId: "claude", driver: "claudeCode" }];
  const line = vi.fn().mockResolvedValue({ kind: "clean" });
  await mount(line);
  await vi.waitFor(() => expect(host.querySelector("[data-home-line='clean']")?.textContent).toBe("Your bots are in the Cloud. Sign in to get them."));
  expect(host.querySelector("button")).toBeNull();
  expect(homeLineText({ kind: "clean" })).toBe("Your bots are in the Cloud. Sign in to get them.");
  expect(homeLineText({ kind: "clean", saved: true })).toBe("Your bots are in your other account's Cloud. Click its icon on the left of the app to get them.");
});

it("with the new-user setup skipped, the clean workspace still offers connecting an AI while none is ready", async () => {
  ais.instances = [{ ready: false, instanceId: "claude", driver: "claudeCode" }];
  await mount(vi.fn().mockResolvedValue({ kind: "clean" }));
  await vi.waitFor(() => expect(host.querySelector("[data-home-line-ai]")?.textContent).toBe("Connect an AI"));
  expect(host.querySelector("[data-connect-ai]")).toBeNull();
  flushSync(() => (host.querySelector("[data-home-line-ai]") as HTMLButtonElement).click());
  expect(host.querySelector("[data-connect-ai]")).not.toBeNull();
});

it("a team's line never offers it", async () => {
  ais.instances = [];
  await mount(vi.fn().mockResolvedValue({ kind: "left", name: "Acme" }));
  await vi.waitFor(() => expect(host.querySelector("[data-home-line='left']")).not.toBeNull());
  expect(host.querySelector("[data-home-line-ai]")).toBeNull();
});

it("in This Mac's own place, the line says it is separate from My Cloud, where the bots from before are, and where an older copy comes in", async () => {
  ais.instances = [{ ready: false, instanceId: "claude", driver: "claudeCode" }];
  await mount(vi.fn().mockResolvedValue({ kind: "profile" }));
  window.ogb = { ...window.ogb, platform: "darwin" } as unknown as typeof window.ogb;
  await vi.waitFor(() => expect(host.querySelector("[data-home-line='profile']")).not.toBeNull());
  expect(homeLineText({ kind: "profile" }, "darwin")).toBe("This Mac starts fresh, separate from My Cloud. The bots you had here are on My Cloud; to bring in an older copy, import its backup in Settings → Backups.");
  expect(homeLineText({ kind: "profile" }, "win32")).toMatch(/^This PC starts fresh/);
  expect(host.querySelector("[data-home-line-ai]")?.textContent, "a fresh place offers connecting an AI while none is ready").toBe("Connect an AI");
  setLocale("pt-br");
  expect(homeLineText({ kind: "profile" }, "darwin")).toMatch(/^Este Mac começa do zero/);
});
