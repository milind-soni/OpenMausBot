// @vitest-environment happy-dom
// The round update button shows only while an update is on its way or
// waiting, and opens a centred card: version, highlights, one primary action,
// Later. The card keeps focus inside, closes on Escape and gives focus back.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdaterState } from "@/lib/updater";
import { UpdateIndicator, updateIndicatorLabel, updateIndicatorShown } from "./UpdateIndicator";
import { updateHasButton } from "./SidebarProfileMenu";

const NOTES = "- **Faster start.** Opens at once. (#1)\n- **Rooms keep actions.** Same as chats. (#2)\n- **Mentions say who they reach.** (#3)";

let push: (state: UpdaterState) => void = () => {};
const install = vi.fn(async () => {});
const check = vi.fn(async () => {});
let host: HTMLDivElement;
let root: Root;

const button = () => host.querySelector<HTMLButtonElement>("[data-update-indicator]");
const card = () => document.querySelector<HTMLElement>("[data-update-card]");
const emit = (state: UpdaterState) => act(async () => push(state));

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  install.mockClear();
  check.mockClear();
  (window as unknown as { ogb: unknown }).ogb = {
    updater: {
      onState: (callback: (state: UpdaterState) => void) => {
        push = callback;
        callback({ status: "idle" });
        return () => {};
      },
      install,
      check,
      getState: async () => ({ status: "idle" }),
    },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(UpdateIndicator)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
});

describe("the update button", () => {
  it("is shown only while an update downloads, prepares, waits or installs", () => {
    for (const status of ["idle", "checking", "error", "handed-off"] as const) expect(updateIndicatorShown({ status })).toBe(false);
    for (const status of ["downloading", "preparing", "downloaded", "installing"] as const) expect(updateIndicatorShown({ status })).toBe(true);
    expect(updateIndicatorShown(null)).toBe(false);
  });

  it("says what it holds", () => {
    expect(updateIndicatorLabel({ status: "downloaded", version: "0.2.0" })).toBe("Update ready: OpenMausBot 0.2.0");
    expect(updateIndicatorLabel({ status: "downloading", percent: 41.6 })).toBe("Downloading an update, 42%");
    expect(updateIndicatorLabel({ status: "downloading" })).toBe("Downloading an update");
  });

  it("takes over the profile row's own update badge for those phases", () => {
    expect(updateHasButton("downloaded")).toBe(true);
    expect(updateHasButton("downloading")).toBe(true);
    expect(updateHasButton("error")).toBe(false);
    expect(updateHasButton("handed-off")).toBe(false);
  });

  it("appears when an update arrives and goes when there is none", async () => {
    expect(button()).toBeNull();
    await emit({ status: "downloading", version: "0.2.0", percent: 10 });
    expect(button()).not.toBeNull();
    expect(button()!.className).toContain("rounded-full");
    expect(button()!.className).toContain("bg-white");
    expect(button()!.className).toContain("size-7");
    await emit({ status: "idle" });
    expect(button()).toBeNull();
  });
});

describe("the update card", () => {
  it("opens centred with the version, highlights and Restart to update, which installs", async () => {
    await emit({ status: "downloaded", version: "0.2.0", releaseNotes: NOTES, installMode: "restart" });
    await act(async () => button()!.click());
    const dialog = card()!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.parentElement!.className).toContain("items-center");
    expect(dialog.className).toContain("max-w-[420px]");
    expect(dialog.textContent).toContain("OpenMausBot 0.2.0");
    expect([...dialog.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Faster start.",
      "Rooms keep actions.",
      "Mentions say who they reach.",
    ]);
    const restart = [...dialog.querySelectorAll("button")].find((node) => node.textContent?.includes("Restart to update"))!;
    expect(document.activeElement).toBe(restart);
    await act(async () => restart.click());
    expect(install).toHaveBeenCalledOnce();
  });

  it("shows the download's progress and holds the action until it is done", async () => {
    await emit({ status: "downloading", version: "0.2.0", percent: 45 });
    await act(async () => button()!.click());
    const bar = card()!.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
    const primary = [...card()!.querySelectorAll("button")].find((node) => node.textContent?.includes("Downloading 45%"))!;
    expect(primary.disabled).toBe(true);
    // the card follows the download and offers the restart once it lands
    await emit({ status: "downloaded", version: "0.2.0", percent: 100 });
    expect(card()!.textContent).toContain("Restart to update");
    expect(card()!.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("offers Install where a terminal finishes the update", async () => {
    await emit({ status: "downloaded", version: "0.2.0", installMode: "handoff" });
    await act(async () => button()!.click());
    expect(card()!.textContent).toContain("Install");
    expect(card()!.textContent).not.toContain("Restart to update");
  });

  it("keeps Tab inside, closes on Escape and Later, and gives focus back to the button", async () => {
    await emit({ status: "downloaded", version: "0.2.0" });
    button()!.focus();
    await act(async () => button()!.click());
    const controls = [...card()!.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    controls.at(-1)!.focus();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true })));
    expect(document.activeElement).toBe(controls[0]);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(button());

    await act(async () => button()!.click());
    const later = [...card()!.querySelectorAll("button")].find((node) => node.textContent === "Later")!;
    await act(async () => later.click());
    expect(card()).toBeNull();
    expect(install).not.toHaveBeenCalled();
  });

  it("closes once there is nothing left to act on, and stays for a failure's Try again", async () => {
    await emit({ status: "downloaded", version: "0.2.0", installMode: "handoff" });
    await act(async () => button()!.click());
    await emit({ status: "handed-off", version: "0.2.0", installMode: "handoff", command: "sudo apt install ./x.deb" });
    expect(card()).toBeNull();
    // the next update does not reopen it by itself
    await emit({ status: "downloaded", version: "0.2.1" });
    expect(card()).toBeNull();

    await act(async () => button()!.click());
    await emit({ status: "error", message: "boom" });
    expect(card()!.textContent).toContain("Try again");
  });

  it("links to all release notes even when none read as highlights", async () => {
    await emit({ status: "downloaded", version: "0.2.0", releaseNotes: "A steadier build with small fixes." });
    await act(async () => button()!.click());
    expect(card()!.querySelectorAll("li")).toHaveLength(0);
    expect(card()!.textContent).toContain("All release notes");
  });

  it("uses one md button scale in the footer", async () => {
    await emit({ status: "downloaded", version: "0.2.0" });
    await act(async () => button()!.click());
    const footer = [...card()!.querySelectorAll("button")].slice(-2);
    for (const node of footer) {
      for (const token of ["h-7", "text-[13px]", "font-medium", "leading-4", "rounded-full", "gap-2"]) expect(node.className).toContain(token);
    }
  });
});
