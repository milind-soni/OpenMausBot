// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/state/store", () => ({
  api: async (path: string) => path === "/api/config"
    ? { computerName: "Studio" }
    : { sessions: sessions.list, current: null },
}));
vi.mock("../lib/session", async (original) => ({
  ...await original<typeof import("../lib/session")>(),
  readSessionState: async () => ({ kind: "loopback" }),
}));
const { ServerPairingCard } = await import("./ServerPairingCard");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const phone = { id: "a", label: "Ada's phone", scopes: ["client"], lastSeenAt: 0, expiresAt: 1 };

it.each([
  ["nothing is paired", []],
  ["a device is paired", [phone]],
])("lets the owner rename the computer when %s", async (_, list) => {
  sessions.list = list;
  flushSync(() => root.render(createElement(ServerPairingCard)));
  await vi.waitFor(() => expect(host.querySelector("[data-phone-pairing-action]")).not.toBeNull());
  if (list.length) await vi.waitFor(() => expect(host.querySelector("[data-paired-device]")).not.toBeNull());
  await vi.waitFor(() => expect(host.querySelector("[data-computer-name]")).not.toBeNull());
});
