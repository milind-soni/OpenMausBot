// @vitest-environment happy-dom
import { createElement, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChiefJobCancel } from "./ChiefJobCancel";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));

const cancelled = { rootId: "old", state: "cancelled" as const, stoppedIds: ["old"], activeIds: [], errors: [] };
const partial = { rootId: "old", state: "partial" as const, stoppedIds: ["old"], activeIds: ["uncertain"], errors: ["Unconfirmed"] };
const old = { id: "old", rootId: "old", botId: "chief", threadId: "main", status: "cancelled", sourceRequest: "The old request" };
const current = { id: "new", rootId: "new", botId: "chief", threadId: "main", status: "completed", sourceRequest: "The current request" };
const job = (status = "completed") => ({ roots: ["old", "new"], nodes: [old, { ...current, status }], unconfirmedStops: [],
  current: { rootId: "new", status, state: status === "completed" ? "completed" : "running", reason: `Native ${status}`, sourceRequest: "The current request" } });
type Props = ComponentProps<typeof ChiefJobCancel> & { connected?: boolean };
const props: Props = { botId: "chief", threadId: "main", activeLeafId: "new-answer", busy: false, waiting: false, receipts: [cancelled], chief: true, canWrite: true };
let host: HTMLDivElement;
let root: Root;
const render = (patch: Partial<Props> = {}) => flushSync(() => root.render(createElement(ChiefJobCancel, { ...props, ...patch })));
const text = () => host.textContent ?? "";
const cancelButton = () => [...host.querySelectorAll("button")].find(button => /Cancel:|Cancelling job/.test(button.textContent ?? ""));

