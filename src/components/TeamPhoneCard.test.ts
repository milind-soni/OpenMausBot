// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { PHONE_ARRIVAL_POLL_MS, TeamPhoneCard, type TeamPhone } from "./TeamPhoneCard";

const fixture = vi.hoisted(() => ({ api: vi.fn(), phones: [] as TeamPhone[], current: "s-desktop" as string | null }));
vi.mock("@/state/store", () => ({ api: fixture.api }));

const phone = (id: string, label: string, email: string): TeamPhone => ({ id, label, email, lastSeenAt: Date.now() - 3 * 60_000, expiresAt: Date.now() + 3_600_000 });
let host: HTMLDivElement;
let root: Root;
const rows = () => [...host.querySelectorAll("[data-team-phone]")].map((row) => row.textContent ?? "");
const removeButtons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-team-phone-remove]")];

beforeEach(() => {
  setLocale("en");
  fixture.phones = [phone("ph-ada", "Ada's iPhone", "ada@acme.test")];
  fixture.current = "s-desktop";
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/team/phones") return { phones: fixture.phones, current: fixture.current };
    if (path.startsWith("/api/team/phones/") && init?.method === "DELETE") {
      fixture.phones = fixture.phones.filter((entry) => entry.id !== decodeURIComponent(path.split("/").pop()!));
      return { ok: true };
    }
    if (path === "/api/team/phone-pairing") return { code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 5 * 60_000, url: "https://acme.example/pair#code=ABCD-EFGH-JKLM", hint: null };
    throw new Error(`unexpected ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.useRealTimers();
  flushSync(() => root.unmount());
  host.remove();
});

describe("Open on your phone, on a Team Cloud: the phones it opened", () => {
  it("lists the paired phone under the code as its device and its member, with Remove", async () => {
    flushSync(() => root.render(createElement(TeamPhoneCard, { team: "Acme" })));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(fixture.api).toHaveBeenCalledWith("/api/team/phones");
    expect(rows()[0]).toContain("Ada's iPhone · ada@acme.test");
    expect(rows()[0]).toContain("seen 3 min ago");
    expect(host.textContent).toContain("Paired devices");
    expect(removeButtons().map((button) => button.textContent)).toEqual(["Remove"]);
  });

  it("shows every phone the server lists for an admin, each with Remove, and removing one signs it out and drops it", async () => {
    fixture.phones = [phone("ph-ada", "Ada's iPhone", "ada@acme.test"), phone("ph-cleo", "Cleo's Pixel", "cleo@acme.test")];
    flushSync(() => root.render(createElement(TeamPhoneCard, { team: "Acme" })));
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().map((row) => row.split(" · seen")[0])).toEqual(["Ada's iPhone · ada@acme.test", "Cleo's Pixel · cleo@acme.test"]);
    flushSync(() => removeButtons()[1]!.click());
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(fixture.api).toHaveBeenCalledWith("/api/team/phones/ph-cleo", { method: "DELETE" });
    expect(rows()[0]).toContain("Ada's iPhone");
  });

  it("marks the phone it is shown on, and offers no Remove for it", async () => {
    fixture.current = "ph-ada";
    flushSync(() => root.render(createElement(TeamPhoneCard, { team: "Acme" })));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain("this browser");
    expect(removeButtons()).toEqual([]);
  });

  it("says when there is none yet, and shows the phone that scans the code without a reload", async () => {
    fixture.phones = [];
    flushSync(() => root.render(createElement(TeamPhoneCard, { team: "Acme" })));
    await vi.waitFor(() => expect(host.textContent).toContain("No devices paired yet."));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-phone-pairing-action]")!.click());
    await vi.waitFor(() => expect(host.querySelector("[data-team-phone-code]")).not.toBeNull());
    fixture.phones = [phone("ph-ada", "Ada's iPhone", "ada@acme.test")];
    await vi.advanceTimersByTimeAsync(PHONE_ARRIVAL_POLL_MS);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain("Ada's iPhone · ada@acme.test");
  });

  it("shows the server's refusal instead of a silent failure", async () => {
    fixture.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") throw new Error("no such phone");
      return { phones: fixture.phones, current: null };
    });
    flushSync(() => root.render(createElement(TeamPhoneCard, { team: "Acme" })));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    flushSync(() => removeButtons()[0]!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("no such phone"));
  });
});
