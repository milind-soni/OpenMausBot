// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Automation } from "@/lib/automations";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));

const { useAllAutomationActions } = await import("./app-actions");

const schedule = { kind: "schedule", id: "routine-1", enabled: true } as Automation;
const hook = { kind: "webhook", id: "hook-1", enabled: true } as Automation;
const app = { kind: "app", id: "acme", enabled: true } as Automation;

let root: Root | null = null;
let actions: ReturnType<typeof useAllAutomationActions>;
function Probe() {
  actions = useAllAutomationActions();
  return null;
}
/** Waits until the last action finished, then gives the refusal shown and what it is about. */
async function shown() {
  await vi.waitFor(() => expect(actions.busy).toBeNull());
  return { error: actions.error, errorFor: actions.errorFor };
}
const refuseWith = (message: string) => fixture.api.mockRejectedValueOnce(new Error(message));

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ trigger: { id: "acme", enabled: false }, routine: { id: "routine-1" }, webhook: { id: "hook-1" } });
  fixture.state = { bots: [], routines: [], webhooks: [] };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(Probe)));
});
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

describe("the automation actions with app events added", () => {
  it("lets an app's action replace a schedule switch's refusal, and its own refusal is not shown beside the schedule", async () => {
    refuseWith("The assigned bot no longer exists");
    flushSync(() => { void actions.toggle(schedule); });
    expect(await shown()).toEqual({ error: "The assigned bot no longer exists", errorFor: "toggle:routine-1" });
    flushSync(() => { void actions.toggle(app); });
    expect(await shown()).toEqual({ error: "", errorFor: null });
    refuseWith("The assigned bot no longer exists");
    flushSync(() => { void actions.toggle(schedule); });
    expect((await shown()).errorFor).toBe("toggle:routine-1");
    refuseWith("Gmail needs reconnecting");
    flushSync(() => { void actions.runNow(app); });
    expect(await shown()).toEqual({ error: "Gmail needs reconnecting", errorFor: null });
  });

  it("lets a webhook delete replace a Pause all refusal once the person confirms it, and keeps it when they cancel", async () => {
    refuseWith("The server is restarting");
    flushSync(() => { void actions.setAllEnabled([schedule, hook], false); });
    expect((await shown()).error).toBe("The server is restarting");
    vi.stubGlobal("confirm", vi.fn(() => false));
    flushSync(() => { void actions.remove(hook, "Delete it?"); });
    expect((await shown()).error).toBe("The server is restarting");
    expect(fixture.api).not.toHaveBeenCalledWith("/api/webhooks/hook-1", expect.anything());
    vi.stubGlobal("confirm", vi.fn(() => true));
    refuseWith("The webhook is still in use");
    flushSync(() => { void actions.remove(hook, "Delete it?"); });
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/webhooks/hook-1", { method: "DELETE" }));
    expect(await shown()).toEqual({ error: "The webhook is still in use", errorFor: "delete:hook-1" });
  });

  it("lets a refused Copy address replace a Pause all refusal", async () => {
    refuseWith("The server is restarting");
    flushSync(() => { void actions.setAllEnabled([schedule, hook], false); });
    expect((await shown()).error).toBe("The server is restarting");
    fixture.api.mockRejectedValue(new Error("The webhook is gone"));
    flushSync(() => { void actions.copyAddress("hook-1"); });
    expect(await shown()).toEqual({ error: "The webhook is gone", errorFor: "copy:hook-1" });
  });

  it("drops a refused switch's refusal once the person confirms deleting a schedule", async () => {
    refuseWith("The assigned bot no longer exists");
    flushSync(() => { void actions.toggle(schedule); });
    expect(await shown()).toEqual({ error: "The assigned bot no longer exists", errorFor: "toggle:routine-1" });
    vi.stubGlobal("confirm", vi.fn(() => true));
    flushSync(() => { void actions.remove(schedule, "Delete it?"); });
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "deleteRoutine", routineId: "routine-1" }));
    expect(await shown()).toEqual({ error: "", errorFor: null });
  });
});