beforeEach(() => {
  fixture.api.mockReset().mockResolvedValue(job());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("current Chief job status", () => {
  it("shows the native completed job instead of a persisted older cancellation", async () => {
    render();
    await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(text()).not.toContain("Job cancelled.");
    expect(host.querySelector("[data-current-job-id]")?.getAttribute("data-current-job-id")).toBe("new");
  });

  it("restores completed status from native state on a fresh mount with cancellation history", async () => {
    render(); await vi.waitFor(() => expect(text()).toContain("Job completed."));
    flushSync(() => root.unmount()); root = createRoot(host); render();
    await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("Job cancelled.");
  });

  it("updates to running and then completed without removing the old transcript receipt", async () => {
    render(); await vi.waitFor(() => expect(text()).toContain("Job completed."));
    fixture.api.mockResolvedValue(job("running")); render({ busy: true, activeLeafId: "new-ask" });
    await vi.waitFor(() => expect(text()).toContain("Job running."));
    expect(cancelButton()?.textContent).toContain("The current request");
    fixture.api.mockResolvedValue(job()); render({ busy: false, activeLeafId: "new-result" });
    await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(text()).not.toContain("Job cancelled.");
  });

  it("shows cancelled only when the native current root is cancelled", async () => {
    fixture.api.mockResolvedValue({ roots: ["old"], nodes: [old], unconfirmedStops: [],
      current: { rootId: "old", status: "cancelled", state: "failed", reason: "Stopped" } });
    render(); await vi.waitFor(() => expect(text()).toContain("Job cancelled."));
  });

  it("keeps earlier partial warnings separate and does not let another receipt hide them", async () => {
    render({ receipts: [partial, { ...cancelled, rootId: "other" }] });
    await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(text()).toContain("Earlier job");
    expect(text()).toContain("Cancellation reported partial");
    expect(text()).not.toContain("Local work has not confirmed it stopped");
    expect(host.querySelector('[data-unconfirmed-job-id="old"]')).not.toBeNull();
  });

  it("shows native stop uncertainty even if its transcript receipt is outside the loaded history", async () => {
    fixture.api.mockResolvedValue({ ...job(), unconfirmedStops: [{ rootId: "old", sourceRequest: "The old request" }] });
    render({ receipts: [] }); await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(host.querySelector('[data-unconfirmed-job-id="old"]')).not.toBeNull();
  });

  it("keeps native uncertainty current and a resolved partial receipt historical", async () => {
    fixture.api.mockResolvedValue({ ...job(), nodes: [current], unconfirmedStops: [{ rootId: "old", sourceRequest: "The clipped old request" }] });
    render({ receipts: [partial] }); await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(text()).toContain("The clipped old request");
    expect(text()).toContain("Local work has not confirmed it stopped");
    fixture.api.mockResolvedValue(job()); window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(text()).toContain("Cancellation reported partial"));
    expect(text()).not.toContain("Local work has not confirmed it stopped");
    expect(text()).toContain("Job completed.");
  });

  it("reports an unavailable read honestly and refreshes on focus", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Disconnected")); render();
    await vi.waitFor(() => expect(text()).toContain("Job status unavailable."));
    expect(text()).not.toContain("Job cancelled.");
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(text()).toContain("Job completed."));
  });

  it("ignores a delayed response from a different thread", async () => {
    let finish!: (value: unknown) => void;
    fixture.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); render();
    fixture.api.mockResolvedValue({ roots: [], nodes: [], current: null, unconfirmedStops: [] });
    render({ threadId: "other-thread", activeLeafId: "other-answer", receipts: [] });
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(2));
    finish({ roots: ["old"], nodes: [old], current: { rootId: "old", status: "cancelled", state: "failed", reason: "Stopped" }, unconfirmedStops: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(text()).not.toContain("Job cancelled.");
    expect(host.querySelector("[data-current-job-id]")).toBeNull();
  });

  it("revalidates a receipt-only update without polling unchanged receipt arrays", async () => {
    render({ receipts: [partial] }); await vi.waitFor(() => expect(text()).toContain("Job completed."));
    render({ receipts: [{ ...partial }] }); expect(fixture.api).toHaveBeenCalledTimes(1);
    render({ receipts: [cancelled] });
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(2));
    expect(host.querySelector('[data-unconfirmed-job-id="old"]')).toBeNull();
  });

  it("updates active native work through a bounded held read without a prop change", async () => {
    let finish!: (value: unknown) => void;
    fixture.api.mockResolvedValueOnce({ ...job("running"), version: "working" })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render({ busy: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(fixture.api.mock.calls[1]?.[0]).toContain("version=working&wait=25000");
    finish({ ...job(), version: "done" });
    await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });

  it("revalidates after reconnect and never presents cached status as confirmed offline", async () => {
    render(); await vi.waitFor(() => expect(text()).toContain("Job completed."));
    render({ connected: false }); expect(text()).toContain("Job status unavailable.");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    render({ connected: true });
    await vi.waitFor(() => expect(text()).toContain("Job completed."));
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });

  it("does not post a cancellation snapshot after the view changes", async () => {
    fixture.api.mockResolvedValue(job("running")); render({ busy: true });
    await vi.waitFor(() => expect(cancelButton()).toBeTruthy());
    let snapshot!: (value: unknown) => void;
    fixture.api.mockImplementationOnce(() => new Promise(resolve => { snapshot = resolve; }));
    flushSync(() => cancelButton()!.click());
    render({ threadId: "other-thread", activeLeafId: "other-ask", receipts: [] });
    snapshot({ rootId: "new" }); await Promise.resolve(); await Promise.resolve();
    expect(fixture.api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("keeps cancellation disabled through a status refresh while its POST is pending", async () => {
    fixture.api.mockResolvedValue(job("running")); render({ busy: true });
    await vi.waitFor(() => expect(cancelButton()).toBeTruthy());
    let finish!: (value: unknown) => void;
    fixture.api.mockImplementation((path, init) => init?.method === "POST" ? new Promise(resolve => { finish = resolve; })
      : path.endsWith("/cancellation") ? Promise.resolve({ rootId: "new" }) : Promise.resolve(job("running")));
    flushSync(() => cancelButton()!.click());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    render({ busy: false, waiting: true });
    await vi.waitFor(() => expect(cancelButton()).toBeTruthy());
    expect(cancelButton()?.disabled).toBe(true);
    finish({ ...cancelled, rootId: "new" }); await Promise.resolve();
  });
});

it("renders blocked reason independently of a completed engine turn", async () => {
 fixture.api.mockResolvedValue({ ...job(), current: { rootId: "new", status: "completed", state: "blocked", reason: "GitHub tool unavailable" } });
 render(); await vi.waitFor(() => expect(text()).toContain("Job blocked: GitHub tool unavailable"));
 expect(text()).not.toContain("Job completed.");
});

it("discloses an untyped historical task outcome separately from completed lifecycle", async () => {
 fixture.api.mockResolvedValue({ ...job(), current: { ...job().current, legacyTaskOutcome: true } });
 render(); await vi.waitFor(() => expect(text()).toContain("requested-task disposition was not recorded"));
 expect(text()).not.toContain("Job completed.");
 expect(host.querySelector("[data-current-job-id]")?.textContent).toBe("Engine turn finished. Task outcome unrecorded and unverified.");
});

for (const access of [{ chief: false, canWrite: true }, { chief: false, canWrite: false }, { chief: true, canWrite: false }]) {
 it(`reads status without cancellation controls for ${JSON.stringify(access)}`, async () => {
  fixture.api.mockResolvedValue(job("running")); render(access);
  await vi.waitFor(() => expect(text()).toContain("Job running."));
  expect(cancelButton()).toBeUndefined();
 });
}
it("restores a delegated cancelled current job for a read-only non-Chief on remount", async () => {
 fixture.api.mockResolvedValue({ roots: ["old"], nodes: [old], current: { rootId: "old", status: "cancelled", state: "failed", reason: "Stopped" } });
 render({ chief: false, canWrite: false });
 await vi.waitFor(() => expect(text()).toContain("Job cancelled."));
 flushSync(() => root.unmount()); root = createRoot(host); render({ chief: false, canWrite: false });
 await vi.waitFor(() => expect(text()).toContain("Job cancelled."));
 expect(cancelButton()).toBeUndefined();
});
it("shows delegated blocked then newer completed status without Chief actions", async () => {
 fixture.api.mockResolvedValue({ ...job(), current: { rootId: "old", status: "completed", state: "blocked", reason: "Missing tool" } });
 render({ chief: false, canWrite: true });
 await vi.waitFor(() => expect(text()).toContain("Job blocked: Missing tool"));
 fixture.api.mockResolvedValue(job()); render({ chief: false, canWrite: true, activeLeafId: "newer-result" });
 await vi.waitFor(() => expect(text()).toContain("Job completed."));
 expect(cancelButton()).toBeUndefined();
});

it("does not post a preflight cancellation after write permission is removed", async () => {
 fixture.api.mockResolvedValue(job("running")); render({ busy: true });
 await vi.waitFor(() => expect(cancelButton()).toBeTruthy());
 let snapshot!: (value: unknown) => void;
 fixture.api.mockImplementationOnce(() => new Promise(resolve => { snapshot = resolve; }));
 flushSync(() => cancelButton()!.click()); render({ canWrite: false, busy: true });
 snapshot({ rootId: "new" }); await Promise.resolve(); await Promise.resolve();
 expect(fixture.api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
 expect(cancelButton()).toBeUndefined();
});
