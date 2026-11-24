// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  admin: true as boolean | null,
  usedGb: 50,
  room: null as null | { id: string; cause: { kind: "disk" | "memory" } },
  dispatch: (() => {}) as (action: unknown) => void,
  reads: [] as Array<{ path: string; background?: boolean }>,
  server: "env-a",
  gate: null as Promise<void> | null,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => fixture.dispatch }));
vi.mock("./CloudRoomCard", () => ({ useCloudRoom: () => ({ snapshot: fixture.room ? { status: "paid", room: fixture.room } : null, bridge: undefined, teamHome: false }) }));
vi.mock("@/state/api", () => ({
  api: async (path: string, init?: { background?: boolean }) => {
    fixture.reads.push({ path, background: init?.background });
    if (fixture.gate) await fixture.gate;
    const { storageReport, GB } = await import("@/lib/storage-report-fixture");
    return { storage: storageReport(), now: { totalBytes: 100 * GB, freeBytes: (100 - fixture.usedGb) * GB, usedBytes: fixture.usedGb * GB }, measureInS: 0, server: fixture.server };
  },
}));

import { setLocale } from "@/lib/i18n";
import { readStorageSeen } from "@/lib/storage-report";
import { forgetStorageReport, rememberStorageSeen } from "@/lib/use-storage-report";
import { StorageNotice } from "./StorageNotice";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  localStorage.clear();
  forgetStorageReport();
  Object.assign(fixture, { admin: true, usedGb: 50, room: null, reads: [], dispatch: vi.fn(), server: "env-a", gate: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** A launch: the sidebar mounts, waits its few seconds, reads once. */
async function launch() {
  await act(async () => { root.render(createElement(StorageNotice)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await answered();
}
/** The read's answer reaches the page. */
async function answered() {
  await act(async () => { await vi.dynamicImportSettled(); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
/** The half-hourly read, with usage at `usedGb`. */
async function later(usedGb: number) {
  fixture.usedGb = usedGb;
  await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
  await answered();
}
async function relaunch() {
  await act(async () => root.unmount());
  forgetStorageReport();
  root = createRoot(container);
  await launch();
}
const line = () => container.querySelector<HTMLElement>("[data-storage-notice]");
const A = "server:env-a";

describe("the sidebar's storage line", () => {
  it("says nothing under 80%, reading in the background a few seconds after launch and never before", async () => {
    await act(async () => { root.render(createElement(StorageNotice)); });
    expect(fixture.reads).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fixture.reads).toEqual([{ path: "/api/diagnostics/storage", background: true }]);
    expect(line()).toBeNull();
  });

  it("at 80% is one quiet line that takes no focus, and opens Settings → Storage only when clicked", async () => {
    fixture.usedGb = 82;
    const before = document.activeElement;
    await launch();
    expect(line()?.dataset.storageNotice).toBe("near");
    expect(line()?.getAttribute("role")).toBe("status");
    expect(line()?.textContent).toBe("Storage 82% full");
    expect(document.activeElement).toBe(before);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"], [role="alert"]')).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    line()!.querySelector("button")!.click();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "storage" });
  });

  it("shown for one launch is seen: never on the launches after, though nobody clicked it", async () => {
    fixture.usedGb = 83;
    await launch();
    expect(line()?.dataset.storageNotice).toBe("near");
    await later(85);
    expect(line(), "stays through the launch it appeared in").not.toBeNull();
    await relaunch();
    expect(line()).toBeNull();
    await relaunch();
    expect(line()).toBeNull();
  });

  it("once seen at a line, stays away on every launch after, comes back at 90%, and once more only after usage falls well under", async () => {
    fixture.usedGb = 83;
    await launch();
    expect(line()).not.toBeNull();
    // Opening Settings → Storage sees it at once.
    await act(async () => { rememberStorageSeen(A, "near"); });
    expect(line()).toBeNull();
    await relaunch();
    expect(line()).toBeNull();
    await later(88);
    expect(line()).toBeNull();
    await later(91);
    expect(line()?.dataset.storageNotice).toBe("full");
    await relaunch();
    expect(line()).toBeNull();
    await later(78);
    expect(line()).toBeNull();
    expect(readStorageSeen(A)).toBe("near");
    await later(81);
    expect(line()).toBeNull();
    await later(70);
    expect(readStorageSeen(A)).toBeNull();
    await later(80);
    expect(line()?.dataset.storageNotice).toBe("near");
  });

  it("keeps each Cloud's seen mark apart: one Cloud's line seen never hides another's, on the same page origin", async () => {
    fixture.usedGb = 84;
    await launch();
    expect(line()?.dataset.storageNotice).toBe("near");
    await relaunch();
    expect(line(), "seen on this Cloud").toBeNull();
    fixture.server = "env-b";
    await relaunch();
    expect(line()?.dataset.storageNotice, "the other Cloud says it once too").toBe("near");
    expect(readStorageSeen(A)).toBe("near");
    expect(readStorageSeen("server:env-b")).toBe("near");
    fixture.server = "env-a";
    await relaunch();
    expect(line()).toBeNull();
  });

  it("an answer to a read from before the page forgot what it knew (another server) never shows", async () => {
    fixture.usedGb = 92;
    let release!: () => void;
    fixture.gate = new Promise((resolve) => { release = resolve; });
    await act(async () => { root.render(createElement(StorageNotice)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fixture.reads).toHaveLength(1);
    await act(async () => { forgetStorageReport(); release(); });
    await answered();
    expect(line()).toBeNull();
  });

  it("clears when usage drops under 80%", async () => {
    fixture.usedGb = 85;
    await launch();
    expect(line()).not.toBeNull();
    await later(60);
    expect(line()).toBeNull();
  });

  it("keeps out of the way of the Admin's own disk card, and shows once that card was put away", async () => {
    fixture.usedGb = 92;
    fixture.room = { id: "offer-9", cause: { kind: "disk" } };
    await launch();
    expect(line()).toBeNull();
    localStorage.setItem("openmausbot.roomCard.hidden.v1", "offer-9");
    await relaunch();
    expect(line()?.dataset.storageNotice).toBe("full");
    // Amber, not red, even at 90%: the avatar's red dot sits right under this line.
    expect(line()!.querySelector("button")!.className).toContain("text-warning");
    expect(line()!.querySelector("button")!.className).not.toContain("text-danger");
  });

  it("a team member who is not an admin sends nothing and sees nothing", async () => {
    fixture.admin = false;
    fixture.usedGb = 95;
    await launch();
    await later(95);
    expect(fixture.reads).toEqual([]);
    expect(line()).toBeNull();
  });
});
