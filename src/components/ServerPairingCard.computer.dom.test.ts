// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({
  api: async (path: string) => path === "/api/auth/pairing"
    ? { code: "ABCD-EFGH-IJKL", expiresAt: Date.now() + 600_000, url: "http://macmini.tail1234.ts.net:8799/pair#code=ABCD-EFGH-IJKL" }
    : path === "/api/config" ? {} : { sessions: [], current: null },
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

async function openDialog(forComputer: boolean) {
  flushSync(() => root.render(createElement(ServerPairingCard, { simple: true, reveal: false, forComputer })));
  const button = await vi.waitFor(() => {
    const found = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("Pair a"));
    expect(found).toBeDefined();
    return found!;
  });
  const label = button.textContent;
  button.click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector("[data-pair-dialog='code']");
    expect(found).not.toBeNull();
    return found!;
  });
  return { label, title: dialog.getAttribute("aria-label"), text: dialog.querySelector("[data-pair-instructions]")?.textContent ?? "", qr: dialog.querySelector("[data-pair-qr]") !== null, all: dialog.textContent ?? "" };
}

it("tells the person to type the code on their other computer, not to install the phone app", async () => {
  const computer = await openDialog(true);
  expect(computer.label).toBe("Pair a computer");
  expect(computer.title).toBe("Pair another computer");
  expect(computer.text).toContain("On your other computer, open Connect to a server");
  expect(computer.text).not.toMatch(/phone/i);
  expect(computer.qr).toBe(false);
  expect(computer.all).not.toMatch(/phone|scan/i);
});

it("keeps the phone wording for phones", async () => {
  const phone = await openDialog(false);
  expect(phone.label).toBe("Pair a phone");
  expect(phone.text).toContain("on your phone");
  expect(phone.qr).toBe(true);
});
