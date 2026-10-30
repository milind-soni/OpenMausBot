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
vi.mock("@/lib/notify", () => ({ setNotificationPlace: (name: string | null) => place.set.push(name) }));
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
